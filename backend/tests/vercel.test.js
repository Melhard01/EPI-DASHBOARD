/**
 * Vercel deployment readiness (no deployment, no database).
 *
 * - the entry point exports a working Express app,
 * - vercel.json / .vercelignore are present and safe,
 * - a Vercel-behind-Cloudflare app accepts only requests that came through our
 *   Cloudflare zone, end to end over real HTTP.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createApp } from '../src/app.js';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

async function listen(app, fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('Vercel entry point and configuration', () => {
  test('api/index.js default-exports a ready Express app (nothing listens on import)', async () => {
    const mod = await import('../api/index.js');
    assert.equal(typeof mod.default, 'function');
    assert.equal(typeof mod.default.handle, 'function', 'an Express app, not the createApp factory');
    await listen(mod.default, async (base) => {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).status, 'success');
    });
  });

  test('vercel.json routes every /api/* request to the function that exists', () => {
    const config = JSON.parse(read('vercel.json'));
    assert.deepEqual(config.rewrites, [{ source: '/api/(.*)', destination: '/api' }]);
    for (const file of Object.keys(config.functions)) {
      assert.ok(existsSync(new URL(file, root)), `${file} must exist`);
    }
    assert.ok(config.functions['api/index.js'].maxDuration <= 60);
    assert.ok(!/DATABASE_URL|SECRET|postgres/i.test(read('vercel.json')), 'no secrets in vercel.json');
  });

  test('.vercelignore keeps secrets and dev-only material out of the upload', () => {
    const ignore = read('.vercelignore').split('\n').map((l) => l.trim());
    for (const entry of ['.env', '.env.*', '.dev-access/', 'node_modules/', 'tests/']) {
      assert.ok(ignore.includes(entry), `.vercelignore must list ${entry}`);
    }
  });

  test('Node is pinned to a major Vercel supports and matches .nvmrc', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.engines.node, /^\d+\.x$/);
    assert.equal(pkg.engines.node.split('.')[0], read('.nvmrc').trim());
  });
});

describe('Vercel behind Cloudflare: only our Cloudflare zone is trusted', () => {
  const SECRET = 'z'.repeat(40);
  const CF_EDGE = '172.70.1.1';
  const options = {
    clientIpSource: 'vercel-cloudflare',
    originAuthSecret: SECRET,
    enforceHttps: true,
    rateLimitStore: null,
  };
  const good = {
    'x-vercel-forwarded-for': CF_EDGE,
    'cf-connecting-ip': '198.51.100.7',
    'x-origin-auth': SECRET,
    'x-forwarded-proto': 'https',
  };

  test('a request through Cloudflare is served', async () => {
    await listen(createApp(options), async (base) => {
      const res = await fetch(`${base}/api/health`, { headers: good });
      assert.equal(res.status, 200);
    });
  });

  test('each way of bypassing Cloudflare is refused with 403 and a generic body', async () => {
    const cases = {
      'direct to Vercel (peer is not Cloudflare)': { ...good, 'x-vercel-forwarded-for': '203.0.113.9' },
      'no Vercel peer header': { ...good, 'x-vercel-forwarded-for': undefined },
      'missing origin secret': { ...good, 'x-origin-auth': undefined },
      'wrong origin secret': { ...good, 'x-origin-auth': 'q'.repeat(40) },
      'spoofed X-Forwarded-For only': { 'x-forwarded-for': CF_EDGE, 'cf-connecting-ip': '198.51.100.7', 'x-origin-auth': SECRET, 'x-forwarded-proto': 'https' },
    };
    await listen(createApp(options), async (base) => {
      for (const [name, headers] of Object.entries(cases)) {
        const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
        const res = await fetch(`${base}/api/health`, { headers: clean });
        assert.equal(res.status, 403, name);
        const text = await res.text();
        assert.ok(!text.includes(SECRET), name);
      }
    });
  });

  test('plain HTTP is refused even from Cloudflare', async () => {
    await listen(createApp(options), async (base) => {
      const res = await fetch(`${base}/api/health`, { headers: { ...good, 'x-forwarded-proto': 'http' } });
      assert.equal(res.status, 403);
    });
  });

  test('the admin API still demands a verified Cloudflare Access identity', async () => {
    await listen(createApp({ ...options, accessVerifier: null }), async (base) => {
      const res = await fetch(`${base}/api/v1/admin/me`, { headers: good });
      assert.ok([401, 503].includes(res.status), `got ${res.status}`);
    });
  });
});
