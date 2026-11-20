/**
 * Admin authentication.
 *
 * 1. Cloudflare Access has already signed the admin in at the edge and sends a
 *    JWT in the Cf-Access-Jwt-Assertion header. We verify it ourselves
 *    (signature, issuer, audience, expiry): the header alone is never trusted.
 * 2. The verified email must belong to an ACTIVE row in
 *    platform_admin.admin_users. Access decides who may sign in; this table
 *    decides who is an admin and for which applications.
 *
 * Results: 401 (no / invalid / expired token), 403 (valid identity but not an
 * active admin), 503 (admin authentication not configured on this server).
 * Logs record only a reason code, never the token or the email.
 */
import { AppError } from '../../shared/utils/AppError.js';
import { logger } from '../../shared/utils/logger.js';
import { database } from '../../shared/database/index.js';
import { AccessTokenError } from '../../shared/security/cloudflareAccess.js';

const ACCESS_HEADER = 'cf-access-jwt-assertion';

const LOOKUP_SQL = `
  SELECT u.id, u.email, u.display_name, u.is_super_admin, u.status,
         COALESCE(array_agg(a.application ORDER BY a.application)
                  FILTER (WHERE a.application IS NOT NULL), '{}') AS applications
  FROM platform_admin.admin_users u
  LEFT JOIN platform_admin.admin_app_access a ON a.user_id = u.id
  WHERE u.email = $1
  GROUP BY u.id`;

// Record activity at most every 5 minutes per admin (avoids a write per request).
const TOUCH_SQL = `
  UPDATE platform_admin.admin_users SET last_seen_at = now()
  WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')`;

export function authenticateAdmin({ applicationSlugs }) {
  return async function authenticate(req, res, next) {
    const verify = req.app.locals.accessVerifier;
    if (!verify) {
      return next(new AppError('Admin authentication is not configured', 503));
    }

    const token = req.headers[ACCESS_HEADER];
    if (typeof token !== 'string' || token === '') {
      return next(new AppError('Authentication required', 401));
    }

    let identity;
    try {
      identity = await verify(token);
    } catch (err) {
      if (err instanceof AccessTokenError) {
        logger.warn('admin authentication failed', { requestId: req.id, reason: err.reason });
        return next(new AppError('Invalid or expired credentials', 401));
      }
      throw err;
    }

    const { rows } = await database.query(LOOKUP_SQL, [identity.email]);
    const user = rows[0];
    if (!user || user.status !== 'active') {
      logger.warn('admin authorization failed', {
        requestId: req.id,
        reason: user ? 'disabled' : 'not_an_admin',
      });
      return next(new AppError('Not authorized', 403));
    }

    await database.query(TOUCH_SQL, [user.id]);

    // Only applications that exist in this deployment count.
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
