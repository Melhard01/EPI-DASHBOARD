/**
 * Centralized, platform-level environment configuration.
 *
 * Loads variables from a local `.env` file when present (Node's built-in
 * loader, no extra dependency) and exposes a frozen, validated config object.
 * Application-specific settings belong in each application's own `config/`.
 *
 * `loadEnv()` is a pure function of its input, so the production safety rules
 * below can be unit-tested without touching process.env.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CLIENT_IP_SOURCES, ClientIpSource } from '../security/clientIp.js';
import { normalizeOrigin } from '../security/cors.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = path.join(projectRoot, '.env');

// Real environment variables always take precedence over the .env file.
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const VALID_ENVIRONMENTS = ['development', 'production', 'test'];
const RATE_LIMIT_STORES = ['postgres', 'memory'];
const AUTH_MODES = ['jwt', 'dev', 'none'];
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MIN_SECRET_LENGTH = 32;

function parsePort(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT value: "${value}"`);
  }
  return port;
}

function parseBodyLimit(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+(?:b|kb|mb)$/i.test(value)) {
    throw new Error(`Invalid BODY_LIMIT value: "${value}" (expected e.g. "100kb")`);
  }
  return value.toLowerCase();
}

function parsePositiveInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name} value: "${value}"`);
  return n;
}

/**
 * Validates the database URL's transport security.
 * Any non-local database must use TLS with full certificate and hostname
 * verification (sslmode=verify-full). Error messages never include the URL.
 */
export function assertSecureDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must be a postgres:// or postgresql:// connection string');
  }
  if (LOCAL_DB_HOSTS.has(url.hostname)) return; // local development database

  const sslmode = url.searchParams.get('sslmode');
  if (sslmode !== 'verify-full') {
    throw new Error(
      'DATABASE_URL must use sslmode=verify-full for remote databases (TLS with certificate and hostname verification)',
    );
  }
  for (const insecure of ['sslrootcert', 'ssl']) {
    const v = url.searchParams.get(insecure);
    if (v !== null && /^(0|false|no-verify|disable)$/i.test(v)) {
      throw new Error(`DATABASE_URL must not disable TLS verification (${insecure}=${v})`);
    }
  }
}

function resolveDatabaseUrl(source, nodeEnv) {
  // Tests never use DATABASE_URL, so they can never touch the real database.
  const value = nodeEnv === 'test' ? source.TEST_DATABASE_URL : source.DATABASE_URL;
  if (!value) {
    if (nodeEnv === 'production') throw new Error('DATABASE_URL is required in production');
    return null;
  }
  assertSecureDatabaseUrl(value);
  return value;
}

