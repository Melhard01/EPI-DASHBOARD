/**
 * JWT token generation and verification for admin authentication.
 *
 * Replaces Cloudflare Access JWT with self-signed JWT tokens.
 * Tokens are signed with a backend secret and include expiration.
 */
import crypto from 'node:crypto';

/**
 * Base64URL encode without padding (per JWT spec).
 */
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Generate a JWT token for an admin user.
 * @param {object} payload { id, email, isSuperAdmin, applications }
 * @param {string} secret JWT secret (32+ chars)
 * @param {number} expiryHours Token expiration in hours
 * @returns {string} JWT token (can be sent to frontend)
 */
export function generateJWT(payload, secret, expiryHours = 24) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (expiryHours * 3600);

  const header = { alg: 'HS256', typ: 'JWT' };
  const claims = {
    ...payload,
    iat: now,
    exp: exp,
    nbf: now,
  };

  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64url(Buffer.from(JSON.stringify(claims)));
  const signature = base64url(
    crypto
      .createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest()
  );

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Verify and decode a JWT token.
 * @param {string} token JWT token from Authorization header
 * @param {string} secret JWT secret (must match generation secret)
 * @returns {object} Decoded payload { id, email, isSuperAdmin, applications, exp, iat }
 * @throws {Error} If token is invalid, expired, or verification fails
 */
export function verifyJWT(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new Error('Invalid token format');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token: expected 3 parts');
  }

  const [encodedHeader, encodedPayload, providedSignature] = parts;

  // Verify signature
  const expectedSignature = base64url(
    crypto
      .createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest()
  );

  if (providedSignature !== expectedSignature) {
    throw new Error('Invalid token signature');
  }

  // Decode and parse payload
  let payload;
  try {
    const decoded = Buffer.from(encodedPayload + '==', 'base64url').toString('utf8');
    payload = JSON.parse(decoded);
  } catch {
    throw new Error('Invalid token payload');
  }

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    throw new Error('Token expired');
  }

  if (payload.nbf > now) {
    throw new Error('Token not yet valid');
  }

  return payload;
}
