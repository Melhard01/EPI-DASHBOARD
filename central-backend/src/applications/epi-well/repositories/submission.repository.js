import { database, assertSafeIdentifier } from '../../../shared/database/index.js';
import { config } from '../config/index.js';

/**
 * Epi Well submission persistence.
 * Every query targets Epi Well's own schema (from Epi Well's config).
 * Values are always passed as parameters, never interpolated.
 */
const TABLE = `${assertSafeIdentifier(config.dbSchema)}.form_submissions`;

export async function saveSubmission(submission) {
  await database.query(
    `INSERT INTO ${TABLE} (submission_id, application, form_type, data, received_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      submission.submissionId,
      submission.application,
      submission.formType,
      JSON.stringify(submission.data),
      submission.receivedAt,
    ],
  );
}
