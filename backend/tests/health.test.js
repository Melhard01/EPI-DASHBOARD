import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { database } from '../src/shared/database/index.js';

let server;
let baseUrl;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function rawGet(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

test('GET /api/health returns platform status', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'success', message: 'Central Backend is running' });
});

const apps = [
  { slug: 'epineon', name: 'Epineon' },
  { slug: 'qaegis', name: 'QAegis' },
  { slug: 'epiwell', name: 'Epi Well' },
];

for (const { slug, name } of apps) {
  test(`GET /api/v1/${slug}/health identifies ${name}`, async () => {
    const { status, body } = await get(`/api/v1/${slug}/health`);
    assert.equal(status, 200);
    assert.equal(body.status, 'success');
    assert.equal(body.message, `${name} API is running`);
    assert.equal(body.application, slug);
    assert.equal(body.name, name);
  });
}

test('unknown routes return 404 in the standard error envelope', async () => {
  const { status, body } = await get('/api/v1/unknown/health');
  assert.equal(status, 404);
  assert.equal(body.status, 'error');
  assert.match(body.message, /Route not found/);
});

describe('GET /api/health/database (database mocked: no network, independent of .env)', () => {
  test('not configured → 503 with a generic message', async (t) => {
    t.mock.method(database, 'isConfigured', () => false);
    const { status, body } = await get('/api/health/database');
    assert.equal(status, 503);
    assert.deepEqual(body, { status: 'error', message: 'Database is not configured' });
  });

  test('reachable → 200', async (t) => {
    t.mock.method(database, 'isConfigured', () => true);
    t.mock.method(database, 'ping', async () => {});
    const { status, body } = await get('/api/health/database');
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'success', message: 'Database is reachable' });
  });

  test('unreachable → 503 without leaking connection details', async (t) => {
    t.mock.method(database, 'isConfigured', () => true);
    t.mock.method(database, 'ping', async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432 (user=neondb_owner)'), { code: 'ECONNREFUSED' });
    });
    const { status, body, text } = await rawGet('/api/health/database');
    assert.equal(status, 503);
    assert.deepEqual(body, { status: 'error', message: 'Database is unreachable' });
    assert.ok(!text.includes('10.1.2.3') && !text.includes('neondb_owner'));
  });
});
