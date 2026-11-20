/**
 * Opt-in integration tests against a real PostgreSQL database.
 *
 * Skipped unless TEST_DATABASE_URL is set. Runs migrations, submits real
 * forms through the HTTP API, reads the rows back, then deletes exactly the
 * rows it created.
 *
 *   TEST_DATABASE_URL='postgresql://...' npm test
 */
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe('database integration', { skip: !enabled && 'TEST_DATABASE_URL not set' }, () => {
  let server;
  let baseUrl;
  let database;
  const created = []; // [schema, submissionId]
  const rateLimitedKeys = []; // client keys created by HTTP rate-limit tests

  before(async () => {
    mock.method(console, 'log', () => {});
    const { createApp } = await import('../src/app.js');
    ({ database } = await import('../src/shared/database/index.js'));
    const { runMigrations, PLATFORM_MIGRATIONS } = await import('../src/shared/database/migrator.js');
    const { applications } = await import('../src/applications/index.js');

    await runMigrations([
      PLATFORM_MIGRATIONS,
      ...applications.map(({ migrationKey, migrationsDir }) => ({ slug: migrationKey, migrationsDir })),
    ]);

    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    for (const [table, id] of created) {
      await database.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    }
    // Remove only the rate-limit rows these tests created.
    await database.query(
      `DELETE FROM platform_admin.rate_limit_counters
       WHERE scope LIKE 'itest:%' OR client_key = ANY($1::text[])`,
      [rateLimitedKeys],
    );
    await new Promise((resolve) => server.close(resolve));
    await database.close();
    mock.restoreAll();
  });

  async function post(path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  test('migrations are idempotent', async () => {
    const { runMigrations, PLATFORM_MIGRATIONS } = await import('../src/shared/database/migrator.js');
    const { applications } = await import('../src/applications/index.js');
    const results = await runMigrations([
      PLATFORM_MIGRATIONS,
      ...applications.map(({ migrationKey, migrationsDir }) => ({ slug: migrationKey, migrationsDir })),
    ]);
    assert.ok(results.every((r) => r.status === 'skipped'));
  });

  test('database health check reports reachable', async () => {
    const res = await fetch(`${baseUrl}/api/health/database`);
    assert.equal(res.status, 200);
  });

  test('an Epineon demo submission is stored only in epineon.demo_submissions', async () => {
    const payload = {
      name: '  Integration Test  ',
      email: 'integration-test@example.com',
      company: 'Test Co',
      product: 'EPICRYPT',
    };
    const { status, body } = await post('/api/v1/epineon/forms/demo', payload);
    assert.equal(status, 201);
    const id = body.data.submissionId;
    created.push(['epineon.demo_submissions', id]);

    const { rows } = await database.query(
      'SELECT name, email, company, role, product, message, status, is_read, created_at FROM epineon.demo_submissions WHERE id = $1',
      [id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Integration Test');
    assert.equal(rows[0].email, 'integration-test@example.com');
    assert.equal(rows[0].product, 'EPICRYPT');
    assert.equal(rows[0].role, null, 'optional fields left blank are NULL');
    assert.equal(rows[0].status, 'new');
    assert.equal(rows[0].is_read, false);
    assert.equal(rows[0].created_at.toISOString(), body.data.receivedAt);

    // The same id exists in NO other table: not another Epineon form, not another application.
    for (const table of ['epineon.sales_submissions', 'epineon.partnerships_submissions', 'qaegis.contact_sales_submissions', 'epiwell.waitlist_submissions',
      'epineon.form_submissions', 'qaegis.form_submissions', 'epiwell.form_submissions']) {
      const col = table.endsWith('form_submissions') ? 'submission_id' : 'id';
      assert.equal((await database.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [id])).rows.length, 0, table);
    }
  });

  test('a QAegis submission is stored only in qaegis.contact_sales_submissions', async () => {
    const { status, body } = await post('/api/v1/qaegis/forms/contact-sales', {
      firstName: 'Integration',
      lastName: 'Test',
      workEmail: 'integration-test@example.com',
      userRange: '1-50',
      message: 'Automated test',
    });
    assert.equal(status, 201);
    const id = body.data.submissionId;
    created.push(['qaegis.contact_sales_submissions', id]);

    const own = await database.query('SELECT first_name, last_name, work_email, user_range, message, company_website FROM qaegis.contact_sales_submissions WHERE id = $1', [id]);
    assert.deepEqual(own.rows[0], { first_name: 'Integration', last_name: 'Test', work_email: 'integration-test@example.com', user_range: '1-50', message: 'Automated test', company_website: null });
    for (const table of ['epineon.demo_submissions', 'epineon.sales_submissions', 'epineon.partnerships_submissions', 'epiwell.waitlist_submissions']) {
      assert.equal((await database.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rows.length, 0, table);
    }
  });

  // --------------------------------------------------- rate limiting (real PG)

  test('rate-limit counters are exact under heavy concurrency', async () => {
    const { PostgresRateLimitStore } = await import('../src/shared/security/rateLimitStores.js');
    const store = new PostgresRateLimitStore({ database, cleanupProbability: 0 });
    const clientKey = 'c'.repeat(64);
    const results = await Promise.all(
      Array.from({ length: 40 }, () => store.hit('itest:concurrency', clientKey, [600, 86400])),
    );
    // Every hit was counted exactly once: counts 1..40 with no duplicates or gaps.
    for (const window of [0, 1]) {
      const hits = results.map((r) => r[window].hits).sort((a, b) => a - b);
      assert.deepEqual(hits, Array.from({ length: 40 }, (_, i) => i + 1));
    }
    assert.ok(results.every((r) => r[0].resetSeconds >= 1 && r[0].resetSeconds <= 600));
  });

  test('rate-limit windows reset in the database', async () => {
    const { PostgresRateLimitStore } = await import('../src/shared/security/rateLimitStores.js');
    const store = new PostgresRateLimitStore({ database, cleanupProbability: 0 });
    const clientKey = 'd'.repeat(64);
    const [first] = await store.hit('itest:reset', clientKey, [1]);
    const [second] = await store.hit('itest:reset', clientKey, [1]);
    if (second.hits === 1) return; // crossed a second boundary between the two calls
    assert.equal(second.hits, first.hits + 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const [after] = await store.hit('itest:reset', clientKey, [1]);
    assert.equal(after.hits, 1);
  });

  test('HTTP: the Postgres-backed limiter returns 429 after the configured limit', async () => {
    const { createApp } = await import('../src/app.js');
    const { PostgresRateLimitStore } = await import('../src/shared/security/rateLimitStores.js');
    const { clientKeyFor } = await import('../src/shared/security/rateLimit.js');
    const secret = 'integration-secret-0123456789abcdef0123456789';
    const ip = '192.0.2.77';
    rateLimitedKeys.push(clientKeyFor(ip, secret));

    const limitedServer = createApp({
      clientIpSource: 'cloudflare-worker',
      rateLimitStore: new PostgresRateLimitStore({ database, cleanupProbability: 0 }),
      rateLimitSecret: secret,
    }).listen(0);
    await new Promise((resolve) => limitedServer.once('listening', resolve));
    const url = `http://127.0.0.1:${limitedServer.address().port}/api/v1/epineon/forms/partnerships`;
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        // Invalid body: counted by the limiter but never stored as a submission.
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
          body: JSON.stringify({ name: 'x' }),
        });
        statuses.push(res.status);
        if (res.status === 429) assert.ok(Number(res.headers.get('retry-after')) > 0);
      }
      assert.deepEqual(statuses, [400, 400, 400, 429]);

      const { rows } = await database.query(
        `SELECT scope, client_key FROM platform_admin.rate_limit_counters WHERE client_key = $1`,
        [rateLimitedKeys.at(-1)],
      );
      assert.equal(rows.length, 2); // 10-minute and daily windows
      assert.ok(rows.every((r) => r.scope === 'epineon:partnerships'));
      // Stored rows contain only the HMAC, never the IP address.
      assert.ok(!JSON.stringify(rows).includes(ip));
    } finally {
      await new Promise((resolve) => limitedServer.close(resolve));
    }
  });

  test('HTTP: concurrent requests through the Postgres limiter allow exactly the limit', async () => {
    const { createApp } = await import('../src/app.js');
    const { PostgresRateLimitStore } = await import('../src/shared/security/rateLimitStores.js');
    const { clientKeyFor } = await import('../src/shared/security/rateLimit.js');
    const secret = 'integration-secret-concurrency-0123456789abcdef';
    const ip = '192.0.2.88';
    rateLimitedKeys.push(clientKeyFor(ip, secret));

    const limitedServer = createApp({
      clientIpSource: 'cloudflare-worker',
      rateLimitStore: new PostgresRateLimitStore({ database, cleanupProbability: 0 }),
      rateLimitSecret: secret,
    }).listen(0);
    await new Promise((resolve) => limitedServer.once('listening', resolve));
    const url = `http://127.0.0.1:${limitedServer.address().port}/api/v1/epineon/forms/partnerships`;
    try {
      // Ventures allows 3 per 10 minutes. Invalid bodies: counted, never stored.
      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
            body: JSON.stringify({ name: 'x' }),
          }),
        ),
      );
      const statuses = responses.map((r) => r.status);
      assert.equal(statuses.filter((s) => s === 400).length, 3, `statuses: ${statuses}`);
      assert.equal(statuses.filter((s) => s === 429).length, 17);

      const { rows } = await database.query(
        `SELECT window_seconds, hits FROM platform_admin.rate_limit_counters
         WHERE client_key = $1 ORDER BY window_seconds`,
        [rateLimitedKeys.at(-1)],
      );
      assert.deepEqual(rows.map((r) => [r.window_seconds, r.hits]), [[600, 20], [86400, 20]]);
    } finally {
      await new Promise((resolve) => limitedServer.close(resolve));
    }
  });

  test('the database connection uses verified TLS', async () => {
    const tls = await database.inspectTls();
    assert.equal(tls.encrypted, true);
    assert.equal(tls.authorized, true, 'server certificate must be verified');
    assert.match(tls.protocol, /^TLSv1\.[23]$/);
  });

  test('the database refuses writes to the old shared tables (frozen) and bad rows in the new ones', async () => {
    await assert.rejects(
      database.query(
        `INSERT INTO qaegis.form_submissions (submission_id, application, form_type, data, received_at)
         VALUES (gen_random_uuid(), 'qaegis', 'contact-sales', '{}'::jsonb, now())`,
      ),
      (err) => err.code === '0A000',
    );
    await assert.rejects(
      database.query(`INSERT INTO qaegis.contact_sales_submissions (first_name, last_name, work_email, user_range, message)
                      VALUES ('F', 'L', 'a@b.co', 'not-a-range', 'm')`),
      (err) => err.code === '23514', // check_violation
    );
  });
});
