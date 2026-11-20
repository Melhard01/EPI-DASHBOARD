/**
 * Test helper: a fake Cloudflare Access team (RSA key + JWKS) and token signer.
 * Tokens are verified by the real createAccessVerifier(); only the key
 * source (an in-memory JWKS instead of Cloudflare's certs URL) is replaced.
 */
import { createAccessKeyPair, signAccessToken } from '../../scripts/lib/access-token.js';
import { createAccessVerifier } from '../../src/shared/security/cloudflareAccess.js';

export const TEST_TEAM = 'https://test-team.cloudflareaccess.com';
export const TEST_AUD = 'test-audience-tag-0123456789abcdef0123456789abcdef';

export function createTestAccess({ now } = {}) {
  const key = createAccessKeyPair('test-key-1');
  const verifier = createAccessVerifier({
    teamDomain: TEST_TEAM,
    audience: TEST_AUD,
    fetchJwks: async () => key.jwks,
    ...(now ? { now } : {}),
  });
  const token = (email, overrides = {}) =>
    signAccessToken({ email, teamDomain: TEST_TEAM, audience: TEST_AUD, key, ...overrides });
  return { key, verifier, token };
}
