/**
 * Rate limiting: limits, 429s, headers, reset, per-client / per-website /
 * per-form independence, concurrency, store failures and privacy.
 *
 * Runs the real app with an in-memory store and a controllable clock.
 * The same behavior against PostgreSQL is covered by
 * tests/database.integration.test.js (opt-in, real database).
 */
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { MemoryRateLimitStore, PostgresRateLimitStore } from '../src/shared/security/rateLimitStores.js';
import { rateLimit, clientKeyFor, defineRateLimitRules } from '../src/shared/security/rateLimit.js';
import { database } from '../src/shared/database/index.js';
import { formRateLimits as epineonLimits } from '../src/applications/epineon/config/rate-limits.js';
import { formRateLimits as qaegisLimits } from '../src/applications/qaegis/config/rate-limits.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const logLines = [];
let clock;
let server;
let baseUrl;
const queries = [];

const PAYLOADS = {
  '/api/v1/epineon/forms/demo': {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    company: 'Analytical Engines',
    product: 'EPICRYPT',
  },
  '/api/v1/epineon/forms/sales': {
    name: 'Grace Hopper',
    email: 'grace@example.org',
    company: 'Compilers Inc',
    product: 'Multiple products',
    useCase: 'Enterprise AI security',
    message: 'Hello',
  },
  '/api/v1/epineon/forms/partnerships': {
    name: 'Alan Turing',
    email: 'alan@example.co.uk',
    organization: 'Bletchley',
    nature: 'Investment',
  },
  '/api/v1/qaegis/forms/contact-sales': {
    firstName: 'Katherine',
    lastName: 'Johnson',
    workEmail: 'katherine@example.com',
    userRange: '51-250',
    message: 'SSO',
  },
  '/api/v1/epi-well/forms/waitlist': { email: 'member@example.com' },
};
const DEMO = '/api/v1/epineon/forms/demo';
const SALES = '/api/v1/epineon/forms/sales';
const VENTURES = '/api/v1/epineon/forms/partnerships';
const QAEGIS = '/api/v1/qaegis/forms/contact-sales';

before(async () => {
  mock.method(console, 'log', (line) => logLines.push(String(line)));
  mock.method(console, 'error', (line) => logLines.push(String(line)));
  // Submissions are "stored" in a recorder, not a real database.
  mock.method(database, 'query', async (text, params) => {
    queries.push({ text, params });
    return { rows: [], rowCount: 1 };
  });
});

after(() => mock.restoreAll());

async function startApp(options) {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = createApp(options).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function post(path, { ip = '203.0.113.10', body = PAYLOADS[path], headers = {} } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
    body: JSON.stringify(body),
  });
}

async function postMany(path, count, options) {
  const statuses = [];
  for (let i = 0; i < count; i++) statuses.push((await post(path, options)).status);
  return statuses;
}

const demoShort = epineonLimits.demo.find((r) => r.windowSeconds === 600);

// ---------------------------------------------------------------------------

