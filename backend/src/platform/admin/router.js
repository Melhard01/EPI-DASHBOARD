/**
 * Central Admin API: /api/v1/admin/*
 *
 * Every route requires:
 *   1. an allowed dashboard Origin (any Origin must be allowed; changes must send one)
 *   2. a verified Cloudflare Access identity that is an ACTIVE admin
 * and is then authorized per application (see permissions.js).
 *
 *   GET    /me
 *   GET    /submissions
 *   GET    /submissions/:application/:formType/:id
 *   PATCH  /submissions/:application/:formType/:id      { status?, read? }
 *   DELETE /submissions/:application/:formType/:id
 *   GET    /stats
 *   GET    /users                 (Super Admin)
 *   POST   /users                 (Super Admin)
 *   PATCH  /users/:id             (Super Admin)
 *   GET    /audit                 (Super Admin)
 */
import { Router } from 'express';
import { AppError } from '../../shared/utils/AppError.js';
import { sendSuccess } from '../../shared/utils/response.js';
import { methodNotAllowed } from '../../shared/middleware/security.js';
import { requireAdminOrigin } from '../../shared/security/cors.js';
import { authenticateAdmin } from './authenticate.js';
import { resolveApplications, assertCanAccess, requireSuperAdmin } from './permissions.js';
import { parseQuery, param, requireBodyKeys, isUuid } from './params.js';
import { SUBMISSION_STATUSES } from './statuses.js';
import {
  listSubmissions,
  getSubmission,
  updateSubmission,
  deleteSubmission,
  statsFor,
  SORT_COLUMNS,
} from './submissions.repository.js';
import { listUsers, createUser, updateUser } from './users.repository.js';
import { listAudit } from './audit.repository.js';

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const paginated = (items, total, page, pageSize) => ({
  items,
  pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
});

