import { AppError } from '../utils/AppError.js';

/**
 * Rejects requests whose body is not JSON with 415 Unsupported Media Type.
 * Requests without a body pass through so validation can report them as
 * empty submissions.
 */
export function requireJson(req, res, next) {
  // A zero-length body is "no body" (clients often send Content-Length: 0).
  const hasEmptyBody =
    req.headers['content-length'] === '0' && req.headers['transfer-encoding'] === undefined;
  if (hasEmptyBody) return next();

  // req.is() returns null when there is no body, false on a type mismatch.
  if (req.is('application/json') === false) {
    return next(new AppError('Content-Type must be application/json', 415));
  }
  return next();
}
