/**
 * Creates (or promotes) a Super Admin. This is the one way to bootstrap the
 * first admin, because the Admin API itself requires an existing admin.
 *
 *   npm run admin:create -- you@example.com ["Display Name"]
 *
 * Needs database access (DATABASE_URL). The email must be the one that signs
 * in through Cloudflare Access. The action is recorded in the audit log.
 */
import { database } from '../src/shared/database/index.js';

const email = (process.argv[2] ?? '').trim().toLowerCase();
const displayName = process.argv[3]?.trim() || null;
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: npm run admin:create -- <email> ["Display Name"]');
  process.exit(1);
}
if (!database.isConfigured()) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

try {
  const result = await database.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO platform_admin.admin_users (email, display_name, is_super_admin)
       VALUES ($1, $2, true)
       ON CONFLICT (email) DO UPDATE
         SET is_super_admin = true, status = 'active',
             display_name = COALESCE(EXCLUDED.display_name, platform_admin.admin_users.display_name)
       RETURNING id, (xmax = 0) AS created`,
      [email, displayName],
    );
    const { id, created } = rows[0];
    await client.query(
      `INSERT INTO platform_admin.audit_log (actor_id, action, target_user_id, details)
       VALUES ($1, 'admin_user.bootstrapped', $1, $2)`,
      [id, JSON.stringify({ created, isSuperAdmin: true, via: 'cli' })],
    );
    return created;
  });
  console.log(`${result ? 'Created' : 'Updated'} Super Admin ${email}`);
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await database.close();
}
