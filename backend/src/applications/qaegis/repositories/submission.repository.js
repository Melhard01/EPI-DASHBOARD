import { insertSubmission } from '../../../shared/database/submissionTable.js';
import { config } from '../config/index.js';

/**
 * QAegis submission persistence.
 * Each form writes to its OWN table inside QAegis's own schema
 * (from QAegis's config): one table per form, never shared.
 */
export async function saveSubmission(form, submission) {
  await insertSubmission(config.dbSchema, form, submission);
}
