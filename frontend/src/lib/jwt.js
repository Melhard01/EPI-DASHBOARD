/**
 * JWT token storage and management.
 * Tokens are stored in sessionStorage (cleared when browser closes).
 */

const TOKEN_KEY = 'admin:jwt:token';
const EXPIRY_KEY = 'admin:jwt:expiry';

/**
 * Store a JWT token and its expiration time.
 * @param {string} token - The JWT token
 * @param {number} expiresIn - Seconds until expiration
 */
export function saveToken(token, expiresIn) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    // Store expiration as absolute timestamp (now + expiresIn seconds)
    const expiryTime = Date.now() + expiresIn * 1000;
    sessionStorage.setItem(EXPIRY_KEY, String(expiryTime));
  } catch (err) {
    console.error('Failed to save token:', err);
  }
}

/**
 * Retrieve the stored JWT token if it exists and hasn't expired.
 * @returns {string|null} The token or null if not found/expired
 */
export function getToken() {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const expiryStr = sessionStorage.getItem(EXPIRY_KEY);

    if (!token || !expiryStr) return null;

    const expiry = Number(expiryStr);
    if (Date.now() > expiry) {
      // Token expired, clean up
      clearToken();
      return null;
    }

    return token;
  } catch (err) {
    console.error('Failed to retrieve token:', err);
    return null;
  }
}

/**
 * Clear the stored JWT token (logout).
 */
export function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXPIRY_KEY);
  } catch (err) {
    console.error('Failed to clear token:', err);
  }
}

/**
 * Check if a valid token is currently stored.
 * @returns {boolean}
 */
export function hasValidToken() {
  return getToken() !== null;
}
