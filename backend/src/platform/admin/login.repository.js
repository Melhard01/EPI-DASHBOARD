/**
 * Admin login: verify email/password and return JWT token.
 */
import { database } from '../../shared/database/index.js';
import { verifyPassword, hashPassword } from '../../shared/security/passwordHash.js';
import { generateJWT } from '../../shared/security/jwtToken.js';
import { AppError } from '../../shared/utils/AppError.js';

const LOOKUP_SQL = `
  SELECT u.id, u.email, u.display_name, u.is_super_admin, u.status, u.password_hash,
         COALESCE(array_agg(a.application ORDER BY a.application)
                  FILTER (WHERE a.application IS NOT NULL), '{}') AS applications
  FROM platform_admin.admin_users u
  LEFT JOIN platform_admin.admin_app_access a ON a.user_id = u.id
  WHERE u.email = $1
  GROUP BY u.id`;

const UPDATE_PASSWORD_SQL = `
  UPDATE platform_admin.admin_users
  SET password_hash = $2, updated_at = now()
  WHERE id = $1`;

/**
 * Admin login with email and password.
 * @returns { token, expiresIn, admin: { id, email, displayName } }
 */
export async function loginAdmin(email, password, jwtSecret, jwtExpiryHours) {
  if (typeof email !== 'string' || !email.includes('@')) {
    throw new AppError('Invalid email', 400);
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new AppError('Invalid password', 400);
  }

  const { rows } = await database.query(LOOKUP_SQL, [email.toLowerCase()]);
  const user = rows[0];

  if (!user) {
    // Don't reveal whether email exists (security best practice)
    throw new AppError('Invalid credentials', 401);
  }

  if (user.status !== 'active') {
    throw new AppError('Account is disabled', 403);
  }

  if (!user.password_hash) {
    // Admin exists but hasn't set password yet
    throw new AppError('Password not set. Contact admin to set password.', 403);
  }

  // Verify password
  const passwordValid = await verifyPassword(password, user.password_hash);
  if (!passwordValid) {
    throw new AppError('Invalid credentials', 401);
  }

  // Generate JWT token
  const token = generateJWT(
    {
      id: user.id,
      email: user.email,
      isSuperAdmin: user.is_super_admin,
      applications: user.applications,
    },
    jwtSecret,
    jwtExpiryHours
  );

  return {
    token,
    expiresIn: jwtExpiryHours * 3600, // in seconds
    admin: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      isSuperAdmin: user.is_super_admin,
    },
  };
}

/**
 * Set or update an admin's password (admin API, requires authentication).
 * Used by: admin setting their own password, super admin setting another admin's password.
 */
export async function setAdminPassword(adminId, newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new AppError('Password must be at least 8 characters', 400);
  }

  const hash = await hashPassword(newPassword);
  const result = await database.query(UPDATE_PASSWORD_SQL, [adminId, hash]);
  if (result.rowCount === 0) {
    throw new AppError('Admin not found', 404);
  }
}