describe('rate limiting over HTTP (cloudflare-worker mode, in-memory store)', () => {
  beforeEach(async () => {
    clock = Date.UTC(2026, 10, 19, 12, 0, 0); // window-aligned start
    await startApp({
      clientIpSource: 'cloudflare-worker',
      rateLimitStore: new MemoryRateLimitStore({ now: () => clock }),
      rateLimitSecret: SECRET,
    });
  });

  test('requests within the limit succeed and carry RateLimit headers', async () => {
    for (let i = 1; i <= demoShort.limit; i++) {
      const res = await post(DEMO);
      assert.equal(res.status, 201, `request ${i}`);
      assert.equal(res.headers.get('ratelimit-limit'), String(demoShort.limit));
      assert.equal(res.headers.get('ratelimit-remaining'), String(demoShort.limit - i));
      assert.equal(res.headers.get('ratelimit-reset'), '600');
      assert.equal(res.headers.get('ratelimit-policy'), '5;w=600, 20;w=86400');
      assert.equal(res.headers.get('retry-after'), null);
    }
  });

  test('the request over the limit gets 429 with Retry-After and a JSON error', async () => {
    await postMany(DEMO, demoShort.limit);
    const res = await post(DEMO);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('retry-after'), '600');
    assert.equal(res.headers.get('ratelimit-remaining'), '0');
    assert.deepEqual(await res.json(), {
      status: 'error',
      message: 'Too many requests. Please try again later.',
    });
  });

  test('rate-limited submissions are not stored', async () => {
    await postMany(DEMO, demoShort.limit);
    queries.length = 0;
    const res = await post(DEMO);
    assert.equal(res.status, 429);
    assert.equal(queries.length, 0);
  });

  test('invalid submissions count toward the limit (no free probing)', async () => {
    const statuses = await postMany(DEMO, demoShort.limit + 1, { body: { name: 'x' } });
    assert.deepEqual(statuses, [...Array(demoShort.limit).fill(400), 429]);
  });

  test('the limit resets when the window ends', async () => {
    await postMany(DEMO, demoShort.limit + 1);
    clock += 599_000;
    assert.equal((await post(DEMO)).status, 429, 'still limited 1s before reset');
    const blocked = await post(DEMO);
    assert.equal(blocked.headers.get('retry-after'), '1');

    clock += 1_000; // next 10-minute window
    const res = await post(DEMO);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('ratelimit-remaining'), String(demoShort.limit - 1));
  });

  test('the daily limit applies across short windows', async () => {
    const daily = epineonLimits.demo.find((r) => r.windowSeconds === 86_400);
    let accepted = 0;
    for (let window = 0; window < 10 && accepted < daily.limit; window++) {
      for (let i = 0; i < demoShort.limit && accepted < daily.limit; i++) {
        assert.equal((await post(DEMO)).status, 201);
        accepted++;
      }
      clock += 600_000;
    }
    assert.equal(accepted, daily.limit);
    const res = await post(DEMO);
    assert.equal(res.status, 429);
    // Retry-After points at the end of the day window, not the 10-minute one.
    assert.ok(Number(res.headers.get('retry-after')) > 600);
    assert.equal(res.headers.get('ratelimit-limit'), String(daily.limit));
  });

  test('different client IPs are limited independently', async () => {
    await postMany(DEMO, demoShort.limit + 1, { ip: '203.0.113.10' });
    assert.equal((await post(DEMO, { ip: '203.0.113.10' })).status, 429);
    assert.equal((await post(DEMO, { ip: '198.51.100.7' })).status, 201);
    assert.equal((await post(DEMO, { ip: '2001:db8:1::1' })).status, 201);
  });

  test('IPv6 clients are grouped by /64 so rotating addresses does not bypass limits', async () => {
    for (let i = 1; i <= demoShort.limit; i++) {
      assert.equal((await post(DEMO, { ip: `2001:db8:aaaa:bbbb::${i}` })).status, 201);
    }
    assert.equal((await post(DEMO, { ip: '2001:db8:aaaa:bbbb:ffff::99' })).status, 429);
    assert.equal((await post(DEMO, { ip: '2001:db8:aaaa:cccc::1' })).status, 201, 'other /64');
  });

  test('IPv4-mapped IPv6 counts as the same IPv4 client', async () => {
    await postMany(DEMO, demoShort.limit, { ip: '203.0.113.50' });
    assert.equal((await post(DEMO, { ip: '::ffff:203.0.113.50' })).status, 429);
  });

  test('each form endpoint has its own counter', async () => {
    await postMany(DEMO, demoShort.limit + 1);
    assert.equal((await post(DEMO)).status, 429);
    assert.equal((await post(SALES)).status, 201);
    assert.equal((await post(VENTURES)).status, 201);
  });

  test('each website has its own counters', async () => {
    await postMany(DEMO, demoShort.limit + 1);
    await postMany(SALES, 6);
    await postMany(VENTURES, 4);
    // Exhausting every Epineon form does not affect QAegis.
    const res = await post(QAEGIS);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('ratelimit-remaining'), '4');
  });

  test('forms use their own configured limits', async () => {
    const partnerships = epineonLimits.partnerships.find((r) => r.windowSeconds === 600);
    const statuses = await postMany(VENTURES, partnerships.limit + 1);
    assert.deepEqual(statuses, [...Array(partnerships.limit).fill(201), 429]);
    const res = await post(QAEGIS);
    assert.equal(res.headers.get('ratelimit-policy'), '5;w=600, 20;w=86400');
  });

  test('concurrent requests cannot exceed the limit', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => post(DEMO)));
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, demoShort.limit);
    assert.equal(statuses.filter((s) => s === 429).length, 25 - demoShort.limit);
  });

  test('forwarding headers other than CF-Connecting-IP are ignored', async () => {
    await postMany(DEMO, demoShort.limit + 1, { ip: '203.0.113.10' });
    const res = await post(DEMO, {
      ip: '203.0.113.10',
      headers: {
        'x-forwarded-for': '198.51.100.1',
        'x-real-ip': '198.51.100.2',
        'true-client-ip': '198.51.100.3',
      },
    });
    assert.equal(res.status, 429);
  });

  test('requests without a valid CF-Connecting-IP are rejected', async () => {
    for (const ip of [undefined, 'not-an-ip', '1.2.3.4, 5.6.7.8', '999.1.1.1']) {
      const res = await fetch(`${baseUrl}${DEMO}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) },
        body: JSON.stringify(PAYLOADS[DEMO]),
      });
      assert.equal(res.status, 400, `ip=${ip}`);
      assert.deepEqual(await res.json(), { status: 'error', message: 'Unable to identify client' });
    }
  });

  test('health endpoints are not rate limited', async () => {
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${baseUrl}/api/health`, { headers: { 'cf-connecting-ip': '203.0.113.10' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('ratelimit-limit'), null);
    }
  });
});

