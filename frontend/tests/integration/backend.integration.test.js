/**
 * Frontend ⇄ backend integration: the dashboard's REAL API client against the
 * REAL backend and a REAL PostgreSQL test database, with real signed tokens.
 *
 * Covers: authentication, website permissions (every cross-website attempt),
 * all five public submission endpoints plus the unified one, honeypot / origin /
 * rate-limit behaviour, lists / search / filters / pagination, status updates,
 * deletion, statistics, team management and the audit log.
 */
import { generateKeyPairSync, createSign } from 'node:crypto';
import { beforeAll, describe, expect, inject, test } from 'vitest';
import { ApiError, configureClient } from '../../src/api/client.js';
import { api } from '../../src/api/endpoints.js';
import { FORMS, as, signToken, submitForm, uniqueTag } from './helpers.js';

const SUPER = inject('superEmail');
const TAG = uniqueTag();
const emails = {
  epineon: `epineon.${TAG}@admin.test`,
  qaegis: `qaegis.${TAG}@admin.test`,
  epiwell: `epiwell.${TAG}@admin.test`,
  multi: `multi.${TAG}@admin.test`,
  disabled: `disabled.${TAG}@admin.test`,
};
const FORM_KEYS = Object.keys(FORMS);
const ids = {}; // formType → { site, id }
let ipCounter = 1;
const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

const fail = async (promise) => {
  const error = await promise.then(() => null, (e) => e);
  expect(error, 'expected the call to fail').toBeInstanceOf(ApiError);
  return error;
};
const list = (params = {}) => api.submissions.list({ pageSize: 100, ...params });
const itemUrl = (formType) => [FORMS[formType].site, formType, ids[formType].id];

beforeAll(async () => {
  as(SUPER);
  await api.users.create({ email: emails.epineon, applications: ['epineon'] });
  await api.users.create({ email: emails.qaegis, applications: ['qaegis'] });
  await api.users.create({ email: emails.epiwell, applications: ['epiwell'] });
  await api.users.create({ email: emails.multi, applications: ['epineon', 'epiwell'] });
  const disabled = await api.users.create({ email: emails.disabled, applications: ['epineon'] });
  await api.users.update(disabled.id, { status: 'disabled' });

  // One submission per form, the way each website's browser sends it.
  for (const [formType, { site, fields }] of Object.entries(FORMS)) {
    const receipt = await submitForm(site, formType, fields(TAG), { ip: nextIp() });
    expect(receipt.status, `${site}/${formType}: ${JSON.stringify(receipt.body)}`).toBe(201);
    ids[formType] = { site, id: receipt.body.data.submissionId };
  }
});

// ============================================================== authentication

