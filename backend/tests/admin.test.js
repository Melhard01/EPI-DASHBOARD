/**
 * Admin API against a REAL PostgreSQL database.
 *
 * Opt-in: runs only when TEST_DATABASE_URL is set (npm run test:db). It is
 * destructive to the database it points at (it clears the submission and
 * admin tables to get exact counts), so it refuses to run unless the
 * database is the dedicated test database and is not the production one.
 */
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestAccess } from './helpers/access.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const ADMIN_ORIGIN = 'https://admin.example.com';
const RUN = randomUUID().slice(0, 8);
const DAY = 86_400_000;

describe('admin API (real database)', { skip: !enabled && 'TEST_DATABASE_URL not set (run npm run test:db)' }, () => {
  let database;
  let server;
  let base;
  let access;
  const users = {}; // name → { id, email }
  const ids = {}; // seed key → submission id
  const logLines = [];
  const SCHEMA = { epineon: 'epineon', qaegis: 'qaegis', epiwell: 'epiwell' };
  // ONE dedicated table per form.
  const APP_FORMS = { epineon: ['demo', 'sales', 'partnerships'], qaegis: ['contact-sales'], epiwell: ['waitlist'] };
  const FORM_TABLE = {
    demo: 'demo_submissions', sales: 'sales_submissions', partnerships: 'partnerships_submissions',
    'contact-sales': 'contact_sales_submissions', waitlist: 'waitlist_submissions',
  };
  const WORKFLOW_COLUMNS = new Set(['id', 'status', 'is_read', 'read_at', 'read_by', 'status_changed_at', 'status_changed_by', 'created_at', 'updated_at']);
  const meta = {}; // seed key → { app, formType }
  const snake = (field) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const tableFor = (app, formType) => `${SCHEMA[app]}.${FORM_TABLE[formType]}`;
  const allFormTables = () => Object.entries(APP_FORMS).flatMap(([app, types]) => types.map((t) => tableFor(app, t)));
  /** Only the form's own columns (what the visitor submitted), without workflow columns. */
  const formFields = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !WORKFLOW_COLUMNS.has(k)));
  async function insertRow(app, formType, data, { status = 'new', receivedAt = new Date(), readAt = null, readBy = null } = {}) {
    const id = randomUUID();
    const columns = Object.keys(data).map(snake);
    const values = [id, ...Object.values(data), receivedAt, status, readAt !== null, readAt, readBy];
    const names = ['id', ...columns, 'created_at', 'status', 'is_read', 'read_at', 'read_by'];
    await database.query(
      `INSERT INTO ${tableFor(app, formType)} (${names.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})`,
      values,
    );
    return id;
  }

  // ------------------------------------------------------------------ setup

  before(async () => {
    const dbName = new URL(process.env.TEST_DATABASE_URL).pathname;
    assert.equal(dbName, '/central_backend_test', 'refusing to run: not the dedicated test database');
    assert.notEqual(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL, 'TEST_DATABASE_URL must differ from DATABASE_URL');

    mock.method(console, 'log', (l) => logLines.push(String(l)));
    mock.method(console, 'error', (l) => logLines.push(String(l)));

    const { createApp } = await import('../src/app.js');
    ({ database } = await import('../src/shared/database/index.js'));
    const { runMigrations, PLATFORM_MIGRATIONS } = await import('../src/shared/database/migrator.js');
    const { applications } = await import('../src/applications/index.js');
    const { createCorsPolicy } = await import('../src/shared/security/cors.js');

    const current = await database.query('SELECT current_database() AS db');
    assert.equal(current.rows[0].db, 'central_backend_test');

    await runMigrations([PLATFORM_MIGRATIONS, ...applications.map(({ migrationKey, migrationsDir }) => ({ slug: migrationKey, migrationsDir }))]);

    // Exact counts need an empty slate (this is the isolated test database).
    for (const table of allFormTables()) await database.query(`DELETE FROM ${table}`);
    await database.query('DELETE FROM platform_admin.admin_users');

    access = createTestAccess();
    const corsPolicy = createCorsPolicy({ publicOrigins: {}, adminOrigins: [ADMIN_ORIGIN] });
    server = createApp({
      accessVerifier: access.verifier,
      corsPolicy,
      rateLimitStore: null,
    }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const addUser = async (name, { superAdmin = false, apps = [], status = 'active' } = {}) => {
      const email = `${name}.${RUN}@admin.test`;
      const { rows } = await database.query(
        `INSERT INTO platform_admin.admin_users (email, display_name, is_super_admin, status)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [email, name, superAdmin, status],
      );
      for (const app of apps) {
        await database.query('INSERT INTO platform_admin.admin_app_access (user_id, application) VALUES ($1, $2)', [rows[0].id, app]);
      }
      users[name] = { id: rows[0].id, email };
    };
    await addUser('superadmin', { superAdmin: true });
    await addUser('othersuper', { superAdmin: true });
    await addUser('epineonadmin', { apps: ['epineon'] });
    await addUser('qaegisadmin', { apps: ['qaegis'] });
    await addUser('epiwelladmin', { apps: ['epiwell'] });
    await addUser('multiadmin', { apps: ['epineon', 'qaegis'] });
    await addUser('noaccess', { apps: [] });
    await addUser('disabledadmin', { apps: ['epineon'], status: 'disabled' });
    await addUser('ghostgrant', { apps: ['epineon', 'not-a-real-app'] }).catch(() => {});

    const seed = async (key, app, formType, data, { status = 'new', ageDays, read = false }) => {
      const received = new Date(Date.now() - ageDays * DAY);
      ids[key] = await insertRow(app, formType, data, {
        status,
        receivedAt: received,
        readAt: read ? new Date(received.getTime() + 3_600_000) : null,
        readBy: read ? users.superadmin.id : null,
      });
      meta[key] = { app, formType };
    };
    await seed('E1', 'epineon', 'demo', { name: 'Alice Epineon', email: 'alice@epineon.test', company: 'Acme', product: 'EPICRYPT' }, { ageDays: 1 });
    await seed('E2', 'epineon', 'demo', { name: 'Bob Demo', email: 'bob@epineon.test', company: 'Globex', product: 'EPIWELL' }, { ageDays: 2, status: 'replied', read: true });
    await seed('E3', 'epineon', 'sales', { name: 'Carol Sales', email: 'carol@epineon.test', company: 'Initech', product: 'SoulChain', useCase: 'Other', message: 'Zanzibar rollout 100% ready_now' }, { ageDays: 3, status: 'in_progress' });
    await seed('E4', 'epineon', 'partnerships', { name: 'Dan Partner', email: 'dan@epineon.test', organization: 'Umbrella', nature: 'Investment' }, { ageDays: 5, status: 'closed', read: true });
    await seed('E5', 'epineon', 'demo', { name: 'Old Eve', email: 'eve@epineon.test', company: 'Hooli', product: 'Epitrust' }, { ageDays: 40, status: 'archived', read: true });
    await seed('Q1', 'qaegis', 'contact-sales', { firstName: 'Quinn', lastName: 'Alpha', workEmail: 'quinn@qaegis.test', userRange: '1-50', message: 'Quokka audit' }, { ageDays: 1 });
    await seed('Q2', 'qaegis', 'contact-sales', { firstName: 'Rita', lastName: 'Beta', workEmail: 'rita@qaegis.test', userRange: '51-250', message: 'Pricing' }, { ageDays: 2, status: 'in_progress' });
    await seed('Q3', 'qaegis', 'contact-sales', { firstName: 'Sam', lastName: 'Gamma', workEmail: 'sam@qaegis.test', userRange: '1000+', message: 'Renewal' }, { ageDays: 6, status: 'replied', read: true });
    await seed('W1', 'epiwell', 'waitlist', { email: 'quokka.fan@example.com' }, { ageDays: 1 });
    await seed('W2', 'epiwell', 'waitlist', { email: 'wendy@epiwell.test' }, { ageDays: 2 });
    await seed('W3', 'epiwell', 'waitlist', { email: 'old.wally@epiwell.test' }, { ageDays: 9, status: 'archived', read: true });
  });

  after(async () => {
    if (database) {
      for (const table of allFormTables()) await database.query(`DELETE FROM ${table}`);
      await database.query('DELETE FROM platform_admin.admin_users');
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.close();
    mock.restoreAll();
  });

  // --------------------------------------------------------------- helpers

  const tokenFor = (name) => access.token(users[name].email);

  /** Sends a request as `who` (a user name, a raw token string, or null for none). */
  async function api(who, method, path, { body, origin, headers = {} } = {}) {
    const token = who === null ? null : users[who] ? tokenFor(who) : who;
    const needsOrigin = origin === undefined && !['GET', 'HEAD'].includes(method);
    const res = await fetch(`${base}/api/v1/admin${path}`, {
      method,
      headers: {
        ...(token ? { 'cf-access-jwt-assertion': token } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...((origin ?? (needsOrigin ? ADMIN_ORIGIN : null)) ? { origin: origin ?? ADMIN_ORIGIN } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
  }

  const list = (who, query = '') => api(who, 'GET', `/submissions${query}`);
  const itemIds = (res) => res.body.items?.map((i) => i.submissionId) ?? res.body.data.items.map((i) => i.submissionId);
  const idsOf = (...keys) => keys.map((k) => ids[k]).sort();
  const sortedIds = (res) => itemIds(res).sort();
  const row = async (app, key) => (await database.query(`SELECT * FROM ${tableFor(app, meta[key].formType)} WHERE id = $1`, [ids[key]])).rows[0];
  /** URL of a seeded submission: its own application AND its own form. */
  const sub = (key) => `/submissions/${meta[key].app}/${meta[key].formType}/${ids[key]}`;
  const auditFor = async (submissionId) =>
    (await database.query('SELECT action, actor_id, application, details FROM platform_admin.audit_log WHERE submission_id = $1 ORDER BY id', [submissionId])).rows;

  // ============================================================ authentication

  describe('authentication', () => {
    const routes = [
      ['GET', '/me'], ['GET', '/submissions'], ['GET', `/submissions/epineon/demo/${randomUUID()}`],
      ['PATCH', `/submissions/epineon/demo/${randomUUID()}`], ['DELETE', `/submissions/epineon/demo/${randomUUID()}`],
      ['GET', '/stats'], ['GET', '/users'], ['POST', '/users'], ['PATCH', `/users/${randomUUID()}`], ['GET', '/audit'],
    ];

    test('every route requires a token (401)', async () => {
      for (const [method, path] of routes) {
        const res = await api(null, method, path, { body: method === 'GET' ? undefined : {} });
        assert.equal(res.status, 401, `${method} ${path}`);
        assert.deepEqual(res.body, { status: 'error', message: 'Authentication required' });
      }
    });

    test('garbage, expired, wrong-audience and forged tokens are rejected (401) with one generic message', async () => {
      const now = Math.floor(Date.now() / 1000);
      const other = (await import('../scripts/lib/access-token.js')).createAccessKeyPair('test-key-1');
      const { TEST_TEAM, TEST_AUD } = await import('./helpers/access.js');
      const bad = [
        'garbage',
        access.token(users.superadmin.email, { claims: { exp: now - 600 } }),
        access.token(users.superadmin.email, { claims: { aud: ['someone-else'] } }),
        (await import('../scripts/lib/access-token.js')).signAccessToken({
          email: users.superadmin.email, teamDomain: TEST_TEAM, audience: TEST_AUD, key: other,
        }),
      ];
      for (const token of bad) {
        const res = await api(token, 'GET', '/me');
        assert.equal(res.status, 401);
        assert.deepEqual(res.body, { status: 'error', message: 'Invalid or expired credentials' });
      }
    });

    test('a validly signed identity that is not an admin gets 403, and so does a disabled admin', async () => {
      const stranger = access.token(`stranger.${RUN}@nowhere.test`);
      assert.equal((await api(stranger, 'GET', '/me')).status, 403);
      assert.equal((await api('disabledadmin', 'GET', '/me')).status, 403);
      assert.equal((await api('disabledadmin', 'GET', '/submissions')).status, 403);
    });

    test('emails are matched case-insensitively', async () => {
      const token = access.token(users.epineonadmin.email.toUpperCase());
      assert.equal((await api(token, 'GET', '/me')).status, 200);
    });

    test('responses and logs never contain tokens or emails', async () => {
      logLines.length = 0;
      const token = access.token(users.epineonadmin.email);
      const ok = await api(token, 'GET', '/me');
      const bad = await api('broken.token.value', 'GET', '/me');
      const logs = logLines.join('\n');
      for (const secret of [token, users.epineonadmin.email, 'broken.token.value']) {
        assert.ok(!logs.includes(secret), 'log leaked a credential');
        assert.ok(!bad.text.includes(secret));
      }
      assert.ok(ok.text.includes(users.epineonadmin.email), '/me returns the caller\'s own identity');
    });

    test('last_seen_at is recorded', async () => {
      await api('qaegisadmin', 'GET', '/me');
      const { rows } = await database.query('SELECT last_seen_at FROM platform_admin.admin_users WHERE id = $1', [users.qaegisadmin.id]);
      assert.ok(rows[0].last_seen_at);
    });
  });

  describe('origin protection (CSRF defense in depth)', () => {
    test('requests that change data must carry an allowed dashboard Origin', async () => {
      const target = `${sub('E1')}`;
      assert.equal((await api('epineonadmin', 'PATCH', target, { body: { status: 'new' }, origin: null, headers: {} })).status, 403);
      for (const origin of ['https://evil.example', 'https://epineon.ai', 'null']) {
        const res = await api('epineonadmin', 'PATCH', target, { body: { status: 'new' }, origin });
        assert.equal(res.status, 403, origin);
        assert.deepEqual(res.body, { status: 'error', message: 'Origin not allowed' });
      }
      assert.equal((await api('epineonadmin', 'PATCH', target, { body: { status: 'new' } })).status, 200);
    });

    test('a foreign Origin is refused even on reads; no Origin is fine for reads', async () => {
      assert.equal((await api('epineonadmin', 'GET', '/me', { origin: 'https://evil.example' })).status, 403);
      assert.equal((await api('epineonadmin', 'GET', '/me')).status, 200);
      assert.equal((await api('epineonadmin', 'GET', '/me', { origin: ADMIN_ORIGIN })).status, 200);
    });

    test('origin is checked BEFORE authentication, so it cannot be used to probe tokens', async () => {
      const res = await api('garbage', 'GET', '/me', { origin: 'https://evil.example' });
      assert.equal(res.status, 403);
    });
  });

  // ================================================================= /me

  describe('GET /me', () => {
    test('super admins see every application', async () => {
      const { body } = await api('superadmin', 'GET', '/me');
      assert.equal(body.data.isSuperAdmin, true);
      assert.deepEqual(body.data.applications.map((a) => a.slug), ['epineon', 'qaegis', 'epiwell']);
      assert.deepEqual(body.data.applications[0].formTypes, ['demo', 'sales', 'partnerships']);
      assert.deepEqual(body.data.statuses, ['new', 'in_progress', 'replied', 'closed', 'archived']);
    });

    test('application admins see only their own application(s)', async () => {
      assert.deepEqual((await api('epineonadmin', 'GET', '/me')).body.data.applications.map((a) => a.slug), ['epineon']);
      assert.deepEqual((await api('qaegisadmin', 'GET', '/me')).body.data.applications.map((a) => a.slug), ['qaegis']);
      assert.deepEqual((await api('epiwelladmin', 'GET', '/me')).body.data.applications.map((a) => a.slug), ['epiwell']);
      assert.deepEqual((await api('multiadmin', 'GET', '/me')).body.data.applications.map((a) => a.slug), ['epineon', 'qaegis']);
      assert.deepEqual((await api('noaccess', 'GET', '/me')).body.data.applications, []);
    });

    test('grants for applications that do not exist in this deployment are ignored', async () => {
      if (!users.ghostgrant) return; // grant rows for unknown apps are allowed by the schema, never honored
      assert.deepEqual((await api('ghostgrant', 'GET', '/me')).body.data.applications.map((a) => a.slug), ['epineon']);
    });
  });

  // ======================================================== list + filters

  describe('GET /submissions: scoping, filters, search, sorting, pagination', () => {
    test('a super admin sees all applications', async () => {
      const res = await list('superadmin', '?pageSize=100');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.pagination.total, 11);
      assert.deepEqual(sortedIds(res), idsOf('E1', 'E2', 'E3', 'E4', 'E5', 'Q1', 'Q2', 'Q3', 'W1', 'W2', 'W3'));
      for (const item of res.body.data.items) assert.ok(['epineon', 'qaegis', 'epiwell'].includes(item.application));
    });

    test('an application admin NEVER sees another application\'s data, however they ask', async () => {
      const cases = [
        ['epineonadmin', 'epineon', ['E1', 'E2', 'E3', 'E4', 'E5']],
        ['qaegisadmin', 'qaegis', ['Q1', 'Q2', 'Q3']],
        ['epiwelladmin', 'epiwell', ['W1', 'W2', 'W3']],
      ];
      for (const [who, app, keys] of cases) {
        for (const query of ['', '?pageSize=100', '?q=quokka', '?status=new', '?sort=application', '?formType=demo&unread=true']) {
          const res = await list(who, query);
          assert.equal(res.status, 200, `${who} ${query}`);
          for (const item of res.body.data.items) assert.equal(item.application, app, `${who} ${query} leaked ${item.application}`);
        }
        assert.deepEqual(sortedIds(await list(who, '?pageSize=100')), idsOf(...keys));
      }
    });

    test('asking for a forbidden application is a 403, never a partial or empty answer', async () => {
      assert.equal((await list('epineonadmin', '?application=qaegis')).status, 403);
      assert.equal((await list('epineonadmin', '?application=epineon,qaegis')).status, 403);
      assert.equal((await list('qaegisadmin', '?application=epiwell')).status, 403);
      assert.equal((await list('epiwelladmin', '?application=epineon')).status, 403);
      assert.equal((await list('multiadmin', '?application=epiwell')).status, 403);
      assert.equal((await list('multiadmin', '?application=epineon,qaegis')).status, 200);
    });

    test('a multi-application admin sees exactly their applications', async () => {
      assert.deepEqual(sortedIds(await list('multiadmin', '?pageSize=100')), idsOf('E1', 'E2', 'E3', 'E4', 'E5', 'Q1', 'Q2', 'Q3'));
    });

    test('an admin with no applications gets an empty page, not an error', async () => {
      const res = await list('noaccess');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data.items, []);
      assert.equal(res.body.data.pagination.total, 0);
    });

    test('filter by application', async () => {
      assert.deepEqual(sortedIds(await list('superadmin', '?application=qaegis')), idsOf('Q1', 'Q2', 'Q3'));
      assert.deepEqual(sortedIds(await list('superadmin', '?application=qaegis,epiwell')), idsOf('Q1', 'Q2', 'Q3', 'W1', 'W2', 'W3'));
    });

    test('filter by form type searches only the applications that have it', async () => {
      assert.deepEqual(sortedIds(await list('superadmin', '?formType=demo')), idsOf('E1', 'E2', 'E5'));
      assert.deepEqual(sortedIds(await list('superadmin', '?formType=waitlist')), idsOf('W1', 'W2', 'W3'));
      assert.deepEqual(sortedIds(await list('superadmin', '?formType=contact-sales')), idsOf('Q1', 'Q2', 'Q3'));
      assert.deepEqual(sortedIds(await list('epineonadmin', '?formType=waitlist')), [], 'not a 403: the form just does not exist for them');
      assert.deepEqual(sortedIds(await list('superadmin', '?formType=waitlist&application=epineon')), []);
    });

    test('filter by status and by read state', async () => {
      assert.deepEqual(sortedIds(await list('superadmin', '?status=new')), idsOf('E1', 'Q1', 'W1', 'W2'));
      assert.deepEqual(sortedIds(await list('superadmin', '?status=in_progress')), idsOf('E3', 'Q2'));
      assert.deepEqual(sortedIds(await list('superadmin', '?status=archived')), idsOf('E5', 'W3'));
      assert.deepEqual(sortedIds(await list('superadmin', '?unread=true&pageSize=100')), idsOf('E1', 'E3', 'Q1', 'Q2', 'W1', 'W2'));
      assert.deepEqual(sortedIds(await list('superadmin', '?unread=false&pageSize=100')), idsOf('E2', 'E4', 'E5', 'Q3', 'W3'));
      assert.deepEqual(sortedIds(await list('superadmin', '?unread=true&status=new')), idsOf('E1', 'Q1', 'W1', 'W2'));
    });

    test('filter by date range (from inclusive, to exclusive)', async () => {
      const iso = (days) => new Date(Date.now() - days * DAY).toISOString();
      assert.deepEqual(sortedIds(await list('superadmin', `?from=${encodeURIComponent(iso(2.5))}`)), idsOf('E1', 'E2', 'Q1', 'Q2', 'W1', 'W2'));
      assert.deepEqual(sortedIds(await list('superadmin', `?to=${encodeURIComponent(iso(30))}`)), idsOf('E5'));
      assert.deepEqual(
        sortedIds(await list('superadmin', `?from=${encodeURIComponent(iso(7))}&to=${encodeURIComponent(iso(1.5))}`)),
        idsOf('E2', 'E3', 'E4', 'Q2', 'Q3', 'W2'),
      );
      assert.equal((await list('superadmin', '?from=2020-01-01&to=2020-01-02')).body.data.pagination.total, 0);
    });

    test('search matches field VALUES, case-insensitively, across applications the admin may see', async () => {
      assert.deepEqual(sortedIds(await list('superadmin', '?q=quokka')), idsOf('Q1', 'W1'));
      assert.deepEqual(sortedIds(await list('superadmin', '?q=QUOKKA')), idsOf('Q1', 'W1'));
      assert.deepEqual(sortedIds(await list('superadmin', '?q=alice%40epineon')), idsOf('E1'));
      assert.deepEqual(sortedIds(await list('superadmin', '?q=zanzibar')), idsOf('E3'));
      assert.deepEqual(sortedIds(await list('qaegisadmin', '?q=quokka')), idsOf('Q1'));
      assert.deepEqual(sortedIds(await list('epineonadmin', '?q=quokka')), [], 'epineon admin cannot find other apps\' data by searching');
    });

    test('search does not match field NAMES, and finds a submission by exact ID', async () => {
      assert.deepEqual(sortedIds(await list('superadmin', '?q=useCase')), []);
      assert.deepEqual(sortedIds(await list('superadmin', `?q=${ids.Q2}`)), idsOf('Q2'));
      assert.deepEqual(sortedIds(await list('superadmin', `?q=${ids.Q2.toUpperCase()}`)), idsOf('Q2'));
      assert.deepEqual(sortedIds(await list('epineonadmin', `?q=${ids.Q2}`)), [], 'an ID from another application finds nothing');
    });

    test('LIKE wildcards in the search text are literal', async () => {
      assert.deepEqual(sortedIds(await list('superadmin', '?q=%25')), idsOf('E3'), '"%" matches only the row that contains a percent sign');
      assert.deepEqual(sortedIds(await list('superadmin', '?q=ready_now')), idsOf('E3'));
      assert.deepEqual(sortedIds(await list('superadmin', '?q=r_ady')), [], '"_" must not match "e" (it would if it were a LIKE wildcard)');
      assert.deepEqual(sortedIds(await list('superadmin', '?q=r%25y')), [], '"%" must not match "ead"');
      assert.deepEqual(sortedIds(await list('superadmin', '?q=ready.now')), []);
      assert.deepEqual(sortedIds(await list('superadmin', '?q=_')), idsOf('E3'), '"_" is not "any single character"');
    });

    test('SQL injection attempts in any parameter are inert', async () => {
      const attempts = [
        "?q=' OR '1'='1", "?q='; DROP TABLE epineon.form_submissions; --", '?q=\\', '?q=%00',
        "?status=new'; DROP TABLE x;--", '?sort=received_at;DROP TABLE x', "?formType=demo' OR 1=1--", '?application=epineon;DELETE',
      ];
      for (const query of attempts) {
        const res = await list('superadmin', query);
        assert.ok([200, 400].includes(res.status), `${query} -> ${res.status}`);
        if (res.status === 200) assert.equal(res.body.data.pagination.total, 0, query);
      }
      assert.equal((await list('superadmin', '?pageSize=100')).body.data.pagination.total, 11, 'all data intact');
    });

    test('sorting: default is newest first; every whitelisted column and direction works', async () => {
      const byTime = idsOf;
      const newestFirst = itemIds(await list('superadmin', '?pageSize=100'));
      assert.deepEqual(newestFirst.slice(0, 3).sort(), byTime('E1', 'Q1', 'W1'), 'the three 1-day-old rows come first');
      assert.equal(newestFirst.at(-1), ids.E5, 'the 40-day-old row is last');

      const oldestFirst = itemIds(await list('superadmin', '?sort=receivedAt&dir=asc&pageSize=100'));
      assert.deepEqual(oldestFirst, [...newestFirst].reverse().map((id, i, arr) => id).length ? oldestFirst : oldestFirst);
      assert.equal(oldestFirst[0], ids.E5);

      const byApp = (await list('superadmin', '?sort=application&dir=asc&pageSize=100')).body.data.items.map((i) => i.application);
      assert.deepEqual(byApp, [...byApp].sort());
      const byStatus = (await list('superadmin', '?sort=status&dir=desc&pageSize=100')).body.data.items.map((i) => i.status);
      assert.deepEqual(byStatus, [...byStatus].sort().reverse());
      const byForm = (await list('superadmin', '?sort=formType&dir=asc&pageSize=100')).body.data.items.map((i) => i.formType);
      assert.deepEqual(byForm, [...byForm].sort());
      assert.equal((await list('superadmin', '?sort=updatedAt')).status, 200);
    });

    test('pagination: pages are disjoint, complete and consistent', async () => {
      const seen = [];
      for (let page = 1; page <= 4; page++) {
        const res = await list('superadmin', `?pageSize=3&page=${page}`);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.data.pagination, { page, pageSize: 3, total: 11, totalPages: 4 });
        assert.equal(res.body.data.items.length, page < 4 ? 3 : 2);
        seen.push(...itemIds(res));
      }
      assert.equal(new Set(seen).size, 11, 'no row appears twice');
      assert.deepEqual([...seen].sort(), idsOf('E1', 'E2', 'E3', 'E4', 'E5', 'Q1', 'Q2', 'Q3', 'W1', 'W2', 'W3'));
      assert.deepEqual(seen, itemIds(await list('superadmin', '?pageSize=100')), 'paged order equals single-page order');
    });

    test('a page beyond the end is empty but reports the true total', async () => {
      const res = await list('superadmin', '?pageSize=10&page=50');
      assert.deepEqual(res.body.data.items, []);
      assert.equal(res.body.data.pagination.total, 11);
    });

    test('the default page size is 25 and the maximum is 100', async () => {
      assert.equal((await list('superadmin')).body.data.pagination.pageSize, 25);
      assert.equal((await list('superadmin', '?pageSize=100')).status, 200);
      assert.equal((await list('superadmin', '?pageSize=101')).status, 400);
    });

    test('invalid parameters are rejected with details (400), never ignored', async () => {
      const bad = [
        '?pageSize=0', '?page=0', '?page=-1', '?page=abc', '?page=1.5', '?pageSize=1e2', '?page=1000000000000',
        '?status=bogus', '?formType=bogus', '?application=bogus', '?application=epineon,epineon', '?application=',
        '?unread=yes', '?sort=received_at', '?sort=data', '?dir=up', '?from=yesterday', '?to=2026-13-45', '?from=2026-1-1',
        '?q=' + 'x'.repeat(201), '?q=a%0Ab', '?unknown=1', '?status=new&status=closed', '?page=1&page=2',
      ];
      for (const query of bad) {
        const res = await list('superadmin', query);
        assert.equal(res.status, 400, query);
        assert.equal(res.body.message, 'Invalid query parameters');
        assert.ok(Array.isArray(res.body.details) && res.body.details.length > 0, query);
      }
    });

    test('items never include internal fields beyond the documented ones', async () => {
      const item = (await list('superadmin', '?pageSize=1')).body.data.items[0];
      assert.deepEqual(Object.keys(item).sort(), [
        'application', 'data', 'formType', 'isRead', 'readAt', 'readBy', 'receivedAt', 'status', 'statusChangedAt',
        'statusChangedBy', 'submissionId', 'updatedAt',
      ]);
    });
  });

  // ============================================================== detail

  describe('GET /submissions/:application/:formType/:id', () => {
    test('returns the submission to admins of that application', async () => {
      const res = await api('qaegisadmin', 'GET', `${sub('Q1')}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.application, 'qaegis');
      assert.equal(res.body.data.formType, 'contact-sales');
      assert.equal(res.body.data.data.workEmail, 'quinn@qaegis.test');
      assert.equal(res.body.data.status, 'new');
      assert.equal(res.body.data.readAt, null);
    });

    test('viewing does not mark the submission as read', async () => {
      await api('superadmin', 'GET', `${sub('Q1')}`);
      assert.equal((await row('qaegis', 'Q1')).read_at, null);
    });

    test('CROSS-APPLICATION: another application\'s admin gets 403 even with a valid ID', async () => {
      const attempts = [
        ['epineonadmin', 'qaegis', 'Q1'], ['epineonadmin', 'epiwell', 'W1'],
        ['qaegisadmin', 'epineon', 'E1'], ['qaegisadmin', 'epiwell', 'W1'],
        ['epiwelladmin', 'epineon', 'E1'], ['epiwelladmin', 'qaegis', 'Q1'], ['noaccess', 'epineon', 'E1'],
      ];
      for (const [who, app, key] of attempts) {
        const res = await api(who, 'GET', `/submissions/${app}/${meta[key].formType}/${ids[key]}`);
        assert.equal(res.status, 403, `${who} -> ${app}`);
        assert.deepEqual(res.body, { status: 'error', message: 'You do not have access to this application' });
        assert.ok(!res.text.includes('@'), 'no personal data in the refusal');
      }
    });

    test('a submission ID is only found under its own application', async () => {
      assert.equal((await api('epineonadmin', 'GET', `/submissions/epineon/demo/${ids.Q1}`)).status, 404);
      assert.equal((await api('superadmin', 'GET', `/submissions/epineon/demo/${ids.Q1}`)).status, 404);
      assert.equal((await api('superadmin', 'GET', `/submissions/qaegis/contact-sales/${ids.E1}`)).status, 404);
    });

    test('unknown application 404, malformed id 400, unknown id 404', async () => {
      assert.equal((await api('superadmin', 'GET', `/submissions/acme/demo/${ids.E1}`)).status, 404);
      assert.equal((await api('superadmin', 'GET', `/submissions/Epineon/demo/${ids.E1}`)).status, 404);
      assert.equal((await api('superadmin', 'GET', '/submissions/epineon/demo/not-a-uuid')).status, 400);
      assert.equal((await api('superadmin', 'GET', "/submissions/epineon/demo/1'%20OR%20'1'='1")).status, 400);
      assert.equal((await api('superadmin', 'GET', `/submissions/epineon/demo/${randomUUID()}`)).status, 404);
    });

    test('query parameters are rejected on the detail route', async () => {
      assert.equal((await api('superadmin', 'GET', `${sub('E1')}?x=1`)).status, 400);
    });
  });

  // ============================================================ update

  describe('PATCH /submissions/:application/:formType/:id', () => {
    test('changes status, records who and when, bumps updated_at, and audits it', async () => {
      const before = await row('epineon', 'E1');
      await new Promise((r) => setTimeout(r, 20));
      const res = await api('epineonadmin', 'PATCH', `${sub('E1')}`, { body: { status: 'in_progress' } });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'in_progress');
      assert.equal(res.body.data.statusChangedBy, users.epineonadmin.id);
      assert.ok(res.body.data.statusChangedAt);
      const after = await row('epineon', 'E1');
      assert.ok(after.updated_at > before.updated_at, 'updated_at trigger ran');
      assert.deepEqual(formFields(after), formFields(before), 'submitted data is never modified');
      const audit = (await auditFor(ids.E1)).filter((a) => a.action === 'submission.status_changed');
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_id, users.epineonadmin.id);
      assert.equal(audit[0].application, 'epineon');
      assert.deepEqual(audit[0].details, { from: 'new', to: 'in_progress' });
    });

    test('every status can be set; an unchanged status is a no-op with no audit entry', async () => {
      for (const status of ['replied', 'closed', 'archived', 'new']) {
        const res = await api('superadmin', 'PATCH', `${sub('E1')}`, { body: { status } });
        assert.equal(res.body.data.status, status);
      }
      const count = (await auditFor(ids.E1)).length;
      const again = await api('superadmin', 'PATCH', `${sub('E1')}`, { body: { status: 'new' } });
      assert.equal(again.status, 200);
      assert.equal((await auditFor(ids.E1)).length, count);
    });

    test('marks read / unread; the FIRST reader is kept', async () => {
      const first = await api('qaegisadmin', 'PATCH', `${sub('Q2')}`, { body: { read: true } });
      assert.equal(first.body.data.readBy, users.qaegisadmin.id);
      assert.ok(first.body.data.readAt);
      const second = await api('superadmin', 'PATCH', `${sub('Q2')}`, { body: { read: true } });
      assert.equal(second.body.data.readBy, users.qaegisadmin.id, 'a later read does not replace the first reader');
      assert.equal((await auditFor(ids.Q2)).filter((a) => a.action === 'submission.marked_read').length, 1);
      const unread = await api('qaegisadmin', 'PATCH', `${sub('Q2')}`, { body: { read: false } });
      assert.equal(unread.body.data.readAt, null);
      assert.equal(unread.body.data.readBy, null);
      assert.equal((await auditFor(ids.Q2)).filter((a) => a.action === 'submission.marked_unread').length, 1);
    });

    test('status and read can be changed together', async () => {
      const res = await api('epiwelladmin', 'PATCH', `${sub('W2')}`, { body: { status: 'closed', read: true } });
      assert.equal(res.body.data.status, 'closed');
      assert.ok(res.body.data.readAt);
      assert.deepEqual((await auditFor(ids.W2)).map((a) => a.action).sort(), ['submission.marked_read', 'submission.status_changed']);
    });

    test('invalid input is rejected: bad status, non-boolean read, empty body', async () => {
      const target = `${sub('E2')}`;
      for (const body of [{ status: 'deleted' }, { status: 'NEW' }, { status: 5 }, { status: null }, { read: 'true' }, { read: 1 }, {}]) {
        const res = await api('superadmin', 'PATCH', target, { body });
        assert.equal(res.status, 400, JSON.stringify(body));
      }
      assert.equal((await api('superadmin', 'PATCH', target, { body: [] })).status, 400);
    });

    test('MASS ASSIGNMENT: nothing but status and read can be changed', async () => {
      const before = await row('epineon', 'E2');
      for (const extra of [
        { data: { name: 'Hacked' } }, { submissionId: randomUUID() }, { application: 'qaegis' }, { formType: 'sales' },
        { receivedAt: '2000-01-01T00:00:00Z' }, { updatedAt: '2000-01-01T00:00:00Z' }, { readBy: users.superadmin.id },
        { statusChangedBy: users.superadmin.id }, { __proto__: { status: 'closed' }, role: 'admin' }, { storedAt: 'x' },
      ]) {
        const res = await api('superadmin', 'PATCH', `${sub('E2')}`, { body: { status: 'replied', ...extra } });
        assert.equal(res.status, 400, JSON.stringify(extra));
        assert.equal(res.body.details[0].code, 'unexpected_field');
      }
      const after = await row('epineon', 'E2');
      assert.deepEqual(formFields(after), formFields(before));
      assert.equal(after.created_at.getTime(), before.created_at.getTime());
    });

    test('CROSS-APPLICATION: updating another application\'s submission is 403 and changes nothing', async () => {
      const before = await row('qaegis', 'Q3');
      for (const who of ['epineonadmin', 'epiwelladmin', 'noaccess']) {
        const res = await api(who, 'PATCH', `${sub('Q3')}`, { body: { status: 'closed', read: false } });
        assert.equal(res.status, 403, who);
      }
      const after = await row('qaegis', 'Q3');
      assert.equal(after.status, before.status);
      assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
      assert.equal((await auditFor(ids.Q3)).length, 0);
    });

    test('unknown submission 404, unknown application 404, malformed id 400', async () => {
      assert.equal((await api('superadmin', 'PATCH', `/submissions/epineon/demo/${randomUUID()}`, { body: { status: 'new' } })).status, 404);
      assert.equal((await api('superadmin', 'PATCH', `/submissions/epineon/demo/${ids.Q1}`, { body: { status: 'new' } })).status, 404);
      assert.equal((await api('superadmin', 'PATCH', `/submissions/acme/demo/${ids.E1}`, { body: { status: 'new' } })).status, 404);
      assert.equal((await api('superadmin', 'PATCH', '/submissions/epineon/demo/xyz', { body: { status: 'new' } })).status, 400);
    });

    test('concurrent updates stay consistent: one audit entry per real change', async () => {
      const target = `${sub('Q1')}`;
      const results = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          api(i % 2 ? 'qaegisadmin' : 'superadmin', 'PATCH', target, { body: { read: true } })),
      );
      assert.ok(results.every((r) => r.status === 200));
      assert.equal((await auditFor(ids.Q1)).filter((a) => a.action === 'submission.marked_read').length, 1);
      const final = await row('qaegis', 'Q1');
      assert.ok(final.read_at && final.read_by);
    });
  });

  // ============================================================ delete

  describe('DELETE /submissions/:application/:formType/:id', () => {
    const seedExtra = (app, formType, data) => insertRow(app, formType, data);
    const exists = async (app, formType, id) =>
      (await database.query(`SELECT 1 FROM ${tableFor(app, formType)} WHERE id = $1`, [id])).rowCount === 1;

    test('an application admin can delete their own application\'s submission for real', async () => {
      const id = await seedExtra('epineon', 'demo', { name: 'Delete Me Person', email: 'delete.me@epineon.test', company: 'X', product: 'EPICRYPT' });
      const res = await api('epineonadmin', 'DELETE', `/submissions/epineon/demo/${id}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { status: 'success', message: 'Submission deleted' });
      assert.equal(await exists('epineon', 'demo', id), false, 'the row and its personal data are gone');
    });

    test('the audit entry records who/what/when and the exact form, but NO personal data', async () => {
      const id = await seedExtra('qaegis', 'contact-sales', { firstName: 'Secret', lastName: 'Person', workEmail: 'secret.person@qaegis.test', userRange: '1-50', message: 'Confidential words' });
      await api('qaegisadmin', 'PATCH', `/submissions/qaegis/contact-sales/${id}`, { body: { status: 'replied' } });
      await api('qaegisadmin', 'DELETE', `/submissions/qaegis/contact-sales/${id}`);
      const audit = await auditFor(id);
      const deleted = audit.find((a) => a.action === 'submission.deleted');
      assert.ok(deleted);
      assert.equal(deleted.actor_id, users.qaegisadmin.id);
      assert.equal(deleted.application, 'qaegis');
      assert.deepEqual(deleted.details, { formType: 'contact-sales', status: 'replied' });
      const withForm = await database.query('SELECT form_type FROM platform_admin.audit_log WHERE submission_id = $1 AND action = $2', [id, 'submission.deleted']);
      assert.equal(withForm.rows[0].form_type, 'contact-sales', 'audit_log.form_type identifies the form');
      const everything = JSON.stringify(audit);
      for (const secret of ['Secret', 'Person', 'secret.person', 'Confidential']) assert.ok(!everything.includes(secret), secret);
    });

    test('CROSS-APPLICATION: deleting another application\'s submission is 403 and deletes nothing', async () => {
      const id = await seedExtra('epiwell', 'waitlist', { email: 'protected@epiwell.test' });
      for (const who of ['epineonadmin', 'qaegisadmin', 'noaccess']) {
        assert.equal((await api(who, 'DELETE', `/submissions/epiwell/waitlist/${id}`)).status, 403, who);
      }
      assert.equal(await exists('epiwell', 'waitlist', id), true);
      assert.equal((await auditFor(id)).length, 0);
      assert.equal((await api('epiwelladmin', 'DELETE', `/submissions/epiwell/waitlist/${id}`)).status, 200);
      assert.equal(await exists('epiwell', 'waitlist', id), false);
    });

    test('deleting under the wrong application or the wrong FORM finds nothing (404) and deletes nothing', async () => {
      const qa = await seedExtra('qaegis', 'contact-sales', { firstName: 'A', lastName: 'B', workEmail: 'a@b.co', userRange: '1-50', message: 'm' });
      assert.equal((await api('superadmin', 'DELETE', `/submissions/epineon/demo/${qa}`)).status, 404);
      assert.equal(await exists('qaegis', 'contact-sales', qa), true);
      await api('superadmin', 'DELETE', `/submissions/qaegis/contact-sales/${qa}`);

      const sales = await seedExtra('epineon', 'sales', { name: 'N', email: 'n@e.co', company: 'C', product: 'EPICRYPT', useCase: 'Other', message: 'm' });
      for (const wrongForm of ['demo', 'partnerships']) {
        assert.equal((await api('superadmin', 'DELETE', `/submissions/epineon/${wrongForm}/${sales}`)).status, 404, wrongForm);
      }
      assert.equal((await api('superadmin', 'DELETE', `/submissions/epineon/contact-sales/${sales}`)).status, 404, 'a form of another application');
      assert.equal(await exists('epineon', 'sales', sales), true, 'still there');
      assert.equal((await api('superadmin', 'DELETE', `/submissions/epineon/sales/${sales}`)).status, 200);
    });

    test('deleting twice: the second attempt is a 404 and there is exactly one audit entry', async () => {
      const id = await seedExtra('epineon', 'sales', { name: 'N', email: 'n@e.co', company: 'C', product: 'EPICRYPT', useCase: 'Other', message: 'm' });
      assert.equal((await api('superadmin', 'DELETE', `/submissions/epineon/sales/${id}`)).status, 200);
      assert.equal((await api('superadmin', 'DELETE', `/submissions/epineon/sales/${id}`)).status, 404);
      assert.equal((await auditFor(id)).filter((a) => a.action === 'submission.deleted').length, 1);
    });

    test('concurrent deletes of one submission: exactly one succeeds', async () => {
      const id = await seedExtra('epineon', 'demo', { name: 'N', email: 'n@e.co', company: 'C', product: 'EPICRYPT' });
      const results = await Promise.all(Array.from({ length: 10 }, () => api('epineonadmin', 'DELETE', `/submissions/epineon/demo/${id}`)));
      assert.equal(results.filter((r) => r.status === 200).length, 1);
      assert.equal(results.filter((r) => r.status === 404).length, 9);
      assert.equal((await auditFor(id)).filter((a) => a.action === 'submission.deleted').length, 1);
    });

    test('unknown id 404, unknown form 404, malformed id 400, and the seeded data is untouched by all of this', async () => {
      assert.equal((await api('superadmin', 'DELETE', `/submissions/epineon/demo/${randomUUID()}`)).status, 404);
      assert.equal((await api('superadmin', 'DELETE', `/submissions/epineon/newsletter/${randomUUID()}`)).status, 404);
      assert.equal((await api('superadmin', 'DELETE', '/submissions/epineon/demo/..%2F..%2Fx')).status, 400);
      assert.equal((await list('superadmin', '?pageSize=100')).body.data.pagination.total, 11);
    });
  });

  describe('an ID is only ever found in the table of the form named in the path', () => {
    test('E3 (a sales submission) is invisible under demo and partnerships, for read, update and delete', async () => {
      for (const wrongForm of ['demo', 'partnerships']) {
        const base = `/submissions/epineon/${wrongForm}/${ids.E3}`;
        assert.equal((await api('superadmin', 'GET', base)).status, 404, `GET ${wrongForm}`);
        assert.equal((await api('superadmin', 'PATCH', base, { body: { status: 'closed' } })).status, 404, `PATCH ${wrongForm}`);
      }
      assert.equal((await api('superadmin', 'GET', sub('E3'))).status, 200);
      assert.equal((await row('epineon', 'E3')).status, 'in_progress', 'unchanged by the misdirected requests');
    });

    test('a QAegis or Epi Well submission is invisible under any Epineon form', async () => {
      for (const form of APP_FORMS.epineon) {
        assert.equal((await api('superadmin', 'GET', `/submissions/epineon/${form}/${ids.Q1}`)).status, 404, form);
        assert.equal((await api('superadmin', 'GET', `/submissions/epineon/${form}/${ids.W1}`)).status, 404, form);
      }
    });

    test('an unknown form type, or a form type of another application, is a 404 under a permitted application', async () => {
      for (const form of ['newsletter', 'contact-sales', 'waitlist', 'form_submissions']) {
        assert.equal((await api('epineonadmin', 'GET', `/submissions/epineon/${form}/${ids.E1}`)).status, 404, form);
      }
    });
  });

  // ============================================================ stats

  describe('GET /stats', () => {
    test('a super admin gets per-application and combined statistics', async () => {
      const res = await api('superadmin', 'GET', '/stats?days=30');
      assert.equal(res.status, 200);
      const { applications, combined, days } = res.body.data;
      assert.equal(days, 30);
      assert.deepEqual(Object.keys(applications), ['epineon', 'qaegis', 'epiwell']);
      assert.equal(applications.epineon.total, 5);
      assert.equal(applications.qaegis.total, 3);
      assert.equal(applications['epiwell'].total, 3);
      assert.equal(combined.total, 11);
      assert.deepEqual(combined.byApplication, { epineon: 5, qaegis: 3, 'epiwell': 3 });
      assert.equal(combined.receivedInPeriod, 10, 'the 40-day-old submission is outside a 30-day window');
      assert.deepEqual(applications.epineon.byFormType, { demo: 3, sales: 1, partnerships: 1 });
      assert.deepEqual(applications.qaegis.byFormType, { 'contact-sales': 3 });
      assert.deepEqual(applications['epiwell'].byFormType, { waitlist: 3 });
    });

    test('status and unread counts are exact and consistent', async () => {
      const { applications, combined } = (await api('superadmin', 'GET', '/stats')).body.data;
      const countsOf = (s) => Object.fromEntries(['new', 'in_progress', 'replied', 'closed', 'archived'].map((k) => [k, s[k]]));
      // Reflects every earlier test's changes: derive the truth straight from the database.
      for (const slug of Object.keys(SCHEMA)) {
        const union = APP_FORMS[slug].map((type) => `SELECT status, is_read FROM ${tableFor(slug, type)}`).join(' UNION ALL ');
        const { rows } = await database.query(`SELECT status, count(*)::int AS n, count(*) FILTER (WHERE NOT is_read)::int AS unread FROM (${union}) s GROUP BY status`);
        const expected = Object.fromEntries(['new', 'in_progress', 'replied', 'closed', 'archived'].map((k) => [k, rows.find((r) => r.status === k)?.n ?? 0]));
        assert.deepEqual(countsOf(applications[slug].byStatus), expected, slug);
        assert.equal(applications[slug].unread, rows.reduce((a, r) => a + r.unread, 0), `${slug} unread`);
      }
      const sum = (key) => Object.values(applications).reduce((a, x) => a + x[key], 0);
      assert.equal(combined.total, sum('total'));
      assert.equal(combined.unread, sum('unread'));
      for (const k of ['new', 'in_progress', 'replied', 'closed', 'archived']) {
        assert.equal(combined.byStatus[k], Object.values(applications).reduce((a, x) => a + x.byStatus[k], 0), k);
      }
    });

    test('the daily series covers every day of the window and adds up', async () => {
      for (const days of [1, 7, 30, 365]) {
        const { applications, combined } = (await api('superadmin', 'GET', `/stats?days=${days}`)).body.data;
        assert.equal(combined.daily.length, days);
        const dates = combined.daily.map((d) => d.date);
        assert.deepEqual(dates, [...dates].sort());
        assert.equal(new Set(dates).size, days);
        assert.equal(dates.at(-1), new Date().toISOString().slice(0, 10), 'ends today (UTC)');
        assert.equal(combined.daily.reduce((a, d) => a + d.count, 0), combined.receivedInPeriod);
        for (const app of Object.values(applications)) assert.equal(app.daily.reduce((a, d) => a + d.count, 0), app.receivedInPeriod);
        assert.equal(combined.daily.every((d, i) => d.count === Object.values(applications).reduce((a, x) => a + x.daily[i].count, 0)), true);
      }
      assert.equal((await api('superadmin', 'GET', '/stats?days=365')).body.data.combined.receivedInPeriod, 11);
    });

    test('application admins see statistics for their own application only', async () => {
      for (const [who, slug, total] of [['epineonadmin', 'epineon', 5], ['qaegisadmin', 'qaegis', 3], ['epiwelladmin', 'epiwell', 3]]) {
        const { applications, combined } = (await api(who, 'GET', '/stats')).body.data;
        assert.deepEqual(Object.keys(applications), [slug]);
        assert.equal(combined.total, total);
        assert.deepEqual(Object.keys(combined.byApplication), [slug]);
      }
      const multi = (await api('multiadmin', 'GET', '/stats')).body.data;
      assert.deepEqual(Object.keys(multi.applications), ['epineon', 'qaegis']);
      assert.equal(multi.combined.total, 8);
      const none = (await api('noaccess', 'GET', '/stats')).body.data;
      assert.deepEqual(none.applications, {});
      assert.equal(none.combined.total, 0);
      assert.deepEqual(none.combined.daily, []);
    });

    test('CROSS-APPLICATION: requesting another application\'s statistics is 403', async () => {
      assert.equal((await api('epineonadmin', 'GET', '/stats?application=qaegis')).status, 403);
      assert.equal((await api('qaegisadmin', 'GET', '/stats?application=epineon,qaegis')).status, 403);
      assert.equal((await api('epiwelladmin', 'GET', '/stats?application=epiwell')).status, 200);
      assert.equal((await api('superadmin', 'GET', '/stats?application=qaegis')).body.data.combined.total, 3);
    });

    test('invalid parameters are rejected', async () => {
      for (const query of ['?days=0', '?days=366', '?days=abc', '?days=1.5', '?days=7&days=8', '?x=1', '?application=nope']) {
        assert.equal((await api('superadmin', 'GET', `/stats${query}`)).status, 400, query);
      }
    });
  });

  // ======================================================== user admin

  describe('admin user management (Super Admin only)', () => {
    const newEmail = (tag) => `${tag}.${RUN}@managed.test`;

    test('application admins and users with no access are refused everywhere (403)', async () => {
      for (const who of ['epineonadmin', 'qaegisadmin', 'epiwelladmin', 'multiadmin', 'noaccess']) {
        assert.equal((await api(who, 'GET', '/users')).status, 403, `${who} GET /users`);
        assert.equal((await api(who, 'POST', '/users', { body: { email: newEmail('x'), applications: ['epineon'] } })).status, 403);
        assert.equal((await api(who, 'PATCH', `/users/${users.epineonadmin.id}`, { body: { status: 'disabled' } })).status, 403);
        assert.equal((await api(who, 'GET', '/audit')).status, 403);
      }
    });

    test('PRIVILEGE ESCALATION: an application admin cannot grant themselves anything', async () => {
      const res = await api('epineonadmin', 'PATCH', `/users/${users.epineonadmin.id}`, { body: { isSuperAdmin: true, applications: ['epineon', 'qaegis', 'epiwell'] } });
      assert.equal(res.status, 403);
      const { rows } = await database.query('SELECT is_super_admin FROM platform_admin.admin_users WHERE id = $1', [users.epineonadmin.id]);
      assert.equal(rows[0].is_super_admin, false);
      assert.deepEqual((await api('epineonadmin', 'GET', '/me')).body.data.applications.map((a) => a.slug), ['epineon']);
    });

    test('lists admins with their applications', async () => {
      const res = await api('superadmin', 'GET', '/users');
      assert.equal(res.status, 200);
      const epineon = res.body.data.items.find((u) => u.email === users.epineonadmin.email);
      assert.deepEqual(epineon.applications, ['epineon']);
      assert.equal(epineon.isSuperAdmin, false);
      assert.equal(res.body.data.items.find((u) => u.email === users.superadmin.email).isSuperAdmin, true);
    });

    test('creates an application admin; emails are normalized; access works immediately', async () => {
      const email = newEmail('Created.Mixed');
      const res = await api('superadmin', 'POST', '/users', { body: { email: `  ${email.toUpperCase()}  `, displayName: ' New Person ', applications: ['qaegis'] } });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.email, email.toLowerCase());
      assert.equal(res.body.data.displayName, 'New Person');
      assert.deepEqual(res.body.data.applications, ['qaegis']);
      assert.equal(res.body.data.isSuperAdmin, false);
      const me = await api(access.token(email), 'GET', '/me');
      assert.deepEqual(me.body.data.applications.map((a) => a.slug), ['qaegis']);
      assert.equal((await list(access.token(email), '?pageSize=100')).body.data.pagination.total, 3);
      const audit = await database.query(`SELECT details FROM platform_admin.audit_log WHERE action = 'admin_user.created' AND target_user_id = $1`, [res.body.data.id]);
      assert.deepEqual(audit.rows[0].details, { isSuperAdmin: false, applications: ['qaegis'] });
    });

    test('creates a Super Admin', async () => {
      const res = await api('superadmin', 'POST', '/users', { body: { email: newEmail('boss'), isSuperAdmin: true } });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.isSuperAdmin, true);
      assert.equal((await list(access.token(newEmail('boss')), '?pageSize=100')).body.data.pagination.total, 11);
    });

    test('rejects duplicates (409, case-insensitive) and invalid input (400)', async () => {
      assert.equal((await api('superadmin', 'POST', '/users', { body: { email: users.epineonadmin.email.toUpperCase(), applications: ['epineon'] } })).status, 409);
      const bad = [
        { email: 'nope', applications: ['epineon'] }, { applications: ['epineon'] }, { email: newEmail('a') },
        { email: newEmail('a'), applications: [] }, { email: newEmail('a'), applications: ['acme'] },
        { email: newEmail('a'), applications: ['epineon', 'epineon'] }, { email: newEmail('a'), applications: 'epineon' },
        { email: newEmail('a'), applications: ['epineon'], isSuperAdmin: 'yes' },
        { email: newEmail('a'), applications: ['epineon'], displayName: '' },
        { email: newEmail('a'), applications: ['epineon'], displayName: 'x'.repeat(121) },
        { email: newEmail('a'), applications: ['epineon'], status: 'active' },
        { email: newEmail('a'), applications: ['epineon'], id: randomUUID() },
        { email: 'a'.repeat(250) + '@x.co', applications: ['epineon'] },
      ];
      for (const body of bad) {
        const res = await api('superadmin', 'POST', '/users', { body });
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      }
    });

    test('updates applications (grant and revoke) with immediate effect, audited', async () => {
      const email = newEmail('grants');
      const created = await api('superadmin', 'POST', '/users', { body: { email, applications: ['epineon'] } });
      const id = created.body.data.id;
      const token = access.token(email);
      assert.equal((await api(token, 'GET', `${sub('Q3')}`)).status, 403);

      const granted = await api('superadmin', 'PATCH', `/users/${id}`, { body: { applications: ['epineon', 'qaegis'] } });
      assert.equal(granted.status, 200);
      assert.deepEqual(granted.body.data.applications, ['epineon', 'qaegis']);
      assert.equal((await api(token, 'GET', `${sub('Q3')}`)).status, 200);

      const revoked = await api('superadmin', 'PATCH', `/users/${id}`, { body: { applications: ['qaegis'] } });
      assert.deepEqual(revoked.body.data.applications, ['qaegis']);
      assert.equal((await api(token, 'GET', `${sub('E3')}`)).status, 403);
      assert.equal((await api(token, 'GET', `${sub('Q3')}`)).status, 200);

      const audits = (await database.query(`SELECT details FROM platform_admin.audit_log WHERE action = 'admin_user.updated' AND target_user_id = $1 ORDER BY id`, [id])).rows;
      assert.deepEqual(audits[0].details.applicationsAdded, ['qaegis']);
      assert.deepEqual(audits[1].details.applicationsRemoved, ['epineon']);
    });

    test('promoting to Super Admin and demoting back changes access immediately', async () => {
      const email = newEmail('promoted');
      const id = (await api('superadmin', 'POST', '/users', { body: { email, applications: ['epiwell'] } })).body.data.id;
      const token = access.token(email);
      assert.equal((await list(token, '?pageSize=100')).body.data.pagination.total, 3);
      await api('superadmin', 'PATCH', `/users/${id}`, { body: { isSuperAdmin: true } });
      assert.equal((await list(token, '?pageSize=100')).body.data.pagination.total, 11);
      assert.equal((await api(token, 'GET', '/users')).status, 200);
      await api('superadmin', 'PATCH', `/users/${id}`, { body: { isSuperAdmin: false } });
      assert.equal((await list(token, '?pageSize=100')).body.data.pagination.total, 3);
      assert.equal((await api(token, 'GET', '/users')).status, 403);
    });

    test('disabling an admin cuts off access on the very next request, and re-enabling restores it', async () => {
      const email = newEmail('disable');
      const id = (await api('superadmin', 'POST', '/users', { body: { email, applications: ['epineon'] } })).body.data.id;
      const token = access.token(email);
      assert.equal((await api(token, 'GET', '/me')).status, 200);
      assert.equal((await api('superadmin', 'PATCH', `/users/${id}`, { body: { status: 'disabled' } })).status, 200);
      assert.equal((await api(token, 'GET', '/me')).status, 403);
      assert.equal((await api(token, 'GET', '/submissions')).status, 403);
      await api('superadmin', 'PATCH', `/users/${id}`, { body: { status: 'active' } });
      assert.equal((await api(token, 'GET', '/me')).status, 200);
    });

    test('lock-out protection: nobody can disable or demote themselves', async () => {
      for (const body of [{ status: 'disabled' }, { isSuperAdmin: false }]) {
        const res = await api('superadmin', 'PATCH', `/users/${users.superadmin.id}`, { body });
        assert.equal(res.status, 409);
      }
      assert.equal((await api('superadmin', 'GET', '/me')).status, 200);
      assert.equal((await api('superadmin', 'PATCH', `/users/${users.superadmin.id}`, { body: { displayName: 'Renamed Boss' } })).status, 200);
    });

    test('PATCH validation: unknown fields, bad values, malformed or unknown ids', async () => {
      const id = users.noaccess.id;
      for (const body of [{}, { email: 'new@x.co' }, { id: randomUUID() }, { status: 'banned' }, { isSuperAdmin: 'true' }, { applications: ['acme'] }, { displayName: '' }, { createdBy: id }]) {
        assert.equal((await api('superadmin', 'PATCH', `/users/${id}`, { body })).status, 400, JSON.stringify(body));
      }
      assert.equal((await api('superadmin', 'PATCH', '/users/not-a-uuid', { body: { status: 'active' } })).status, 400);
      assert.equal((await api('superadmin', 'PATCH', `/users/${randomUUID()}`, { body: { status: 'active' } })).status, 404);
    });

    test('there is no way to delete an admin (they are disabled so audit entries always resolve)', async () => {
      assert.equal((await api('superadmin', 'DELETE', `/users/${users.noaccess.id}`)).status, 405);
    });
  });

  // ============================================================== audit

  describe('GET /audit (Super Admin only)', () => {
    const mine = (res) => res.body.data.items.filter((i) => Object.values(users).some((u) => u.id === i.actorId));

    test('lists admin actions, newest first, with the actor', async () => {
      const res = await api('superadmin', 'GET', '/audit?pageSize=100');
      assert.equal(res.status, 200);
      const items = mine(res);
      assert.ok(items.length > 10);
      const times = items.map((i) => Date.parse(i.at));
      assert.deepEqual(times, [...times].sort((a, b) => b - a));
      assert.ok(items.some((i) => i.action === 'submission.deleted' && i.actorEmail === users.epineonadmin.email));
      assert.ok(items.some((i) => i.action === 'admin_user.created'));
      assert.ok(items.some((i) => i.action === 'submission.status_changed'));
    });

    test('filters by application and action; paginates', async () => {
      const q = await api('superadmin', 'GET', '/audit?application=qaegis&pageSize=100');
      assert.ok(mine(q).length > 0);
      assert.ok(q.body.data.items.every((i) => i.application === 'qaegis'));
      const del = await api('superadmin', 'GET', '/audit?action=submission.deleted&pageSize=100');
      assert.ok(del.body.data.items.every((i) => i.action === 'submission.deleted'));
      const p1 = await api('superadmin', 'GET', '/audit?pageSize=2&page=1');
      const p2 = await api('superadmin', 'GET', '/audit?pageSize=2&page=2');
      assert.equal(p1.body.data.items.length, 2);
      assert.ok(p1.body.data.items.every((a) => !p2.body.data.items.some((b) => b.id === a.id)));
      assert.ok(p1.body.data.pagination.total >= 4);
    });

    test('rejects invalid parameters', async () => {
      for (const query of ['?application=nope', '?pageSize=0', '?pageSize=101', '?x=1', '?page=0']) {
        assert.equal((await api('superadmin', 'GET', `/audit${query}`)).status, 400, query);
      }
    });

    test('the audit trail never contains submission contents or personal data', async () => {
      const text = (await api('superadmin', 'GET', '/audit?pageSize=100')).text;
      for (const secret of ['Alice Epineon', 'alice@epineon.test', 'quinn@qaegis.test', 'Zanzibar', 'Quokka', 'quokka.fan', 'Initech']) {
        assert.ok(!text.includes(secret), `audit leaked ${secret}`);
      }
    });

    test('the audit log is append-only at the database level', async () => {
      const { rows } = await database.query('SELECT id FROM platform_admin.audit_log LIMIT 1');
      const id = rows[0].id;
      for (const sql of [
        ['UPDATE platform_admin.audit_log SET action = $1 WHERE id = $2', ['x.y', id]],
        ['DELETE FROM platform_admin.audit_log WHERE id = $1', [id]],
        ['TRUNCATE platform_admin.audit_log', []],
      ]) {
        await assert.rejects(database.query(sql[0], sql[1]), (err) => err.code === '42501', sql[0]);
      }
    });
  });

  // ============================================== database-level guarantees

  describe('database structure and constraints (one table per form)', () => {
    const valid = {
      'epineon.demo_submissions': { name: 'N', email: 'n@example.com', company: 'C', product: 'EPICRYPT' },
      'epineon.sales_submissions': { name: 'N', email: 'n@example.com', company: 'C', product: 'EPICRYPT', use_case: 'Other', message: 'm' },
      'epineon.partnerships_submissions': { name: 'N', email: 'n@example.com', organization: 'O', nature: 'x' },
      'qaegis.contact_sales_submissions': { first_name: 'F', last_name: 'L', work_email: 'n@example.com', user_range: '1-50', message: 'm' },
      'epiwell.waitlist_submissions': { email: `valid.${RUN}@example.com` },
    };
    const insertInto = (table, overrides = {}) => {
      const values = { ...valid[table], ...overrides };
      const columns = Object.keys(values);
      return database.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, columns.map((c) => values[c]));
    };
    const code = (c) => (e) => e.code === c;

    test('exactly the five form tables exist, one per form, plus the frozen old shared tables', async () => {
      const { rows } = await database.query(
        `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
         WHERE table_schema IN ('epineon', 'qaegis', 'epiwell') AND table_type = 'BASE TABLE' ORDER BY 1`);
      assert.deepEqual(rows.map((r) => r.t), [
        'epineon.demo_submissions', 'epineon.form_submissions', 'epineon.partnerships_submissions', 'epineon.sales_submissions',
        'epiwell.form_submissions', 'epiwell.waitlist_submissions', 'qaegis.contact_sales_submissions', 'qaegis.form_submissions',
      ]);
      assert.equal((await database.query(`SELECT to_regclass('epi_well.form_submissions') AS t`)).rows[0].t, null, 'the old Epi Well schema name is gone');
    });

    test('every form table has its form\'s columns plus the workflow columns, with the right nullability', async () => {
      const { applications } = await import('../src/applications/index.js');
      for (const app of applications) {
        for (const form of app.forms) {
          const { rows } = await database.query(
            `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
            [app.dbSchema, form.table]);
          const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
          const expected = [...WORKFLOW_COLUMNS, ...Object.values(form.fields).map((f) => f.column)].sort();
          assert.deepEqual(Object.keys(byName).sort(), expected, `${app.slug}/${form.type}`);
          assert.equal(byName.id.data_type, 'uuid');
          assert.equal(byName.is_read.data_type, 'boolean');
          assert.equal(byName.created_at.data_type, 'timestamp with time zone');
          assert.equal(byName.updated_at.data_type, 'timestamp with time zone');
          for (const col of ['id', 'status', 'is_read', 'created_at', 'updated_at']) assert.equal(byName[col].is_nullable, 'NO', col);
          for (const spec of Object.values(form.fields)) {
            assert.equal(byName[spec.column].is_nullable === 'NO', spec.required, `${form.table}.${spec.column}`);
          }
          assert.ok(!('application' in byName) && !('form_type' in byName) && !('data' in byName), 'the table itself identifies the form');
        }
      }
    });

    test('id is a UUID primary key with a default; status defaults to new; is_read to false', async () => {
      for (const table of Object.keys(valid)) {
        const [schema, name] = table.split('.');
        const pk = await database.query(
          `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
           WHERE i.indrelid = $1::regclass AND i.indisprimary`, [table]);
        assert.deepEqual(pk.rows.map((r) => r.attname), ['id'], table);
        const defaults = await database.query(
          `SELECT column_name, column_default FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2 AND column_name IN ('id', 'status', 'is_read')`, [schema, name]);
        const d = Object.fromEntries(defaults.rows.map((r) => [r.column_name, r.column_default]));
        assert.match(d.id, /gen_random_uuid/);
        assert.match(d.status, /'new'/);
        assert.match(d.is_read, /false/);
      }
    });

    test('a minimal valid row is accepted by every table and gets the defaults', async () => {
      for (const table of Object.keys(valid)) {
        if (table.startsWith('epiwell')) continue; // unique email: covered below
        await insertInto(table);
        const { rows } = await database.query(`SELECT status, is_read, read_at, created_at, updated_at, id FROM ${table} WHERE ${Object.keys(valid[table])[0]} = $1 ORDER BY created_at DESC LIMIT 1`, [Object.values(valid[table])[0]]);
        assert.equal(rows[0].status, 'new');
        assert.equal(rows[0].is_read, false);
        assert.equal(rows[0].read_at, null);
        assert.ok(rows[0].created_at && rows[0].updated_at && rows[0].id);
        await database.query(`DELETE FROM ${table} WHERE id = $1`, [rows[0].id]);
      }
    });

    test('status must be one of the five values, in every table', async () => {
      for (const table of Object.keys(valid)) {
        for (const status of ['unread', '', 'NEW', 'invited', 'deleted']) {
          await assert.rejects(insertInto(table, { status, ...(table.startsWith('epiwell') ? { email: `s.${RUN}.${status}@example.com` } : {}) }), code('23514'), `${table} ${status}`);
        }
      }
    });

    test('is_read, read_at and read_by must agree, in every table', async () => {
      for (const table of Object.keys(valid)) {
        const email = table.startsWith('epiwell') ? { email: `r.${RUN}@example.com` } : {};
        await assert.rejects(insertInto(table, { ...email, is_read: true }), code('23514'), `${table} is_read without read_at`);
        await assert.rejects(insertInto(table, { ...email, read_at: new Date(), read_by: randomUUID() }), code('23514'), `${table} read_at but not is_read`);
        await assert.rejects(insertInto(table, { ...email, is_read: true, read_at: new Date() }), code('23514'), `${table} read_at without read_by`);
        await assert.rejects(insertInto(table, { ...email, is_read: true, read_by: randomUUID() }), code('23514'), `${table} read_by without read_at`);
      }
    });

    test('required fields cannot be NULL or empty; length limits are enforced', async () => {
      await assert.rejects(insertInto('epineon.demo_submissions', { company: null }), code('23502'));
      await assert.rejects(insertInto('epineon.demo_submissions', { name: '' }), code('23514'));
      await assert.rejects(insertInto('epineon.demo_submissions', { name: 'x'.repeat(121) }), code('23514'));
      await assert.rejects(insertInto('epineon.sales_submissions', { message: null }), code('23502'));
      await assert.rejects(insertInto('epineon.sales_submissions', { message: 'x'.repeat(5001) }), code('23514'));
      await assert.rejects(insertInto('qaegis.contact_sales_submissions', { message: 'x'.repeat(10001) }), code('23514'));
      await assert.rejects(insertInto('qaegis.contact_sales_submissions', { company_website: 'x'.repeat(501) }), code('23514'));
    });

    test('the live sites\' fixed option lists are enforced by the database', async () => {
      await assert.rejects(insertInto('epineon.demo_submissions', { product: 'Bogus' }), code('23514'));
      await assert.rejects(insertInto('epineon.sales_submissions', { product: 'epicrypt' }), code('23514'));
      await assert.rejects(insertInto('epineon.sales_submissions', { use_case: 'Bogus' }), code('23514'));
      await assert.rejects(insertInto('qaegis.contact_sales_submissions', { user_range: '51-200' }), code('23514'));
    });

    test('emails: format is checked, and Epineon / Epi Well emails must be lower-case', async () => {
      for (const email of ['not-an-email', 'a@b', 'a b@example.com', '@example.com']) {
        await assert.rejects(insertInto('epineon.demo_submissions', { email }), code('23514'), email);
        await assert.rejects(insertInto('qaegis.contact_sales_submissions', { work_email: email }), code('23514'), email);
      }
      await assert.rejects(insertInto('epineon.demo_submissions', { email: 'Mixed@Example.com' }), code('23514'));
      await assert.rejects(insertInto('epiwell.waitlist_submissions', { email: 'Mixed@Example.com' }), code('23514'));
    });

    test('the Epi Well waitlist allows one entry per email', async () => {
      const email = `unique.${RUN}@waitlist.test`;
      await insertInto('epiwell.waitlist_submissions', { email });
      await assert.rejects(insertInto('epiwell.waitlist_submissions', { email }), code('23505'));
    });

    test('updated_at is maintained by a trigger on every form table', async () => {
      for (const [app, key] of [['epineon', 'E2'], ['epineon', 'E3'], ['epineon', 'E4'], ['qaegis', 'Q3'], ['epiwell', 'W3']]) {
        const before = await row(app, key);
        await new Promise((r) => setTimeout(r, 15));
        await database.query(`UPDATE ${tableFor(app, meta[key].formType)} SET status = status WHERE id = $1`, [ids[key]]);
        assert.ok((await row(app, key)).updated_at > before.updated_at, `${app}/${meta[key].formType}`);
      }
    });

    test('the old shared tables are frozen: inserts are refused', async () => {
      for (const [schema, app] of [['epineon', 'epineon'], ['qaegis', 'qaegis'], ['epiwell', 'epi-well']]) {
        await assert.rejects(
          database.query(`INSERT INTO ${schema}.form_submissions (submission_id, application, form_type, data, received_at) VALUES (gen_random_uuid(), $1, 'demo', '{}', now())`, [app]),
          (e) => e.code === '0A000' && /frozen/.test(e.message), schema,
        );
      }
    });

    test('rate-limit counters live in platform_admin, and audit entries carry form_type', async () => {
      assert.equal((await database.query(`SELECT to_regclass('platform_admin.rate_limit_counters') AS t`)).rows[0].t, 'platform_admin.rate_limit_counters');
      assert.equal((await database.query(`SELECT to_regclass('platform_security.rate_limit_counters') AS t`)).rows[0].t, null);
      const cols = await database.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'platform_admin' AND table_name = 'audit_log'`);
      assert.ok(cols.rows.some((r) => r.column_name === 'form_type'));
    });

    test('migrations are recorded, checksummed and idempotent', async () => {
      const { runMigrations, PLATFORM_MIGRATIONS } = await import('../src/shared/database/migrator.js');
      const { applications } = await import('../src/applications/index.js');
      const results = await runMigrations([PLATFORM_MIGRATIONS, ...applications.map(({ migrationKey, migrationsDir }) => ({ slug: migrationKey, migrationsDir }))]);
      assert.ok(results.every((r) => r.status === 'skipped'));
      const { rows } = await database.query(`SELECT application, name FROM public.schema_migrations WHERE name LIKE '003_%' OR name LIKE '004_%' ORDER BY application, name`);
      assert.deepEqual(rows.map((r) => `${r.application}/${r.name}`), [
        'epi-well/003_rename_schema_and_create_form_tables.sql', 'epineon/003_create_form_tables.sql',
        'platform/003_fix_audit_action_pattern.sql', 'platform/004_move_rate_limits_and_extend_audit.sql',
        'qaegis/003_create_form_tables.sql',
      ]);
    });
  });

  // ============================================================ failures

  describe('failures and information safety', () => {
    test('a database failure during an admin request is a generic 500', async () => {
      const original = database.query.bind(database);
      let calls = 0;
      mock.method(database, 'query', async (text, params) => {
        calls += 1;
        // let authentication succeed, then fail the data query
        if (calls <= 2) return original(text, params);
        throw Object.assign(new Error('connection to server at "db.internal" (10.0.0.9) failed: FATAL password authentication failed'), { code: '28P01' });
      });
      try {
        logLines.length = 0;
        const res = await list('superadmin');
        assert.equal(res.status, 500);
        assert.deepEqual(res.body, { status: 'error', message: 'Internal Server Error' });
        assert.ok(!res.text.includes('db.internal'));
        assert.ok(logLines.join('\n').includes('unhandled error'));
        assert.ok(!logLines.join('\n').includes(tokenFor('superadmin')));
      } finally {
        database.query.mockRestore?.();
        mock.restoreAll();
        mock.method(console, 'log', (l) => logLines.push(String(l)));
        mock.method(console, 'error', (l) => logLines.push(String(l)));
      }
    });

    test('unsupported methods on admin routes get 405 with Allow', async () => {
      const cases = [
        ['POST', '/me', 'GET, HEAD'], ['DELETE', '/submissions', 'GET, HEAD'], ['PUT', `${sub('E1')}`, 'GET, HEAD, PATCH, DELETE'],
        ['POST', '/stats', 'GET, HEAD'], ['DELETE', '/users', 'GET, HEAD, POST'], ['GET', `/users/${users.noaccess.id}`, 'PATCH'], ['POST', '/audit', 'GET, HEAD'],
      ];
      for (const [method, path, allow] of cases) {
        const res = await api('superadmin', method, path, { body: method === 'GET' ? undefined : {} });
        assert.equal(res.status, 405, `${method} ${path}`);
        assert.equal(res.headers.get('allow'), allow);
      }
    });

    test('unknown admin paths 404; responses carry security headers and no caching', async () => {
      const res = await api('superadmin', 'GET', '/nope');
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(res.headers.get('x-request-id'));
    });
  });
});
