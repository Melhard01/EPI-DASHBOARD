/**
 * The API client: the only code that talks to the backend.
 * Tests it against MSW handlers (real fetch, real parsing) and stubbed fetch
 * for browser-only behaviour (opaque redirects).
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server.js';
import { ApiError, configureClient, getClientSettings, request } from '../src/api/client.js';
import { api } from '../src/api/endpoints.js';
import { BASE } from './msw/fakeBackend.js';

const A = `${BASE}/api/v1/admin`;
const envelope = (data) => HttpResponse.json({ status: 'success', message: 'ok', ...(data === undefined ? {} : { data }) });

afterEach(() => vi.unstubAllGlobals());

describe('successful responses', () => {
  test('returns the data of the success envelope', async () => {
    server.use(http.get(`${A}/me`, () => envelope({ email: 'a@b.co' })));
    await expect(api.me()).resolves.toEqual({ email: 'a@b.co' });
  });

  test('returns null when the envelope has no data (e.g. delete)', async () => {
    server.use(http.delete(`${A}/submissions/epineon/demo/x`, () => envelope()));
    await expect(api.submissions.remove('epineon', 'demo', 'x')).resolves.toBeNull();
  });
});

describe('requests', () => {
  test('serializes query parameters: skips empty values, joins arrays, keeps false and 0', async () => {
    let seen;
    server.use(http.get(`${A}/submissions`, ({ request }) => {
      seen = new URL(request.url).search;
      return envelope({ items: [], pagination: {} });
    }));
    await api.submissions.list({ q: 'a b&c', status: '', formType: undefined, application: ['epineon', 'qaegis'], unread: false, page: 0, from: null });
    const params = new URLSearchParams(seen);
    expect(Object.fromEntries(params)).toEqual({ q: 'a b&c', application: 'epineon,qaegis', unread: 'false', page: '0' });
  });

  test('sends JSON bodies with a content type, and no body or content type on GET', async () => {
    let post;
    let get;
    server.use(
      http.post(`${A}/users`, async ({ request }) => {
        post = { type: request.headers.get('content-type'), body: await request.json() };
        return envelope({});
      }),
      http.get(`${A}/me`, ({ request }) => {
        get = { type: request.headers.get('content-type'), accept: request.headers.get('accept') };
        return envelope({});
      }),
    );
    await api.users.create({ email: 'x@y.co' });
    await api.me();
    expect(post).toEqual({ type: 'application/json', body: { email: 'x@y.co' } });
    expect(get).toEqual({ type: null, accept: 'application/json' });
  });

  test('path segments are URL-encoded so an id cannot change the route', async () => {
    let path;
    server.use(http.get(`${A}/submissions/:a/:f/:id`, ({ request }) => {
      path = new URL(request.url).pathname;
      return envelope({});
    }));
    await api.submissions.get('epineon', 'demo', '../../users');
    expect(path).toBe('/api/v1/admin/submissions/epineon/demo/..%2F..%2Fusers');
  });

  test('sends the configured extra headers, and nothing secret by default', async () => {
    let headers;
    server.use(http.get(`${A}/me`, ({ request }) => {
      headers = Object.fromEntries(request.headers);
      return envelope({});
    }));
    await api.me();
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('cf-access-jwt-assertion');
    configureClient({ headers: { 'x-test': '1' } });
    await api.me();
    expect(headers['x-test']).toBe('1');
  });

  test('uses the configured base URL (empty = same origin)', async () => {
    configureClient({ baseUrl: '' });
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: 'success', data: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await request('/me');
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/v1/admin/me');
    expect(fetchSpy.mock.calls[0][1].credentials).toBe('same-origin');
    configureClient({ baseUrl: 'https://api.example.com' });
    await request('/me');
    expect(fetchSpy.mock.calls[1][0]).toBe('https://api.example.com/api/v1/admin/me');
    expect(fetchSpy.mock.calls[1][1].credentials).toBe('include');
  });

  test('can be aborted', async () => {
    server.use(http.get(`${A}/me`, async () => {
      await new Promise((r) => setTimeout(r, 200));
      return envelope({});
    }));
    const controller = new AbortController();
    const pending = api.me(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('errors', () => {
  test('HTTP errors become ApiError with status, safe message and validation details', async () => {
    server.use(http.post(`${A}/users`, () =>
      HttpResponse.json({
        status: 'error', message: 'Validation failed',
        details: [{ field: 'email', code: 'invalid_email', message: 'Must be a valid email address' }, { field: null, code: 'invalid_body', message: 'General problem' }, { field: 'email', code: 'x', message: 'second email message' }],
      }, { status: 400 })));
    const error = await api.users.create({}).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, message: 'Validation failed', kind: 'http' });
    expect(error.fieldErrors).toEqual({ email: 'Must be a valid email address' });
    expect(error.details).toHaveLength(3);
  });

  test.each([[401, 'isUnauthorized'], [403, 'isForbidden'], [404, 'isNotFound']])('status %i sets %s', async (status, flag) => {
    server.use(http.get(`${A}/me`, () => HttpResponse.json({ status: 'error', message: 'nope' }, { status })));
    const error = await api.me().catch((e) => e);
    expect(error[flag]).toBe(true);
    expect(error.isNetwork).toBe(false);
  });

  test('a 401 calls onUnauthorized exactly once; other errors do not', async () => {
    const onUnauthorized = vi.fn();
    configureClient({ onUnauthorized });
    server.use(
      http.get(`${A}/me`, () => HttpResponse.json({ status: 'error', message: 'Authentication required' }, { status: 401 })),
      http.get(`${A}/stats`, () => HttpResponse.json({ status: 'error', message: 'Not authorized' }, { status: 403 })),
    );
    await api.me().catch(() => {});
    await api.stats({}).catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test('a non-JSON error body (e.g. a proxy page) still yields a clean ApiError', async () => {
    server.use(http.get(`${A}/me`, () => new HttpResponse('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })));
    const error = await api.me().catch((e) => e);
    expect(error).toMatchObject({ status: 502, message: 'Request failed (502)', details: [] });
    expect(error.message).not.toContain('html');
  });

  test('a server message is never replaced by or mixed with raw response text', async () => {
    server.use(http.get(`${A}/me`, () => HttpResponse.json({ status: 'error', message: 'Internal Server Error', stack: 'SECRET STACK' }, { status: 500 })));
    const error = await api.me().catch((e) => e);
    expect(error.message).toBe('Internal Server Error');
    expect(JSON.stringify(error)).not.toContain('SECRET STACK');
  });

  test('network failures become a friendly ApiError of kind "network"', async () => {
    server.use(http.get(`${A}/me`, () => HttpResponse.error()));
    const error = await api.me().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'network', status: 0 });
    expect(error.isNetwork).toBe(true);
    expect(error.message).toMatch(/cannot reach the server/i);
  });

  test('an expired Cloudflare Access session (opaque redirect) is reported as "session expired" (401)', async () => {
    const onUnauthorized = vi.fn();
    configureClient({ onUnauthorized });
    vi.stubGlobal('fetch', vi.fn(async () => ({ type: 'opaqueredirect', status: 0, ok: false })));
    const error = await request('/me').catch((e) => e);
    expect(error).toMatchObject({ status: 401, kind: 'session' });
    expect(error.message).toMatch(/session has expired/i);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test('requests are made with redirect: "manual" so a login redirect is detectable', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await request('/me');
    expect(fetchSpy.mock.calls[0][1].redirect).toBe('manual');
  });
});

describe('configuration', () => {
  test('configureClient merges settings', () => {
    configureClient({ headers: { a: '1' } });
    expect(getClientSettings().headers).toEqual({ a: '1' });
    expect(getClientSettings().baseUrl).toBe(BASE);
  });
});
