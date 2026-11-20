import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Logs one line per completed request: request ID, method, path, status and
 * duration.
 *
 * Deliberately NOT logged: query strings (may contain personal data), request
 * bodies, headers (may contain credentials) and client IP addresses.
 */
export function requestLogger(req, res, next) {
  if (!env.requestLogging) return next();

  // performance.now() is a web standard, available on Node.js and Workers.
  const start = performance.now();
  res.on('finish', () => {
    logger.info('request', {
      requestId: req.id,
      method: req.method,
      // originalUrl survives router mounting; the query string is removed.
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
    });
  });
  next();
}
