/**
 * Admin authorization rules. Enforced server-side on every request.
 *
 *   Super Admin          every application, plus admin-user management and audit
 *   Application admin    only the applications granted in admin_app_access
 *
 * Application admins may read, update and delete submissions of their own
 * applications only. Requests for any other application get 403 BEFORE any
 * query runs, and list/stat queries are built only from permitted schemas.
 */
import { AppError } from '../../shared/utils/AppError.js';

export function canAccess(admin, slug) {
  return admin.applications.includes(slug);
}

/**
 * Resolves which applications a request may touch.
 * @param {string[]|undefined} requested explicit filter (already validated as known slugs)
 */
export function resolveApplications(admin, requested) {
  if (!requested) return admin.applications;
  const forbidden = requested.filter((slug) => !canAccess(admin, slug));
  if (forbidden.length > 0) {
    throw new AppError('You do not have access to this application', 403);
  }
  return requested;
}

export function assertCanAccess(admin, slug) {
  if (!canAccess(admin, slug)) {
    throw new AppError('You do not have access to this application', 403);
  }
}

export function requireSuperAdmin(req, res, next) {
  if (!req.admin?.isSuperAdmin) {
    return next(new AppError('Super Admin access required', 403));
  }
  return next();
}

/**
 * Validates that an inviter can grant the requested permissions.
 * This runs before invitation creation to prevent privilege escalation.
 */
export function validateInvitationPermissions(inviter, isSuperAdmin, applications) {
  // Only Super Admins can invite Super Admins
  if (isSuperAdmin && !inviter.isSuperAdmin) {
    throw new AppError('Only Super Admins can invite other Super Admins', 403);
  }

  // Website-specific admins cannot grant access outside their scope
  if (!inviter.isSuperAdmin) {
    const inviterApps = new Set(inviter.applications);
    const unauthorized = applications.filter((app) => !inviterApps.has(app));
    if (unauthorized.length > 0) {
      throw new AppError(
        `You cannot grant access to ${unauthorized.join(', ')}. You can only manage: ${inviter.applications.join(', ')}`,
        403,
      );
    }
  }
}
