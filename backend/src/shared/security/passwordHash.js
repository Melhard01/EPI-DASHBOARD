/**
 * Password hashing with bcrypt.
 *
 * Uses bcrypt for secure password hashing with automatic salt generation.
 * Never store plain-text passwords; always use bcrypt.
 */
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12; // Balance between security and performance

/**
 * Hash a plain-text password using bcrypt.
 * @param {string} password Plain-text password
 * @returns {Promise<string>} Hashed password (safe to store in database)
 */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a plain-text password against a stored bcrypt hash.
 * @param {string} password Plain-text password to verify
 * @param {string} hash Stored bcrypt hash
 * @returns {Promise<boolean>} True if password matches hash
 */
export async function verifyPassword(password, hash) {
  if (typeof password !== 'string' || typeof hash !== 'string') {
    return false;
  }
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}
