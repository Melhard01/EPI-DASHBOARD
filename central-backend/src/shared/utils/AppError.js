/**
 * Operational error with an associated HTTP status code.
 *
 * Throw (or pass to `next`) an AppError for expected failures such as
 * "not found" or "bad request". Anything else is treated as an unexpected
 * internal error by the centralized error handler.
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
  }
}
