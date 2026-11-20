/**
 * Unified submissions endpoint, CORS, and anti-spam behaviour over HTTP.
 * The database is replaced by a recorder, so no database is touched.
 */
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createCorsPolicy } from '../src/shared/security/cors.js';
import { MemoryRateLimitStore } from '../src/shared/security/rateLimitStores.js';
import { database } from '../src/shared/database/index.js';
import { submissionInserts } from './helpers/insert.js';

const ORIGINS = {
  epineon: 'https://epineon.ai',
  qaegis: 'https://qaegis.com',
  'epiwell': 'https://epiwell.tech',
  admin: 'https://admin.example.com',
};
const corsPolicy = createCorsPolicy({
  publicOrigins: { epineon: [ORIGINS.epineon], qaegis: [ORIGINS.qaegis], 'epiwell': [ORIGINS['epiwell']] },
  adminOrigins: [ORIGINS.admin],
});

const BODIES = {
  'epineon/demo': { name: 'Ada', email: 'Ada@Example.com', company: 'C', product: 'EPICRYPT' },
  'epineon/sales': { name: 'Grace', email: 'g@example.org', company: 'C', product: 'SoulChain', useCase: 'Other', message: 'Hello' },
  'epineon/partnerships': { name: 'Alan', email: 'a@example.org', organization: 'O', nature: 'Investment' },
  'qaegis/contact-sales': { firstName: 'Kat', lastName: 'J', workEmail: 'k@example.com', userRange: '251-1000', message: 'SSO' },
  'epiwell/waitlist': { email: 'Member@Example.com' },
};
const SCHEMA = { epineon: 'epineon', qaegis: 'qaegis', epiwell: 'epiwell' };
const TABLE = {
  demo: 'demo_submissions', sales: 'sales_submissions', partnerships: 'partnerships_submissions',
  'contact-sales': 'contact_sales_submissions', waitlist: 'waitlist_submissions',
};
const stored = () => submissionInserts(queries)[0].row;

const logLines = [];
const queries = [];
let queryImpl;
const okQuery = async () => ({ rows: [], rowCount: 1 });
let server;
let base;

