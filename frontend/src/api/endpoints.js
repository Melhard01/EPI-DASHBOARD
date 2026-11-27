/**
 * Typed-by-convention wrappers around the backend's admin REST endpoints
 * (see docs/API_DOCUMENTATION.md). Every call goes through request().
 */
import { request } from './client.js';

const seg = encodeURIComponent;
const itemPath = (application, formType, id) => `/submissions/${seg(application)}/${seg(formType)}/${seg(id)}`;

export const api = {
  /** Email/password login: returns { token, expiresIn, admin } */
  login: (email, password) =>
    request('/login', { method: 'POST', body: { email, password } }),

  /** The signed-in admin, their applications and forms. */
  me: (signal) => request('/me', { signal }),

  submissions: {
    /** @param {{application?: string|string[], formType?: string, status?: string, unread?: boolean, from?: string, to?: string, q?: string, sort?: string, dir?: 'asc'|'desc', page?: number, pageSize?: number}} params */
    list: (params, signal) => request('/submissions', { query: params, signal }),
    get: (application, formType, id, signal) => request(itemPath(application, formType, id), { signal }),
    /** @param {{status?: string, read?: boolean}} changes */
    update: (application, formType, id, changes) => request(itemPath(application, formType, id), { method: 'PATCH', body: changes }),
    remove: (application, formType, id) => request(itemPath(application, formType, id), { method: 'DELETE' }),
  },

  stats: (params, signal) => request('/stats', { query: params, signal }),

  users: {
    list: (signal) => request('/users', { signal }),
    create: (body) => request('/users', { method: 'POST', body }),
    update: (id, body) => request(`/users/${seg(id)}`, { method: 'PATCH', body }),
    delete: (id) => request(`/users/${seg(id)}`, { method: 'DELETE' }),
  },

  audit: {
    list: (params, signal) => request('/audit', { query: params, signal }),
  },
};
