import { validateSubmission } from '../../../shared/utils/validation.js';
import { createSubmission, acceptValidationResult } from '../../../shared/utils/submission.js';
import { logger } from '../../../shared/utils/logger.js';
import { AppError } from '../../../shared/utils/AppError.js';
import { config } from '../config/index.js';
import { saveSubmission } from '../repositories/submission.repository.js';

/**
 * Epi Well form processing.
 *
 * The owning application is always taken from Epi Well's own config, never
 * from the request, so a submission can only ever be attributed to Epi Well.
 * A receipt is returned only after the submission has been stored.
 */
export async function submitForm(form, body) {
  const data = acceptValidationResult(validateSubmission(form, body), {
    application: config.slug,
    formType: form.type,
  });

  const submission = createSubmission({
    application: config.slug,
    formType: form.type,
    data,
  });

  try {
    await saveSubmission(submission);
  } catch (err) {
    // Unique violation on the waitlist email index: same answer as the live site.
    if (err.code === '23505' && form.type === 'waitlist') {
      throw new AppError('This email is already on the waitlist.', 409);
    }
    throw err;
  }

  // Metadata only, never personal data.
  logger.info('form submission stored', {
    application: submission.application,
    formType: submission.formType,
    submissionId: submission.submissionId,
  });

  return submission;
}
