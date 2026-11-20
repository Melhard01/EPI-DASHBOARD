/**
 * An in-memory fake of the central backend's admin API (MSW handlers), used by
 * component tests. It mirrors the real API's contract AND its permission rules
 * (403 for websites the admin may not use, 404 for unknown forms, strict
 * parameters), so the UI is exercised against realistic behaviour. The real
 * backend is tested separately (tests/integration/).
 */
import { http, HttpResponse } from 'msw';

export const BASE = 'http://api.test';
const A = `${BASE}/api/v1/admin`;
const STATUSES = ['new', 'in_progress', 'replied', 'closed', 'archived'];

export const APPS = [
  { slug: 'epineon', name: 'Epineon', formTypes: ['demo', 'sales', 'partnerships'] },
  { slug: 'qaegis', name: 'QAegis', formTypes: ['contact-sales'] },
  { slug: 'epiwell', name: 'Epi Well', formTypes: ['waitlist'] },
];

export const ADMINS = {
  superAdmin: { id: 'u-super', email: 'super@admin.test', displayName: 'Sam Super', isSuperAdmin: true, applications: ['epineon', 'qaegis', 'epiwell'] },
  epineonAdmin: { id: 'u-epineon', email: 'epineon@admin.test', displayName: null, isSuperAdmin: false, applications: ['epineon'] },
  qaegisAdmin: { id: 'u-qaegis', email: 'qaegis@admin.test', displayName: 'Quinn QA', isSuperAdmin: false, applications: ['qaegis'] },
  multiAdmin: { id: 'u-multi', email: 'multi@admin.test', displayName: null, isSuperAdmin: false, applications: ['epineon', 'epiwell'] },
};

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

export function seedSubmissions() {
  const make = (id, application, formType, data, extra = {}) => ({
    application, formType, submissionId: id, status: 'new', isRead: false, data,
    receivedAt: iso(1), updatedAt: iso(1), readAt: null, readBy: null, statusChangedAt: null, statusChangedBy: null, ...extra,
  });
  return [
    make('11111111-1111-4111-8111-111111111111', 'epineon', 'demo', { name: 'Alice Epineon', email: 'alice@epineon.test', company: 'Acme', product: 'EPICRYPT' }, { receivedAt: iso(0.1) }),
    make('22222222-2222-4222-8222-222222222222', 'epineon', 'demo', { name: 'Bob Demo', email: 'bob@epineon.test', company: 'Globex', product: 'EPIWELL' }, { status: 'replied', isRead: true, readAt: iso(1), readBy: 'u-super', receivedAt: iso(2) }),
    make('33333333-3333-4333-8333-333333333333', 'epineon', 'sales', { name: 'Carol Sales', email: 'carol@epineon.test', company: 'Initech', product: 'SoulChain', useCase: 'Other', message: 'Zanzibar rollout\nsecond line' }, { status: 'in_progress', receivedAt: iso(3) }),
    make('44444444-4444-4444-8444-444444444444', 'epineon', 'partnerships', { name: 'Dan Partner', email: 'dan@epineon.test', organization: 'Umbrella', nature: 'Investment' }, { status: 'closed', isRead: true, readAt: iso(4), readBy: 'u-super', receivedAt: iso(5) }),
    make('55555555-5555-4555-8555-555555555555', 'qaegis', 'contact-sales', { firstName: 'Quinn', lastName: 'Alpha', workEmail: 'quinn@qaegis.test', companyWebsite: 'example.com', userRange: '51-250', message: 'Quokka audit' }, { receivedAt: iso(0.5) }),
    make('66666666-6666-4666-8666-666666666666', 'qaegis', 'contact-sales', { firstName: 'Rita', lastName: 'Beta', workEmail: 'rita@qaegis.test', userRange: '1-50', message: 'Pricing' }, { status: 'archived', isRead: true, readAt: iso(8), readBy: 'u-super', receivedAt: iso(9) }),
    make('77777777-7777-4777-8777-777777777777', 'epiwell', 'waitlist', { email: 'wendy@epiwell.test' }, { receivedAt: iso(1.5) }),
  ];
}

