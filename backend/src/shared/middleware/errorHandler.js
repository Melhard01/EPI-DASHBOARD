import { logger } from '../utils/logger.js';
import { sendError } from '../utils/response.js';

/**
 * Centralized error handler. Must be registered last.
 *
 * - Operational errors (AppError) return their own status, message and details.
 * - Body-parser errors (malformed JSON, oversized body, bad encoding) map to
 *   fixed, safe messages.
 * - Other client errors raised by Express or Node (e.g. an undecodable URL)
 *   keep their 4xx status but get a generic message. Their own message is
 *   never echoed back.
 * - Everything else returns a generic 500. Internal details (message, stack)
 *   are logged server-side and never sent to the client, in any environment.
 *
 * Request bodies, headers and query strings are never logged.
 */
const BODY_PARSER_ERRORS = Object.freeze({
  'entity.parse.failed': [400, 'Malformed JSON in request body'],
  'entity.too.large': [413, 'Request body is too large'],
  'encoding.unsupported': [415, 'Unsupported content encoding'],
  'charset.unsupported': [415, 'Unsupported charset'],
  'request.aborted': [400, 'Request was aborted'],
  'request.size.invalid': [400, 'Request size did not match Content-Length'],
});

const GENERIC_CLIENT_ERROR_MESSAGES = Object.freeze({
  400: 'Bad Request',
  404: 'Not Found',
  405: 'Method not allowed',
  413: 'Request body is too large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  431: 'Request Header Fields Too Large',
});

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let statusCode;
  let message;
  let details;

  const status = Number(err?.status ?? err?.statusCode);

  if (err?.isOperational) {
    statusCode = err.statusCode;
    message = err.message;
    details = err.details;
  } else if (err?.type && Object.hasOwn(BODY_PARSER_ERRORS, err.type)) {
    [statusCode, message] = BODY_PARSER_ERRORS[err.type];
  } else if (status >= 400 && status < 500) {
    statusCode = status;
    message = GENERIC_CLIENT_ERROR_MESSAGES[status] ?? 'Bad Request';
  } else {
    statusCode = 500;
    message = 'Internal Server Error';
  }

  if (statusCode >= 500) {
    logger.error('unhandled error', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      code: err?.code,
      error: err?.message,
      stack: err?.stack,
    });
  }

  if (res.headersSent) return next(err);

  return sendError(res, {
    statusCode,
    message,
    data: details !== undefined ? { details } : {},
  });
}
