/**
 * Prints a local development admin token (AUTH_MODE=dev only).
 *
 *   npm run dev:token -- admin@example.com
 *
 * Creates a throw-away RSA key pair in .dev-access/ (git-ignored) on first
 * use and writes its public JWKS where the dev server reads it. Send the
 * token in the Cf-Access-Jwt-Assertion header, exactly as Cloudflare Access
 * would in production. The email must also exist in platform_admin.admin_users
 * (see npm run admin:create).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { createAccessKeyPair, signAccessToken } from './lib/access-token.js';
import { DEV_ACCESS } from '../src/app.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: development tokens are never valid in production.');
  process.exit(1);
}

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: npm run dev:token -- <email>');
  process.exit(1);
}

const dir = path.resolve('.dev-access');
const privatePath = path.join(dir, 'private-key.pem');
const jwksPath = path.join(dir, 'jwks.json');
const kid = 'dev-key-1';

mkdirSync(dir, { recursive: true, mode: 0o700 });
if (!existsSync(privatePath) || !existsSync(jwksPath)) {
  const pair = createAccessKeyPair(kid);
  writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(jwksPath, JSON.stringify(pair.jwks, null, 2), { mode: 0o600 });
}

const privateKey = createPrivateKey(readFileSync(privatePath));
const token = signAccessToken({
  email,
  teamDomain: DEV_ACCESS.teamDomain,
  audience: DEV_ACCESS.audience,
  key: { kid, privateKey },
  ttlSeconds: 8 * 60 * 60,
});
process.stdout.write(`${token}\n`);