const json = (data, init) => HttpResponse.json(data, init);
const ok = (message, data) => json({ status: 'success', message, ...(data === undefined ? {} : { data }) });
const fail = (status, message, details) => json({ status: 'error', message, ...(details ? { details } : {}) }, { status });

/**
 * @param {{ admin?: keyof ADMINS | object | null, submissions?: object[], users?: object[], audit?: object[] }} options
 *   admin = null simulates "no session" (401); admin = 'disabled' simulates a non-admin identity (403).
 */
export function createFakeBackend({ admin = 'superAdmin', submissions = seedSubmissions(), users, audit } = {}) {
  const state = {
    submissions,
    requests: [],
    users: users ?? Object.values(ADMINS).map((a) => ({
      id: a.id, email: a.email, displayName: a.displayName, isSuperAdmin: a.isSuperAdmin, status: 'active',
      applications: a.isSuperAdmin ? [] : a.applications, createdAt: iso(30), updatedAt: iso(30), lastSeenAt: iso(0.01),
    })),
    audit: audit ?? [
      { id: 3, at: iso(0.1), actorId: 'u-super', actorEmail: 'super@admin.test', action: 'submission.status_changed', application: 'epineon', formType: 'demo', submissionId: '22222222-2222-4222-8222-222222222222', targetUserId: null, details: { from: 'new', to: 'replied' } },
      { id: 2, at: iso(1), actorId: 'u-super', actorEmail: 'super@admin.test', action: 'admin_user.created', application: null, formType: null, submissionId: null, targetUserId: 'u-epineon', details: { isSuperAdmin: false, applications: ['epineon'] } },
      { id: 1, at: iso(2), actorId: 'u-epineon', actorEmail: 'epineon@admin.test', action: 'submission.deleted', application: 'epineon', formType: 'sales', submissionId: '99999999-9999-4999-8999-999999999999', targetUserId: null, details: { formType: 'sales', status: 'closed' } },
    ],
    admin: typeof admin === 'string' && ADMINS[admin] ? ADMINS[admin] : admin,
  };

  const record = (request, body) => {
    const url = new URL(request.url);
    state.requests.push({ method: request.method, path: url.pathname.replace('/api/v1/admin', ''), query: Object.fromEntries(url.searchParams), body });
  };

  const authenticate = () => {
    if (state.admin === null) return fail(401, 'Authentication required');
    if (state.admin === 'disabled') return fail(403, 'Not authorized');
    return null;
  };
  const permitted = () => state.admin.isSuperAdmin ? APPS.map((a) => a.slug) : state.admin.applications;
  const appsFor = () => APPS.filter((a) => permitted().includes(a.slug));
  const guarded = (handler) => async ({ request, params }) => {
    const body = ['POST', 'PATCH'].includes(request.method) ? await request.clone().json().catch(() => undefined) : undefined;
    record(request, body);
    return authenticate() ?? handler({ request, params, body, url: new URL(request.url) });
  };
  const superOnly = (handler) => guarded((ctx) => (state.admin.isSuperAdmin ? handler(ctx) : fail(403, 'Super Admin access required')));

  /** Resolves :application/:formType the way the real API does: unknown 404, forbidden 403, unknown form 404. */
  const resolveItem = (params) => {
    const app = APPS.find((a) => a.slug === params.application);
    if (!app) return { error: fail(404, 'Application not found') };
    if (!permitted().includes(app.slug)) return { error: fail(403, 'You do not have access to this application') };
    if (!app.formTypes.includes(params.formType)) return { error: fail(404, 'Form not found') };
    const index = state.submissions.findIndex((s) => s.application === app.slug && s.formType === params.formType && s.submissionId === params.id);
    return { app, index };
  };

  const handlers = [
    http.get(`${A}/me`, guarded(() => ok('Authenticated', {
      id: state.admin.id, email: state.admin.email, displayName: state.admin.displayName, isSuperAdmin: state.admin.isSuperAdmin,
      applications: appsFor(), statuses: STATUSES,
    }))),

    http.get(`${A}/submissions`, guarded(({ url }) => {
      const q = Object.fromEntries(url.searchParams);
      const requested = q.application ? q.application.split(',') : permitted();
      if (requested.some((slug) => !permitted().includes(slug))) return fail(403, 'You do not have access to this application');
      let items = state.submissions.filter((s) => requested.includes(s.application));
      if (q.formType) items = items.filter((s) => s.formType === q.formType);
      if (q.status) items = items.filter((s) => s.status === q.status);
      if (q.unread === 'true') items = items.filter((s) => !s.isRead);
      if (q.unread === 'false') items = items.filter((s) => s.isRead);
      if (q.from) items = items.filter((s) => s.receivedAt >= new Date(q.from).toISOString());
      if (q.to) items = items.filter((s) => s.receivedAt < new Date(q.to).toISOString());
      if (q.q) items = items.filter((s) => Object.values(s.data).some((v) => String(v).toLowerCase().includes(q.q.toLowerCase())) || s.submissionId === q.q.toLowerCase());
      const sortKey = q.sort ?? 'receivedAt';
      const dir = q.dir === 'asc' ? 1 : -1;
      items = [...items].sort((a, b) => (String(a[sortKey]) < String(b[sortKey]) ? -dir : String(a[sortKey]) > String(b[sortKey]) ? dir : 0));
      const pageSize = Number(q.pageSize ?? 25);
      const page = Number(q.page ?? 1);
      return ok('Submissions retrieved', {
        items: items.slice((page - 1) * pageSize, page * pageSize),
        pagination: { page, pageSize, total: items.length, totalPages: Math.max(1, Math.ceil(items.length / pageSize)) },
      });
    })),

    http.get(`${A}/submissions/:application/:formType/:id`, guarded(({ params }) => {
      const { error, index } = resolveItem(params);
      if (error) return error;
      return index < 0 ? fail(404, 'Submission not found') : ok('Submission retrieved', state.submissions[index]);
    })),

    http.patch(`${A}/submissions/:application/:formType/:id`, guarded(({ params, body }) => {
      const { error, index } = resolveItem(params);
      if (error) return error;
      if (index < 0) return fail(404, 'Submission not found');
      const bad = Object.keys(body ?? {}).filter((k) => !['status', 'read'].includes(k));
      if (bad.length || !body || Object.keys(body).length === 0) {
        return fail(400, 'Validation failed', bad.map((field) => ({ field, code: 'unexpected_field', message: 'Field is not allowed' })));
      }
      if (body.status !== undefined && !STATUSES.includes(body.status)) return fail(400, 'Validation failed', [{ field: 'status', code: 'invalid_value', message: 'Must be one of the allowed statuses' }]);
      const row = state.submissions[index];
      if (body.status !== undefined && body.status !== row.status) Object.assign(row, { status: body.status, statusChangedAt: new Date().toISOString(), statusChangedBy: state.admin.id });
      if (body.read === true && !row.isRead) Object.assign(row, { isRead: true, readAt: new Date().toISOString(), readBy: state.admin.id });
      if (body.read === false) Object.assign(row, { isRead: false, readAt: null, readBy: null });
      row.updatedAt = new Date().toISOString();
      return ok('Submission updated', row);
    })),

    http.delete(`${A}/submissions/:application/:formType/:id`, guarded(({ params }) => {
      const { error, index } = resolveItem(params);
      if (error) return error;
      if (index < 0) return fail(404, 'Submission not found');
      state.submissions.splice(index, 1);
      return ok('Submission deleted');
    })),

    http.get(`${A}/stats`, guarded(({ url }) => {
      const days = Number(url.searchParams.get('days') ?? 30);
      const apps = appsFor();
      const perApp = {};
      const combined = { total: 0, unread: 0, receivedInPeriod: 0, byStatus: Object.fromEntries(STATUSES.map((s) => [s, 0])), byApplication: {}, daily: [] };
      for (const app of apps) {
        const rows = state.submissions.filter((s) => s.application === app.slug);
        const since = Date.now() - days * 86_400_000;
        const daily = Array.from({ length: days }, (_, i) => {
          const date = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
          return { date, count: rows.filter((r) => r.receivedAt.slice(0, 10) === date).length };
        });
        const byStatus = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
        perApp[app.slug] = {
          total: rows.length, unread: rows.filter((r) => !r.isRead).length,
          receivedInPeriod: rows.filter((r) => new Date(r.receivedAt).getTime() >= since).length,
          byStatus, byFormType: Object.fromEntries(app.formTypes.map((t) => [t, rows.filter((r) => r.formType === t).length])), daily,
        };
        combined.total += rows.length;
        combined.unread += perApp[app.slug].unread;
        combined.receivedInPeriod += perApp[app.slug].receivedInPeriod;
        combined.byApplication[app.slug] = rows.length;
        for (const s of STATUSES) combined.byStatus[s] += byStatus[s];
        combined.daily = combined.daily.length ? combined.daily.map((d, i) => ({ date: d.date, count: d.count + daily[i].count })) : daily.map((d) => ({ ...d }));
      }
      return ok('Statistics retrieved', { days, applications: perApp, combined });
    })),

    http.get(`${A}/users`, superOnly(() => ok('Admin users retrieved', { items: state.users }))),

    http.post(`${A}/users`, superOnly(({ body }) => {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email ?? '')) return fail(400, 'Validation failed', [{ field: 'email', code: 'invalid_email', message: 'Must be a valid email address' }]);
      if (!body.isSuperAdmin && (body.applications ?? []).length === 0) return fail(400, 'Validation failed', [{ field: 'applications', code: 'required', message: 'Grant at least one application or Super Admin' }]);
      if (state.users.some((u) => u.email === body.email.toLowerCase())) return fail(409, 'An admin with this email already exists');
      const user = { id: `u-${state.users.length + 1}`, email: body.email.toLowerCase(), displayName: body.displayName ?? null, isSuperAdmin: body.isSuperAdmin === true, status: 'active', applications: body.applications ?? [], createdAt: iso(0), updatedAt: iso(0), lastSeenAt: null };
      state.users.push(user);
      return json({ status: 'success', message: 'Admin user created', data: user }, { status: 201 });
    })),

    http.patch(`${A}/users/:id`, superOnly(({ params, body }) => {
      const user = state.users.find((u) => u.id === params.id);
      if (!user) return fail(404, 'Admin user not found');
      if (params.id === state.admin.id && (body.status === 'disabled' || body.isSuperAdmin === false)) return fail(409, 'You cannot remove your own Super Admin access or disable yourself');
      Object.assign(user, Object.fromEntries(Object.entries(body).filter(([k]) => ['displayName', 'isSuperAdmin', 'status', 'applications'].includes(k))));
      return ok('Admin user updated', user);
    })),

    http.get(`${A}/audit`, superOnly(({ url }) => {
      const q = Object.fromEntries(url.searchParams);
      let items = state.audit;
      if (q.application) items = items.filter((i) => i.application === q.application);
      if (q.action) items = items.filter((i) => i.action === q.action);
      const pageSize = Number(q.pageSize ?? 50);
      const page = Number(q.page ?? 1);
      return ok('Audit log retrieved', { items: items.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total: items.length, totalPages: Math.max(1, Math.ceil(items.length / pageSize)) } });
    })),
  ];

  return {
    handlers,
    state,
    /** Requests received so far, optionally only those under a path prefix. */
    requests: (prefix = '') => state.requests.filter((r) => r.path.startsWith(prefix)),
    lastRequest: (prefix = '') => state.requests.filter((r) => r.path.startsWith(prefix)).at(-1),
    /** The last request that CHANGED something (POST/PATCH/DELETE), ignoring refresh GETs. */
    lastWrite: (prefix = '') => state.requests.filter((r) => r.path.startsWith(prefix) && r.method !== 'GET').at(-1),
  };
}
