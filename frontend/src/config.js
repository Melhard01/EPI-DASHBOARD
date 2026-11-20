// Public, build-time configuration. Only VITE_-prefixed variables reach the
// browser, so nothing secret may ever be placed here.
const rawBase = import.meta.env.VITE_API_BASE_URL ?? '';

export const config = Object.freeze({
  /** '' = same origin as the dashboard (recommended). */
  apiBaseUrl: String(rawBase).replace(/\/+$/, ''),
  accessLogoutUrl: import.meta.env.VITE_ACCESS_LOGOUT_URL || '',
});
