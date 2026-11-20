/**
 * Migration rehearsal: old shared-table structure → one table per form.
 *
 * Rebuilds the isolated TEST database to the structure that existed before
 * the per-form tables (migrations up to the old 002/003), seeds realistic old
 * rows, then applies the new migrations and proves:
 *   - every old row is copied exactly into ITS form's own table
 *   - the old tables keep their data byte-for-byte and become insert-frozen
 *   - the Epi Well schema rename, the rate-limit table move and the audit
 *     column are non-destructive
 *   - an old row that cannot be carried over aborts the whole migration
 *
 * Opt-in (npm run test:db). Destructive to the test database only: it refuses
 * to run unless the database is the dedicated test database.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const DAY = 86_400_000;

describe('migration rehearsal (real test database)', { skip: !enabled && 'TEST_DATABASE_URL not set (run npm run test:db)' }, () => {
  let database;
  let runMigrations;
  let targets;
  const SCHEMAS = ['epineon', 'qaegis', 'epi_well', 'epiwell', 'platform_admin', 'platform_security'];

  const numberOf = (file) => Number(file.slice(0, 3));
  // "Before" = what was applied to production before this change: apps up to 002, platform up to 003.
  const beforeOnly = (target, file) => numberOf(file) <= (target.slug === 'platform' ? 3 : 2);

  async function resetToOld() {
    for (const schema of SCHEMAS) await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await database.query('DROP TABLE IF EXISTS public.schema_migrations');
    await runMigrations(targets, { only: beforeOnly });
  }

  const checksum = async (table) =>
    (await database.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t.submission_id)), 'empty') AS sum FROM ${table} t`)).rows[0];

  async function seedLegacy(schema, app, formType, data, { status = 'new', ageDays, read = false, changed = false }) {
    const id = randomUUID();
    const received = new Date(Date.now() - ageDays * DAY);
    await database.query(
      `INSERT INTO ${schema}.form_submissions
         (submission_id, application, form_type, data, received_at, status, read_at, read_by, status_changed_at, status_changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, app, formType, JSON.stringify(data), received, status,
        read ? new Date(received.getTime() + 3_600_000) : null, read ? randomUUID() : null,
        changed ? new Date(received.getTime() + 7_200_000) : null, changed ? randomUUID() : null],
    );
    return id;
  }

  // schema (old, in the table the rows came from) → new schema/table/columns
  const FORMS = [
    { app: 'epineon', oldSchema: 'epineon', newSchema: 'epineon', formType: 'demo', table: 'demo_submissions',
      columns: { name: 'name', email: 'email', company: 'company', role: 'role', product: 'product', message: 'message' } },
    { app: 'epineon', oldSchema: 'epineon', newSchema: 'epineon', formType: 'sales', table: 'sales_submissions',
      columns: { name: 'name', email: 'email', company: 'company', role: 'role', product: 'product', use_case: 'useCase', message: 'message' } },
    { app: 'epineon', oldSchema: 'epineon', newSchema: 'epineon', formType: 'partnerships', table: 'partnerships_submissions',
      columns: { name: 'name', email: 'email', organization: 'organization', nature: 'nature' } },
    { app: 'qaegis', oldSchema: 'qaegis', newSchema: 'qaegis', formType: 'contact-sales', table: 'contact_sales_submissions',
      columns: { first_name: 'firstName', last_name: 'lastName', work_email: 'workEmail', company_website: 'companyWebsite', user_range: 'userRange', message: 'message' } },
    { app: 'epi-well', oldSchema: 'epi_well', newSchema: 'epiwell', formType: 'waitlist', table: 'waitlist_submissions',
      columns: { email: 'email' } },
  ];

  const seeded = []; // { form, id, data, legacy row facts }

  before(async () => {
    assert.equal(new URL(process.env.TEST_DATABASE_URL).pathname, '/central_backend_test', 'refusing to run: not the dedicated test database');
    assert.notEqual(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    ({ database } = await import('../src/shared/database/index.js'));
    ({ runMigrations } = await import('../src/shared/database/migrator.js'));
    const { PLATFORM_MIGRATIONS } = await import('../src/shared/database/migrator.js');
    const { applications } = await import('../src/applications/index.js');
    targets = [PLATFORM_MIGRATIONS, ...applications.map(({ migrationKey, migrationsDir }) => ({ slug: migrationKey, migrationsDir }))];
    assert.equal((await database.query('SELECT current_database() AS db')).rows[0].db, 'central_backend_test');
  });

  after(async () => {
    // Leave the test database fully migrated and empty for the other suites.
    await resetToOld();
    await runMigrations(targets);
    await database.close();
  });

  describe('the old structure is rebuilt exactly as it was in production', () => {
    test('old schemas and shared tables exist; per-form tables do not', async () => {
      await resetToOld();
      const { rows } = await database.query(
        `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
         WHERE table_schema = ANY($1) ORDER BY 1`, [SCHEMAS]);
      const names = rows.map((r) => r.t);
      assert.ok(names.includes('epi_well.form_submissions'));
      assert.ok(names.includes('platform_security.rate_limit_counters'));
      assert.ok(!names.some((n) => n.endsWith('demo_submissions') || n.startsWith('epiwell.')));
    });
  });

  describe('migrating existing data', () => {
    let baseline;
    let sharedFacts;

    before(async () => {
      await resetToOld();
      const data = {
        demoFull: { name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Engines', role: 'CTO', product: 'EPICRYPT', message: 'Reporting\nand integrations' },
        demoMin: { name: 'Min Demo', email: 'min@example.com', company: 'Min Co', product: 'Not sure yet' },
        sales: { name: 'Grace Hopper', email: 'grace@example.org', company: 'Compilers', role: 'VP', product: 'SoulChain', useCase: 'Health & wellness', message: 'Enterprise rollout' },
        partner: { name: 'Alan Turing', email: 'alan@example.co.uk', organization: 'Bletchley', nature: 'Investment' },
        qaFull: { firstName: 'Katherine', lastName: 'Johnson', workEmail: 'Katherine@Example.com', companyWebsite: 'https://example.com', userRange: '51-250', message: 'SSO' },
        qaMin: { firstName: 'Min', lastName: 'Q', workEmail: 'min@qaegis.test', userRange: '1000+', message: 'Hi' },
        wait1: { email: 'member.one@example.com' },
        wait2: { email: 'member.two@example.com' },
      };
      const add = async (form, key, opts) => {
        const id = await seedLegacy(form.oldSchema, form.app, form.formType, data[key], opts);
        seeded.push({ form, id, data: data[key] });
      };
      await add(FORMS[0], 'demoFull', { ageDays: 3, status: 'replied', read: true, changed: true });
      await add(FORMS[0], 'demoMin', { ageDays: 1 });
      await add(FORMS[1], 'sales', { ageDays: 5, status: 'in_progress', read: true, changed: true });
      await add(FORMS[2], 'partner', { ageDays: 9, status: 'closed', read: true, changed: true });
      await add(FORMS[3], 'qaFull', { ageDays: 2, status: 'archived', read: true, changed: true });
      await add(FORMS[3], 'qaMin', { ageDays: 4 });
      await add(FORMS[4], 'wait1', { ageDays: 1 });
      await add(FORMS[4], 'wait2', { ageDays: 6, status: 'archived', read: true, changed: true });

      // platform data that must survive the platform changes
      await database.query(`INSERT INTO platform_security.rate_limit_counters (scope, client_key, window_seconds, window_start, hits, expires_at)
        VALUES ('epineon:demo', $1, 600, date_trunc('hour', now()), 3, date_trunc('hour', now()) + interval '10 minutes')`, ['a'.repeat(64)]);
      const user = await database.query(`INSERT INTO platform_admin.admin_users (email) VALUES ('rehearsal@admin.test') RETURNING id`);
      await database.query(`INSERT INTO platform_admin.admin_app_access (user_id, application) VALUES ($1, 'epi-well'), ($1, 'epineon')`, [user.rows[0].id]);
      await database.query(`INSERT INTO platform_admin.audit_log (actor_id, action, application, details) VALUES ($1, 'submission.deleted', 'epi-well', '{"formType":"waitlist"}')`, [user.rows[0].id]);

      baseline = {
        epineon: await checksum('epineon.form_submissions'),
        qaegis: await checksum('qaegis.form_submissions'),
        epiWell: await checksum('epi_well.form_submissions'),
        audit: (await database.query('SELECT md5(string_agg(a::text, $1 ORDER BY a.id)) AS s FROM platform_admin.audit_log a', ['|'])).rows[0].s,
        migrations: (await database.query('SELECT count(*)::int AS n FROM public.schema_migrations')).rows[0].n,
      };
      sharedFacts = (await database.query(`SELECT submission_id, status, read_at, read_by, status_changed_at, status_changed_by, received_at, updated_at FROM epineon.form_submissions
        UNION ALL SELECT submission_id, status, read_at, read_by, status_changed_at, status_changed_by, received_at, updated_at FROM qaegis.form_submissions
        UNION ALL SELECT submission_id, status, read_at, read_by, status_changed_at, status_changed_by, received_at, updated_at FROM epi_well.form_submissions`)).rows;
      assert.equal(sharedFacts.length, 8);

      await runMigrations(targets); // the new migrations
    });

    test('exactly the new migrations were applied, and history stays under the old Epi Well key', async () => {
      const { rows } = await database.query('SELECT application, name FROM public.schema_migrations ORDER BY application, name');
      const names = rows.map((r) => `${r.application}/${r.name}`);
      assert.equal(rows.length, baseline.migrations + 4);
      for (const expected of [
        'epineon/003_create_form_tables.sql', 'qaegis/003_create_form_tables.sql',
        'epi-well/003_rename_schema_and_create_form_tables.sql', 'platform/004_move_rate_limits_and_extend_audit.sql',
        'epi-well/001_create_form_submissions.sql', 'epi-well/002_add_submission_workflow.sql',
      ]) assert.ok(names.includes(expected), expected);
      assert.ok(!names.some((n) => n.startsWith('epiwell/')), 'no history under the new slug');
    });

    for (const form of FORMS) {
      test(`${form.app}/${form.formType}: every old row is copied exactly into ${form.newSchema}.${form.table}`, async () => {
        const mine = seeded.filter((s) => s.form === form);
        assert.ok(mine.length >= 1);
        const { rows } = await database.query(`SELECT * FROM ${form.newSchema}.${form.table} ORDER BY created_at`);
        assert.equal(rows.length, mine.length, 'row count');
        for (const s of mine) {
          const row = rows.find((r) => r.id === s.id);
          assert.ok(row, `row ${s.id} missing`);
          for (const [column, key] of Object.entries(form.columns)) {
            assert.equal(row[column], s.data[key] ?? null, `${column}`);
          }
          const old = sharedFacts.find((f) => f.submission_id === s.id);
          assert.equal(row.status, old.status);
          assert.equal(row.is_read, old.read_at !== null);
          assert.equal(row.read_at?.getTime() ?? null, old.read_at?.getTime() ?? null);
          assert.equal(row.read_by, old.read_by);
          assert.equal(row.status_changed_at?.getTime() ?? null, old.status_changed_at?.getTime() ?? null);
          assert.equal(row.status_changed_by, old.status_changed_by);
          assert.equal(row.created_at.getTime(), old.received_at.getTime(), 'created_at = old received_at');
          assert.equal(row.updated_at.getTime(), old.updated_at.getTime());
        }
      });
    }

    test('a form\'s rows are in ITS table only (nothing leaked into another form\'s table)', async () => {
      const ids = (rows) => rows.map((r) => r.id).sort();
      for (const form of FORMS) {
        const mine = seeded.filter((s) => s.form === form).map((s) => s.id).sort();
        const stored = ids((await database.query(`SELECT id FROM ${form.newSchema}.${form.table}`)).rows);
        assert.deepEqual(stored, mine, `${form.table} holds exactly its own rows`);
      }
    });

    test('the old shared tables are untouched byte-for-byte', async () => {
      assert.deepEqual(await checksum('epineon.form_submissions'), baseline.epineon);
      assert.deepEqual(await checksum('qaegis.form_submissions'), baseline.qaegis);
      assert.deepEqual(await checksum('epiwell.form_submissions'), baseline.epiWell, 'the Epi Well table moved with its renamed schema');
    });

    test('the old shared tables are frozen: inserts are rejected, reads still work', async () => {
      for (const schema of ['epineon', 'qaegis', 'epiwell']) {
        await assert.rejects(
          database.query(`INSERT INTO ${schema}.form_submissions (submission_id, application, form_type, data, received_at)
                          VALUES (gen_random_uuid(), $1, 'x', '{}', now())`, [schema === 'epiwell' ? 'epi-well' : schema]),
          (err) => err.code === '0A000' && /frozen/.test(err.message), schema,
        );
        assert.ok((await checksum(`${schema}.form_submissions`)).n > 0);
      }
    });

    test('Epi Well: the old schema name is gone, the new one holds everything', async () => {
      const { rows } = await database.query(`SELECT nspname FROM pg_namespace WHERE nspname IN ('epi_well', 'epiwell')`);
      assert.deepEqual(rows.map((r) => r.nspname), ['epiwell']);
    });

    test('platform: rate-limit data moved to platform_admin, nothing lost', async () => {
      assert.equal((await database.query(`SELECT to_regclass('platform_security.rate_limit_counters') AS t`)).rows[0].t, null);
      const { rows } = await database.query('SELECT scope, hits FROM platform_admin.rate_limit_counters');
      assert.deepEqual(rows, [{ scope: 'epineon:demo', hits: 3 }]);
      assert.equal((await database.query('SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = $1 AND schemaname = $2', ['rate_limit_counters', 'platform_admin'])).rows[0].n, 2);
    });

    test('platform: access rows follow the Epi Well rename, audit history is untouched and gains form_type', async () => {
      const { rows } = await database.query(`SELECT application FROM platform_admin.admin_app_access ORDER BY application`);
      assert.deepEqual(rows.map((r) => r.application), ['epineon', 'epiwell']);
      const audit = await database.query('SELECT application, form_type, details FROM platform_admin.audit_log');
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].application, 'epi-well', 'append-only history is never rewritten');
      assert.equal(audit.rows[0].form_type, null);
    });

    test('re-running the migrations changes nothing', async () => {
      const results = await runMigrations(targets);
      assert.ok(results.every((r) => r.status === 'skipped'));
    });
  });

  describe('an old row that cannot be carried over aborts everything', () => {
    test('unknown form type → migration fails and the new tables are not created (full rollback)', async () => {
      await resetToOld();
      // Bypass nothing: just store an old-structure row with a form type the new design does not know.
      await seedLegacy('epineon', 'epineon', 'newsletter', { email: 'x@example.com' }, { ageDays: 1 });
      const sum = await checksum('epineon.form_submissions');

      await assert.rejects(runMigrations(targets), /unknown form_type/);

      assert.equal((await database.query(`SELECT to_regclass('epineon.demo_submissions') AS t`)).rows[0].t, null, 'nothing half-created');
      assert.deepEqual(await checksum('epineon.form_submissions'), sum, 'old data intact');
      const applied = await database.query(`SELECT name FROM public.schema_migrations WHERE application = 'epineon' ORDER BY name`);
      assert.deepEqual(applied.rows.map((r) => r.name), ['001_create_form_submissions.sql', '002_add_submission_workflow.sql']);
    });

    test('a row that violates a new constraint (e.g. unknown product) aborts and rolls back', async () => {
      await resetToOld();
      await seedLegacy('epineon', 'epineon', 'demo', { name: 'X', email: 'x@example.com', company: 'C', product: 'Not A Product' }, { ageDays: 1 });
      await assert.rejects(runMigrations(targets), (err) => err.code === '23514');
      assert.equal((await database.query(`SELECT to_regclass('epineon.demo_submissions') AS t`)).rows[0].t, null);
    });
  });
});
