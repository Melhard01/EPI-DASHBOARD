/**
 * Admin authentication and permission scoping WITHOUT a database.
 * The database is replaced by a recorder, so these tests can inspect the
 * exact SQL each admin role would run and prove that no query ever mentions
 * a schema the caller may not access.
 */
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createCorsPolicy } from '../src/shared/security/cors.js';
import { database } from '../src/shared/database/index.js';
import { createTestAccess } from './helpers/access.js';

const ADMIN_ORIGIN = 'https://admin.example.com';
const access = createTestAccess();
const corsPolicy = createCorsPolicy({ publicOrigins: {}, adminOrigins: [ADMIN_ORIGIN] });

const queries = [];
const logLines = [];
let directory; // email → admin row returned by the (fake) user lookup
let failLookup = false;
let server;
let base;

const admin = (overrides) => ({
  id: randomUUID(),
  email: 'x@admin.test',
  display_name: null,
  is_super_admin: false,
  status: 'active',
  applications: [],
  ...overrides,
});

before(async () => {
  mock.method(console, 'log', (l) => logLines.push(String(l)));
  mock.method(console, 'error', (l) => logLines.push(String(l)));
  mock.method(database, 'query', async (text, params) => {
    queries.push({ text, params });
    if (text.includes('FROM platform_admin.admin_users u')) {
      if (failLookup) throw Object.assign(new Error('boom: password authentication failed for 10.0.0.1'), { code: '28P01' });
      const row = directory.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (/SELECT count\(\*\)::int AS total/.test(text)) return { rows: [{ total: 0 }] };
    return { rows: [], rowCount: 0 };
  });
  // Transactions run through the same recorder, so nothing here ever reaches a real database.
  mock.method(database, 'withTransaction', async (fn) => fn({ query: (text, params) => database.query(text, params) }));
  server = createApp({ accessVerifier: access.verifier, corsPolicy, rateLimitStore: null }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  mock.restoreAll();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  queries.length = 0;
  logLines.length = 0;
  failLookup = false;
  directory = new Map([
    ['super@admin.test', admin({ email: 'super@admin.test', is_super_admin: true })],
    ['epineon@admin.test', admin({ email: 'epineon@admin.test', applications: ['epineon'] })],
    ['qaegis@admin.test', admin({ email: 'qaegis@admin.test', applications: ['qaegis'] })],
    ['multi@admin.test', admin({ email: 'multi@admin.test', applications: ['epineon', 'epiwell'] })],
    ['none@admin.test', admin({ email: 'none@admin.test', applications: [] })],
    ['off@admin.test', admin({ email: 'off@admin.test', applications: ['epineon'], status: 'disabled' })],
    ['ghost@admin.test', admin({ email: 'ghost@admin.test', applications: ['epineon', 'acme'] })],
  ]);
});

async function call(email, method, path, { token, body, origin } = {}) {
  const jwt = token ?? (email ? access.token(email) : null);
  const res = await fetch(`${base}/api/v1/admin${path}`, {
    method,
    headers: {
      ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
}

/** All SQL sent after authentication (i.e. excluding the admin lookup/touch). */
const dataQueries = () => queries.filter((q) => !q.text.includes('platform_admin.admin_users'));
// Each form has its own table (e.g. epineon.demo_submissions): find which application schemas a query touches.
const schemasIn = (text) => ['epineon', 'qaegis', 'epiwell'].filter((s) => new RegExp(`\\b${s}\\.[a-z_]+_submissions\\b`).test(text));
// The tables a query touches, e.g. "epineon.demo_submissions".
const tablesIn = (text) => [...text.matchAll(/\b(epineon|qaegis|epiwell)\.([a-z_]+_submissions)\b/g)].map((m) => `${m[1]}.${m[2]}`);
const FIRST_FORM = { epineon: 'demo', qaegis: 'contact-sales', epiwell: 'waitlist' };

// ------------------------------------------------------------ authentication

describe('authentication failures (no database)', () => {
  test('without a configured verifier the whole admin API answers 503', async () => {
    const bare = createApp({ accessVerifier: null, corsPolicy, rateLimitStore: null }).listen(0);
    await new Promise((resolve) => bare.once('listening', resolve));
    try {
      for (const [method, path] of [['GET', '/me'], ['GET', '/submissions'], ['GET', '/stats'], ['GET', '/users'], ['GET', '/audit']]) {
        const res = await fetch(`http://127.0.0.1:${bare.address().port}/api/v1/admin${path}`, {
          method, headers: { 'cf-access-jwt-assertion': access.token('super@admin.test') },
        });
        assert.equal(res.status, 503, path);
        assert.deepEqual(await res.json(), { status: 'error', message: 'Admin authentication is not configured' });
      }
    } finally {
      await new Promise((resolve) => bare.close(resolve));
    }
  });

  test('no token → 401 and the database is never consulted', async () => {
    const res = await call(null, 'GET', '/submissions');
    assert.equal(res.status, 401);
    assert.equal(queries.length, 0);
  });

  test('a bad token → 401 and the database is never consulted', async () => {
    for (const token of ['junk', 'a.b.c', access.token('super@admin.test', { claims: { aud: ['x'] } }), access.token('super@admin.test', { ttlSeconds: -3600 })]) {
      const res = await call(null, 'GET', '/me', { token });
      assert.equal(res.status, 401);
    }
    assert.equal(queries.length, 0);
  });

  test('an empty Access header is the same as none', async () => {
    assert.equal((await call(null, 'GET', '/me', { token: '' })).status, 401);
  });

  test('unknown and disabled admins → 403 (and no data query runs)', async () => {
    assert.equal((await call('stranger@nowhere.test', 'GET', '/submissions')).status, 403);
    assert.equal((await call('off@admin.test', 'GET', '/submissions')).status, 403);
    assert.equal(dataQueries().length, 0);
  });

  test('a database failure while checking the admin is a generic 500, with no leak', async () => {
    failLookup = true;
    const res = await call('super@admin.test', 'GET', '/me');
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { status: 'error', message: 'Internal Server Error' });
    assert.ok(!res.text.includes('10.0.0.1'));
    assert.ok(!logLines.join('\n').includes(access.token('super@admin.test')));
  });

  test('tokens and emails are never logged', async () => {
    const token = access.token('epineon@admin.test');
    await call(null, 'GET', '/me', { token });
    await call(null, 'GET', '/me', { token: 'junk.junk.junk' });
    const logs = logLines.join('\n');
    assert.ok(!logs.includes(token));
    assert.ok(!logs.includes('epineon@admin.test'));
    assert.ok(!logs.includes('junk.junk.junk'));
  });
});

describe('origin rules (no database)', () => {
  test('foreign origins are refused before authentication; changes need an origin', async () => {
    assert.equal((await call('super@admin.test', 'GET', '/me', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call(null, 'GET', '/me', { origin: 'https://evil.example', token: 'junk' })).status, 403);
    assert.equal(queries.length, 0);
    const id = randomUUID();
    assert.equal((await call('super@admin.test', 'PATCH', `/submissions/epineon/${id}`, { body: { status: 'new' } })).status, 403);
    assert.equal((await call('super@admin.test', 'DELETE', `/submissions/epineon/${id}`)).status, 403);
    assert.equal((await call('super@admin.test', 'POST', '/users', { body: {} })).status, 403);
    assert.equal(dataQueries().length, 0);
    assert.equal((await call('super@admin.test', 'GET', '/me', { origin: ADMIN_ORIGIN })).status, 200);
  });
});

// ---------------------------------------------------- permission scoping

describe('per-application scoping of the SQL that runs', () => {
  test('/me reports only the applications the caller may use', async () => {
    const slugs = async (email) => (await call(email, 'GET', '/me')).body.data.applications.map((a) => a.slug);
    assert.deepEqual(await slugs('super@admin.test'), ['epineon', 'qaegis', 'epiwell']);
    assert.deepEqual(await slugs('epineon@admin.test'), ['epineon']);
    assert.deepEqual(await slugs('qaegis@admin.test'), ['qaegis']);
    assert.deepEqual(await slugs('multi@admin.test'), ['epineon', 'epiwell']);
    assert.deepEqual(await slugs('none@admin.test'), []);
    assert.deepEqual(await slugs('ghost@admin.test'), ['epineon'], 'grants for applications that do not exist are ignored');
  });

  test('the list query of an application admin mentions ONLY their own schema', async () => {
    const expectations = {
      'epineon@admin.test': ['epineon'],
      'qaegis@admin.test': ['qaegis'],
      'multi@admin.test': ['epineon', 'epiwell'],
      'super@admin.test': ['epineon', 'qaegis', 'epiwell'],
    };
    for (const [email, expected] of Object.entries(expectations)) {
      for (const query of ['', '?q=anything', '?status=new&sort=application', '?formType=demo', '?unread=true']) {
        queries.length = 0;
        const res = await call(email, 'GET', `/submissions${query}`);
        assert.equal(res.status, 200, `${email} ${query}`);
        for (const { text } of dataQueries()) {
          const used = schemasIn(text);
          for (const schema of used) assert.ok(expected.includes(schema), `${email} ${query}: query touched ${schema}`);
        }
        if (!query.includes('formType')) {
          const used = new Set(dataQueries().flatMap(({ text }) => schemasIn(text)));
          assert.deepEqual([...used].sort(), [...expected].sort(), `${email} ${query}`);
        }
      }
    }
  });

  test('a form-type filter reads ONLY that form\'s table; an unfiltered list reads every permitted form table, nothing else', async () => {
    const tables = async (email, query) => {
      queries.length = 0;
      assert.equal((await call(email, 'GET', `/submissions${query}`)).status, 200);
      return [...new Set(dataQueries().flatMap(({ text }) => tablesIn(text)))].sort();
    };
    assert.deepEqual(await tables('super@admin.test', '?formType=sales'), ['epineon.sales_submissions']);
    assert.deepEqual(await tables('super@admin.test', '?formType=contact-sales'), ['qaegis.contact_sales_submissions']);
    assert.deepEqual(await tables('epineon@admin.test', ''), ['epineon.demo_submissions', 'epineon.partnerships_submissions', 'epineon.sales_submissions']);
    assert.deepEqual(await tables('qaegis@admin.test', ''), ['qaegis.contact_sales_submissions']);
    assert.deepEqual(await tables('multi@admin.test', '?application=epiwell'), ['epiwell.waitlist_submissions']);
    assert.deepEqual((await tables('super@admin.test', '')).length, 5, 'five forms, five tables');
  });

  test('detail, update and delete touch exactly the one table named in the path', async () => {
    const id = randomUUID();
    for (const [method, body] of [['GET'], ['PATCH', { status: 'closed' }], ['DELETE']]) {
      for (const [app, formType, table] of [['epineon', 'sales', 'epineon.sales_submissions'], ['epineon', 'partnerships', 'epineon.partnerships_submissions'], ['qaegis', 'contact-sales', 'qaegis.contact_sales_submissions']]) {
        queries.length = 0;
        await call('super@admin.test', method, `/submissions/${app}/${formType}/${id}`, { body, origin: method === 'GET' ? undefined : ADMIN_ORIGIN });
        const touched = new Set(dataQueries().flatMap(({ text }) => tablesIn(text)));
        assert.deepEqual([...touched], [table], `${method} ${app}/${formType}`);
      }
    }
  });

  test('an unknown form type under a permitted application is a 404 and runs no query', async () => {
    queries.length = 0;
    assert.equal((await call('epineon@admin.test', 'GET', `/submissions/epineon/contact-sales/${randomUUID()}`)).status, 404);
    assert.equal((await call('epineon@admin.test', 'GET', `/submissions/epineon/waitlist/${randomUUID()}`)).status, 404);
    assert.equal(dataQueries().length, 0);
  });

  test('a caller with no applications runs no data query at all', async () => {
    const res = await call('none@admin.test', 'GET', '/submissions?q=x');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.items, []);
    assert.equal(dataQueries().length, 0);
    const stats = await call('none@admin.test', 'GET', '/stats');
    assert.equal(stats.body.data.combined.total, 0);
    assert.equal(dataQueries().length, 0);
  });

  test('a form type filter restricts the schemas searched to the applications that have that form', async () => {
    await call('super@admin.test', 'GET', '/submissions?formType=waitlist');
    assert.deepEqual([...new Set(dataQueries().flatMap(({ text }) => schemasIn(text)))], ['epiwell']);
    queries.length = 0;
    await call('epineon@admin.test', 'GET', '/submissions?formType=waitlist');
    assert.equal(dataQueries().length, 0, 'an Epineon admin asking for waitlist rows queries nothing');
  });

  test('requesting a forbidden application is a 403 and no data query runs', async () => {
    for (const [email, query] of [
      ['epineon@admin.test', '?application=qaegis'], ['epineon@admin.test', '?application=epineon,qaegis'],
      ['qaegis@admin.test', '?application=epiwell'], ['multi@admin.test', '?application=qaegis'], ['none@admin.test', '?application=epineon'],
    ]) {
      queries.length = 0;
      assert.equal((await call(email, 'GET', `/submissions${query}`)).status, 403, `${email} ${query}`);
      assert.equal((await call(email, 'GET', `/stats${query}`)).status, 403, `${email} stats ${query}`);
      assert.equal(dataQueries().length, 0, `${email} ${query} ran a data query`);
    }
  });

  test('single-submission routes check the application BEFORE touching the database', async () => {
    const id = randomUUID();
    for (const [email, app] of [['epineon@admin.test', 'qaegis'], ['qaegis@admin.test', 'epineon'], ['none@admin.test', 'epiwell'], ['multi@admin.test', 'qaegis']]) {
      for (const [method, body] of [['GET'], ['PATCH', { status: 'closed' }], ['DELETE']]) {
        queries.length = 0;
        const res = await call(email, method, `/submissions/${app}/${FIRST_FORM[app]}/${id}`, { body, origin: method === 'GET' ? undefined : ADMIN_ORIGIN });
        assert.equal(res.status, 403, `${email} ${method} ${app}`);
        assert.equal(dataQueries().length, 0, `${email} ${method} ${app} ran a data query`);
      }
    }
  });

  test('stats queries are scoped the same way', async () => {
    await call('qaegis@admin.test', 'GET', '/stats');
    const used = new Set(dataQueries().flatMap(({ text }) => schemasIn(text)));
    assert.deepEqual([...used], ['qaegis']);
  });

  test('user management and audit are Super Admin only, and refuse before any query', async () => {
    for (const email of ['epineon@admin.test', 'qaegis@admin.test', 'multi@admin.test', 'none@admin.test']) {
      queries.length = 0;
      assert.equal((await call(email, 'GET', '/users')).status, 403);
      assert.equal((await call(email, 'POST', '/users', { body: { email: 'a@b.co', isSuperAdmin: true }, origin: ADMIN_ORIGIN })).status, 403);
      assert.equal((await call(email, 'PATCH', `/users/${randomUUID()}`, { body: { isSuperAdmin: true }, origin: ADMIN_ORIGIN })).status, 403);
      assert.equal((await call(email, 'GET', '/audit')).status, 403);
      assert.equal(dataQueries().length, 0);
    }
    assert.equal((await call('super@admin.test', 'GET', '/audit')).status, 200);
  });

  test('the SQL always passes values as parameters (no user input in the query text)', async () => {
    const hostile = "x'; DROP TABLE epineon.demo_submissions; --";
    await call('super@admin.test', 'GET', `/submissions?q=${encodeURIComponent(hostile)}&formType=demo&status=new`);
    for (const { text } of dataQueries()) {
      assert.ok(!text.includes('DROP TABLE'), text);
      assert.ok(!text.includes(hostile));
    }
    const params = dataQueries().flatMap((q) => q.params ?? []);
    assert.ok(params.some((p) => typeof p === 'string' && p.includes('DROP TABLE')), 'hostile text travelled as a bound parameter');
  });

  test('parameter validation happens before any query runs', async () => {
    for (const query of ['?status=bogus', '?pageSize=500', '?sort=data', '?unknown=1', '?status=new&status=closed']) {
      queries.length = 0;
      assert.equal((await call('super@admin.test', 'GET', `/submissions${query}`)).status, 400, query);
      assert.equal(dataQueries().length, 0, query);
    }
  });
});
