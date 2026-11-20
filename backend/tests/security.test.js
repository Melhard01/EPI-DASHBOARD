/**
 * Transport and HTTP security: trusted client IP resolution, HTTPS
 * enforcement, security headers, method handling, malformed requests,
 * production configuration rules and database TLS requirements.
 */
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { loadEnv, assertSecureDatabaseUrl } from '../src/shared/config/env.js';
import { parseIp, createCidrMatcher, rateLimitSubject } from '../src/shared/security/ipAddress.js';
import { resolveClientIp, isSecureRequest, ORIGIN_AUTH_HEADER } from '../src/shared/security/clientIp.js';
import { database } from '../src/shared/database/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logLines = [];

before(() => {
  mock.method(console, 'log', (line) => logLines.push(String(line)));
  mock.method(console, 'error', (line) => logLines.push(String(line)));
  mock.method(database, 'query', async () => ({ rows: [], rowCount: 1 }));
});
after(() => mock.restoreAll());

async function withApp(options, fn) {
  const server = createApp(options).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const fakeReq = (remoteAddress, headers = {}, encrypted = undefined) => ({
  socket: { remoteAddress, encrypted },
  headers,
});

// ------------------------------------------------------------- IP parsing

describe('IP address parsing', () => {
  test('accepts valid IPv4 and IPv6, rejects garbage', () => {
    for (const ip of ['1.2.3.4', '255.255.255.255', '::1', '2001:db8::1', '::ffff:1.2.3.4', '2001:db8:0:0:0:0:0:1']) {
      assert.ok(parseIp(ip), ip);
    }
    for (const ip of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.4 ', 'abc', '2001:db8:::1',
      '1:2:3:4:5:6:7:8:9', 'fe80::1%eth0', '1.2.3.4/24', 'x'.repeat(100)]) {
      assert.equal(parseIp(ip), null, JSON.stringify(ip));
    }
  });

  test('CIDR matching', () => {
    const matches = createCidrMatcher(['173.245.48.0/20', '2606:4700::/32']);
    assert.ok(matches('173.245.48.1'));
    assert.ok(matches('173.245.63.255'));
    assert.ok(!matches('173.245.64.0'));
    assert.ok(matches('2606:4700:10::6816:1'));
    assert.ok(!matches('2606:4701::1'));
    assert.ok(matches('::ffff:173.245.48.1'), 'IPv4-mapped');
    assert.ok(!matches('garbage'));
    assert.throws(() => createCidrMatcher(['1.2.3.4/33']));
  });

  test('rate-limit subject normalization', () => {
    assert.equal(rateLimitSubject('203.0.113.10'), 'v4:203.0.113.10');
    assert.equal(rateLimitSubject('::ffff:203.0.113.10'), 'v4:203.0.113.10');
    assert.equal(rateLimitSubject('2001:db8:aa:bb:1:2:3:4'), 'v6:20010db800aa00bb::/64');
    assert.equal(rateLimitSubject('bogus'), null);
  });
});

// ------------------------------------------------------ trusted client IP

