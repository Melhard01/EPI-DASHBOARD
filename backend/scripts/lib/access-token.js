/**
 * Local signing of Cloudflare-Access-style JWTs, for development and tests.
 *
 * NEVER used in production: AUTH_MODE=dev is refused when NODE_ENV=production,
 * and the keys it creates live in a git-ignored folder. Production tokens are
 * issued and signed by Cloudflare Access only.
 */
import { generateKeyPairSync, createSign } from 'node:crypto';

const b64url = (value) => Buffer.from(value).toString('base64url');

export function createAccessKeyPair(kid = 'dev-key-1') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, jwks: { keys: [jwk] } };
}

/**
 * @param {object} options
 * @param {string} options.email
 * @param {string} options.teamDomain issuer
 * @param {string} options.audience   Access AUD tag
 * @param {{kid: string, privateKey: import('node:crypto').KeyObject}} options.key
 * @param {number} [options.ttlSeconds]
 * @param {object} [options.claims]   extra/overriding claims (tests)
 * @param {object} [options.header]   extra/overriding header fields (tests)
 */
export function signAccessToken({ email, teamDomain, audience, key, ttlSeconds = 3600, claims = {}, header = {} }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: teamDomain,
    aud: [audience],
    sub: `user-${email}`,
    email,
    iat: now,
    nbf: now,
    exp: now + ttlSeconds,
    ...claims,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  const head = { alg: 'RS256', typ: 'JWT', kid: key.kid, ...header };
  const signingInput = `${b64url(JSON.stringify(head))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}
