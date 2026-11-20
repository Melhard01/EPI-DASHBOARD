/**
 * Platform-wide HTTP security middleware (infrastructure only).
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/AppError.js';
import { resolveClientIp, isSecureRequest } from '../security/clientIp.js';

/**
 * Assigns a server-generated request ID (never taken from the client) for
 * log correlation, and returns it in the X-Request-Id response header.
 */
export function requestId(req, res, next) {
  req.id = randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

/**
 * Security headers appropriate for a JSON-only API.
 * HSTS is sent only when HTTPS is enforced (production), never on localhost.
 */
export function securityHeaders({ hsts }) {
  return function setSecurityHeaders(req, res, next) {
    res.set({
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    if (hsts) {
      // 2 years, all subdomains. Add "preload" only after a deliberate
      // decision for the whole domain; it is hard to undo.
      res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
    next();
  };
}

/**
 * Resolves the trusted client IP into req.clientIp (see security/clientIp.js).
 * Requests that bypass Cloudflare in a Cloudflare mode are rejected here.
 */
export function clientIdentity({ source, originSecret = null }) {
  return function identifyClient(req, res, next) {
    req.clientIp = resolveClientIp(req, source, { originSecret });
    next();
  };
}

/**
 * Rejects (never redirects) requests that did not arrive over HTTPS.
 * A redirect would only happen after the client had already sent the
 * request, including any body, in plaintext, and would teach clients that
 * HTTP "works". A hard failure surfaces misconfigured clients immediately.
 */
export function requireHttps({ source, originSecret = null }) {
  return function enforceHttps(req, res, next) {
    if (!isSecureRequest(req, source, { originSecret })) {
      return next(new AppError('HTTPS is required', 403));
    }
    return next();
  };
}

/**
 * Terminal handler for a known path requested with an unsupported method:
 * 405 with an Allow header (instead of a misleading 404).
 */
export function methodNotAllowed(allowedMethods) {
  const allow = allowedMethods.join(', ');
  return function rejectMethod(req, res, next) {
    res.set('Allow', allow);
    next(new AppError('Method not allowed', 405));
  };
}