describe('client IP resolution', () => {
  const CF_EDGE = '172.70.1.1'; // inside 172.64.0.0/13
  const CF_EDGE_V6 = '2a06:98c1::1'; // inside 2a06:98c0::/29

  test('socket mode uses the TCP peer and ignores every header', () => {
    const req = fakeReq('192.0.2.5', {
      'cf-connecting-ip': '198.51.100.1',
      'x-forwarded-for': '198.51.100.2',
      'x-real-ip': '198.51.100.3',
    });
    assert.equal(resolveClientIp(req, 'socket'), '192.0.2.5');
  });

  test('cloudflare-worker mode uses CF-Connecting-IP only', () => {
    const req = fakeReq('127.0.0.1', { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '6.6.6.6' });
    assert.equal(resolveClientIp(req, 'cloudflare-worker'), '198.51.100.1');
  });

  test('cloudflare-proxy mode trusts CF-Connecting-IP only from Cloudflare edge IPs', () => {
    assert.equal(
      resolveClientIp(fakeReq(CF_EDGE, { 'cf-connecting-ip': '198.51.100.1' }), 'cloudflare-proxy'),
      '198.51.100.1',
    );
    assert.equal(
      resolveClientIp(fakeReq(CF_EDGE_V6, { 'cf-connecting-ip': '2001:db8::5' }), 'cloudflare-proxy'),
      '2001:db8::5',
    );
    assert.equal(
      resolveClientIp(fakeReq(`::ffff:${CF_EDGE}`, { 'cf-connecting-ip': '198.51.100.1' }), 'cloudflare-proxy'),
      '198.51.100.1',
    );
  });

  test('cloudflare-proxy mode rejects direct-to-origin requests with a spoofed header', () => {
    for (const peer of ['203.0.113.9', '127.0.0.1', '10.0.0.1', '2001:db8::1', undefined]) {
      assert.throws(
        () => resolveClientIp(fakeReq(peer, { 'cf-connecting-ip': '198.51.100.1' }), 'cloudflare-proxy'),
        (err) => err.statusCode === 403 && err.message === 'Forbidden',
        String(peer),
      );
    }
  });

  test('missing, invalid or duplicated CF-Connecting-IP is rejected', () => {
    for (const value of [undefined, '', 'abc', '1.2.3.4, 5.6.7.8', ['1.2.3.4', '5.6.7.8']]) {
      const headers = value === undefined ? {} : { 'cf-connecting-ip': value };
      assert.throws(
        () => resolveClientIp(fakeReq(CF_EDGE, headers), 'cloudflare-proxy'),
        (err) => err.statusCode === 400,
        JSON.stringify(value),
      );
    }
  });

  describe('vercel-cloudflare mode', () => {
    const SECRET = 's'.repeat(40);
    const via = (peer, extra = {}) =>
      fakeReq('127.0.0.1', { 'x-vercel-forwarded-for': peer, 'cf-connecting-ip': '198.51.100.1', ...extra });

    test('trusts CF-Connecting-IP when Vercel reports a Cloudflare edge peer and the secret matches', () => {
      const opts = { originSecret: SECRET };
      assert.equal(resolveClientIp(via(CF_EDGE, { [ORIGIN_AUTH_HEADER]: SECRET }), 'vercel-cloudflare', opts), '198.51.100.1');
      assert.equal(
        resolveClientIp(via(CF_EDGE_V6, { [ORIGIN_AUTH_HEADER]: SECRET, 'cf-connecting-ip': '2001:db8::5' }), 'vercel-cloudflare', opts),
        '2001:db8::5',
      );
    });

    test('rejects a direct hit on the Vercel address (peer is not Cloudflare) even with a spoofed header', () => {
      for (const peer of ['203.0.113.9', '127.0.0.1', '10.0.0.1', '2001:db8::1']) {
        assert.throws(
          () => resolveClientIp(via(peer, { [ORIGIN_AUTH_HEADER]: SECRET }), 'vercel-cloudflare', { originSecret: SECRET }),
          (err) => err.statusCode === 403,
          peer,
        );
      }
      assert.throws(
        () => resolveClientIp(fakeReq(CF_EDGE, { 'cf-connecting-ip': '198.51.100.1' }), 'vercel-cloudflare', {}),
        (err) => err.statusCode === 403,
        'the TCP peer and X-Forwarded-For are never used in this mode',
      );
      assert.throws(
        () => resolveClientIp(fakeReq('127.0.0.1', { 'x-forwarded-for': CF_EDGE, 'cf-connecting-ip': '198.51.100.1' }), 'vercel-cloudflare', {}),
        (err) => err.statusCode === 403,
      );
    });

    test('rejects a missing, wrong, repeated or differently-sized origin secret', () => {
      const opts = { originSecret: SECRET };
      for (const value of [undefined, '', 'wrong', SECRET + 'x', SECRET.slice(1), `${SECRET}, ${SECRET}`]) {
        const headers = value === undefined ? {} : { [ORIGIN_AUTH_HEADER]: value };
        assert.throws(
          () => resolveClientIp(via(CF_EDGE, headers), 'vercel-cloudflare', opts),
          (err) => err.statusCode === 403,
          JSON.stringify(value),
        );
      }
    });

    test('without a configured secret the edge-peer check alone applies (non-production)', () => {
      assert.equal(resolveClientIp(via(CF_EDGE), 'vercel-cloudflare', {}), '198.51.100.1');
    });

    test('an invalid or duplicated CF-Connecting-IP is rejected with 400', () => {
      for (const value of [undefined, '', 'abc', '1.2.3.4, 5.6.7.8']) {
        const headers = { [ORIGIN_AUTH_HEADER]: SECRET };
        const req = fakeReq('127.0.0.1', { 'x-vercel-forwarded-for': CF_EDGE, ...headers, ...(value === undefined ? {} : { 'cf-connecting-ip': value }) });
        assert.throws(() => resolveClientIp(req, 'vercel-cloudflare', { originSecret: SECRET }), (err) => err.statusCode === 400, JSON.stringify(value));
      }
    });

    test('X-Forwarded-Proto is trusted only on a verified Cloudflare request', () => {
      const opts = { originSecret: SECRET };
      const good = via(CF_EDGE, { [ORIGIN_AUTH_HEADER]: SECRET, 'x-forwarded-proto': 'https' });
      const noSecret = via(CF_EDGE, { 'x-forwarded-proto': 'https' });
      const direct = via('203.0.113.9', { [ORIGIN_AUTH_HEADER]: SECRET, 'x-forwarded-proto': 'https' });
      assert.equal(isSecureRequest(good, 'vercel-cloudflare', opts), true);
      assert.equal(isSecureRequest(noSecret, 'vercel-cloudflare', opts), false);
      assert.equal(isSecureRequest(direct, 'vercel-cloudflare', opts), false);
      assert.equal(isSecureRequest(via(CF_EDGE, { [ORIGIN_AUTH_HEADER]: SECRET, 'x-forwarded-proto': 'http' }), 'vercel-cloudflare', opts), false);
    });
  });

  test('unknown modes fail loudly', () => {
    assert.throws(() => resolveClientIp(fakeReq('1.2.3.4'), 'x-forwarded-for'));
  });
});

