/**
 * Integration test environment:
 *   1. a dedicated TEST database (never production) is migrated and emptied
 *   2. a throw-away RSA key pair stands in for Cloudflare Access's signing key
 *   3. the real backend is started in AUTH_MODE=dev, the way it runs locally,
 *      trusting only that key
 *   4. a first Super Admin is bootstrapped with the backend's own CLI script
 *
 * Needs:  INTEGRATION_DATABASE_URL = a PostgreSQL URL of a database whose name
 *         contains "test" (e.g. the backend's central_backend_test).
 * Optional: BACKEND_DIR (default ../backend)
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startBackend } from './backendProcess.js';

export const ORIGINS = {
  dashboard: 'http://localhost:5173',
  epineon: 'https://epineon.test',
  qaegis: 'https://qaegis.test',
  epiwell: 'https://epiwell.test',
};

export default async function setup({ provide }) {
  const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('INTEGRATION_DATABASE_URL is not set. Point it at the dedicated TEST database (its name must contain "test").');
  }
  const dbName = new URL(databaseUrl).pathname.slice(1);
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to run: the database "${dbName}" does not look like a test database (its name must contain "test").`);
  }

  const backendDir = path.resolve(process.env.BACKEND_DIR ?? '../backend');
  const runId = randomUUID().slice(0, 8);
  const tmp = mkdtempSync(path.join(tmpdir(), 'frontend-integration-'));

  // Stand-in for Cloudflare Access's signing key (public half goes to the backend as a JWKS file).
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'integration-key';
  const jwksPath = path.join(tmp, 'jwks.json');
  writeFileSync(jwksPath, JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }));

  const baseEnv = {
    NODE_ENV: 'development',
    DATABASE_URL: databaseUrl,
    AUTH_MODE: 'dev',
    DEV_ACCESS_JWKS_PATH: jwksPath,
    ADMIN_ALLOWED_ORIGINS: ORIGINS.dashboard,
    CORS_ORIGINS_EPINEON: ORIGINS.epineon,
    CORS_ORIGINS_QAEGIS: ORIGINS.qaegis,
    CORS_ORIGINS_EPIWELL: ORIGINS.epiwell,
    // Like production behind Cloudflare: the client address comes from CF-Connecting-IP.
    CLIENT_IP_SOURCE: 'cloudflare-worker',
    RATE_LIMIT_STORE: 'memory',
  };

  const run = (args, extraEnv = {}) => {
    const result = spawnSync(process.execPath, args, {
      cwd: backendDir,
      env: { PATH: process.env.PATH, ...baseEnv, ...extraEnv },
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (result.status !== 0) throw new Error(`backend ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };

  // 1. migrate, then empty the form tables and admins (exact counts; safe: test database only)
  run(['scripts/migrate.js']);
  run(['--input-type=module', '-e', `
    const { database } = await import('./src/shared/database/index.js');
    const db = (await database.query('SELECT current_database() AS db')).rows[0].db;
    if (!/test/i.test(db)) throw new Error('not a test database: ' + db);
    for (const t of ['epineon.demo_submissions','epineon.sales_submissions','epineon.partnerships_submissions','qaegis.contact_sales_submissions','epiwell.waitlist_submissions']) await database.query('DELETE FROM ' + t);
    await database.query('DELETE FROM platform_admin.admin_users');
    await database.close();
  `]);

  // 2. bootstrap the first Super Admin with the backend's own script
  const superEmail = `super.${runId}@integration.test`;
  run(['scripts/create-super-admin.js', superEmail, 'Integration Super']);

  // 3. start the real backend
  const backend = await startBackend({ backendDir, env: baseEnv });

  provide('backendUrl', backend.url);
  provide('privateKeyPem', privateKey.export({ type: 'pkcs8', format: 'pem' }));
  provide('keyId', kid);
  provide('superEmail', superEmail);
  provide('runId', runId);
  provide('origins', ORIGINS);
  provide('backendDir', backendDir);
  provide('databaseUrl', databaseUrl);
  provide('jwksPath', jwksPath);

  return async () => {
    await backend.stop();
    rmSync(tmp, { recursive: true, force: true });
  };
}
