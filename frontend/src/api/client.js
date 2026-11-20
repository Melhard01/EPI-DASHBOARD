/**
 * The ONE place the dashboard talks to the backend (REST over fetch).
 *
 * - No credentials, tokens or database access exist in the browser code. In
 *   production Cloudflare Access authenticates the browser and adds the signed
 *   header at the edge; locally the Vite dev proxy does.
 * - The backend owns all validation and permissions. This client only moves
 *   JSON, and turns failures into ApiError objects the UI can render.
 */
import { config } from '../config.js';

export class ApiError extends Error {
  /**
   * @param {{ status?: number, message: string, details?: Array<{field: string|null, code: string, message: string}>, kind?: 'http'|'network'|'session' }} init
   */
  constructor({ status = 0, message, details = [], kind = 'http' }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.kind = kind;
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  get isForbidden() {
    return this.status === 403;
  }

  get isNotFound() {
    return this.status === 404;
  }

  get isNetwork() {
    return this.kind === 'network';
  }

  /** Server validation messages keyed by field name, for showing next to inputs. */
  get fieldErrors() {
    const out = {};
    for (const d of this.details) if (d.field && !out[d.field]) out[d.field] = d.message;
    return out;
  }
}

let settings = {
  baseUrl: config.apiBaseUrl,
  /** Extra headers (tests / integration only; production sends none). */
  headers: {},
  /** Called when the server says the session is gone (401). */
  onUnauthorized: null,
};

/** Overrides client settings (used by tests and the app bootstrap). */
export function configureClient(next) {
  settings = { ...settings, ...next };
}

export function getClientSettings() {
  return settings;
}

function buildUrl(path, query) {
  const url = `${settings.baseUrl}/api/v1/admin${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * @returns {Promise<any>} the `data` of the backend's success envelope
 *   ({ status: 'success', message, data }), or null when it has none.
 */
export async function request(path, { method = 'GET', query, body, signal } = {}) {
  const headers = { accept: 'application/json', ...settings.headers };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: settings.baseUrl ? 'include' : 'same-origin',
      // An expired Cloudflare Access session answers with a redirect to the login
      // page. Following it would fail as a confusing cross-origin error, so it is
      // detected and reported as "session expired" instead.
      redirect: 'manual',
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError({ kind: 'network', message: 'Cannot reach the server. Check your connection and try again.' });
  }

  if (response.type === 'opaqueredirect') {
    settings.onUnauthorized?.();
    throw new ApiError({ status: 401, kind: 'session', message: 'Your session has expired. Please sign in again.' });
  }

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON (e.g. a proxy error page): the status code is still reported */
    }
  }

  if (!response.ok) {
    const error = new ApiError({
      status: response.status,
      message: typeof json?.message === 'string' ? json.message : `Request failed (${response.status})`,
      details: Array.isArray(json?.details) ? json.details : [],
    });
    if (error.isUnauthorized) settings.onUnauthorized?.();
    throw error;
  }
  return json?.data ?? null;
}