// ------------------------------------------------------------------ HTTPS

describe('HTTPS detection', () => {
  test('X-Forwarded-Proto is trusted only from Cloudflare', () => {
    const viaEdge = fakeReq('172.70.1.1', { 'x-forwarded-proto': 'https' });
    const direct = fakeReq('203.0.113.9', { 'x-forwarded-proto': 'https' });
    assert.equal(isSecureRequest(viaEdge, 'cloudflare-proxy'), true);
    assert.equal(isSecureRequest(direct, 'cloudflare-proxy'), false);
    assert.equal(isSecureRequest(direct, 'socket'), false, 'never trusted in socket mode');
    assert.equal(isSecureRequest(fakeReq('1.1.1.1', { 'x-forwarded-proto': 'https' }), 'cloudflare-worker'), true);
    assert.equal(isSecureRequest(fakeReq('1.1.1.1', { 'x-forwarded-proto': 'http' }), 'cloudflare-worker'), false);
    assert.equal(isSecureRequest(fakeReq('1.1.1.1', {}), 'cloudflare-worker'), false);
  });

  test('a TLS socket is always secure', () => {
    assert.equal(isSecureRequest(fakeReq('192.0.2.1', {}, true), 'socket'), true);
  });
});

describe('HTTPS enforcement (production behavior)', () => {
  const options = { clientIpSource: 'cloudflare-worker', enforceHttps: true, rateLimitStore: null };

  test('plain HTTP is rejected with 403 JSON and never redirected', async () => {
    await withApp(options, async (base) => {
      for (const proto of ['http', undefined]) {
        const res = await fetch(`${base}/api/v1/epineon/forms/demo`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'content-type': 'application/json',
            'cf-connecting-ip': '198.51.100.1',
            ...(proto ? { 'x-forwarded-proto': proto } : {}),
          },
          body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', company: 'C', product: 'EPICRYPT' }),
        });
        assert.equal(res.status, 403);
        assert.equal(res.headers.get('location'), null, 'must not redirect');
        assert.deepEqual(await res.json(), { status: 'error', message: 'HTTPS is required' });
      }
    });
  });

  test('HTTPS requests are accepted and receive HSTS', async () => {
    await withApp(options, async (base) => {
      const res = await fetch(`${base}/api/health`, {
        headers: { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-proto': 'https' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
    });
  });

  test('HSTS is also sent on rejected plain-HTTP responses', async () => {
    await withApp(options, async (base) => {
      const res = await fetch(`${base}/api/health`, { headers: { 'cf-connecting-ip': '198.51.100.1' } });
      assert.equal(res.status, 403);
      assert.ok(res.headers.get('strict-transport-security'));
    });
  });

  test('local development does not send HSTS', async () => {
    await withApp({ rateLimitStore: null }, async (base) => {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('strict-transport-security'), null);
    });
  });
});

