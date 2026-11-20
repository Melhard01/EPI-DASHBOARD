/**
 * Rate-limit counter stores.
 *
 * Interface (both stores):
 *   hit(scope, clientKey, windows: number[])
 *     → Promise<Array<{ windowSeconds, hits, resetSeconds }>>
 *   Atomically records one hit in the current fixed window of each window
 *   size and returns the updated count for each.
 *
 * - PostgresRateLimitStore: production. Shared across every server instance,
 *   exact under concurrency, and works on Node.js today and on Cloudflare
 *   Workers via Hyperdrive later.
 * - MemoryRateLimitStore: tests and local development only. Per-process, so
 *   it is refused in production.
 *
 * A Durable Object store could implement the same interface later.
 */
import { logger } from '../utils/logger.js';

const TABLE = 'platform_security.rate_limit_counters';

// One statement, atomic per row: ON CONFLICT ... DO UPDATE takes a row lock,
// so concurrent requests are serialized and every hit is counted exactly once.
// Window boundaries use the database clock (now()), so all server instances
// agree on window boundaries regardless of their local clocks.
const HIT_SQL = `
  INSERT INTO ${TABLE} AS c (scope, client_key, window_seconds, window_start, hits, expires_at)
  SELECT $1, $2, w.seconds, s.window_start, 1, s.window_start + make_interval(secs => w.seconds)
  FROM unnest($3::int[]) AS w(seconds)
  CROSS JOIN LATERAL (
    SELECT to_timestamp(floor(extract(epoch FROM now()) / w.seconds) * w.seconds) AS window_start
  ) AS s
  ON CONFLICT (scope, client_key, window_seconds, window_start)
  DO UPDATE SET hits = c.hits + 1
  RETURNING window_seconds,
            hits,
            GREATEST(1, CEIL(EXTRACT(epoch FROM (c.expires_at - now()))))::int AS reset_seconds`;

// Bounded batch delete of expired windows (keeps each cleanup cheap).
const CLEANUP_SQL = `
  DELETE FROM ${TABLE}
  WHERE ctid = ANY (ARRAY(
    SELECT ctid FROM ${TABLE} WHERE expires_at < now() LIMIT 1000
  ))`;

export class PostgresRateLimitStore {
  /**
   * @param {{ database: { query: Function }, cleanupProbability?: number, random?: () => number }} deps
   */
  constructor({ database, cleanupProbability = 0.01, random = Math.random }) {
    this.database = database;
    this.cleanupProbability = cleanupProbability;
    this.random = random;
  }

  async hit(scope, clientKey, windows) {
    const { rows } = await this.database.query(HIT_SQL, [scope, clientKey, windows]);
    if (rows.length !== windows.length) {
      throw new Error('Rate limit store returned an unexpected number of rows');
    }

    // Opportunistic cleanup of expired counters. It is awaited because
    // Cloudflare Workers may cancel un-awaited work after the response.
    if (this.random() < this.cleanupProbability) {
      await this.database.query(CLEANUP_SQL).catch((err) => {
        logger.warn('rate limit cleanup failed', { code: err.code });
      });
    }

    return rows.map((r) => ({
      windowSeconds: Number(r.window_seconds),
      hits: Number(r.hits),
      resetSeconds: Number(r.reset_seconds),
    }));
  }
}

export class MemoryRateLimitStore {
  /** @param {{ now?: () => number }} [options] now() returns epoch milliseconds */
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.counters = new Map();
  }

  async hit(scope, clientKey, windows) {
    const nowSeconds = this.now() / 1000;
    this.#evictExpired(nowSeconds);

    return windows.map((windowSeconds) => {
      const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
      const expiresAt = windowStart + windowSeconds;
      const key = `${scope}|${clientKey}|${windowSeconds}|${windowStart}`;
      const entry = this.counters.get(key) ?? { hits: 0, expiresAt };
      entry.hits += 1;
      this.counters.set(key, entry);
      return {
        windowSeconds,
        hits: entry.hits,
        resetSeconds: Math.max(1, Math.ceil(expiresAt - nowSeconds)),
      };
    });
  }

  #evictExpired(nowSeconds) {
    if (this.counters.size < 10_000) return;
    for (const [key, entry] of this.counters) {
      if (entry.expiresAt <= nowSeconds) this.counters.delete(key);
    }
  }
}
