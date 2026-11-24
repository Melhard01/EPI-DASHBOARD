/**
 * Admin authentication via JWT tokens.
 *
 * 1. Client sends JWT token in Authorization header: "Bearer <token>"
 * 2. We verify the JWT signature and expiration.
 * 3. The verified email must belong to an ACTIVE row in
 *    platform_admin.admin_users (determines admin permissions).
 *
 * Results: 401 (no / invalid / expired token), 403 (valid identity but not an
 * active admin), 503 (admin authentication not configured on this server).
 * Logs record only a reason code, never the token or the email.
 */
import { AppError } from '../../shared/utils/AppError.js';
import { logger } from '../../shared/utils/logger.js';
import { database } from '../../shared/database/index.js';
import { verifyJWT } from '../../shared/security/jwtToken.js';

const AUTH_HEADER = 'authorization';
const BEARER_PREFIX = 'bearer ';

const LOOKUP_SQL = `
  SELECT u.id, u.email, u.display_name, u.is_super_admin, u.status,
         COALESCE(array_agg(a.application ORDER BY a.application)
                  FILTER (WHERE a.application IS NOT NULL), '{}') AS applications
  FROM platform_admin.admin_users u
  LEFT JOIN platform_admin.admin_app_access a ON a.user_id = u.id
  WHERE u.email = $1
  GROUP BY u.id`;

const TOUCH_SQL = `
  UPDATE platform_admin.admin_users SET last_seen_at = now()
  WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')`;

export function authenticateAdmin({ applicationSlugs, jwtSecret }) {
  return async function authenticate(req, res, next) {
    if (!jwtSecret) {
      return next(new AppError('Admin authentication is not configured', 503));
    }

    // Extract token from Authorization: Bearer <token>
    const authHeader = req.headers[AUTH_HEADER];
    if (typeof authHeader !== 'string' || !authHeader.toLowerCase().startsWith(BEARER_PREFIX)) {
      return next(new AppError('Authentication required', 401));
    }

    const token = authHeader.slice(BEARER_PREFIX.length).trim();
    if (!token) {
      return next(new AppError('Authentication required', 401));
    }

    // Verify JWT token
    let identity;
    try {
      identity = verifyJWT(token, jwtSecret);
    } catch (err) {
      logger.warn('admin authentication failed', { requestId: req.id, reason: err.message });
      return next(new AppError('Invalid or expired credentials', 401));
    }

    // Verify admin is active in database
    const { rows } = await database.query(LOOKUP_SQL, [identity.email]);
    const user = rows[0];
    if (!user || user.status !== 'active') {
      logger.warn('admin authorization failed', {
        requestId: req.id,
        reason: user ? 'disabled' : 'not_an_admin',
      });
      return next(new AppError('Not authorized', 403));
    }

    // Update last_seen_at timestamp (at most every 5 minutes)
    await database.query(TOUCH_SQL, [user.id]);

    // Only applications that exist in this deployment count
    const granted = user.is_super_admin ? applicationSlugs : user.applications.filter((s) => applicationSlugs.includes(s));
    req.admin = Object.freeze({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      isSuperAdmin: user.is_super_admin === true,
      applications: Object.freeze([...granted]),
    });
    return next();
  };
}
