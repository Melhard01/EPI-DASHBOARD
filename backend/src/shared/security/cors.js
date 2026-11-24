/**
 * CORS and Origin enforcement (infrastructure only, dependency-free).
 *
 * Route classes:
 *   /api/v1/<app>/forms/*   public: only that application's own website origins
 *   /api/v1/submissions     public: any registered website origin for the
 *                           preflight; the actual request is then checked
 *                           against the TARGET application's origins
 *   /api/v1/admin/*         admin: dashboard origins only, with credentials
 *   anything else           no CORS headers at all
 *
 * CORS only restricts what browsers may read. Origins are therefore also
 * ENFORCED server-side (requireAllowedOrigin / requireAdminOrigin): a browser
 * request from a foreign origin is rejected with 403 before any processing.
 * Requests without an Origin header (server-to-server, curl) are not browser
 * cross-site requests and are allowed on public endpoints only.
 */
import { AppError } from '../utils/AppError.js';

const EXPOSED_HEADERS =
  'RateLimit-Policy, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After, X-Request-Id';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

const PUBLIC_METHODS = ['POST'];
const PUBLIC_HEADERS = ['content-type'];
const ADMIN_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'];
// authorization: JWT token sent by the dashboard in Authorization: Bearer header
const ADMIN_HEADERS = ['content-type', 'authorization'];
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Normalizes and validates one configured origin. Throws on bad config.
 * Production allows only https origins; development also allows
 * http://localhost and http://127.0.0.1.
 */
export function normalizeOrigin(value, { allowLocalHttp }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid CORS origin: "${value}"`);
  }
  const origin = url.origin;
  if (origin === 'null' || value.replace(/\/$/, '') !== origin) {
    throw new Error(`CORS origin must be scheme://host[:port] only: "${value}"`);
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'https:') return origin;
  if (url.protocol === 'http:' && allowLocalHttp && isLocal) return origin;
  throw new Error(`CORS origin must use https: "${value}"`);
}

/**
 * @param {{ publicOrigins?: Record<string, string[]>, adminOrigins?: string[] }} config
 *   publicOrigins maps application slug → allowed website origins
 */
export function createCorsPolicy({ publicOrigins = {}, adminOrigins = [] } = {}) {
  const perApp = new Map(Object.entries(publicOrigins).map(([slug, list]) => [slug, new Set(list)]));
  const anyPublic = new Set([...perApp.values()].flatMap((set) => [...set]));
  const admin = new Set(adminOrigins);
  return Object.freeze({
    isPublicAllowed: (slug, origin) => perApp.get(slug)?.has(origin) === true,
    isAnyPublicAllowed: (origin) => anyPublic.has(origin),
    isAdminAllowed: (origin) => admin.has(origin),
  });
}

function originOf(req) {
  const value = req.headers.origin;
  return typeof value === 'string' && value !== '' ? value : null;
}

function classify(path, apiBase) {
  if (path === `${apiBase}/admin` || path.startsWith(`${apiBase}/admin/`)) return { kind: 'admin' };
  if (path === `${apiBase}/submissions`) return { kind: 'public-any' };
  const match = path.startsWith(`${apiBase}/`)
    ? /^\/([a-z0-9]+(?:-[a-z0-9]+)*)\/forms\/[^/]+$/.exec(path.slice(apiBase.length))
    : null;
  if (match) return { kind: 'public-app', slug: match[1] };
  return null;
}

/**
 * Global CORS middleware: answers preflight requests and adds CORS headers
 * for allowed origins. Reads the policy from req.app.locals.corsPolicy.
 */
export function cors({ apiBase }) {
  return function handleCors(req, res, next) {
    const routeClass = classify(req.path, apiBase);
    if (!routeClass) return next();

    res.vary('Origin');
    const origin = originOf(req);
    if (!origin) return next();

    const policy = req.app.locals.corsPolicy;
    const allowed =
      routeClass.kind === 'admin'
        ? policy.isAdminAllowed(origin)
        : routeClass.kind === 'public-any'
          ? policy.isAnyPublicAllowed(origin)
          : policy.isPublicAllowed(routeClass.slug, origin);

    if (allowed) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Expose-Headers', EXPOSED_HEADERS);
      if (routeClass.kind === 'admin') res.set('Access-Control-Allow-Credentials', 'true');
    }

    const isPreflight = req.method === 'OPTIONS' && req.headers['access-control-request-method'];
    if (!isPreflight) return next();

    if (!allowed) return next(new AppError('Origin not allowed', 403));

    const methods = routeClass.kind === 'admin' ? ADMIN_METHODS : PUBLIC_METHODS;
    const headers = routeClass.kind === 'admin' ? ADMIN_HEADERS : PUBLIC_HEADERS;
    const requestedMethod = String(req.headers['access-control-request-method']).toUpperCase();
    const requestedHeaders = String(req.headers['access-control-request-headers'] ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);

    if (!methods.includes(requestedMethod) || !requestedHeaders.every((h) => headers.includes(h))) {
      return next(new AppError('CORS request not allowed', 403));
    }

    res.set('Access-Control-Allow-Methods', methods.join(', '));
    res.set('Access-Control-Allow-Headers', headers.join(', '));
    res.set('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
    return res.status(204).end();
  };
}

/**
 * Per-application origin enforcement for public form submissions.
 * A browser request from an origin that is not one of THIS application's
 * websites is rejected, even on the shared /api/v1/submissions endpoint.
 */
export function requireAllowedOrigin(slug) {
  return function enforceAllowedOrigin(req, res, next) {
    const origin = originOf(req);
    if (origin && !req.app.locals.corsPolicy.isPublicAllowed(slug, origin)) {
      return next(new AppError('Origin not allowed', 403));
    }
    return next();
  };
}

/**
 * Origin enforcement for the admin API (CSRF defense in depth, alongside
 * Cloudflare Access): any Origin must be a dashboard origin, and requests
 * that change data must carry one.
 */
export function requireAdminOrigin(req, res, next) {
  const origin = originOf(req);
  if (origin && !req.app.locals.corsPolicy.isAdminAllowed(origin)) {
    return next(new AppError('Origin not allowed', 403));
  }
  if (!origin && UNSAFE_METHODS.has(req.method)) {
    return next(new AppError('Origin header required', 403));
  }
  return next();
}
