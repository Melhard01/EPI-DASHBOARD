/**
 * Generic submission record infrastructure.
 *
 * Every accepted submission is stamped with the owning application, the form
 * type, a unique ID and a server-side timestamp. These values are always set
 * by the server, never taken from the client.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from './AppError.js';
import { logger } from './logger.js';
import { Rejection } from './validation.js';

export function createSubmission({ application, formType, data }) {
  if (!application || !formType) {
    throw new Error('createSubmission requires application and formType');
  }
  return Object.freeze({
    submissionId: randomUUID(),
    application,
    formType,
    receivedAt: new Date().toISOString(),
    data: Object.freeze({ ...data }),
  });
}

/**
 * Public receipt returned to the client. Deliberately excludes `data`
 * so no personal information is ever echoed back.
 */
export function toReceipt(submission) {
  return {
    application: submission.application,
    formType: submission.formType,
    submissionId: submission.submissionId,
    receivedAt: submission.receivedAt,
  };
}

/**
 * Turns a validateSubmission() result into either clean data or an AppError.
 * Anti-spam rejections get deliberately generic messages (the same ones the
 * live Epineon site uses), so a bot cannot tell which check it tripped.
 */
export function acceptValidationResult(result, { application, formType }) {
  if (result.rejected) {
    logger.warn('submission rejected', { application, formType, reason: result.rejected });
    if (result.rejected === Rejection.EXPIRED) {
      throw new AppError('This form expired. Please reload and try again.', 400);
    }
    throw new AppError('Your message could not be sent. Please try again.', 400);
  }
  if (result.errors) {
    throw new AppError('Validation failed', 400, result.errors);
  }
  return result.data;
}