export function createAdminRouter({ applications }) {
  const bySlug = new Map(applications.map((a) => [a.slug, a]));
  const slugs = applications.map((a) => a.slug);
  const allFormTypes = [...new Set(applications.flatMap((a) => a.formTypes))];
  const router = Router();

  router.use(requireAdminOrigin);
  router.use(authenticateAdmin({ applicationSlugs: slugs }));

  /** Resolves :application from the path: 404 if unknown, 403 if not permitted. */
  function appFromPath(req) {
    const app = bySlug.get(req.params.application);
    if (!app) throw new AppError('Application not found', 404);
    assertCanAccess(req.admin, app.slug);
    return app;
  }

  /** Resolves :formType inside the (already authorized) application: 404 if it has no such form. */
  function formFromPath(app, req) {
    const form = app.forms.find((f) => f.type === req.params.formType);
    if (!form) throw new AppError('Form not found', 404);
    return form;
  }

  function submissionIdFromPath(req) {
    if (!isUuid(req.params.id)) throw new AppError('Invalid submission ID', 400);
    return req.params.id.toLowerCase();
  }

  // ---------------------------------------------------------------- me
  router
    .route('/me')
    .get((req, res) =>
      sendSuccess(res, {
        message: 'Authenticated',
        data: {
          data: {
            id: req.admin.id,
            email: req.admin.email,
            displayName: req.admin.displayName,
            isSuperAdmin: req.admin.isSuperAdmin,
            applications: req.admin.applications.map((slug) => ({
              slug,
              name: bySlug.get(slug).name,
              formTypes: bySlug.get(slug).formTypes,
            })),
            statuses: SUBMISSION_STATUSES,
          },
        },
      }),
    )
    .all(methodNotAllowed(['GET', 'HEAD']));

  // ------------------------------------------------------- submissions
  router
    .route('/submissions')
    .get(async (req, res) => {
      const q = parseQuery(req.query, {
        application: param.list(slugs),
        formType: param.oneOf(allFormTypes),
        status: param.oneOf(SUBMISSION_STATUSES),
        unread: param.boolean(),
        from: param.timestamp(),
        to: param.timestamp(),
        q: param.text({ max: 200 }),
        sort: param.oneOf(Object.keys(SORT_COLUMNS), 'receivedAt'),
        dir: param.oneOf(['asc', 'desc'], 'desc'),
        page: param.int({ min: 1, max: 100_000, fallback: 1 }),
        pageSize: param.int({ min: 1, max: 100, fallback: 25 }),
      });

      const permitted = resolveApplications(req.admin, q.application);
      let apps = permitted.map((slug) => bySlug.get(slug));
      if (q.formType) {
        // A form type only exists in some applications; search just those.
        apps = apps.filter((a) => a.formTypes.includes(q.formType));
      }

      const result = apps.length
        ? await listSubmissions({
            apps,
            filters: { formType: q.formType, status: q.status, unread: q.unread, from: q.from, to: q.to, q: q.q },
            sort: q.sort,
            dir: q.dir,
            page: q.page,
            pageSize: q.pageSize,
          })
        : { items: [], total: 0 };

      return sendSuccess(res, {
        message: 'Submissions retrieved',
        data: { data: paginated(result.items, result.total, q.page, q.pageSize) },
      });
    })
    .all(methodNotAllowed(['GET', 'HEAD']));

  router
    .route('/submissions/:application/:formType/:id')
    .get(async (req, res) => {
      parseQuery(req.query, {});
      const app = appFromPath(req);
      const form = formFromPath(app, req);
      const submission = await getSubmission(app, form, submissionIdFromPath(req));
      if (!submission) throw new AppError('Submission not found', 404);
      return sendSuccess(res, { message: 'Submission retrieved', data: { data: submission } });
    })
    .patch(async (req, res) => {
      const app = appFromPath(req);
      const form = formFromPath(app, req);
      const id = submissionIdFromPath(req);
      const body = requireBodyKeys(req.body, ['status', 'read']);
      const errors = [];
      if (body.status !== undefined && !SUBMISSION_STATUSES.includes(body.status)) {
        errors.push({ field: 'status', code: 'invalid_value', message: `Must be one of: ${SUBMISSION_STATUSES.join(', ')}` });
      }
      if (body.read !== undefined && typeof body.read !== 'boolean') {
        errors.push({ field: 'read', code: 'invalid_type', message: 'Must be true or false' });
      }
      if (errors.length) throw new AppError('Validation failed', 400, errors);

      const submission = await updateSubmission(app, form, id, { status: body.status, read: body.read }, req.admin.id);
      if (!submission) throw new AppError('Submission not found', 404);
      return sendSuccess(res, { message: 'Submission updated', data: { data: submission } });
    })
    .delete(async (req, res) => {
      const app = appFromPath(req);
      const form = formFromPath(app, req);
      const deleted = await deleteSubmission(app, form, submissionIdFromPath(req), req.admin.id);
      if (!deleted) throw new AppError('Submission not found', 404);
      return sendSuccess(res, { message: 'Submission deleted' });
    })
    .all(methodNotAllowed(['GET', 'HEAD', 'PATCH', 'DELETE']));

  // ------------------------------------------------------------- stats
  router
    .route('/stats')
    .get(async (req, res) => {
      const q = parseQuery(req.query, {
        application: param.list(slugs),
        days: param.int({ min: 1, max: 365, fallback: 30 }),
      });
      const permitted = resolveApplications(req.admin, q.application);

      const perApp = {};
      const combined = {
        total: 0,
        unread: 0,
        receivedInPeriod: 0,
        byStatus: Object.fromEntries(SUBMISSION_STATUSES.map((s) => [s, 0])),
        byApplication: {},
        daily: null,
      };

      for (const slug of permitted) {
        const row = await statsFor(bySlug.get(slug), q.days);
        const app = bySlug.get(slug);
        const byStatus = Object.fromEntries(SUBMISSION_STATUSES.map((s) => [s, row.by_status[s] ?? 0]));
        const byFormType = Object.fromEntries(app.formTypes.map((t) => [t, row.by_form_type[t] ?? 0]));
        perApp[slug] = {
          total: row.total,
          unread: row.unread,
          receivedInPeriod: row.received_in_period,
          byStatus,
          byFormType,
          daily: row.daily,
        };

        combined.total += row.total;
        combined.unread += row.unread;
        combined.receivedInPeriod += row.received_in_period;
        combined.byApplication[slug] = row.total;
        for (const s of SUBMISSION_STATUSES) combined.byStatus[s] += byStatus[s];
        combined.daily = combined.daily
          ? combined.daily.map((d, i) => ({ date: d.date, count: d.count + row.daily[i].count }))
          : row.daily.map((d) => ({ ...d }));
      }
      combined.daily ??= [];

      return sendSuccess(res, {
        message: 'Statistics retrieved',
        data: { data: { days: q.days, applications: perApp, combined } },
      });
    })
    .all(methodNotAllowed(['GET', 'HEAD']));

  // ------------------------------------------------- users (Super Admin)
  function validateUserFields(body, { creating }) {
    const errors = [];
    const out = {};
    if (creating || body.email !== undefined) {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!EMAIL_PATTERN.test(email) || email.length > 254) {
        errors.push({ field: 'email', code: 'invalid_email', message: 'Must be a valid email address' });
      }
      out.email = email;
    }
    if (body.displayName !== undefined) {
      if (body.displayName !== null && (typeof body.displayName !== 'string' || body.displayName.trim() === ''
        || body.displayName.trim().length > 120 || /[\u0000-\u001F\u007F]/.test(body.displayName))) {
        errors.push({ field: 'displayName', code: 'invalid_value', message: 'Must be 1-120 printable characters or null' });
      }
      out.displayName = body.displayName === null ? null : String(body.displayName).trim();
    }
    if (body.isSuperAdmin !== undefined || creating) {
      const value = body.isSuperAdmin ?? false;
      if (typeof value !== 'boolean') errors.push({ field: 'isSuperAdmin', code: 'invalid_type', message: 'Must be true or false' });
      out.isSuperAdmin = value;
    }
    if (body.status !== undefined) {
      if (!['active', 'disabled'].includes(body.status)) {
        errors.push({ field: 'status', code: 'invalid_value', message: 'Must be active or disabled' });
      }
      out.status = body.status;
    }
    if (body.applications !== undefined || creating) {
      const value = body.applications ?? [];
      if (!Array.isArray(value) || value.some((s) => !slugs.includes(s)) || new Set(value).size !== value.length) {
        errors.push({ field: 'applications', code: 'invalid_value', message: `Must be a list of: ${slugs.join(', ')}` });
      }
      out.applications = Array.isArray(value) ? [...value] : [];
    }
    if (errors.length) throw new AppError('Validation failed', 400, errors);
    return out;
  }

  router
    .route('/users')
    .get(requireSuperAdmin, async (req, res) => {
      parseQuery(req.query, {});
      const users = await listUsers();
      return sendSuccess(res, { message: 'Admin users retrieved', data: { data: { items: users } } });
    })
    .post(requireSuperAdmin, async (req, res) => {
      const body = requireBodyKeys(req.body, ['email', 'displayName', 'isSuperAdmin', 'applications'], { requireOne: false });
      const fields = validateUserFields(body, { creating: true });
      if (!fields.isSuperAdmin && fields.applications.length === 0) {
        throw new AppError('Validation failed', 400, [
          { field: 'applications', code: 'required', message: 'Grant at least one application or Super Admin' },
        ]);
      }
      const user = await createUser(fields, req.admin.id);
      return sendSuccess(res, { statusCode: 201, message: 'Admin user created', data: { data: user } });
    })
    .all(methodNotAllowed(['GET', 'HEAD', 'POST']));

  router
    .route('/users/:id')
    .patch(requireSuperAdmin, async (req, res) => {
      if (!isUuid(req.params.id)) throw new AppError('Invalid user ID', 400);
      const body = requireBodyKeys(req.body, ['displayName', 'isSuperAdmin', 'status', 'applications']);
      const fields = validateUserFields(body, { creating: false });
      const user = await updateUser(req.params.id.toLowerCase(), fields, req.admin.id);
      if (!user) throw new AppError('Admin user not found', 404);
      return sendSuccess(res, { message: 'Admin user updated', data: { data: user } });
    })
    .all(methodNotAllowed(['PATCH']));

  // ------------------------------------------------- audit (Super Admin)
  router
    .route('/audit')
    .get(requireSuperAdmin, async (req, res) => {
      const q = parseQuery(req.query, {
        application: param.oneOf(slugs),
        action: param.text({ max: 64 }),
        page: param.int({ min: 1, max: 100_000, fallback: 1 }),
        pageSize: param.int({ min: 1, max: 100, fallback: 50 }),
      });
      const result = await listAudit(q);
      return sendSuccess(res, {
        message: 'Audit log retrieved',
        data: { data: paginated(result.items, result.total, q.page, q.pageSize) },
      });
    })
    .all(methodNotAllowed(['GET', 'HEAD']));

  return router;
}
