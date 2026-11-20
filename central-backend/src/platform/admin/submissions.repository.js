/**
 * Admin access to submissions across applications.
 *
 * Generic: works only from the application descriptors it is given
 * ({ slug, dbSchema }). Callers pass ONLY the applications the admin is
 * permitted to see, so a forbidden application's schema never appears in the
 * SQL at all. Schema names are validated identifiers; all values are bound
 * parameters.
 */
import { database, assertSafeIdentifier } from '../../shared/database/index.js';
import { insertAudit } from './audit.repository.js';

const COLUMNS = `submission_id, form_type, status, data, received_at, updated_at,
  read_at, read_by, status_changed_at, status_changed_by`;

export const SORT_COLUMNS = Object.freeze({
  receivedAt: 'received_at',
  updatedAt: 'updated_at',
  status: 'status',
  formType: 'form_type',
  application: 'application',
});

const tableOf = (app) => `${assertSafeIdentifier(app.dbSchema)}.form_submissions`;
const escapeLike = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
const iso = (value) => (value ? value.toISOString() : null);

export function toSubmissionDto(application, row) {
  return {
    application,
    formType: row.form_type,
    submissionId: row.submission_id,
    status: row.status,
    data: row.data,
    receivedAt: iso(row.received_at),
    updatedAt: iso(row.updated_at),
    readAt: iso(row.read_at),
    readBy: row.read_by,
    statusChangedAt: iso(row.status_changed_at),
    statusChangedBy: row.status_changed_by,
  };
}

/**
 * @param {object} args
 * @param {Array<{slug: string, dbSchema: string}>} args.apps permitted + filtered applications
 * @param {object} args.filters { formType, status, unread, from, to, q }
 */
