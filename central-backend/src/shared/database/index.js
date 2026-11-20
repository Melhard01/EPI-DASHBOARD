/**
 * Shared PostgreSQL access layer (infrastructure only).
 *
 * - One lazily-created connection pool per process. It is reused across warm
 *   serverless invocations and kept small for Neon's pooled endpoint.
 * - Contains no application SQL. Each application owns its own repositories
 *   and migrations, and only ever writes to its own schema.
 * - `database` is a plain object so tests can replace `database.query` with
 *   node:test's mock.method() without touching a real database.
 */
import pg from 'pg';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

let pool = null;

function createPool() {
  const url = new URL(env.databaseUrl);
  const channelBinding = url.searchParams.get('channel_binding') === 'require';

  const newPool = new pg.Pool({
    connectionString: env.databaseUrl,
    enableChannelBinding: channelBinding,
    max: env.dbPoolMax,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
    application_name: 'central-backend',
  });

  // Idle-client errors (e.g. the server closed the connection) must not crash
  // the process. Only the code and message are logged, never query parameters.
  newPool.on('error', (err) => {
    logger.error('database pool error', { code: err.code, error: err.message });
  });

  return newPool;
}

function getPool() {
  if (!env.databaseUrl) {
    throw new AppError('Service temporarily unavailable', 503);
  }
  pool ??= createPool();
  return pool;
}

/**
 * Validates a schema/table identifier that comes from application config.
 * Identifiers can't be parameterized in SQL, so they are restricted to a
 * safe character set and checked when the module loads.
 */
export function assertSafeIdentifier(name) {
  if (typeof name !== 'string' || !IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`Unsafe SQL identifier: "${name}"`);
  }
  return name;
}

export const database = {
  isConfigured() {
    return Boolean(env.databaseUrl);
  },

  /** Parameterized query. Always pass values via `params`, never by string concatenation. */
  async query(text, params) {
    return getPool().query(text, params);
  },

  /** Runs `fn(client)` inside a transaction on a dedicated connection. */
  async withTransaction(fn) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  async ping() {
    await database.query('SELECT 1');
  },

  /**
   * Reports the TLS state of a live pooled connection (for tests and
   * diagnostics). Returns no addresses, credentials or certificate details.
   */
  async inspectTls() {
    const client = await getPool().connect();
    try {
      const socket = client.connection?.stream;
      return {
        encrypted: socket?.encrypted === true,
        authorized: socket?.authorized === true,
        protocol: typeof socket?.getProtocol === 'function' ? socket.getProtocol() : null,
      };
    } finally {
      client.release();
    }
  },

  async close() {
    if (pool) {
      const current = pool;
      pool = null;
      await current.end();
    }
  },
};