// ------------------------------------------------- headers / methods / input

describe('HTTP hardening', () => {
  let base;
  let server;
  before(async () => {
    server = createApp({ rateLimitStore: null }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  test('security headers are present on success, error and 404 responses', async () => {
    for (const [method, url] of [['GET', '/api/health'], ['GET', '/nope'], ['POST', '/api/v1/qaegis/forms/contact-sales']]) {
      const res = await fetch(`${base}${url}`, { method });
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
      assert.equal(res.headers.get('x-powered-by'), null);
      assert.equal(res.headers.get('etag'), null);
      assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    }
  });

  test('a client-supplied X-Request-Id is not trusted', async () => {
    const res = await fetch(`${base}/api/health`, { headers: { 'x-request-id': 'attacker' } });
    assert.notEqual(res.headers.get('x-request-id'), 'attacker');
  });

  test('wrong methods get 405 with Allow on every known route', async () => {
    const cases = [
      ['DELETE', '/api/health', 'GET, HEAD'],
      ['POST', '/api/health/database', 'GET, HEAD'],
      ['PUT', '/api/v1/epineon/health', 'GET, HEAD'],
      ['GET', '/api/v1/epineon/forms/sales', 'POST'],
      ['PATCH', '/api/v1/qaegis/forms/contact-sales', 'POST'],
      ['DELETE', '/api/v1/epineon/forms/partnerships', 'POST'],
    ];
    for (const [method, url, allow] of cases) {
      const res = await fetch(`${base}${url}`, { method });
      assert.equal(res.status, 405, `${method} ${url}`);
      assert.equal(res.headers.get('allow'), allow);
      assert.deepEqual(await res.json(), { status: 'error', message: 'Method not allowed' });
    }
  });

  test('HEAD on health works', async () => {
    const res = await fetch(`${base}/api/health`, { method: 'HEAD' });
    assert.equal(res.status, 200);
  });

  test('unknown routes still return 404', async () => {
    const res = await fetch(`${base}/api/v1/epineon/forms/nope`, { method: 'POST' });
    assert.equal(res.status, 404);
  });

  test('compressed request bodies are refused (no decompression bombs)', async () => {
    const res = await fetch(`${base}/api/v1/qaegis/forms/contact-sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
    });
    assert.equal(res.status, 415);
    assert.deepEqual(await res.json(), { status: 'error', message: 'Unsupported content encoding' });
  });

  test('unsupported charsets are refused', async () => {
    const res = await fetch(`${base}/api/v1/qaegis/forms/contact-sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=iso-8859-1' },
      body: '{}',
    });
    assert.equal(res.status, 415);
  });

  test('deeply nested JSON is rejected cleanly', async () => {
    const depth = 20_000;
    const res = await fetch(`${base}/api/v1/qaegis/forms/contact-sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"needs":' + '['.repeat(depth) + ']'.repeat(depth) + '}',
    });
    assert.equal(res.status, 400);
  });

  test('malformed URL encoding returns a generic 400 or 404, never a 500', async () => {
    const res = await fetch(`${base}/api/v1/epineon/forms/%E0%A4%A`, { method: 'POST' });
    assert.ok([400, 404].includes(res.status), String(res.status));
    const body = await res.json();
    assert.equal(body.status, 'error');
    assert.ok(!JSON.stringify(body).includes('URIError'));
  });

  test('sensitive request headers never reach logs or responses', async () => {
    logLines.length = 0;
    const secrets = ['Bearer super-secret-token', 'session=abc123secret', 'basic-api-key-xyz'];
    const res = await fetch(`${base}/api/v1/qaegis/forms/contact-sales?email=leak%40example.com`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: secrets[0],
        cookie: secrets[1],
        'x-api-key': secrets[2],
      },
      body: JSON.stringify({ firstName: 'Kat', lastName: 'J', workEmail: 'kat@example.com', userRange: '1-50', message: 'x' }),
    });
    const text = JSON.stringify([...res.headers]) + (await res.text());
    const logs = logLines.join('\n');
    for (const s of [...secrets, 'leak@example.com', 'leak%40example.com', 'kat@example.com']) {
      assert.ok(!text.includes(s), `response leaked ${s}`);
      assert.ok(!logs.includes(s), `log leaked ${s}`);
    }
  });
});

// ---------------------------------------------------- production config

describe('production configuration rules', () => {
  const SECURE_DB = 'postgresql://user:pw@db.example.com/app?sslmode=verify-full';
  const valid = {
    NODE_ENV: 'production',
    DATABASE_URL: SECURE_DB,
    CLIENT_IP_SOURCE: 'cloudflare-worker',
    RATE_LIMIT_SECRET: 'x'.repeat(32),
    ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
    ACCESS_AUD: 'a'.repeat(64),
  };

  test('a complete secure configuration loads', () => {
    const cfg = loadEnv(valid);
    assert.equal(cfg.enforceHttps, true);
    assert.equal(cfg.rateLimitStore, 'postgres');
    assert.equal(cfg.clientIpSource, 'cloudflare-worker');
  });

  test('Vercel behind Cloudflare: loads only with a strong ORIGIN_AUTH_SECRET', () => {
    const vercel = { ...valid, CLIENT_IP_SOURCE: 'vercel-cloudflare' };
    assert.throws(() => loadEnv(vercel), /ORIGIN_AUTH_SECRET/);
    assert.throws(() => loadEnv({ ...vercel, ORIGIN_AUTH_SECRET: 'short' }), /at least 32/);
    const cfg = loadEnv({ ...vercel, ORIGIN_AUTH_SECRET: 'o'.repeat(32) });
    assert.equal(cfg.clientIpSource, 'vercel-cloudflare');
    assert.equal(cfg.originAuthSecret, 'o'.repeat(32));
    // other Cloudflare modes do not require it
    assert.equal(loadEnv(valid).originAuthSecret, null);
  });

  test('HTTPS enforcement is always on in production and off locally', () => {
    assert.equal(loadEnv(valid).enforceHttps, true);
    assert.equal(loadEnv({ NODE_ENV: 'development' }).enforceHttps, false);
  });

  const failures = [
    ['missing DATABASE_URL', { DATABASE_URL: undefined }, /DATABASE_URL is required/],
    ['socket client IP source', { CLIENT_IP_SOURCE: 'socket' }, /behind Cloudflare/],
    ['default client IP source', { CLIENT_IP_SOURCE: undefined }, /behind Cloudflare/],
    ['unknown client IP source', { CLIENT_IP_SOURCE: 'x-forwarded-for' }, /Invalid CLIENT_IP_SOURCE/],
    ['in-memory rate limiting', { RATE_LIMIT_STORE: 'memory' }, /RATE_LIMIT_STORE=postgres/],
    ['missing rate limit secret', { RATE_LIMIT_SECRET: undefined }, /RATE_LIMIT_SECRET is required/],
    ['short rate limit secret', { RATE_LIMIT_SECRET: 'short' }, /at least 32/],
    ['no admin auth configured', { ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined }, /AUTH_MODE=cloudflare-access/],
    ['dev admin auth', { AUTH_MODE: 'dev' }, /AUTH_MODE=cloudflare-access/],
    ['admin auth without audience', { ACCESS_AUD: undefined }, /ACCESS_TEAM_DOMAIN and ACCESS_AUD/],
    ['http CORS origin', { CORS_ORIGINS_EPINEON: 'http://epineon.ai' }, /https/],
    ['plain-HTTP localhost CORS origin', { ADMIN_ALLOWED_ORIGINS: 'http://localhost:5173' }, /https/],
    ['sslmode=require', { DATABASE_URL: SECURE_DB.replace('verify-full', 'require') }, /verify-full/],
    ['sslmode=disable', { DATABASE_URL: SECURE_DB.replace('verify-full', 'disable') }, /verify-full/],
    ['no sslmode', { DATABASE_URL: 'postgresql://user:pw@db.example.com/app' }, /verify-full/],
  ];
  for (const [name, override, pattern] of failures) {
    test(`refuses to start with ${name}`, () => {
      assert.throws(() => loadEnv({ ...valid, ...override }), pattern);
    });
  }

  test('configuration errors never include the connection string', () => {
    const secretUrl = 'postgresql://admin:TopSecretPw@db.example.com/app?sslmode=disable';
    try {
      loadEnv({ ...valid, DATABASE_URL: secretUrl });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(!err.message.includes('TopSecretPw'));
      assert.ok(!err.message.includes('admin'));
    }
  });

  test('the server process refuses to start with insecure production settings', () => {
    const result = spawnSync(process.execPath, ['-e', "import('./src/app.js')"], {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://admin:TopSecretPw@db.example.com/app?sslmode=disable',
        CLIENT_IP_SOURCE: 'cloudflare-worker',
        RATE_LIMIT_SECRET: 'x'.repeat(32),
        ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
        ACCESS_AUD: 'a'.repeat(64),
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sslmode=verify-full/);
    assert.ok(!result.stderr.includes('TopSecretPw'));
  });
});

describe('database TLS requirements', () => {
  test('remote databases require sslmode=verify-full', () => {
    assert.doesNotThrow(() => assertSecureDatabaseUrl('postgresql://u:p@ep-x.neon.tech/db?sslmode=verify-full&channel_binding=require'));
    for (const mode of ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'no-verify']) {
      assert.throws(() => assertSecureDatabaseUrl(`postgresql://u:p@ep-x.neon.tech/db?sslmode=${mode}`), /verify-full/, mode);
    }
  });

  test('TLS verification cannot be disabled by other parameters', () => {
    assert.throws(
      () => assertSecureDatabaseUrl('postgresql://u:p@db.example.com/db?sslmode=verify-full&ssl=false'),
      /must not disable/,
    );
  });

  test('localhost databases may be used without TLS in development', () => {
    assert.doesNotThrow(() => assertSecureDatabaseUrl('postgresql://u:p@localhost:5432/dev'));
    assert.doesNotThrow(() => assertSecureDatabaseUrl('postgres://u:p@127.0.0.1/dev'));
  });

  test('non-postgres and malformed URLs are rejected', () => {
    assert.throws(() => assertSecureDatabaseUrl('mysql://u:p@db.example.com/db'));
    assert.throws(() => assertSecureDatabaseUrl('not a url'));
  });
});

describe('request logging', () => {
  test('logs the full path without the query string, even inside a mounted router', () => {
    // Request logging is off under NODE_ENV=test, so run the real logger in a
    // development-mode child process with a fake request/response.
    const script = `
      const { EventEmitter } = await import('node:events');
      const { requestLogger } = await import('./src/shared/middleware/requestLogger.js');
      const res = new EventEmitter();
      res.statusCode = 429;
      const req = {
        id: 'req-1',
        method: 'POST',
        path: '/ventures',
        originalUrl: '/api/v1/epineon/forms/ventures?email=leak%40example.com',
      };
      requestLogger(req, res, () => {});
      res.emit('finish');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: projectRoot,
      env: { PATH: process.env.PATH, NODE_ENV: 'development', DATABASE_URL: '', REQUEST_LOGGING: 'true' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const entry = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(entry.message, 'request');
    assert.equal(entry.path, '/api/v1/epineon/forms/ventures');
    assert.equal(entry.status, 429);
    assert.ok(!result.stdout.includes('leak'));
  });
});