describe('authentication (Cloudflare-Access-style tokens, verified by the real backend)', () => {
  test('no token → 401', async () => {
    as(SUPER, { token: null });
    const error = await fail(api.me());
    expect(error).toMatchObject({ status: 401, message: 'Authentication required' });
    expect(error.isUnauthorized).toBe(true);
  });

  test('garbage, expired, wrong-audience, wrong-issuer and forged tokens → 401, one generic message', async () => {
    const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const b64 = (v) => Buffer.from(v).toString('base64url');
    const forgedInput = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'integration-key' }))}.${b64(JSON.stringify({ iss: 'https://dev-access.invalid', aud: ['central-backend-local-development'], email: SUPER, exp: Math.floor(Date.now() / 1000) + 3600 }))}`;
    const forged = `${forgedInput}.${createSign('RSA-SHA256').update(forgedInput).sign(stranger.privateKey).toString('base64url')}`;
    const tokens = [
      'garbage',
      signToken(SUPER, { ttlSeconds: -600 }),
      signToken(SUPER, { audience: 'some-other-app' }),
      signToken(SUPER, { issuer: 'https://evil.cloudflareaccess.com' }),
      forged,
    ];
    for (const token of tokens) {
      as(SUPER, { token });
      expect(await fail(api.me())).toMatchObject({ status: 401, message: 'Invalid or expired credentials' });
    }
  });

  test('a validly signed identity that is not an administrator → 403', async () => {
    as(`stranger.${TAG}@nowhere.test`);
    const error = await fail(api.me());
    expect(error).toMatchObject({ status: 403, message: 'Not authorized' });
  });

  test('a Super Admin gets every website with its forms, and the status list', async () => {
    as(SUPER);
    const me = await api.me();
    expect(me).toMatchObject({ email: SUPER, isSuperAdmin: true });
    expect(me.applications.map((a) => [a.slug, a.name, a.formTypes])).toEqual([
      ['epineon', 'Epineon', ['demo', 'sales', 'partnerships']],
      ['qaegis', 'QAegis', ['contact-sales']],
      ['epiwell', 'Epi Well', ['waitlist']],
    ]);
    expect(me.statuses).toEqual(['new', 'in_progress', 'replied', 'closed', 'archived']);
  });

  test('every form the backend exposes is one this test knows (frontend labels stay in sync)', async () => {
    as(SUPER);
    const me = await api.me();
    expect(me.applications.flatMap((a) => a.formTypes).sort()).toEqual([...FORM_KEYS].sort());
  });

  test('disabling an admin cuts access on the very next request; re-enabling restores it', async () => {
    as(SUPER);
    const users = await api.users.list();
    const target = users.items.find((u) => u.email === emails.epiwell);
    as(emails.epiwell);
    expect((await api.me()).applications.map((a) => a.slug)).toEqual(['epiwell']);
    as(SUPER);
    await api.users.update(target.id, { status: 'disabled' });
    as(emails.epiwell);
    expect((await fail(api.me())).status).toBe(403);
    as(SUPER);
    await api.users.update(target.id, { status: 'active' });
    as(emails.epiwell);
    expect((await api.me()).email).toBe(emails.epiwell);
  });

  test('a disabled administrator is refused', async () => {
    as(emails.disabled);
    expect((await fail(api.me())).status).toBe(403);
    expect((await fail(api.submissions.list({}))).status).toBe(403);
  });

  test('changes need an allowed dashboard Origin (browsers always send one): missing or foreign → 403', async () => {
    // A throw-away submission, so the shared fixtures stay untouched for the other tests.
    const scratch = await submitForm('epineon', 'demo', FORMS.demo.fields(uniqueTag()), { ip: nextIp() }); // its own tag: not part of this run's fixtures
    const [site, formType, id] = ['epineon', 'demo', scratch.body.data.submissionId];
    as(SUPER, { origin: null });
    expect(await fail(api.submissions.update(site, formType, id, { read: true }))).toMatchObject({ status: 403, message: 'Origin header required' });
    as(SUPER, { origin: 'https://evil.example' });
    expect(await fail(api.submissions.update(site, formType, id, { read: true }))).toMatchObject({ status: 403, message: 'Origin not allowed' });
    as(SUPER, { origin: 'https://epineon.test' });
    expect((await fail(api.me())).status).toBe(403);
    as(SUPER);
    await expect(api.submissions.update(site, formType, id, { read: true })).resolves.toMatchObject({ isRead: true });
  });
});

// ================================================== the three websites submit

describe('submissions from the three websites reach the dashboard', () => {
  test('all five forms are stored under the right website and form, with their own fields', async () => {
    as(SUPER);
    const { items } = await list({ q: TAG });
    expect(items).toHaveLength(5);
    const byForm = Object.fromEntries(items.map((i) => [i.formType, i]));
    expect(Object.keys(byForm).sort()).toEqual([...FORM_KEYS].sort());
    for (const [formType, { site, fields }] of Object.entries(FORMS)) {
      const item = byForm[formType];
      expect(item.application).toBe(site);
      expect(item.status).toBe('new');
      expect(item.isRead).toBe(false);
      expect(item.data).toEqual(fields(TAG));
      expect(item.submissionId).toBe(ids[formType].id);
    }
  });

  test('the public receipt has the documented shape and never contains submitted data', async () => {
    const response = await submitForm('qaegis', 'contact-sales', FORMS['contact-sales'].fields(`${TAG}r`), { ip: nextIp() });
    expect(response.status).toBe(201);
    expect(Object.keys(response.body.data).sort()).toEqual(['application', 'formType', 'receivedAt', 'submissionId']);
    expect(JSON.stringify(response.body)).not.toContain('quinn');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://qaegis.test');
  });

  test('emails are stored lower-cased and blank optional fields are left out', async () => {
    const response = await submitForm('epineon', 'demo', { name: `Case Test ${TAG}`, email: `UPPER.${TAG}@EPINEON.TEST`, company: 'C', product: 'EPIWELL', role: '   ' }, { ip: nextIp() });
    expect(response.status).toBe(201);
    as(SUPER);
    const item = await api.submissions.get('epineon', 'demo', response.body.data.submissionId);
    expect(item.data).toEqual({ name: `Case Test ${TAG}`, email: `upper.${TAG}@epineon.test`, company: 'C', product: 'EPIWELL' });
  });

  test('the unified endpoint stores into the same place', async () => {
    const response = await submitForm('epiwell', 'waitlist', { email: `unified.${TAG}@epiwell.test` }, { ip: nextIp(), viaUnified: true });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ application: 'epiwell', formType: 'waitlist' });
    as(SUPER);
    expect((await api.submissions.get('epiwell', 'waitlist', response.body.data.submissionId)).data.email).toBe(`unified.${TAG}@epiwell.test`);
  });

  test('invalid submissions are refused with field messages and store nothing', async () => {
    as(SUPER);
    const before = (await list({ formType: 'sales' })).pagination.total;
    const bad = await submitForm('epineon', 'sales', { name: 'X', email: 'not-an-email', company: 'C', product: 'Not a product', useCase: 'Other' }, { ip: nextIp() });
    expect(bad.status).toBe(400);
    expect(bad.body.details.map((d) => `${d.field}:${d.code}`).sort()).toEqual(['email:invalid_email', 'message:required', 'product:invalid_option']);
    expect((await list({ formType: 'sales' })).pagination.total).toBe(before);
  });

  test('the honeypot rejects silently and stores nothing', async () => {
    as(SUPER);
    const before = (await list()).pagination.total;
    const bot = await submitForm('epineon', 'demo', { ...FORMS.demo.fields(`${TAG}bot`), companyWebsite: 'http://spam.example' }, { ip: nextIp() });
    expect(bot).toMatchObject({ status: 400, body: { status: 'error', message: 'Your message could not be sent. Please try again.' } });
    const fast = await submitForm('epineon', 'demo', { ...FORMS.demo.fields(`${TAG}fast`), formStartedAt: Date.now() - 300 }, { ip: nextIp() });
    expect(fast.body).toEqual(bot.body);
    expect((await list()).pagination.total).toBe(before);
  });

  test('Epi Well: a duplicate email is a 409 and a disposable domain is refused', async () => {
    as(SUPER);
    const dupe = await submitForm('epiwell', 'waitlist', { email: FORMS.waitlist.fields(TAG).email.toUpperCase() }, { ip: nextIp() });
    expect(dupe).toMatchObject({ status: 409, body: { message: 'This email is already on the waitlist.' } });
    const disposable = await submitForm('epiwell', 'waitlist', { email: `x.${TAG}@mailinator.com` }, { ip: nextIp() });
    expect(disposable.status).toBe(400);
    expect(disposable.body.details[0].code).toBe('blocked_domain');
    expect((await list({ formType: 'waitlist', q: FORMS.waitlist.fields(TAG).email })).items).toHaveLength(1);
  });

  test('each website may only post to its OWN forms (origin enforced), and nothing is stored', async () => {
    as(SUPER);
    const before = (await list()).pagination.total;
    const crossed = await submitForm('epineon', 'demo', FORMS.demo.fields(`${TAG}x`), { ip: nextIp(), headers: { origin: 'https://qaegis.test' } });
    expect(crossed).toMatchObject({ status: 403, body: { message: 'Origin not allowed' } });
    expect(crossed.headers.get('access-control-allow-origin')).toBeNull();
    expect((await list()).pagination.total).toBe(before);
  });

  test('CORS preflight: allowed for the website\'s own origin, refused for others', async () => {
    const base = inject('backendUrl');
    const preflight = (origin) => fetch(`${base}/api/v1/epiwell/forms/waitlist`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type', 'cf-connecting-ip': nextIp() },
    });
    const ok = await preflight('https://epiwell.test');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://epiwell.test');
    expect((await preflight('https://epineon.test')).status).toBe(403);
    expect((await preflight('https://evil.example')).status).toBe(403);
  });
});

// ============================================================== permissions

describe('website permissions, enforced by the real backend', () => {
  const OWN = { epineon: ['demo', 'sales', 'partnerships'], qaegis: ['contact-sales'], epiwell: ['waitlist'] };

  test.each(['epineon', 'qaegis', 'epiwell'])('the %s admin sees only their own website', async (site) => {
    as(emails[site]);
    const me = await api.me();
    expect(me.isSuperAdmin).toBe(false);
    expect(me.applications.map((a) => a.slug)).toEqual([site]);
    const { items, pagination } = await list();
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((i) => i.application))).toEqual(new Set([site]));
    expect(new Set(items.map((i) => i.formType))).toEqual(new Set(OWN[site]));
    expect(pagination.total).toBe(items.length);
    for (const formType of OWN[site]) expect(items.some((i) => i.submissionId === ids[formType].id)).toBe(true);
  });

  test('searching for another website\'s data finds nothing', async () => {
    as(emails.epineon);
    expect((await list({ q: `quinn${TAG}@qaegis.test` })).items).toEqual([]);
    expect((await list({ q: `member${TAG}@epiwell.test` })).items).toEqual([]);
    as(emails.qaegis);
    expect((await list({ q: `demo${TAG}@epineon.test` })).items).toEqual([]);
    as(SUPER);
    expect((await list({ q: `quinn${TAG}@qaegis.test` })).items).toHaveLength(1);
  });

  test('asking for another website explicitly is a 403 (list, filter and statistics)', async () => {
    as(emails.epineon);
    expect(await fail(api.submissions.list({ application: 'qaegis' }))).toMatchObject({ status: 403, message: 'You do not have access to this application' });
    expect((await fail(api.submissions.list({ application: ['epineon', 'epiwell'] }))).status).toBe(403);
    expect((await fail(api.stats({ application: 'epiwell' }))).status).toBe(403);
    as(emails.qaegis);
    expect((await fail(api.submissions.list({ application: 'epineon' }))).status).toBe(403);
    as(emails.epiwell);
    expect((await fail(api.stats({ application: 'qaegis' }))).status).toBe(403);
  });

  test('another website\'s submission cannot be read, changed or deleted — and is left untouched', async () => {
    const attempts = [
      [emails.epineon, 'contact-sales'], [emails.epineon, 'waitlist'],
      [emails.qaegis, 'demo'], [emails.qaegis, 'waitlist'],
      [emails.epiwell, 'sales'], [emails.epiwell, 'contact-sales'],
    ];
    for (const [who, formType] of attempts) {
      const [site, , id] = itemUrl(formType);
      as(who);
      expect(await fail(api.submissions.get(site, formType, id)), `${who} read ${formType}`).toMatchObject({ status: 403 });
      expect((await fail(api.submissions.update(site, formType, id, { status: 'closed' }))).status).toBe(403);
      expect((await fail(api.submissions.remove(site, formType, id))).status).toBe(403);
    }
    as(SUPER);
    for (const formType of ['contact-sales', 'waitlist', 'demo', 'sales']) {
      const item = await api.submissions.get(...itemUrl(formType));
      expect(item.status).toBe('new');
    }
  });

  test('an ID is only found under its own website AND form', async () => {
    as(emails.epineon);
    const [, , salesId] = itemUrl('sales');
    expect((await fail(api.submissions.get('epineon', 'demo', salesId))).status).toBe(404);
    expect((await fail(api.submissions.update('epineon', 'partnerships', salesId, { status: 'closed' }))).status).toBe(404);
    expect((await fail(api.submissions.get('epineon', 'contact-sales', salesId))).status).toBe(404);
    expect((await fail(api.submissions.get('acme', 'demo', salesId))).status).toBe(404);
    expect((await api.submissions.get('epineon', 'sales', salesId)).data.useCase).toBe('Other');
  });

  test('statistics cover only the admin\'s own website(s)', async () => {
    as(emails.epineon);
    const own = await api.stats({ days: 7 });
    expect(Object.keys(own.applications)).toEqual(['epineon']);
    expect(Object.keys(own.applications.epineon.byFormType)).toEqual(['demo', 'sales', 'partnerships']);
    expect(own.combined.total).toBe(own.applications.epineon.total);
    as(emails.multi);
    expect(Object.keys((await api.stats()).applications)).toEqual(['epineon', 'epiwell']);
  });

  test('a two-website admin sees exactly those two websites', async () => {
    as(emails.multi);
    const { items } = await list();
    expect(new Set(items.map((i) => i.application))).toEqual(new Set(['epineon', 'epiwell']));
    expect((await fail(api.submissions.get(...itemUrl('contact-sales')))).status).toBe(403);
  });

  test('administrator management and the audit log are Super Admin only', async () => {
    for (const who of [emails.epineon, emails.qaegis, emails.epiwell, emails.multi]) {
      as(who);
      expect((await fail(api.users.list())).status).toBe(403);
      expect((await fail(api.audit.list({}))).status).toBe(403);
      expect((await fail(api.users.create({ email: `x.${TAG}@y.test`, isSuperAdmin: true }))).status).toBe(403);
    }
  });

  test('PRIVILEGE ESCALATION: an admin cannot promote themselves or add websites', async () => {
    as(SUPER);
    const target = (await api.users.list()).items.find((u) => u.email === emails.epineon);
    as(emails.epineon);
    expect((await fail(api.users.update(target.id, { isSuperAdmin: true, applications: ['epineon', 'qaegis', 'epiwell'] }))).status).toBe(403);
    expect((await api.me()).applications.map((a) => a.slug)).toEqual(['epineon']);
  });
});

// ============================================================ managing items

describe('managing submissions through the dashboard client', () => {
  test('status changes and read tracking are stored and listed', async () => {
    as(emails.epineon);
    const [site, formType, id] = itemUrl('partnerships');
    const updated = await api.submissions.update(site, formType, id, { status: 'in_progress', read: true });
    expect(updated).toMatchObject({ status: 'in_progress', isRead: true });
    expect(updated.statusChangedBy).toBeTruthy();
    expect(updated.readBy).toBe(updated.statusChangedBy);
    expect(updated.data).toEqual(FORMS.partnerships.fields(TAG));

    const filtered = await list({ status: 'in_progress', q: TAG });
    expect(filtered.items.map((i) => i.submissionId)).toEqual([id]);

    const unread = await api.submissions.update(site, formType, id, { read: false });
    expect(unread).toMatchObject({ isRead: false, readAt: null, readBy: null, status: 'in_progress' });
  });

  test('invalid changes are refused with details', async () => {
    as(SUPER);
    const [site, formType, id] = itemUrl('demo');
    const badStatus = await fail(api.submissions.update(site, formType, id, { status: 'deleted' }));
    expect(badStatus).toMatchObject({ status: 400 });
    expect(badStatus.fieldErrors.status).toBeTruthy();
    const mass = await fail(api.submissions.update(site, formType, id, { status: 'closed', data: { name: 'Hacked' }, submissionId: 'x' }));
    expect(mass.details.map((d) => d.code)).toEqual(['unexpected_field', 'unexpected_field']);
    expect((await api.submissions.get(site, formType, id)).data.name).toBe(FORMS.demo.fields(TAG).name);
  });

  test('deleting removes the submission for good and is recorded in the audit log without personal data', async () => {
    const created = await submitForm('epineon', 'sales', { ...FORMS.sales.fields(`${TAG}del`), name: `Delete Target ${TAG}` }, { ip: nextIp() });
    const id = created.body.data.submissionId;
    as(emails.epineon);
    await expect(api.submissions.remove('epineon', 'sales', id)).resolves.toBeNull();
    expect((await fail(api.submissions.get('epineon', 'sales', id))).status).toBe(404);
    expect((await fail(api.submissions.remove('epineon', 'sales', id))).status).toBe(404);
    expect((await list({ q: `Delete Target ${TAG}` })).items).toEqual([]);

    as(SUPER);
    const audit = await api.audit.list({ action: 'submission.deleted', pageSize: 100 });
    const entry = audit.items.find((i) => i.submissionId === id);
    expect(entry).toMatchObject({ application: 'epineon', formType: 'sales', actorEmail: emails.epineon, details: { formType: 'sales', status: 'new' } });
    expect(JSON.stringify(entry)).not.toContain('Delete Target');
    expect(JSON.stringify(entry)).not.toContain(`sales${TAG}del@epineon.test`);
  });

  test('the audit log records status changes with their form, newest first, and can be filtered', async () => {
    as(SUPER);
    const all = await api.audit.list({ pageSize: 100 });
    const times = all.items.map((i) => Date.parse(i.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const changes = await api.audit.list({ action: 'submission.status_changed', application: 'epineon', pageSize: 100 });
    expect(changes.items.some((i) => i.formType === 'partnerships' && i.details.to === 'in_progress')).toBe(true);
    expect(changes.items.every((i) => i.application === 'epineon')).toBe(true);
    const text = JSON.stringify(all.items);
    for (const personal of [`demo${TAG}@epineon.test`, `quinn${TAG}@qaegis.test`, 'Pricing please', 'Need SSO']) expect(text).not.toContain(personal);
  });
});

// ============================================== lists: search, filter, paging

describe('lists against the real database', () => {
  const LIST_TAG = `${TAG}L`;
  beforeAll(async () => {
    for (let i = 0; i < 7; i++) {
      const r = await submitForm('epiwell', 'waitlist', { email: `page${i}.${LIST_TAG}@epiwell.test` }, { ip: nextIp() });
      expect(r.status).toBe(201);
    }
  });

  test('pagination: pages are complete, disjoint and consistent', async () => {
    as(SUPER);
    const seen = [];
    for (let page = 1; page <= 3; page++) {
      const result = await api.submissions.list({ q: LIST_TAG, pageSize: 3, page, sort: 'receivedAt', dir: 'asc' });
      expect(result.pagination).toEqual({ page, pageSize: 3, total: 7, totalPages: 3 });
      expect(result.items).toHaveLength(page < 3 ? 3 : 1);
      seen.push(...result.items.map((i) => i.submissionId));
    }
    expect(new Set(seen).size).toBe(7);
    const beyond = await api.submissions.list({ q: LIST_TAG, pageSize: 3, page: 9 });
    expect(beyond.items).toEqual([]);
    expect(beyond.pagination.total).toBe(7);
  });

  test('sorting works in both directions', async () => {
    as(SUPER);
    const asc = (await list({ q: LIST_TAG, sort: 'receivedAt', dir: 'asc' })).items.map((i) => i.data.email);
    const desc = (await list({ q: LIST_TAG, sort: 'receivedAt', dir: 'desc' })).items.map((i) => i.data.email);
    expect(desc).toEqual([...asc].reverse());
    expect(asc[0]).toBe(`page0.${LIST_TAG.toLowerCase()}@epiwell.test`); // the server stores emails lower-cased
  });

  test('filters by form, website, status and read state, and combines them', async () => {
    as(SUPER);
    const one = (await list({ q: LIST_TAG })).items[0];
    await api.submissions.update(one.application, one.formType, one.submissionId, { status: 'replied', read: true });
    expect((await list({ q: LIST_TAG, status: 'replied' })).items.map((i) => i.submissionId)).toEqual([one.submissionId]);
    expect((await list({ q: LIST_TAG, unread: true })).pagination.total).toBe(6);
    expect((await list({ q: LIST_TAG, unread: false })).pagination.total).toBe(1);
    expect((await list({ q: LIST_TAG, formType: 'waitlist', application: 'epiwell', unread: true, status: 'new' })).pagination.total).toBe(6);
    expect((await list({ q: LIST_TAG, formType: 'demo' })).items).toEqual([]);
    expect((await list({ q: LIST_TAG, application: ['epineon', 'qaegis'] })).items).toEqual([]);
  });

  test('date range: "to" is exclusive, so the picker\'s inclusive day needs the next day', async () => {
    as(SUPER);
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await list({ q: LIST_TAG, from: today, to: tomorrow })).pagination.total).toBe(7);
    expect((await list({ q: LIST_TAG, to: today })).pagination.total).toBe(0);
    expect((await list({ q: LIST_TAG, from: tomorrow })).pagination.total).toBe(0);
  });

  test('search is case-insensitive, matches values only, and treats % and _ literally', async () => {
    as(SUPER);
    expect((await list({ q: LIST_TAG.toUpperCase() })).pagination.total).toBe(7);
    expect((await list({ q: 'email' })).items.filter((i) => i.formType === 'waitlist' && JSON.stringify(i.data).includes('"email"') && !i.data.email.includes('email'))).toEqual([]);
    expect((await list({ q: '%' })).items).toEqual([]);
    expect((await list({ q: '_' })).items).toEqual([]);
    const target = (await list({ q: LIST_TAG })).items[0];
    expect((await list({ q: target.submissionId })).items.map((i) => i.submissionId)).toEqual([target.submissionId]);
  });

  test('invalid parameters are rejected by the server with a clear error', async () => {
    as(SUPER);
    const bad = [{ pageSize: 101 }, { page: 0 }, { sort: 'data' }, { status: 'bogus' }, { from: 'yesterday' }, { formType: 'newsletter' }];
    for (const params of bad) {
      const error = await fail(api.submissions.list(params));
      expect(error, JSON.stringify(params)).toMatchObject({ status: 400, message: 'Invalid query parameters' });
      expect(error.details.length).toBeGreaterThan(0);
    }
  });
});

// ================================================================ statistics

describe('statistics', () => {
  test('combined numbers equal the sum of the websites, with a zero-filled daily series', async () => {
    as(SUPER);
    const stats = await api.stats({ days: 14 });
    const apps = Object.values(stats.applications);
    expect(stats.combined.total).toBe(apps.reduce((a, x) => a + x.total, 0));
    expect(stats.combined.unread).toBe(apps.reduce((a, x) => a + x.unread, 0));
    expect(Object.values(stats.combined.byStatus).reduce((a, b) => a + b, 0)).toBe(stats.combined.total);
    expect(stats.combined.daily).toHaveLength(14);
    expect(stats.combined.daily.at(-1).date).toBe(new Date().toISOString().slice(0, 10));
    expect(stats.combined.daily.reduce((a, d) => a + d.count, 0)).toBe(stats.combined.receivedInPeriod);
    expect(stats.applications.epineon.byFormType.sales).toBeGreaterThanOrEqual(1);
    expect(stats.applications.epiwell.byFormType.waitlist).toBeGreaterThanOrEqual(8);
    expect(await fail(api.stats({ days: 0 }))).toMatchObject({ status: 400 });
  });
});

// ============================================================ team management

describe('team management through the client', () => {
  test('creates, edits and lists administrators; the server\'s field errors come back usable', async () => {
    as(SUPER);
    const email = `team.${TAG}@admin.test`;
    const created = await api.users.create({ email: email.toUpperCase(), displayName: 'Team Test', applications: ['qaegis'] });
    expect(created).toMatchObject({ email, displayName: 'Team Test', isSuperAdmin: false, status: 'active', applications: ['qaegis'] });

    const duplicate = await fail(api.users.create({ email, applications: ['qaegis'] }));
    expect(duplicate).toMatchObject({ status: 409, message: 'An admin with this email already exists' });

    const invalidEmail = await fail(api.users.create({ email: 'nope', applications: ['qaegis'] }));
    expect(invalidEmail.fieldErrors.email).toBeTruthy();
    const noApps = await fail(api.users.create({ email: `n.${TAG}@admin.test` }));
    expect(noApps.fieldErrors.applications).toBeTruthy();
    const badApp = await fail(api.users.create({ email: `n.${TAG}@admin.test`, applications: ['acme'] }));
    expect(badApp.fieldErrors.applications).toBeTruthy();

    // access changes take effect immediately
    as(email);
    expect((await fail(api.submissions.get(...itemUrl('demo')))).status).toBe(403);
    as(SUPER);
    await api.users.update(created.id, { applications: ['qaegis', 'epineon'] });
    as(email);
    expect((await api.submissions.get(...itemUrl('demo'))).formType).toBe('demo');
    as(SUPER);
    expect((await api.users.list()).items.find((u) => u.id === created.id).applications).toEqual(['epineon', 'qaegis']);
  });

  test('nobody can lock themselves out', async () => {
    as(SUPER);
    const me = (await api.users.list()).items.find((u) => u.email === SUPER);
    expect(await fail(api.users.update(me.id, { status: 'disabled' }))).toMatchObject({ status: 409 });
    expect(await fail(api.users.update(me.id, { isSuperAdmin: false }))).toMatchObject({ status: 409 });
    expect((await api.me()).isSuperAdmin).toBe(true);
  });

  test('administrator changes appear in the audit log with who did them', async () => {
    as(SUPER);
    const audit = await api.audit.list({ pageSize: 100 });
    expect(audit.items.some((i) => i.action === 'admin_user.created' && i.actorEmail === SUPER)).toBe(true);
    expect(audit.items.some((i) => i.action === 'admin_user.updated')).toBe(true);
  });
});

// ================================================================ rate limits

describe('rate limiting at the public API', () => {
  test('a client that floods a form gets 429 with Retry-After; other clients are unaffected', async () => {
    const flooder = '203.0.113.99';
    const statuses = [];
    let limited;
    for (let i = 0; i < 4; i++) {
      const r = await submitForm('epineon', 'partnerships', FORMS.partnerships.fields(`${TAG}rl${i}`), { ip: flooder });
      statuses.push(r.status);
      limited = r;
    }
    expect(statuses).toEqual([201, 201, 201, 429]); // partnerships: 3 per 10 minutes
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('ratelimit-remaining')).toBe('0');
    expect(limited.body).toEqual({ status: 'error', message: 'Too many requests. Please try again later.' });

    const other = await submitForm('epineon', 'partnerships', FORMS.partnerships.fields(`${TAG}rlx`), { ip: '203.0.113.100' });
    expect(other.status).toBe(201);
    const differentForm = await submitForm('epineon', 'demo', FORMS.demo.fields(`${TAG}rly`), { ip: flooder });
    expect(differentForm.status).toBe(201);
  });

  test('the admin API is not rate limited', async () => {
    as(SUPER);
    for (let i = 0; i < 25; i++) await api.me();
  });
});

// ========================================= transport-level behaviour of the client

describe('the client against real responses', () => {
  test('error responses carry only safe messages (no stack traces or internals)', async () => {
    as(SUPER);
    const error = await fail(api.submissions.get('epineon', 'demo', 'not-a-uuid'));
    expect(error).toMatchObject({ status: 400, message: 'Invalid submission ID' });
    const ask = (path, headers = {}) => fetch(`${inject('backendUrl')}${path}`, { headers: { 'cf-connecting-ip': '203.0.113.5', ...headers } });

    // Unauthenticated: even an unknown admin path answers 401, so route existence is not revealed.
    expect((await ask('/api/v1/admin/nope')).status).toBe(401);

    const unknown = await ask('/api/v1/nope');
    const text = await unknown.text();
    expect(unknown.status).toBe(404);
    expect(text).not.toMatch(/stack|at .*\.js|node_modules/);
    expect(unknown.headers.get('cache-control')).toBe('no-store');
    expect(unknown.headers.get('x-content-type-options')).toBe('nosniff');
    expect(unknown.headers.get('x-powered-by')).toBeNull();
  });

  test('an unreachable backend is reported as a network error, not a crash', async () => {
    configureClient({ baseUrl: 'http://127.0.0.1:1', headers: {} });
    const error = await fail(api.me());
    expect(error).toMatchObject({ kind: 'network', status: 0 });
  });
});