export async function listSubmissions({ apps, filters, sort, dir, page, pageSize }) {
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const union = apps
    .map((app) => `SELECT ${bind(app.slug)}::text AS application, ${COLUMNS} FROM ${tableOf(app)}`)
    .join('\n UNION ALL \n');

  const where = [];
  if (filters.formType) where.push(`s.form_type = ${bind(filters.formType)}`);
  if (filters.status) where.push(`s.status = ${bind(filters.status)}`);
  if (filters.unread === true) where.push('s.read_at IS NULL');
  if (filters.unread === false) where.push('s.read_at IS NOT NULL');
  if (filters.from) where.push(`s.received_at >= ${bind(filters.from)}`);
  if (filters.to) where.push(`s.received_at < ${bind(filters.to)}`);
  if (filters.q) {
    // Case-insensitive search across every field VALUE (not field names),
    // or an exact submission ID.
    where.push(`(s.submission_id::text = ${bind(filters.q.toLowerCase())}
      OR EXISTS (SELECT 1 FROM jsonb_each_text(s.data) AS kv
                 WHERE kv.value ILIKE ${bind(`%${escapeLike(filters.q)}%`)} ESCAPE '\\'))`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM (${union}) AS s ${whereSql}`;

  const countParams = [...params];
  const orderBy = `${SORT_COLUMNS[sort]} ${dir === 'asc' ? 'ASC' : 'DESC'}, s.received_at DESC, s.submission_id`;
  const limit = bind(pageSize);
  const offset = bind((page - 1) * pageSize);

  const [count, rows] = await Promise.all([
    database.query(`SELECT count(*)::int AS total ${from}`, countParams),
    database.query(`SELECT s.* ${from} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`, params),
  ]);

  return {
    total: count.rows[0].total,
    items: rows.rows.map((r) => toSubmissionDto(r.application, r)),
  };
}

export async function getSubmission(app, submissionId) {
  const { rows } = await database.query(
    `SELECT ${COLUMNS} FROM ${tableOf(app)} WHERE submission_id = $1`,
    [submissionId],
  );
  return rows[0] ? toSubmissionDto(app.slug, rows[0]) : null;
}

/**
 * Applies { status?, read? } atomically and records audit entries in the
 * same transaction. Returns the updated submission, or null if not found.
 */
export async function updateSubmission(app, submissionId, { status, read }, actorId) {
  return database.withTransaction(async (client) => {
    const current = await client.query(
      `SELECT status, read_at FROM ${tableOf(app)} WHERE submission_id = $1 FOR UPDATE`,
      [submissionId],
    );
    if (current.rowCount === 0) return null;
    const before = current.rows[0];

    const sets = [];
    const params = [submissionId];
    const bind = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    const audits = [];

    if (status !== undefined && status !== before.status) {
      sets.push(`status = ${bind(status)}`, 'status_changed_at = now()', `status_changed_by = ${bind(actorId)}`);
      audits.push({ action: 'submission.status_changed', details: { from: before.status, to: status } });
    }
    if (read === true && before.read_at === null) {
      sets.push('read_at = now()', `read_by = ${bind(actorId)}`);
      audits.push({ action: 'submission.marked_read', details: {} });
    }
    if (read === false && before.read_at !== null) {
      sets.push('read_at = NULL', 'read_by = NULL');
      audits.push({ action: 'submission.marked_unread', details: {} });
    }

    let row;
    if (sets.length > 0) {
      const updated = await client.query(
        `UPDATE ${tableOf(app)} SET ${sets.join(', ')} WHERE submission_id = $1 RETURNING ${COLUMNS}`,
        params,
      );
      row = updated.rows[0];
      for (const audit of audits) {
        await insertAudit(client, { actorId, application: app.slug, submissionId, ...audit });
      }
    } else {
      const unchanged = await client.query(`SELECT ${COLUMNS} FROM ${tableOf(app)} WHERE submission_id = $1`, [submissionId]);
      row = unchanged.rows[0];
    }
    return toSubmissionDto(app.slug, row);
  });
}

/** Hard delete + audit entry (ID, form type and last status only). */
export async function deleteSubmission(app, submissionId, actorId) {
  return database.withTransaction(async (client) => {
    const deleted = await client.query(
      `DELETE FROM ${tableOf(app)} WHERE submission_id = $1 RETURNING form_type, status`,
      [submissionId],
    );
    if (deleted.rowCount === 0) return false;
    await insertAudit(client, {
      actorId,
      action: 'submission.deleted',
      application: app.slug,
      submissionId,
      details: { formType: deleted.rows[0].form_type, status: deleted.rows[0].status },
    });
    return true;
  });
}

/** Statistics for one application over the last `days` days (UTC days). */
export async function statsFor(app, days) {
  const table = tableOf(app);
  const { rows } = await database.query(
    `SELECT
       (SELECT count(*)::int FROM ${table}) AS total,
       (SELECT count(*)::int FROM ${table} WHERE read_at IS NULL) AS unread,
       (SELECT count(*)::int FROM ${table}
          WHERE received_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                                - make_interval(days => $1 - 1)) AS received_in_period,
       (SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb)
          FROM (SELECT status, count(*)::int AS n FROM ${table} GROUP BY status) x) AS by_status,
       (SELECT COALESCE(jsonb_object_agg(form_type, n), '{}'::jsonb)
          FROM (SELECT form_type, count(*)::int AS n FROM ${table} GROUP BY form_type) x) AS by_form_type,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object('date', to_char(d, 'YYYY-MM-DD'), 'count', COALESCE(c.n, 0)) ORDER BY d), '[]'::jsonb)
          FROM generate_series(
                 date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $1 - 1),
                 date_trunc('day', now() AT TIME ZONE 'UTC'),
                 interval '1 day') AS d
          LEFT JOIN (SELECT date_trunc('day', received_at AT TIME ZONE 'UTC') AS day, count(*)::int AS n
                     FROM ${table}
                     WHERE received_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                                          - make_interval(days => $1 - 1)
                     GROUP BY 1) AS c ON c.day = d) AS daily`,
    [days],
  );
  return rows[0];
}
