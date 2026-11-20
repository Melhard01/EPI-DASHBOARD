/**
 * Submission workflow statuses. Must match the CHECK constraint in each
 * application's 002_add_submission_workflow.sql (verified by tests).
 * "Read" is tracked separately (read_at / read_by), not as a status.
 */
export const SUBMISSION_STATUSES = Object.freeze(['new', 'in_progress', 'replied', 'closed', 'archived']);