describe('socket mode (local development)', () => {
  before(async () => {
    clock = Date.UTC(2026, 10, 19, 12, 0, 0);
    await startApp({
      clientIpSource: 'socket',
      rateLimitStore: new MemoryRateLimitStore({ now: () => clock }),
      rateLimitSecret: SECRET,
    });
  });

  test('spoofed CF-Connecting-IP / X-Forwarded-For cannot bypass the limit', async () => {
    const statuses = [];
    for (let i = 0; i < demoShort.limit + 3; i++) {
      const res = await post(DEMO, {
        ip: `198.51.100.${i}`, // ignored in socket mode
        headers: { 'x-forwarded-for': `192.0.2.${i}` },
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [...Array(demoShort.limit).fill(201), 429, 429, 429]);
  });
});

// ---------------------------------------------------------------------------

describe('store failures', () => {
  test('a failing rate-limit store returns a generic 503 and processes nothing', async () => {
    const failingDb = {
      query: async () => {
        const err = new Error('connect ETIMEDOUT 10.0.0.5:5432 user=neondb_owner password=hunter2');
        err.code = 'ETIMEDOUT';
        throw err;
      },
    };
    await startApp({
      clientIpSource: 'cloudflare-worker',
      rateLimitStore: new PostgresRateLimitStore({ database: failingDb }),
      rateLimitSecret: SECRET,
    });
    logLines.length = 0;
    queries.length = 0;

    const res = await post(QAEGIS);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: 'error', message: 'Service temporarily unavailable' });
    assert.equal(queries.length, 0, 'submission must not be stored');

    const logs = logLines.join('\n');
    assert.ok(logs.includes('rate limit store unavailable'));
    assert.ok(logs.includes('ETIMEDOUT'));
    for (const secret of ['hunter2', 'neondb_owner', '10.0.0.5', '203.0.113.10', 'katherine@example.com']) {
      assert.ok(!logs.includes(secret), `log leaked ${secret}`);
    }
  });
});

describe('PostgresRateLimitStore (SQL contract, mocked database)', () => {
  test('sends one atomic, parameterized statement and maps the result', async () => {
    const calls = [];
    const fakeDb = {
      query: async (text, params) => {
        calls.push({ text, params });
        return {
          rows: [
            { window_seconds: 600, hits: 3, reset_seconds: 120 },
            { window_seconds: 86400, hits: 7, reset_seconds: 5000 },
          ],
        };
      },
    };
    const store = new PostgresRateLimitStore({ database: fakeDb, cleanupProbability: 0 });
    const key = clientKeyFor('203.0.113.10', SECRET);
    const result = await store.hit('epineon:demo', key, [600, 86400]);

    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /INSERT INTO platform_security\.rate_limit_counters/);
    assert.match(calls[0].text, /ON CONFLICT \(scope, client_key, window_seconds, window_start\)\s+DO UPDATE SET hits = c\.hits \+ 1/);
    assert.deepEqual(calls[0].params, ['epineon:demo', key, [600, 86400]]);
    assert.ok(!calls[0].text.includes('203.0.113.10'));
    assert.deepEqual(result, [
      { windowSeconds: 600, hits: 3, resetSeconds: 120 },
      { windowSeconds: 86400, hits: 7, resetSeconds: 5000 },
    ]);
  });

  test('runs bounded cleanup of expired counters when sampled', async () => {
    const calls = [];
    const fakeDb = {
      query: async (text) => {
        calls.push(text);
        return { rows: [{ window_seconds: 60, hits: 1, reset_seconds: 60 }] };
      },
    };
    const store = new PostgresRateLimitStore({ database: fakeDb, cleanupProbability: 1 });
    await store.hit('qaegis:contact-sales', 'a'.repeat(64), [60]);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /DELETE FROM platform_security\.rate_limit_counters/);
    assert.match(calls[1], /expires_at < now\(\) LIMIT 1000/);
  });

  test('a failed cleanup does not fail the request', async () => {
    let n = 0;
    const fakeDb = {
      query: async () => {
        if (n++ === 1) throw Object.assign(new Error('boom'), { code: '57014' });
        return { rows: [{ window_seconds: 60, hits: 1, reset_seconds: 60 }] };
      },
    };
    const store = new PostgresRateLimitStore({ database: fakeDb, cleanupProbability: 1 });
    const result = await store.hit('qaegis:contact-sales', 'a'.repeat(64), [60]);
    assert.equal(result[0].hits, 1);
  });
});

