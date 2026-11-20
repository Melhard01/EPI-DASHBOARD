import { validateSubmission } from '../../../shared/utils/validation.js';
import { createSubmission, acceptValidationResult } from '../../../shared/utils/submission.js';
import { logger } from '../../../shared/utils/logger.js';
import { config } from '../config/index.js';
import { saveSubmission } from '../repositories/submission.repository.js';

/**
 * Epineon form processing.
 *
 * The owning application is always taken from Epineon's own config, never
 * from the request, so a submission can only ever be attributed to Epineon.
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

  await saveSubmission(form, submission);

  // Metadata only, never personal data.
  logger.info('form submission stored', {
    application: submission.application,
    formType: submission.formType,
    submissionId: submission.submissionId,
  });

  return submission;
}
