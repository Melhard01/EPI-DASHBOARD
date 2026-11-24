/**
 * Test helper: JWT token generation for testing.
 * Uses the real generateJWT and verifyJWT from the JWT token module.
 */
import { generateJWT, verifyJWT } from '../../src/shared/security/jwtToken.js';

export const TEST_JWT_SECRET = 'test-secret-must-be-32-characters1';

export function createTestJWT() {
  const verifier = (token) => {
    try {
      return verifyJWT(token, TEST_JWT_SECRET);
    } catch (err) {
      throw new Error(err.message);
    }
  };

  const token = (email, overrides = {}) =>
    generateJWT({ email, ...overrides }, TEST_JWT_SECRET, 24);

  return { verifier, token };
}
