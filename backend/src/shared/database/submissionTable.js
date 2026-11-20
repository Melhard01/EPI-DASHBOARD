/**
 * Generic insert for a form's OWN submission table (infrastructure only).
 *
 * Every form has a dedicated table (e.g. epineon.demo_submissions) declared in
 * its form definition. This builds a fully parameterized INSERT for exactly
 * that table: columns come from the (startup-validated) form definition and
 * only fields the visitor actually filled in are written; optional fields left
 * blank stay NULL. The schema always comes from the calling application's own
 * config, so one application can never write into another's schema.
 */
import { database, assertSafeIdentifier } from './index.js';

export function buildInsert(schema, form, submission) {
  if (!form.table) throw new Error(`Form "${form.type}" has no table configured`);
  const table = `${assertSafeIdentifier(schema)}.${assertSafeIdentifier(form.table)}`;

  const columns = ['id'];
  const values = [submission.submissionId];
  for (const [field, spec] of Object.entries(form.fields)) {
    if (Object.hasOwn(submission.data, field)) {
      columns.push(assertSafeIdentifier(spec.column));
      values.push(submission.data[field]);
    }
  }
  columns.push('created_at');
  values.push(submission.receivedAt);

  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  return { text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, values };
}

export async function insertSubmission(schema, form, submission) {
  const { text, values } = buildInsert(schema, form, submission);
  await database.query(text, values);
}
