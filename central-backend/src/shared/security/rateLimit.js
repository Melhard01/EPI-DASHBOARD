/**
 * Generic rate-limiting middleware (infrastructure only).
 *
 * Each application declares its own limits per form and builds a limiter
 * with its own scope, e.g. "epineon:demo". Counters are keyed by
 * (scope, client), so every website and every form is limited independently.
 *
 * Privacy: raw IP addresses are never stored or logged. The client key is an
 * HMAC-SHA256 of the normalized address (IPv6 grouped by /64) under a secret.
 *
 * Headers follow the IETF RateLimit header fields draft:
 *   RateLimit-Policy, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset,
 * plus Retry-After on 429 responses.
 */
import { createHmac } from 'node:crypto';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { sendError } from '../utils/response.js';
import { rateLimitSubject } from './ipAddress.js';

const SCOPE_PATTERN = /^[a-z0-9-]+:[a-z0-9-]+$/;
const MAX_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/** Validates a list of { limit, windowSeconds } rules. Throws at startup on misconfiguration. */
export function defineRateLimitRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('Rate limit rules must be a non-empty array');
  }
  const seen = new Set();
  return Object.freeze(
    rules.map(({ limit, windowSeconds }) => {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`Invalid rate limit: ${limit}`);
      }
      if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > MAX_WINDOW_SECONDS) {
        throw new Error(`Invalid rate limit window: ${windowSeconds}`);
      }
      if (seen.has(windowSeconds)) {
        throw new Error(`Duplicate rate limit window: ${windowSeconds}s`);
      }
      seen.add(windowSeconds);
      return Object.freeze({ limit, windowSeconds });
    }),
  );
}

/** HMAC of the normalized client address. Returns 64 hex chars. */
export function clientKeyFor(ip, secret) {
  const subject = rateLimitSubject(ip);
  if (!subject) throw new AppError('Unable to identify client', 400);
  return createHmac('sha256', secret).update(subject).digest('hex');
}

/**
 * Builds the rate-limit middleware for one scope.
 *
 * At request time it reads from req.app.locals:
 *   rateLimitStore  - store instance, or null when rate limiting is disabled
 *                     (never allowed in production; enforced in createApp)
 *   rateLimitSecret - HMAC secret for client keys
 * and expects req.clientIp to have been set by the client identity middleware.
 */
export function rateLimit({ scope, rules }) {
  if (!SCOPE_PATTERN.test(scope ?? '')) throw new Error(`Invalid rate limit scope: "${scope}"`);
  const validRules = defineRateLimitRules(rules);
  const windows = validRules.map((r) => r.windowSeconds);
  const policyHeader = validRules.map((r) => `${r.limit};w=${r.windowSeconds}`).join(', ');

  return async function rateLimitMiddleware(req, res, next) {
    const { rateLimitStore: store, rateLimitSecret: secret } = req.app.locals;
    if (!store) return next();

    const clientKey = clientKeyFor(req.clientIp, secret);

    let results;
    try {
      results = await store.hit(scope, clientKey, windows);
    } catch (err) {
      // Fail closed: if limits can't be checked, the request is not processed.
      logger.error('rate limit store unavailable', { scope, requestId: req.id, code: err.code });
      return sendError(res, { statusCode: 503, message: 'Service temporarily unavailable' });
    }

    const evaluated = validRules.map((rule) => {
      const r = results.find((x) => x.windowSeconds === rule.windowSeconds);
      return {
        ...rule,
        hits: r.hits,
        remaining: Math.max(0, rule.limit - r.hits),
        resetSeconds: r.resetSeconds,
        exceeded: r.hits > rule.limit,
      };
    });

    // Report the most restrictive rule: least remaining, then longest reset.
    const binding = [...evaluated].sort(
      (a, b) => a.remaining - b.remaining || b.resetSeconds - a.resetSeconds,
    )[0];

    res.set('RateLimit-Policy', policyHeader);
    res.set('RateLimit-Limit', String(binding.limit));
    res.set('RateLimit-Remaining', String(binding.remaining));
    res.set('RateLimit-Reset', String(binding.resetSeconds));

    const exceeded = evaluated.filter((r) => r.exceeded);
    if (exceeded.length > 0) {
      const retryAfter = Math.max(...exceeded.map((r) => r.resetSeconds));
      res.set('Retry-After', String(retryAfter));
      logger.warn('rate limit exceeded', { scope, requestId: req.id });
      return sendError(res, {
        statusCode: 429,
        message: 'Too many requests. Please try again later.',
      });
    }

    return next();
  };
}
