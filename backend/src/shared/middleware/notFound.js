import { AppError } from '../utils/AppError.js';

/**
 * Catches any request that did not match a route and forwards a 404
 * to the centralized error handler.
 */
export function notFound(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}
