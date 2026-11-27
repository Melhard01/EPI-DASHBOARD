/**
 * Admin user management (Super Admin only). Every change is audited in the
 * same transaction. Users are disabled, never deleted, so audit entries
 * always resolve to a person.
 */
import { AppError } from '../../shared/utils/AppError.js';
import { database } from '../../shared/database/index.js';
import { insertAudit } from './audit.repository.js';

const SELECT_USERS = `
  SELECT u.id, u.email, u.display_name, u.is_super_admin, u.status, u.created_at, u.updated_at, u.last_seen_at,
         COALESCE(array_agg(a.application ORDER BY a.application)
                  FILTER (WHERE a.application IS NOT NULL), '{}') AS applications
  FROM platform_admin.admin_users u
  LEFT JOIN platform_admin.admin_app_access a ON a.user_id = u.id`;

const iso = (value) => (value ? value.toISOString() : null);

export function toUserDto(r) {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    isSuperAdmin: r.is_super_admin,
    status: r.status,
    applications: r.applications,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    lastSeenAt: iso(r.last_seen_at),
  };
}

async function fetchUser(client, id) {
  const { rows } = await client.query(`${SELECT_USERS} WHERE u.id = $1 GROUP BY u.id`, [id]);
  return rows[0] ? toUserDto(rows[0]) : null;
}

export async function listUsers() {
  const { rows } = await database.query(`${SELECT_USERS} GROUP BY u.id ORDER BY u.email`);
  return rows.map(toUserDto);
}

export async function createUser({ email, displayName, isSuperAdmin, applications }, actorId) {
  try {
    return await database.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO platform_admin.admin_users (email, display_name, is_super_admin, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [email, displayName ?? null, isSuperAdmin, actorId],
      );
      const id = rows[0].id;
      for (const application of applications) {
        await client.query(
          `INSERT INTO platform_admin.admin_app_access (user_id, application, granted_by) VALUES ($1, $2, $3)`,
          [id, application, actorId],
        );
      }
      await insertAudit(client, {
        actorId,
        action: 'admin_user.created',
        targetUserId: id,
        details: { isSuperAdmin, applications },
      });
      return fetchUser(client, id);
    });
  } catch (err) {
    if (err.code === '23505') throw new AppError('An admin with this email already exists', 409);
    throw err;
  }
}

/**
 * Updates an admin. Guards against lock-out: nobody can disable or demote
 * themselves, and the last active Super Admin can never be removed.
 */
export async function updateUser(id, changes, actorId) {
  return database.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, is_super_admin, status FROM platform_admin.admin_users WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (rows.length === 0) return null;
    const before = rows[0];

    const demotes = changes.isSuperAdmin === false && before.is_super_admin;
    const disables = changes.status === 'disabled' && before.status === 'active';
    if ((demotes || disables) && id === actorId) {
      throw new AppError('You cannot remove your own Super Admin access or disable yourself', 409);
    }
    if ((demotes || disables) && before.is_super_admin && before.status === 'active') {
      const others = await client.query(
        `SELECT id FROM platform_admin.admin_users
         WHERE is_super_admin AND status = 'active' AND id <> $1 FOR UPDATE`,
        [id],
      );
      if (others.rowCount === 0) {
        throw new AppError('At least one active Super Admin must remain', 409);
      }
    }

    const sets = [];
    const params = [id];
    const bind = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (changes.displayName !== undefined) sets.push(`display_name = ${bind(changes.displayName)}`);
    if (changes.isSuperAdmin !== undefined) sets.push(`is_super_admin = ${bind(changes.isSuperAdmin)}`);
    if (changes.status !== undefined) sets.push(`status = ${bind(changes.status)}`);
    if (sets.length > 0) {
      await client.query(`UPDATE platform_admin.admin_users SET ${sets.join(', ')} WHERE id = $1`, params);
    }

    let added = [];
    let removed = [];
    if (changes.applications !== undefined) {
      const current = await client.query(
        `SELECT application FROM platform_admin.admin_app_access WHERE user_id = $1`,
        [id],
      );
      const have = new Set(current.rows.map((r) => r.application));
      const want = new Set(changes.applications);
      added = [...want].filter((a) => !have.has(a));
      removed = [...have].filter((a) => !want.has(a));
      for (const application of removed) {
        await client.query(
          `DELETE FROM platform_admin.admin_app_access WHERE user_id = $1 AND application = $2`,
          [id, application],
        );
      }
      for (const application of added) {
        await client.query(
          `INSERT INTO platform_admin.admin_app_access (user_id, application, granted_by) VALUES ($1, $2, $3)`,
          [id, application, actorId],
        );
      }
    }

    await insertAudit(client, {
      actorId,
      action: 'admin_user.updated',
      targetUserId: id,
      details: {
        fields: Object.keys(changes).filter((k) => k !== 'applications' && changes[k] !== undefined),
        ...(changes.isSuperAdmin !== undefined ? { isSuperAdmin: changes.isSuperAdmin } : {}),
        ...(changes.status !== undefined ? { status: changes.status } : {}),
        ...(added.length ? { applicationsAdded: added } : {}),
        ...(removed.length ? { applicationsRemoved: removed } : {}),
      },
    });
    return fetchUser(client, id);
  });
}

/**
 * Deletes an admin user permanently.
 * Guards: Cannot delete yourself, cannot delete last Super Admin.
 * Cascades: Deletes app access, audit entries still reference the user by ID.
 */
export async function deleteUser(id, actorId) {
  return database.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, is_super_admin, status, email FROM platform_admin.admin_users WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (rows.length === 0) return null;
    const user = rows[0];

    // Cannot delete yourself
    if (id === actorId) {
      throw new AppError('You cannot delete your own account', 409);
    }

    // Cannot delete if it's the last active Super Admin
    if (user.is_super_admin && user.status === 'active') {
      const others = await client.query(
        `SELECT id FROM platform_admin.admin_users
         WHERE is_super_admin AND status = 'active' AND id <> $1 FOR UPDATE`,
        [id],
      );
      if (others.rowCount === 0) {
        throw new AppError('At least one active Super Admin must remain', 409);
      }
    }

    // Delete app access (cascaded by FK in some cases, explicit here for clarity)
    await client.query(`DELETE FROM platform_admin.admin_app_access WHERE user_id = $1`, [id]);

    // Delete the user
    await client.query(`DELETE FROM platform_admin.admin_users WHERE id = $1`, [id]);

    // Audit
    await insertAudit(client, {
      actorId,
      action: 'admin_user.deleted',
      targetUserId: id,
      details: {
        email: user.email,
        isSuperAdmin: user.is_super_admin,
      },
    });

    return { email: user.email };
  });
}
