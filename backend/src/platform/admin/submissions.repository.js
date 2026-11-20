/**
 * Admin access to submissions across applications and forms.
 *
 * Every form has its OWN table. This module is generic: it works only from the
 * application descriptors it is given ({ slug, dbSchema, forms[] }, where each
 * form declares its table and field → column mapping). Callers pass ONLY the
 * applications the admin is permitted to see, so a forbidden application's
 * schema never appears in the SQL at all.
 *
 * Lists and searches combine one SELECT per permitted form table with
 * UNION ALL; the application and form type are derived from which table a row
 * came from, so a row can never be mistaken for another form's. Schema, table
 * and column names are startup-validated identifiers; every value is a bound
 * parameter.
 */
import { database, assertSafeIdentifier } from '../../shared/database/index.js';
import { insertAudit } from './audit.repository.js';

export const SORT_COLUMNS = Object.freeze({
  receivedAt: 'received_at',
  updatedAt: 'updated_at',
  status: 'status',
  formType: 'form_type',
  application: 'application',
});

const tableOf = (app, form) => `${assertSafeIdentifier(app.dbSchema)}.${assertSafeIdentifier(form.table)}`;
const escapeLike = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
const iso = (value) => (value ? value.toISOString() : null);

export function toSubmissionDto(row) {
  return {
    application: row.application,
    formType: row.form_type,
    submissionId: row.submission_id,
    status: row.status,
    isRead: row.is_read,
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
 * One SELECT for one form table, in the common shape. The form's own columns
 * are rebuilt into `data` under their API field names (blank optional fields
 * are omitted).
 */
function selectForm(app, form, bind) {
  const pairs = Object.entries(form.fields)
    .flatMap(([field, spec]) => [`${bind(field)}::text`, `t.${assertSafeIdentifier(spec.column)}`])
    .join(', ');
  return `SELECT ${bind(app.slug)}::text AS application, ${bind(form.type)}::text AS form_type,
       t.id AS submission_id, t.status, t.is_read,
       jsonb_strip_nulls(jsonb_build_object(${pairs})) AS data,
       t.created_at AS received_at, t.updated_at, t.read_at, t.read_by,
       t.status_changed_at, t.status_changed_by
  FROM ${tableOf(app, form)} t`;
}

/**
 * @param {object} args
 * @param {Array<{slug: string, dbSchema: string, forms: object[]}>} args.apps permitted + filtered applications
 * @param {object} args.filters { formType, status, unread, from, to, q }
 */
export async function listSubmissions({ apps, filters, sort, dir, page, pageSize }) {
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const branches = apps.flatMap((app) =>
    app.forms.filter((form) => !filters.formType || form.type === filters.formType).map((form) => selectForm(app, form, bind)),
  );
  if (branches.length === 0) return { total: 0, items: [] };
  const union = branches.join('\n UNION ALL \n');

  const where = [];
  if (filters.status) where.push(`s.status = ${bind(filters.status)}`);
  if (filters.unread === true) where.push('NOT s.is_read');
  if (filters.unread === false) where.push('s.is_read');
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

  return { total: count.rows[0].total, items: rows.rows.map(toSubmissionDto) };
}

async function fetchOne(queryable, app, form, submissionId) {
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const text = `${selectForm(app, form, bind)} WHERE t.id = ${bind(submissionId)}`;
  const { rows } = await queryable.query(text, params);
  return rows[0] ? toSubmissionDto(rows[0]) : null;
}

export function getSubmission(app, form, submissionId) {
  return fetchOne(database, app, form, submissionId);
}

/**
 * Applies { status?, read? } atomically and records audit entries in the
 * same transaction. Returns the updated submission, or null if not found.
 */
export async function updateSubmission(app, form, submissionId, { status, read }, actorId) {
  const table = tableOf(app, form);
  return database.withTransaction(async (client) => {
    const current = await client.query(`SELECT status, is_read FROM ${table} WHERE id = $1 FOR UPDATE`, [submissionId]);
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
    if (read === true && !before.is_read) {
      sets.push('is_read = true', 'read_at = now()', `read_by = ${bind(actorId)}`);
      audits.push({ action: 'submission.marked_read', details: {} });
    }
    if (read === false && before.is_read) {
      sets.push('is_read = false', 'read_at = NULL', 'read_by = NULL');
      audits.push({ action: 'submission.marked_unread', details: {} });
    }

    if (sets.length > 0) {
      await client.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1`, params);
      for (const audit of audits) {
        await insertAudit(client, { actorId, application: app.slug, formType: form.type, submissionId, ...audit });
      }
    }
    return fetchOne(client, app, form, submissionId);
  });
}

/** Hard delete + audit entry (ID, form type and last status only). */
export async function deleteSubmission(app, form, submissionId, actorId) {
  return database.withTransaction(async (client) => {
    const deleted = await client.query(`DELETE FROM ${tableOf(app, form)} WHERE id = $1 RETURNING status`, [submissionId]);
    if (deleted.rowCount === 0) return false;
    await insertAudit(client, {
      actorId,
      action: 'submission.deleted',
      application: app.slug,
      formType: form.type,
      submissionId,
      details: { formType: form.type, status: deleted.rows[0].status },
    });
    return true;
  });
}

/** Statistics for one application (all of its form tables) over the last `days` days (UTC days). */
export async function statsFor(app, days) {
  const params = [days];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const union = app.forms
    .map((form) => `SELECT ${bind(form.type)}::text AS form_type, t.status, t.is_read, t.created_at FROM ${tableOf(app, form)} t`)
    .join('\n UNION ALL \n');

  const { rows } = await database.query(
    `WITH s AS (${union})
     SELECT
       (SELECT count(*)::int FROM s) AS total,
       (SELECT count(*)::int FROM s WHERE NOT is_read) AS unread,
       (SELECT count(*)::int FROM s
          WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                              - make_interval(days => $1 - 1)) AS received_in_period,
       (SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb)
          FROM (SELECT status, count(*)::int AS n FROM s GROUP BY status) x) AS by_status,
       (SELECT COALESCE(jsonb_object_agg(form_type, n), '{}'::jsonb)
          FROM (SELECT form_type, count(*)::int AS n FROM s GROUP BY form_type) x) AS by_form_type,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object('date', to_char(d, 'YYYY-MM-DD'), 'count', COALESCE(c.n, 0)) ORDER BY d), '[]'::jsonb)
          FROM generate_series(
                 date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $1 - 1),
                 date_trunc('day', now() AT TIME ZONE 'UTC'),
                 interval '1 day') AS d
          LEFT JOIN (SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day, count(*)::int AS n
                     FROM s
                     WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                                          - make_interval(days => $1 - 1)
                     GROUP BY 1) AS c ON c.day = d) AS daily`,
    params,
  );
  return rows[0];
}
