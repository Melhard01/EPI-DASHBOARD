import { insertSubmission } from '../../../shared/database/submissionTable.js';
import { config } from '../config/index.js';

/**
 * Epi Well submission persistence.
 * Each form writes to its OWN table inside Epi Well's own schema
 * (from Epi Well's config): one table per form, never shared.
 */
export async function saveSubmission(form, submission) {
  await insertSubmission(config.dbSchema, form, submission);
}
