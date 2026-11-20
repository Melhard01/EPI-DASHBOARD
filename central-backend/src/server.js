/**
 * Local HTTP server entry point.
 * (A Cloudflare Workers entry point would use createApp() directly instead.)
 */
import { createApp } from './app.js';
import { applications } from './applications/index.js';
import { env } from './shared/config/env.js';
import { logger } from './shared/utils/logger.js';
import { database } from './shared/database/index.js';

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info('server started', {
    port: env.port,
    environment: env.nodeEnv,
    applications: applications.map((a) => a.slug),
    database: database.isConfigured() ? 'configured' : 'not configured',
    clientIpSource: env.clientIpSource,
    rateLimitStore: env.rateLimitStore,
    httpsEnforced: env.enforceHttps,
  });
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  server.close(async () => {
    await database.close().catch(() => {});
    process.exit(0);
  });
  // Force exit if open connections keep the server alive
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { reason: String(reason) });
});
