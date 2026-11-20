/**
 * Local development architecture: the Vite dev server proxies /api to the real
 * backend and plays the role Cloudflare Access plays in production (adds the
 * signed identity header). The browser code itself never holds a token.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createServer } from 'vite';
import { startBackend, freePort } from './backendProcess.js';
import { signToken } from './helpers.js';
import { configureClient } from '../../src/api/client.js';
import { api } from '../../src/api/endpoints.js';

const frontendDir = path.resolve(import.meta.dirname, '../..');
const SUPER = inject('superEmail');

let backend;
let withToken;
let withoutToken;
let token;

async function startVite(devToken, backendUrl, port) {
  process.env.DEV_ACCESS_TOKEN = devToken;
  process.env.DEV_API_TARGET = backendUrl;
  const server = await createServer({
    root: frontendDir,
    configFile: path.join(frontendDir, 'vite.config.js'),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'silent',
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${port}` };
}

beforeAll(async () => {
  const portA = await freePort();
  const portB = await freePort();
  // The backend the way developers run it: socket client IP, AUTH_MODE=dev. The dashboard origin is the Vite URL.
  backend = await startBackend({
    backendDir: inject('backendDir'),
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: inject('databaseUrl'),
      AUTH_MODE: 'dev',
      DEV_ACCESS_JWKS_PATH: inject('jwksPath'),
      ADMIN_ALLOWED_ORIGINS: `http://127.0.0.1:${portA},http://127.0.0.1:${portB}`,
      RATE_LIMIT_STORE: 'memory',
    },
  });
  token = signToken(SUPER);
  withToken = await startVite(token, backend.url, portA);
  withoutToken = await startVite('', backend.url, portB);
});

afterAll(async () => {
  await withToken?.server.close();
  await withoutToken?.server.close();
  await backend?.stop();
  delete process.env.DEV_ACCESS_TOKEN;
  delete process.env.DEV_API_TARGET;
});

describe('Vite dev proxy ⇄ backend', () => {
  test('the dashboard origin reaches the backend through /api with NO credentials of its own', async () => {
    const res = await fetch(`${withToken.url}/api/v1/admin/me`); // exactly what the browser sends: nothing special
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ email: SUPER, isSuperAdmin: true });
  });

  test('without the dev token configured, the dashboard is simply "not signed in" (401)', async () => {
    const res = await fetch(`${withoutToken.url}/api/v1/admin/me`);
    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe('Authentication required');
  });

  test('public endpoints are proxied too', async () => {
    const res = await fetch(`${withToken.url}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'success', message: 'Central Backend is running' });
  });

  test('the frontend API client works unchanged through the proxy (same origin, relative URLs in the browser)', async () => {
    configureClient({ baseUrl: withToken.url, headers: {}, onUnauthorized: null });
    const me = await api.me();
    expect(me.email).toBe(SUPER);
    expect(me.applications.map((a) => a.slug)).toEqual(['epineon', 'qaegis', 'epiwell']);
    const stats = await api.stats({ days: 7 });
    expect(stats.combined.daily).toHaveLength(7);
  });

  test('changes pass through with the browser\'s Origin; without it the backend refuses', async () => {
    const send = (headers) =>
      fetch(`${withToken.url}/api/v1/admin/submissions/epineon/demo/00000000-0000-4000-8000-000000000000`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ read: true }),
      });
    const noOrigin = await send({});
    expect(noOrigin.status).toBe(403);
    expect((await noOrigin.json()).message).toBe('Origin header required');
    const withOrigin = await send({ origin: withToken.url });
    expect(withOrigin.status).toBe(404); // allowed through; the submission simply does not exist
  });

  test('the token lives only in the dev server\'s Node process: no page or script served to the browser contains it', async () => {
    for (const asset of ['/', '/src/main.jsx', '/src/api/client.js', '/src/config.js', '/@vite/client', '/@vite/env']) {
      const res = await fetch(`${withToken.url}${asset}`);
      const text = await res.text();
      expect(text, asset).not.toContain(token);
      expect(text, asset).not.toContain(token.slice(0, 40));
      expect(text.toLowerCase(), asset).not.toContain('cf-access-jwt-assertion');
    }
  });

  test('another client cannot read the token back from the dev server', async () => {
    const res = await fetch(`${withToken.url}/api/v1/admin/me`, { headers: { 'cf-access-jwt-assertion': 'attacker-supplied' } });
    // The proxy overrides it with its own configured token: the response is for the developer, never an echo.
    expect(res.status).toBe(200);
    expect(JSON.stringify([...res.headers])).not.toContain(token);
  });
});
