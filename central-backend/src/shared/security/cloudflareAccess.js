/**
 * Cloudflare Access JWT verification (infrastructure only, dependency-free).
 *
 * Cloudflare Access authenticates admins before requests reach the API and
 * forwards a signed JWT in the `Cf-Access-Jwt-Assertion` header. The token
 * is NOT trusted until it is verified here:
 *   - RS256 signature, key chosen by `kid` from the team's JWKS
 *     (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs)
 *   - `iss` equals the configured team domain exactly
 *   - `aud` contains this application's Access AUD tag
 *   - `exp` in the future and `nbf` not in the future (small clock leeway)
 *   - an `email` claim is present (service tokens have none and are refused)
 *
 * Uses Web Crypto (crypto.subtle), available on Node.js and Cloudflare Workers.
 * Keys are cached; Access rotates keys every 6 weeks and keeps old keys valid
 * for 7 days, so an unknown `kid` triggers a (throttled) refetch.
 *
 * Verification failures throw AccessTokenError with a machine-readable
 * `reason` for logs. Callers return a generic 401 to clients.
 */

const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const CLOCK_LEEWAY_SECONDS = 60;
const MAX_TOKEN_LENGTH = 8192;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const MIN_REFETCH_INTERVAL_MS = 30 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5000;

export class AccessTokenError extends Error {
  constructor(reason) {
    super(`Access token rejected: ${reason}`);
    this.name = 'AccessTokenError';
    this.reason = reason;
  }
}

function base64UrlDecode(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new AccessTokenError('malformed');
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function decodeJson(segment) {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (err) {
    if (err instanceof AccessTokenError) throw err;
    throw new AccessTokenError('malformed');
  }
}

/** Normalizes "https://team.cloudflareaccess.com/" → "https://team.cloudflareaccess.com". */
export function normalizeTeamDomain(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ACCESS_TEAM_DOMAIN must be an https origin, e.g. https://<team>.cloudflareaccess.com');
  }
  return url.origin;
}

/** Fetches a JWKS document over HTTPS with a timeout. */
export function httpJwksFetcher(url) {
  return async () => {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`JWKS fetch failed with status ${res.status}`);
    return res.json();
  };
}

/**
 * @param {object} options
 * @param {string} options.teamDomain   https://<team>.cloudflareaccess.com
 * @param {string} options.audience     Access application AUD tag
 * @param {() => Promise<{keys: object[]}>} [options.fetchJwks] defaults to the team certs URL
 * @param {() => number} [options.now]  epoch ms (injectable for tests)
 */
export function createAccessVerifier({ teamDomain, audience, fetchJwks, now = Date.now, cacheTtlMs = DEFAULT_CACHE_TTL_MS }) {
  const issuer = normalizeTeamDomain(teamDomain);
  if (typeof audience !== 'string' || audience.length < 8) {
    throw new Error('ACCESS_AUD must be the Access application AUD tag');
  }
  const loadJwks = fetchJwks ?? httpJwksFetcher(`${issuer}/cdn-cgi/access/certs`);

  let keys = new Map(); // kid → CryptoKey
  let fetchedAt = 0;
  let lastAttempt = 0;
  let inflight = null;

  async function refresh() {
    lastAttempt = now();
    const jwks = await loadJwks();
    const next = new Map();
    for (const jwk of Array.isArray(jwks?.keys) ? jwks.keys : []) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
      if (jwk.use !== undefined && jwk.use !== 'sig') continue;
      const { kty, n, e } = jwk;
      next.set(jwk.kid, await crypto.subtle.importKey('jwk', { kty, n, e, alg: 'RS256', ext: true }, ALGORITHM, false, ['verify']));
    }
    if (next.size === 0) throw new Error('JWKS contained no usable RS256 keys');
    keys = next;
    fetchedAt = now();
  }

  async function keyFor(kid) {
    const stale = now() - fetchedAt > cacheTtlMs;
    if (keys.has(kid) && !stale) return keys.get(kid);
    // Unknown kid or stale cache: refetch, but never more than once per
    // MIN_REFETCH_INTERVAL_MS (random kids must not hammer the certs endpoint).
    if (stale || now() - lastAttempt >= MIN_REFETCH_INTERVAL_MS) {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      try {
        await inflight;
      } catch {
        if (!keys.has(kid)) throw new AccessTokenError('jwks_unavailable');
      }
    }
    const key = keys.get(kid);
    if (!key) throw new AccessTokenError('unknown_key');
    return key;
  }

  return async function verifyAccessToken(token) {
    if (typeof token !== 'string' || token.length === 0) throw new AccessTokenError('missing');
    if (token.length > MAX_TOKEN_LENGTH) throw new AccessTokenError('malformed');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AccessTokenError('malformed');

    const header = decodeJson(parts[0]);
    if (header.alg !== 'RS256') throw new AccessTokenError('bad_algorithm');
    if (typeof header.kid !== 'string' || header.kid.length === 0) throw new AccessTokenError('malformed');

    const payload = decodeJson(parts[1]);
    const signature = base64UrlDecode(parts[2]);
    const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

    const key = await keyFor(header.kid);
    const valid = await crypto.subtle.verify(ALGORITHM, key, signature, signedData);
    if (!valid) throw new AccessTokenError('bad_signature');

    // Claims (checked only after the signature is valid)
    if (payload.iss !== issuer) throw new AccessTokenError('bad_issuer');
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) throw new AccessTokenError('bad_audience');

    const nowSeconds = Math.floor(now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_LEEWAY_SECONDS <= nowSeconds) {
      throw new AccessTokenError('expired');
    }
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf - CLOCK_LEEWAY_SECONDS > nowSeconds)) {
      throw new AccessTokenError('not_yet_valid');
    }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
      throw new AccessTokenError('no_email'); // e.g. service tokens
    }

    return { email, subject: typeof payload.sub === 'string' ? payload.sub : null };
  };
}