describe('client keys (privacy)', () => {
  test('raw IPs are never used as keys: HMAC-SHA256, 64 hex chars', () => {
    const key = clientKeyFor('203.0.113.10', SECRET);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!key.includes('203'));
  });

  test('keys depend on the secret', () => {
    assert.notEqual(
      clientKeyFor('203.0.113.10', SECRET),
      clientKeyFor('203.0.113.10', `${SECRET}x`),
    );
  });

  test('the same /64 maps to the same key; IPv4-mapped maps to IPv4', () => {
    assert.equal(clientKeyFor('2001:db8::1', SECRET), clientKeyFor('2001:db8::ffff', SECRET));
    assert.equal(clientKeyFor('203.0.113.10', SECRET), clientKeyFor('::ffff:203.0.113.10', SECRET));
  });

  test('responses and logs never contain the client IP', async () => {
    clock = Date.UTC(2026, 10, 19, 12, 0, 0);
    await startApp({
      clientIpSource: 'cloudflare-worker',
      rateLimitStore: new MemoryRateLimitStore({ now: () => clock }),
      rateLimitSecret: SECRET,
    });
    logLines.length = 0;
    const ip = '192.0.2.199';
    const responses = [];
    for (let i = 0; i < demoShort.limit + 1; i++) {
      const res = await post(DEMO, { ip });
      responses.push(JSON.stringify([...res.headers]) + (await res.text()));
    }
    assert.ok(responses.at(-1).includes('Too many requests'));
    for (const r of responses) assert.ok(!r.includes(ip));
    assert.ok(!logLines.join('\n').includes(ip));
  });
});

describe('rate limit configuration', () => {
  test('rejects invalid rules at startup', () => {
    assert.throws(() => defineRateLimitRules([]));
    assert.throws(() => defineRateLimitRules([{ limit: 0, windowSeconds: 60 }]));
    assert.throws(() => defineRateLimitRules([{ limit: 5, windowSeconds: 0 }]));
    assert.throws(() => defineRateLimitRules([{ limit: 5, windowSeconds: 1.5 }]));
    assert.throws(() => defineRateLimitRules([{ limit: 5, windowSeconds: 8 * 86400 }]));
    assert.throws(() => defineRateLimitRules([{ limit: 5, windowSeconds: 60 }, { limit: 9, windowSeconds: 60 }]));
  });

  test('rejects invalid scopes', () => {
    const rules = [{ limit: 1, windowSeconds: 60 }];
    for (const scope of ['', 'epineon', 'Epineon:demo', 'epineon:demo:x', "epineon:demo'--"]) {
      assert.throws(() => rateLimit({ scope, rules }), undefined, scope);
    }
  });

  test('every Epineon and QAegis form has independent limits', () => {
    assert.deepEqual(Object.keys(epineonLimits).sort(), ['demo', 'partnerships', 'sales']);
    assert.deepEqual(Object.keys(qaegisLimits), ['contact-sales']);
    for (const rules of [...Object.values(epineonLimits), ...Object.values(qaegisLimits)]) {
      assert.doesNotThrow(() => defineRateLimitRules(rules));
    }
  });
});