before(() => {
  mock.method(console, 'log', (l) => logLines.push(String(l)));
  mock.method(console, 'error', (l) => logLines.push(String(l)));
  mock.method(database, 'query', async (text, params) => {
    queries.push({ text, params });
    return queryImpl(text, params);
  });
});
after(async () => {
  mock.restoreAll();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function startApp(options = {}) {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = createApp({ corsPolicy, rateLimitStore: null, ...options }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(async () => {
  queries.length = 0;
  logLines.length = 0;
  queryImpl = okQuery;
  await startApp();
});

async function call(path, { method = 'POST', origin, body, headers = {}, raw } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(origin ? { origin } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
}

const unified = (application, formType, data, options) =>
  call('/api/v1/submissions', { body: { application, formType, data }, ...options });
const perApp = (key, extra = {}, options) => {
  const [app, type] = key.split('/');
  return call(`/api/v1/${app}/forms/${type}`, { body: { ...BODIES[key], ...extra }, ...options });
};

// ======================================================== unified endpoint

describe('POST /api/v1/submissions', () => {
  for (const key of Object.keys(BODIES)) {
    const [app, type] = key.split('/');
    test(`stores ${key} in ${SCHEMA[app]} with the right application and form type`, async () => {
      const { status, body } = await unified(app, type, BODIES[key]);
      assert.equal(status, 201);
      assert.deepEqual(Object.keys(body.data).sort(), ['application', 'formType', 'receivedAt', 'submissionId']);
      assert.equal(body.data.application, app);
      assert.equal(body.data.formType, type);
      assert.equal(queries.length, 1);
      const [insert] = submissionInserts(queries);
      assert.equal(`${insert.schema}.${insert.table}`, `${SCHEMA[app]}.${TABLE[type]}`);
    });
  }

  test('the receipt never contains submitted data', async () => {
    const { text } = await unified('qaegis', 'contact-sales', BODIES['qaegis/contact-sales']);
    for (const value of Object.values(BODIES['qaegis/contact-sales'])) assert.ok(!text.includes(value), value);
  });

  test('stores trimmed, normalized data (lower-cased email) exactly like the per-application endpoint', async () => {
    await unified('epiwell', 'waitlist', { email: '  Member@Example.com ' });
    assert.equal(stored().email, 'member@example.com');
  });

  test('validation errors from the application\'s own form are returned', async () => {
    const { status, body } = await unified('epineon', 'sales', { ...BODIES['epineon/sales'], useCase: 'Not a listed use case' });
    assert.equal(status, 400);
    assert.deepEqual(body.details, [
      { field: 'useCase', code: 'invalid_option', message: 'Field must be one of the allowed options' },
    ]);
    assert.equal(queries.length, 0);
  });

  describe('envelope validation', () => {
    const errorsOf = async (payload) => {
      const { status, body } = await call('/api/v1/submissions', payload);
      assert.equal(status, 400);
      assert.equal(queries.length, 0);
      return body.details.map((d) => `${d.field}:${d.code}`).sort();
    };

    test('missing application, formType and data', async () => {
      assert.deepEqual(await errorsOf({ body: { x: 1 } }), [
        'application:required', 'data:required', 'formType:required', 'x:unexpected_field',
      ]);
    });

    test('unknown application and unknown form type', async () => {
      assert.deepEqual(await errorsOf({ body: { application: 'acme', formType: 'demo', data: {} } }), ['application:unknown_application']);
      assert.deepEqual(await errorsOf({ body: { application: 'epineon', formType: 'nope', data: {} } }), ['formType:unknown_form_type']);
    });

    test('a form type that belongs to another application is unknown here', async () => {
      assert.deepEqual(await errorsOf({ body: { application: 'qaegis', formType: 'demo', data: BODIES['epineon/demo'] } }), ['formType:unknown_form_type']);
      assert.deepEqual(await errorsOf({ body: { application: 'epineon', formType: 'waitlist', data: { email: 'a@b.co' } } }), ['formType:unknown_form_type']);
    });

    test('wrong types', async () => {
      assert.deepEqual(await errorsOf({ body: { application: 5, formType: ['demo'], data: 'x' } }), [
        'application:invalid_type', 'data:invalid_type', 'formType:invalid_type',
      ]);
      assert.deepEqual(await errorsOf({ body: { application: 'epineon', formType: 'demo', data: [BODIES['epineon/demo']] } }), ['data:invalid_type']);
    });

    test('identity fields outside the envelope are rejected', async () => {
      assert.deepEqual(
        await errorsOf({ body: { application: 'qaegis', formType: 'contact-sales', data: BODIES['qaegis/contact-sales'], submissionId: 'x', status: 'closed' } }),
        ['status:unexpected_field', 'submissionId:unexpected_field'],
      );
    });

    test('identity fields smuggled inside data are rejected by the form itself', async () => {
      const { status, body } = await unified('qaegis', 'contact-sales', {
        ...BODIES['qaegis/contact-sales'], application: 'epineon', formType: 'demo', submissionId: 'chosen',
      });
      assert.equal(status, 400);
      assert.deepEqual(body.details.map((d) => d.field).sort(), ['application', 'formType', 'submissionId']);
    });

    test('empty, non-object and malformed bodies', async () => {
      const empty = await call('/api/v1/submissions', { method: 'POST', headers: { 'content-type': 'application/json' } });
      assert.equal(empty.status, 400);
      assert.equal(empty.body.details[0].code, 'empty_submission');
      assert.equal((await call('/api/v1/submissions', { body: [] })).status, 400);
      assert.equal((await call('/api/v1/submissions', { raw: '{"application":' })).status, 400);
    });

    test('prototype-pollution style names are just unknown', async () => {
      for (const formType of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        assert.deepEqual(await errorsOf({ body: { application: 'epineon', formType, data: {} } }), ['formType:unknown_form_type']);
      }
      assert.deepEqual(await errorsOf({ body: { application: '__proto__', formType: 'demo', data: {} } }), ['application:unknown_application']);
    });
  });

  test('other methods get 405, other content types 415', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const res = await call('/api/v1/submissions', { method });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'POST');
    }
    const res = await call('/api/v1/submissions', { raw: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(res.status, 415);
  });

  test('"submissions" and "admin" can never be application slugs, and slugs must be unique', async () => {
    const { applications } = await import('../src/applications/index.js');
    const [epineon] = applications;
    for (const slug of ['admin', 'submissions']) {
      assert.throws(
        () => createApp({ rateLimitStore: null, corsPolicy, applications: [{ ...epineon, slug }] }),
        /reserved/,
        slug,
      );
    }
    assert.throws(
      () => createApp({ rateLimitStore: null, corsPolicy, applications: [epineon, epineon] }),
      /Duplicate application slug/,
    );
  });
});

// =================================================== rate limits are shared

describe('rate limiting is shared between both entry points', () => {
  test('requests through /api/v1/submissions and the per-app endpoint use the same counters', async () => {
    await startApp({ rateLimitStore: new MemoryRateLimitStore(), clientIpSource: 'socket' });
    const limit = 3; // epineon partnerships: 3 per 10 minutes
    const statuses = [
      (await perApp('epineon/partnerships')).status,
      (await unified('epineon', 'partnerships', BODIES['epineon/partnerships'])).status,
      (await perApp('epineon/partnerships')).status,
    ];
    assert.deepEqual(statuses, [201, 201, 201]);
    assert.equal(statuses.length, limit);
    const viaUnified = await unified('epineon', 'partnerships', BODIES['epineon/partnerships']);
    assert.equal(viaUnified.status, 429);
    assert.equal(viaUnified.headers.get('retry-after') > 0, true);
    assert.equal((await perApp('epineon/partnerships')).status, 429);
    // Another form of the same app, and another app, are unaffected.
    assert.equal((await unified('epineon', 'demo', BODIES['epineon/demo'])).status, 201);
    assert.equal((await unified('qaegis', 'contact-sales', BODIES['qaegis/contact-sales'])).status, 201);
  });

  test('invalid envelopes are not counted, but invalid form data is', async () => {
    await startApp({ rateLimitStore: new MemoryRateLimitStore(), clientIpSource: 'socket' });
    for (let i = 0; i < 6; i++) assert.equal((await call('/api/v1/submissions', { body: { application: 'x' } })).status, 400);
    for (let i = 0; i < 3; i++) assert.equal((await unified('epineon', 'partnerships', { name: 'x' })).status, 400);
    assert.equal((await unified('epineon', 'partnerships', { name: 'x' })).status, 429);
  });
});

// ========================================================== origin policy

describe('origin enforcement on submissions', () => {
  test('each application accepts only its own website origins', async () => {
    assert.equal((await perApp('epineon/demo', {}, { origin: ORIGINS.epineon })).status, 201);
    assert.equal((await perApp('qaegis/contact-sales', {}, { origin: ORIGINS.qaegis })).status, 201);
    assert.equal((await perApp('epiwell/waitlist', {}, { origin: ORIGINS['epiwell'] })).status, 201);
    queries.length = 0;
    for (const [key, foreign] of [
      ['epineon/demo', ORIGINS.qaegis],
      ['qaegis/contact-sales', ORIGINS.epineon],
      ['epiwell/waitlist', ORIGINS.epineon],
      ['epineon/demo', ORIGINS['epiwell']],
    ]) {
      const res = await perApp(key, {}, { origin: foreign });
      assert.equal(res.status, 403, `${key} from ${foreign}`);
      assert.deepEqual(res.body, { status: 'error', message: 'Origin not allowed' });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    }
    assert.equal(queries.length, 0, 'nothing from a foreign origin is stored');
  });

  test('the unified endpoint applies the TARGET application\'s origins', async () => {
    assert.equal((await unified('epineon', 'demo', BODIES['epineon/demo'], { origin: ORIGINS.epineon })).status, 201);
    const cross = await unified('epineon', 'demo', BODIES['epineon/demo'], { origin: ORIGINS.qaegis });
    assert.equal(cross.status, 403);
    assert.equal(queries.length, 1);
  });

  test('near-miss origins are rejected (scheme, subdomain, suffix, port, null)', async () => {
    for (const origin of ['http://epineon.ai', 'https://www.epineon.ai', 'https://epineon.ai.evil.com', 'https://epineon.ai:8443', 'null', 'https://EPINEON.AI.']) {
      assert.equal((await perApp('epineon/demo', {}, { origin })).status, 403, origin);
    }
  });

  test('requests without an Origin header (server-to-server) are allowed on public endpoints', async () => {
    assert.equal((await perApp('epineon/demo')).status, 201);
  });
});

// ================================================================== CORS

describe('CORS preflight and headers', () => {
  const preflight = (path, origin, { method = 'POST', headers = 'content-type' } = {}) =>
    call(path, {
      method: 'OPTIONS',
      origin,
      headers: { 'access-control-request-method': method, 'access-control-request-headers': headers },
    });

  test('an allowed origin gets a precise 204 preflight answer', async () => {
    const res = await preflight('/api/v1/epineon/forms/demo', ORIGINS.epineon);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGINS.epineon);
    assert.equal(res.headers.get('access-control-allow-methods'), 'POST');
    assert.equal(res.headers.get('access-control-allow-headers'), 'content-type');
    assert.equal(res.headers.get('access-control-max-age'), '600');
    assert.equal(res.headers.get('access-control-allow-credentials'), null, 'public endpoints never allow credentials');
    assert.match(res.headers.get('vary'), /Origin/i);
    assert.equal(queries.length, 0);
  });

  test('Access-Control-Allow-Origin is never a wildcard', async () => {
    for (const path of ['/api/v1/epineon/forms/demo', '/api/v1/submissions', '/api/v1/admin/me']) {
      for (const origin of [ORIGINS.epineon, ORIGINS.admin, 'https://evil.example']) {
        const res = await preflight(path, origin);
        assert.notEqual(res.headers.get('access-control-allow-origin'), '*', `${path} ${origin}`);
      }
    }
  });

  test('another application\'s origin, unknown origins and the string "null" are refused', async () => {
    for (const origin of [ORIGINS.qaegis, 'https://evil.example', 'null', ORIGINS.admin]) {
      const res = await preflight('/api/v1/epineon/forms/demo', origin);
      assert.equal(res.status, 403, origin);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    }
  });

  test('unsupported methods and headers in the preflight are refused', async () => {
    assert.equal((await preflight('/api/v1/epineon/forms/demo', ORIGINS.epineon, { method: 'DELETE' })).status, 403);
    assert.equal((await preflight('/api/v1/epineon/forms/demo', ORIGINS.epineon, { method: 'PUT' })).status, 403);
    assert.equal((await preflight('/api/v1/epineon/forms/demo', ORIGINS.epineon, { headers: 'content-type, authorization' })).status, 403);
    assert.equal((await preflight('/api/v1/epineon/forms/demo', ORIGINS.epineon, { headers: 'x-custom' })).status, 403);
  });

  test('the actual response exposes rate-limit headers to allowed origins only', async () => {
    await startApp({ rateLimitStore: new MemoryRateLimitStore(), clientIpSource: 'socket' });
    const ok = await perApp('epineon/demo', {}, { origin: ORIGINS.epineon });
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGINS.epineon);
    assert.match(ok.headers.get('access-control-expose-headers'), /RateLimit-Remaining/);
    assert.match(ok.headers.get('access-control-expose-headers'), /Retry-After/);
  });

  test('the unified endpoint answers preflights for any registered website origin only', async () => {
    for (const origin of [ORIGINS.epineon, ORIGINS.qaegis, ORIGINS['epiwell']]) {
      assert.equal((await preflight('/api/v1/submissions', origin)).status, 204, origin);
    }
    assert.equal((await preflight('/api/v1/submissions', 'https://evil.example')).status, 403);
    assert.equal((await preflight('/api/v1/submissions', ORIGINS.admin)).status, 403);
  });

  test('admin preflights are allowed only from dashboard origins, with credentials and the Access header', async () => {
    const res = await preflight('/api/v1/admin/submissions', ORIGINS.admin, {
      method: 'PATCH',
      headers: 'content-type, cf-access-jwt-assertion',
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGINS.admin);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.match(res.headers.get('access-control-allow-methods'), /PATCH/);
    for (const origin of [ORIGINS.epineon, ORIGINS.qaegis, 'https://evil.example']) {
      assert.equal((await preflight('/api/v1/admin/submissions', origin, { method: 'PATCH' })).status, 403, origin);
    }
  });

  test('non-API paths get no CORS headers at all', async () => {
    const res = await call('/api/health', { method: 'GET', origin: ORIGINS.epineon });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  test('an OPTIONS request without preflight headers is not a CORS preflight', async () => {
    const res = await call('/api/v1/epineon/forms/demo', { method: 'OPTIONS' });
    assert.equal(res.status, 405);
  });
});

describe('CORS configuration', () => {
  test('policy matches exact origins only', () => {
    const policy = createCorsPolicy({ publicOrigins: { a: ['https://a.example'] }, adminOrigins: ['https://d.example'] });
    assert.equal(policy.isPublicAllowed('a', 'https://a.example'), true);
    assert.equal(policy.isPublicAllowed('a', 'https://a.example/'), false);
    assert.equal(policy.isPublicAllowed('b', 'https://a.example'), false);
    assert.equal(policy.isAdminAllowed('https://a.example'), false);
    assert.equal(policy.isAdminAllowed('https://d.example'), true);
    assert.equal(policy.isAnyPublicAllowed('https://a.example'), true);
  });
});

// ============================================================== anti-spam

describe('honeypot and timing over HTTP', () => {
  const GENERIC = { status: 'error', message: 'Your message could not be sent. Please try again.' };
  const startedAgo = (ms) => Date.now() - ms;

  test('a filled Epineon honeypot (companyWebsite) is rejected, stores nothing, and says nothing specific', async () => {
    const res = await perApp('epineon/demo', { companyWebsite: 'http://spam.example' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, GENERIC);
    assert.equal(queries.length, 0);
  });

  test('an empty honeypot is fine and is not stored', async () => {
    const res = await perApp('epineon/demo', { companyWebsite: '' });
    assert.equal(res.status, 201);
    assert.ok(!('company_website' in stored()) && !Object.values(stored()).includes(''));
  });

  test('too-fast submissions look identical to honeypot hits (a bot cannot tell which trap it hit)', async () => {
    const honeypot = await perApp('epineon/sales', { companyWebsite: 'x' });
    const fast = await perApp('epineon/sales', { formStartedAt: startedAgo(300) });
    assert.equal(fast.status, 400);
    assert.deepEqual(fast.body, honeypot.body);
    assert.equal(queries.length, 0);
  });

  test('stale forms (> 24 h) get an "expired" message and are not stored', async () => {
    const res = await perApp('epineon/demo', { formStartedAt: startedAgo(25 * 3_600_000) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { status: 'error', message: 'This form expired. Please reload and try again.' });
    assert.equal(queries.length, 0);
  });

  test('a human-speed submission with a timestamp is accepted and the timestamp is not stored', async () => {
    const res = await perApp('epineon/demo', { formStartedAt: startedAgo(20_000) });
    assert.equal(res.status, 201);
    assert.ok(!('form_started_at' in stored()), 'the timestamp is never stored');
  });

  test('a malformed timestamp is a validation error', async () => {
    const res = await perApp('epineon/demo', { formStartedAt: 'yesterday' });
    assert.equal(res.status, 400);
    assert.equal(res.body.details[0].field, 'formStartedAt');
  });

  test('on QAegis, companyWebsite is a REAL field (not a honeypot) and the honeypot is "website"', async () => {
    const real = await perApp('qaegis/contact-sales', { companyWebsite: 'https://example.com' });
    assert.equal(real.status, 201);
    assert.equal(stored().company_website, 'https://example.com');
    queries.length = 0;
    const trap = await perApp('qaegis/contact-sales', { website: 'spam' });
    assert.equal(trap.status, 400);
    assert.deepEqual(trap.body, GENERIC);
    assert.equal(queries.length, 0);
  });

  test('the same checks apply through the unified endpoint', async () => {
    const res = await unified('epineon', 'demo', { ...BODIES['epineon/demo'], companyWebsite: 'x' });
    assert.deepEqual(res.body, GENERIC);
    assert.equal(queries.length, 0);
  });

  test('rejections are logged without any submitted data', async () => {
    await perApp('epineon/demo', { name: 'Distinct Visitor Name', email: 'distinct.visitor@example.com', companyWebsite: 'spam' });
    const logs = logLines.join('\n');
    assert.ok(logs.includes('submission rejected'));
    assert.ok(logs.includes('"reason":"spam"'));
    assert.ok(!logs.includes('Distinct Visitor'));
    assert.ok(!logs.includes('distinct.visitor'));
  });

  test('honeypot-rejected requests still use up the rate limit', async () => {
    await startApp({ rateLimitStore: new MemoryRateLimitStore(), clientIpSource: 'socket' });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await perApp('epineon/partnerships', { website: 'x', companyWebsite: 'spam' })).status);
    assert.deepEqual(statuses, [400, 400, 400, 429]);
  });
});

// ===================================================== Epi Well waitlist

describe('Epi Well waitlist', () => {
  test('stores a lower-cased email and nothing else', async () => {
    const res = await perApp('epiwell/waitlist');
    assert.equal(res.status, 201);
    assert.equal(stored().email, 'member@example.com');
  });

  test('blocks the live site\'s disposable domains', async () => {
    for (const domain of ['mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email', 'yopmail.com']) {
      const res = await call('/api/v1/epiwell/forms/waitlist', { body: { email: `x@${domain}` } });
      assert.equal(res.status, 400, domain);
      assert.equal(res.body.details[0].code, 'blocked_domain');
    }
    assert.equal(queries.length, 0);
  });

  test('a duplicate email returns 409 and stores nothing new', async () => {
    queryImpl = async () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    };
    const res = await perApp('epiwell/waitlist');
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { status: 'error', message: 'This email is already on the waitlist.' });
    assert.ok(!res.text.includes('constraint'));
  });

  test('a unique violation on another application is an internal error, not a 409', async () => {
    queryImpl = async () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    };
    const res = await perApp('epineon/demo');
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { status: 'error', message: 'Internal Server Error' });
  });

  test('database errors on the unified endpoint are generic 500s too', async () => {
    queryImpl = async () => {
      throw Object.assign(new Error('password authentication failed for user "neondb_owner"'), { code: '28P01' });
    };
    const res = await unified('qaegis', 'contact-sales', BODIES['qaegis/contact-sales']);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { status: 'error', message: 'Internal Server Error' });
    assert.ok(!res.text.includes('neondb_owner'));
  });
});