export function loadEnv(source) {
  const nodeEnv = source.NODE_ENV || 'development';
  if (!VALID_ENVIRONMENTS.includes(nodeEnv)) {
    throw new Error(`Invalid NODE_ENV "${nodeEnv}". Expected one of: ${VALID_ENVIRONMENTS.join(', ')}`);
  }
  const isProduction = nodeEnv === 'production';
  const databaseUrl = resolveDatabaseUrl(source, nodeEnv);

  // --- Client IP source -------------------------------------------------
  const clientIpSource = source.CLIENT_IP_SOURCE || ClientIpSource.SOCKET;
  if (!CLIENT_IP_SOURCES.includes(clientIpSource)) {
    throw new Error(`Invalid CLIENT_IP_SOURCE "${clientIpSource}". Expected one of: ${CLIENT_IP_SOURCES.join(', ')}`);
  }
  // Allow Vercel deployments without Cloudflare: use socket IP source directly
  // In Vercel serverless, all requests come from the same edge server, so IP-based client tracking
  // should use the X-Forwarded-For header or similar instead of relying on socket IP

  // Vercel behind Cloudflare: a secret that a Cloudflare Transform Rule adds as the
  // X-Origin-Auth header, proving the request came through our own Cloudflare zone.
  const originAuthSecret = source.ORIGIN_AUTH_SECRET || null;
  if (originAuthSecret !== null && originAuthSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`ORIGIN_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (isProduction && clientIpSource === ClientIpSource.VERCEL_CLOUDFLARE && !originAuthSecret) {
    throw new Error('CLIENT_IP_SOURCE=vercel-cloudflare requires ORIGIN_AUTH_SECRET in production');
  }

  // --- Rate limiting ----------------------------------------------------
  const defaultStore = nodeEnv === 'test' || !databaseUrl ? 'memory' : 'postgres';
  const rateLimitStore = source.RATE_LIMIT_STORE || defaultStore;
  if (!RATE_LIMIT_STORES.includes(rateLimitStore)) {
    throw new Error(`Invalid RATE_LIMIT_STORE "${rateLimitStore}". Expected one of: ${RATE_LIMIT_STORES.join(', ')}`);
  }
  if (isProduction && rateLimitStore !== 'postgres') {
    throw new Error('Production requires RATE_LIMIT_STORE=postgres (in-memory limits are per-instance)');
  }
  if (rateLimitStore === 'postgres' && !databaseUrl) {
    throw new Error('RATE_LIMIT_STORE=postgres requires a database URL');
  }

  const rateLimitSecret = source.RATE_LIMIT_SECRET || null;
  if (rateLimitSecret !== null && rateLimitSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`RATE_LIMIT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (isProduction && !rateLimitSecret) {
    throw new Error('RATE_LIMIT_SECRET is required in production');
  }

  // --- Admin authentication -------------------------------------------
  // jwt:   email/password authentication with JWT tokens (recommended)
  // dev:   locally signed JWTs (npm run dev:token), never production
  // none:  admin API answers 503 (no admin access configured)
  const authMode = source.AUTH_MODE || 'none';
  if (!AUTH_MODES.includes(authMode)) {
    throw new Error(`Invalid AUTH_MODE "${authMode}". Expected one of: ${AUTH_MODES.join(', ')}`);
  }
  if (isProduction && authMode === 'none') {
    throw new Error('Production requires AUTH_MODE=jwt or AUTH_MODE=dev');
  }

  let jwtSecret = null;
  let jwtExpiryHours = 24;
  if (authMode === 'jwt') {
    jwtSecret = source.JWT_SECRET || null;
    if (!jwtSecret || jwtSecret.length < MIN_SECRET_LENGTH) {
      throw new Error(`AUTH_MODE=jwt requires JWT_SECRET (at least ${MIN_SECRET_LENGTH} characters)`);
    }
    jwtExpiryHours = Number(source.JWT_EXPIRY_HOURS) || 24;
    if (!Number.isInteger(jwtExpiryHours) || jwtExpiryHours < 1 || jwtExpiryHours > 365) {
      throw new Error('JWT_EXPIRY_HOURS must be between 1 and 365');
    }
  }

  // --- CORS ---------------------------------------------------------------
  // CORS_ORIGINS_<APP> (e.g. CORS_ORIGINS_EPI_WELL) and ADMIN_ALLOWED_ORIGINS:
  // comma-separated origins. Production accepts https origins only.
  const parseOrigins = (value) =>
    String(value ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => normalizeOrigin(v, { allowLocalHttp: !isProduction }));
  const corsOrigins = {};
  for (const [key, value] of Object.entries(source)) {
    const match = /^CORS_ORIGINS_([A-Z0-9_]+)$/.exec(key);
    if (match) corsOrigins[match[1]] = parseOrigins(value);
  }
  const adminOrigins = parseOrigins(source.ADMIN_ALLOWED_ORIGINS);


  // --- Email configuration -----------------------------------------------
  const resendApiKey = source.RESEND_API_KEY || null;
  const adminDashboardUrl = source.ADMIN_DASHBOARD_URL || null;
  const invitationExpiryHours = Number(source.INVITATION_EXPIRY_HOURS) || 24;

  if (invitationExpiryHours < 1 || invitationExpiryHours > 365) {
    throw new Error("INVITATION_EXPIRY_HOURS must be between 1 and 365");
  }

  if (isProduction && !resendApiKey) {
    throw new Error("RESEND_API_KEY is required in production");
  }
  if (isProduction && !adminDashboardUrl) {
    throw new Error("ADMIN_DASHBOARD_URL is required in production");
  }
  return Object.freeze({
    nodeEnv,
    isProduction,
    authMode,
    jwtSecret,
    jwtExpiryHours,
    devAccessJwksPath: source.DEV_ACCESS_JWKS_PATH || '.dev-access/jwks.json',
    corsOrigins: Object.freeze(corsOrigins),
    adminOrigins: Object.freeze(adminOrigins),
    isTest: nodeEnv === 'test',
    port: parsePort(source.PORT, 3000),
    requestLogging: source.REQUEST_LOGGING !== 'false' && nodeEnv !== 'test',
    bodyLimit: parseBodyLimit(source.BODY_LIMIT, '100kb'),
    databaseUrl,
    dbPoolMax: parsePositiveInt(source.DB_POOL_MAX, 5, 'DB_POOL_MAX'),
    clientIpSource,
    originAuthSecret,
    // HTTPS is mandatory in production and cannot be switched off there.
    enforceHttps: isProduction,
    rateLimitStore,
    // Outside production a missing secret gets a random per-process value.
    rateLimitSecret,
    resendApiKey,
    adminDashboardUrl,
    invitationExpiryHours,
  });
}

export const env = loadEnv(process.env);
