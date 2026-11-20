const KEY = 'admin:last-auth-reload';
const MIN_INTERVAL_MS = 15_000;

/**
 * The server says the session is gone (Cloudflare Access expired). Reloading the
 * page makes Access show its login again. A guard prevents a reload loop when
 * the sign-in does not succeed: the session page then offers a manual button.
 */
export function reloadToSignIn() {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < MIN_INTERVAL_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage unavailable: fall through and reload once */
  }
  window.location.reload();
  return true;
}
