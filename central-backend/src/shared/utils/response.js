/**
 * Helpers that keep every JSON response in the same envelope shape:
 *   success: { status: "success", message, ...data }
 *   error:   { status: "error",   message, ...details }
 */
export function sendSuccess(res, { statusCode = 200, message, data = {} } = {}) {
  return res.status(statusCode).json({ status: 'success', message, ...data });
}

export function sendError(res, { statusCode = 500, message, data = {} } = {}) {
  return res.status(statusCode).json({ status: 'error', message, ...data });
}
