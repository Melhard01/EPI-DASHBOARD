/**
 * Append-only admin audit log (platform_admin.audit_log).
 * Entries never contain submission contents: only IDs, actions and status
 * values. The table rejects UPDATE/DELETE/TRUNCATE by trigger.
 */
import { database } from '../../shared/database/index.js';

export async function insertAudit(client, { actorId, action, application = null, formType = null, submissionId = null, targetUserId = null, details = {} }) {
  await client.query(
    `INSERT INTO platform_admin.audit_log (actor_id, action, application, form_type, submission_id, target_user_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actorId, action, application, formType, submissionId, targetUserId, JSON.stringify(details)],
  );
}

export async function listAudit({ application, action, page, pageSize }) {
  const where = [];
  const params = [];
  if (application) {
    params.push(application);
    where.push(`l.application = $${params.length}`);
  }
  if (action) {
    params.push(action);
    where.push(`l.action = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const count = await database.query(`SELECT count(*)::int AS total FROM platform_admin.audit_log l ${whereSql}`, params);
  params.push(pageSize, (page - 1) * pageSize);
  const { rows } = await database.query(
    `SELECT l.id, l.at, l.actor_id, u.email AS actor_email, l.action, l.application, l.form_type,
            l.submission_id, l.target_user_id, l.details
     FROM platform_admin.audit_log l
     LEFT JOIN platform_admin.admin_users u ON u.id = l.actor_id
     ${whereSql}
     ORDER BY l.at DESC, l.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    total: count.rows[0].total,
    items: rows.map((r) => ({
      id: Number(r.id),
      at: r.at.toISOString(),
      actorId: r.actor_id,
      actorEmail: r.actor_email,
      action: r.action,
      application: r.application,
      formType: r.form_type,
      submissionId: r.submission_id,
      targetUserId: r.target_user_id,
      details: r.details,
    })),
  };
}
