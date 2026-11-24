/**
 * Express application factory.
 *
 * Builds the app without starting a server, so it can be reused by
 * server.js (local Node.js), the test suite, and a future Cloudflare Workers
 * entry point (httpServerHandler from "cloudflare:node").
 *
 * Request pipeline (order matters):
 *   requestId → securityHeaders → requestLogger → clientIdentity
 *   → requireHttps (production) → express.json → routes → 404 → errorHandler
 */
import { randomBytes } from 'node:crypto';
import express from 'express';
import { applications } from './applications/index.js';
import { requestLogger } from './shared/middleware/requestLogger.js';
import { notFound } from './shared/middleware/notFound.js';
import { errorHandler } from './shared/middleware/errorHandler.js';
import {
  requestId,
  securityHeaders,
  clientIdentity,
  requireHttps,
  methodNotAllowed,
} from './shared/middleware/security.js';
import { sendSuccess, sendError } from './shared/utils/response.js';
import { env } from './shared/config/env.js';
import { database } from './shared/database/index.js';
import { logger } from './shared/utils/logger.js';
import { ClientIpSource } from './shared/security/clientIp.js';
import { PostgresRateLimitStore, MemoryRateLimitStore } from './shared/security/rateLimitStores.js';
import { cors, createCorsPolicy } from './shared/security/cors.js';
import { createSubmissionsRouter } from './platform/submissions.routes.js';
import { createAdminRouter } from './platform/admin/router.js';

const API_PREFIX = '/api';
const API_VERSION = 'v1';
const API_BASE = `${API_PREFIX}/${API_VERSION}`;
// Platform paths under /api/v1 that no application slug may use.
const RESERVED_SLUGS = new Set(['admin', 'submissions']);

function getJWTSecret() {
  if (env.authMode === 'jwt') {
    if (!env.jwtSecret) {
      throw new Error('AUTH_MODE=jwt requires JWT_SECRET (32+ chars)');
    }
    return env.jwtSecret;
  }
  return null;
}

/** CORS_ORIGINS_<APP> → application slug (e.g. EPI_WELL → epi-well). */
function createDefaultCorsPolicy() {
  const publicOrigins = {};
  for (const app of applications) {
    const key = app.slug.toUpperCase().replace(/-/g, '_');
    publicOrigins[app.slug] = env.corsOrigins[key] ?? [];
  }
  return createCorsPolicy({ publicOrigins, adminOrigins: env.adminOrigins });
}

function createDefaultRateLimitStore() {
  return env.rateLimitStore === 'postgres'
    ? new PostgresRateLimitStore({ database })
    : new MemoryRateLimitStore();
}

/**
 * @param {object} [options] Overrides for tests. Production refuses any
 *   override that would weaken security.
 * @param {string} [options.clientIpSource]
 * @param {boolean} [options.enforceHttps]
 * @param {object|null} [options.rateLimitStore] null disables rate limiting
 * @param {string} [options.rateLimitSecret]
 * @param {Function|null} [options.accessVerifier] Access JWT verifier (null = admin API off)
 * @param {object} [options.corsPolicy] from createCorsPolicy()
 * @param {object[]} [options.applications] application registry override (tests)
 */
export function createApp(options = {}) {
  const settings = {
    clientIpSource: options.clientIpSource ?? env.clientIpSource,
    originAuthSecret: options.originAuthSecret !== undefined ? options.originAuthSecret : env.originAuthSecret,
    enforceHttps: options.enforceHttps ?? env.enforceHttps,
    rateLimitStore:
      options.rateLimitStore !== undefined ? options.rateLimitStore : createDefaultRateLimitStore(),
    rateLimitSecret:
      options.rateLimitSecret ?? env.rateLimitSecret ?? randomBytes(32).toString('hex'),
    jwtSecret:
      options.jwtSecret !== undefined ? options.jwtSecret : getJWTSecret(),
    jwtExpiryHours:
      options.jwtExpiryHours ?? env.jwtExpiryHours ?? 24,
    corsPolicy: options.corsPolicy ?? createDefaultCorsPolicy(),
  };

  if (env.isProduction) {
    if (!settings.enforceHttps) throw new Error('HTTPS enforcement cannot be disabled in production');
    if (!settings.rateLimitStore) throw new Error('Rate limiting cannot be disabled in production');
    if (settings.clientIpSource === ClientIpSource.SOCKET) {
      throw new Error('Production must use a trusted proxy configuration (not bare socket)');
    }
    if (settings.clientIpSource === ClientIpSource.VERCEL_CLOUDFLARE && !settings.originAuthSecret) {
      throw new Error('Production on Vercel requires ORIGIN_AUTH_SECRET');
    }
  }

  const registry = options.applications ?? applications;
  const app = express();

  app.disable('x-powered-by');
  app.disable('etag'); // API responses are never cached (Cache-Control: no-store)
  // Express's own proxy trust stays OFF: X-Forwarded-* is never trusted
  // implicitly. Client IP and protocol come from shared/security/clientIp.js.
  app.set('trust proxy', false);

  app.locals.rateLimitStore = settings.rateLimitStore;
  app.locals.rateLimitSecret = settings.rateLimitSecret;
  app.locals.corsPolicy = settings.corsPolicy;

  // Platform-wide middleware
  app.use(requestId);
  app.use(securityHeaders({ hsts: settings.enforceHttps }));
  app.use(requestLogger);
  app.use(clientIdentity({ source: settings.clientIpSource, originSecret: settings.originAuthSecret }));
  if (settings.enforceHttps) {
    app.use(requireHttps({ source: settings.clientIpSource, originSecret: settings.originAuthSecret }));
  }
  // CORS: answers preflights, adds headers for allowed origins (see cors.js).
  app.use(cors({ apiBase: API_BASE }));
  // strict: only objects/arrays as top-level JSON.
  // inflate: false: compressed bodies are refused (no decompression bombs).
  app.use(express.json({ limit: env.bodyLimit, strict: true, inflate: false }));

  // Platform health check
  app
    .route(`${API_PREFIX}/health`)
    .get((req, res) => sendSuccess(res, { message: 'Central Backend is running' }))
    .all(methodNotAllowed(['GET', 'HEAD']));

  // Database connectivity check (never exposes connection details or errors)
  app
    .route(`${API_PREFIX}/health/database`)
    .get(async (req, res) => {
      if (!database.isConfigured()) {
        return sendError(res, { statusCode: 503, message: 'Database is not configured' });
      }
      try {
        await database.ping();
        return sendSuccess(res, { message: 'Database is reachable' });
      } catch (err) {
        logger.error('database health check failed', { requestId: req.id, code: err.code });
        return sendError(res, { statusCode: 503, message: 'Database is unreachable' });
      }
    })
    .all(methodNotAllowed(['GET', 'HEAD']));

  // Platform endpoints that span applications
  app.use(`${API_BASE}/submissions`, createSubmissionsRouter(registry));
  app.use(
    `${API_BASE}/admin`,
    createAdminRouter({
      applications: registry,
      jwtSecret: settings.jwtSecret,
      jwtExpiryHours: settings.jwtExpiryHours,
    })
  );

  // Mount each application on its own isolated namespace
  const seen = new Set();
  for (const application of registry) {
    if (seen.has(application.slug)) {
      throw new Error(`Duplicate application slug: "${application.slug}"`);
    }
    if (RESERVED_SLUGS.has(application.slug)) {
      throw new Error(`Application slug "${application.slug}" is reserved`);
    }
    seen.add(application.slug);
    app.use(`${API_BASE}/${application.slug}`, application.router);
  }

  // Must be registered last
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
