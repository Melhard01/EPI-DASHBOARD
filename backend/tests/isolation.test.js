/**
 * Architecture guard: enforces module boundaries.
 *
 * - An application may import from itself, from src/shared, or from packages.
 * - An application may NOT import from another application.
 * - src/shared may NOT import from any application.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const appsDir = path.join(srcDir, 'applications');
const sharedDir = path.join(srcDir, 'shared');

function listJsFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return listJsFiles(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

function relativeImports(file) {
  const source = readFileSync(file, 'utf8');
  const pattern = /(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  return [...source.matchAll(pattern)].map((m) => path.resolve(path.dirname(file), m[1] ?? m[2]));
}

const appNames = readdirSync(appsDir).filter((e) => statSync(path.join(appsDir, e)).isDirectory());

for (const appName of appNames) {
  test(`application "${appName}" does not import other applications`, () => {
    const ownDir = path.join(appsDir, appName) + path.sep;
    for (const file of listJsFiles(path.join(appsDir, appName))) {
      for (const target of relativeImports(file)) {
        const crossesIntoApps = target.startsWith(appsDir + path.sep) && !target.startsWith(ownDir);
        assert.ok(
          !crossesIntoApps,
          `${path.relative(srcDir, file)} imports ${path.relative(srcDir, target)}`,
        );
      }
    }
  });
}

test('shared code does not import application code', () => {
  for (const file of listJsFiles(sharedDir)) {
    for (const target of relativeImports(file)) {
      assert.ok(
        !target.startsWith(appsDir + path.sep) && target !== appsDir,
        `${path.relative(srcDir, file)} imports ${path.relative(srcDir, target)}`,
      );
    }
  }
});

// ------------------------------------------------------------------ database

const { applications } = await import('../src/applications/index.js');

test('every application has a unique database schema', () => {
  const schemas = applications.map((a) => a.dbSchema);
  assert.equal(new Set(schemas).size, schemas.length, `duplicate schemas: ${schemas}`);
});

for (const app of applications) {
  test(`migrations of "${app.slug}" only touch its own schema (${app.dbSchema})`, () => {
    const others = applications.filter((a) => a !== app).flatMap((a) => [a.dbSchema, ...a.legacySchemas]);
    const own = [app.dbSchema, ...app.legacySchemas];
    const files = readdirSync(app.migrationsDir).filter((f) => f.endsWith('.sql'));
    assert.ok(files.length > 0, 'expected at least one migration');
    for (const file of files) {
      const sql = readFileSync(path.join(app.migrationsDir, file), 'utf8').toLowerCase();
      for (const other of others) {
        assert.ok(
          !new RegExp(`\\b${other}\\s*\\.`).test(sql) && !new RegExp(`schema[^;]*\\b${other}\\b`).test(sql),
          `${app.slug}/${file} references schema "${other}"`,
        );
      }
      assert.ok(own.some((schema) => sql.includes(`${schema}.`)), `${app.slug}/${file} should use one of its own schemas (${own})`);
    }
  });
}

// ------------------------------------------------- platform security schema

const { PLATFORM_MIGRATIONS } = await import('../src/shared/database/migrator.js');
// Platform-owned schemas (shared infrastructure, never application data).
const PLATFORM_SCHEMAS = ['platform_security', 'platform_admin'];

test('application migrations never touch the platform security schema', () => {
  for (const app of applications) {
    for (const file of readdirSync(app.migrationsDir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(path.join(app.migrationsDir, file), 'utf8').toLowerCase();
      for (const schema of PLATFORM_SCHEMAS) {
        assert.ok(!sql.includes(schema), `${app.slug}/${file} references ${schema}`);
      }
    }
  }
});

test('platform migrations never touch application schemas', () => {
  const files = readdirSync(PLATFORM_MIGRATIONS.migrationsDir).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const sql = readFileSync(path.join(PLATFORM_MIGRATIONS.migrationsDir, file), 'utf8').toLowerCase();
    for (const app of applications) {
      assert.ok(!new RegExp(`\\b${app.dbSchema}\\s*\\.`).test(sql), `platform/${file} references ${app.dbSchema}`);
    }
    // Every platform migration works in a known platform schema, and only there.
    assert.ok(PLATFORM_SCHEMAS.some((schema) => sql.includes(`${schema}.`)), `platform/${file}`);
    const qualified = [...sql.matchAll(/\b(?:schema\s+(?:if\s+not\s+exists\s+)?|on\s+|into\s+|from\s+|table\s+(?:if\s+not\s+exists\s+)?|function\s+|references\s+)([a-z_][a-z0-9_]*)\./g)].map((m) => m[1]);
    for (const schema of qualified) {
      assert.ok(PLATFORM_SCHEMAS.includes(schema), `platform/${file} uses non-platform schema "${schema}"`);
    }
  }
});

test('no application schema is named like the platform schema', () => {
  assert.ok(applications.every((a) => !PLATFORM_SCHEMAS.includes(a.dbSchema) && a.dbSchema !== 'public'));
  assert.ok(applications.every((a) => !a.dbSchema.startsWith('platform_')));
});

for (const app of applications) {
  test(`application "${app.slug}" defines its own rate limits for exactly its own forms`, async () => {
    const { formRateLimits } = await import(`../src/applications/${app.slug}/config/rate-limits.js`);
    const { forms } = await import(`../src/applications/${app.slug}/forms/index.js`);
    assert.deepEqual(Object.keys(formRateLimits).sort(), forms.map((f) => f.type).sort());
  });
}

// ------------------------------------------------------ platform layer (Step 5)

const platformDir = path.join(srcDir, 'platform');

test('platform code (unified submissions + admin API) does not import application code', () => {
  const files = listJsFiles(platformDir);
  assert.ok(files.length > 0);
  for (const file of files) {
    for (const target of relativeImports(file)) {
      assert.ok(
        !target.startsWith(appsDir + path.sep) && target !== appsDir,
        `${path.relative(srcDir, file)} imports ${path.relative(srcDir, target)}`,
      );
    }
  }
});

test('applications never import the platform layer', () => {
  for (const file of listJsFiles(appsDir)) {
    for (const target of relativeImports(file)) {
      assert.ok(
        !target.startsWith(platformDir + path.sep),
        `${path.relative(srcDir, file)} imports ${path.relative(srcDir, target)}`,
      );
    }
  }
});

test('every application schema is queried only through its own descriptor (no hard-coded schema names in platform code)', () => {
  for (const file of listJsFiles(platformDir)) {
    const source = readFileSync(file, 'utf8');
    for (const app of applications) {
      assert.ok(
        !new RegExp(`\\b${app.dbSchema}\\.[a-z_]+`).test(source),
        `${path.relative(srcDir, file)} hard-codes ${app.dbSchema}`,
      );
    }
  }
});

test('submission statuses in the admin API match every application\'s CHECK constraint', async () => {
  const { SUBMISSION_STATUSES } = await import('../src/platform/admin/statuses.js');
  for (const app of applications) {
    // Both the old shared-table migration (002) and the per-form tables migration (003).
    for (const file of readdirSync(app.migrationsDir).filter((f) => /^00[23]_/.test(f))) {
      const sql = readFileSync(path.join(app.migrationsDir, file), 'utf8');
      const checks = [...sql.matchAll(/CHECK \(status IN \(([^)]+)\)\)/g)];
      assert.ok(checks.length > 0, `${app.slug}/${file}: status CHECK not found`);
      for (const match of checks) {
        const declared = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
        assert.deepEqual(declared, [...SUBMISSION_STATUSES], `${app.slug}/${file}`);
      }
    }
  }
});


// ------------------------------------------------ one dedicated table per form

const COMMON_COLUMNS = ['id', 'status', 'is_read', 'read_at', 'read_by', 'status_changed_at', 'status_changed_by', 'created_at', 'updated_at'];

/** The CREATE TABLE statement for schema.table, found in any of the application's migrations. */
function createTableBlock(app, table) {
  const matches = [];
  for (const file of readdirSync(app.migrationsDir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(path.join(app.migrationsDir, file), 'utf8');
    const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${app.dbSchema}\\.${table} \\(([\\s\\S]*?)\\n\\);`);
    const match = re.exec(sql);
    if (match) matches.push({ file, block: match[1] });
  }
  return matches;
}

describe('one dedicated table per form', () => {
  const allForms = applications.flatMap((app) => app.forms.map((form) => ({ app, form })));

  test('there are five forms, each with its own table name (unique across the whole platform)', () => {
    assert.equal(allForms.length, 5);
    const names = allForms.map(({ app, form }) => `${app.dbSchema}.${form.table}`);
    assert.equal(new Set(names).size, names.length, `duplicate table: ${names}`);
    for (const { form } of allForms) {
      assert.match(form.table, /^[a-z][a-z0-9_]*_submissions$/);
      assert.notEqual(form.table, 'form_submissions', 'the shared table must never be used');
    }
  });

  test('no two forms of an application share a table; names follow the form type', () => {
    for (const app of applications) {
      const tables = app.forms.map((f) => f.table);
      assert.equal(new Set(tables).size, tables.length, app.slug);
      for (const form of app.forms) {
        assert.equal(form.table, `${form.type.replace(/-/g, '_')}_submissions`, `${app.slug}/${form.type}`);
      }
    }
  });

  for (const { app, form } of allForms) {
    describe(`${app.slug}/${form.type} → ${app.dbSchema}.${form.table}`, () => {
      const created = createTableBlock(app, form.table);

      test('is created by exactly one migration, in the application\'s own schema', () => {
        assert.equal(created.length, 1, `expected exactly one CREATE TABLE for ${app.dbSchema}.${form.table}`);
      });

      test('has every form field as a column, plus the common workflow columns, and nothing else', () => {
        const columns = [...created[0].block.matchAll(/^\s{2}([a-z_]+)\s+(?:uuid|text|boolean|timestamptz)\b/gm)].map((m) => m[1]);
        const expected = [...COMMON_COLUMNS, ...Object.values(form.fields).map((f) => f.column)].sort();
        assert.deepEqual([...columns].sort(), expected);
        assert.ok(!columns.includes('application') && !columns.includes('form_type') && !columns.includes('data'),
          'the table itself identifies the form: no application / form_type / data columns');
      });

      test('required fields are NOT NULL and optional fields are nullable', () => {
        for (const [name, spec] of Object.entries(form.fields)) {
          const line = created[0].block.split('\n').find((l) => new RegExp(`^\\s{2}${spec.column}\\s`).test(l));
          assert.ok(line, `${name}: column ${spec.column} not found`);
          assert.equal(/NOT NULL/.test(line), spec.required, `${name} (${spec.column}): NOT NULL should be ${spec.required}`);
        }
      });

      test('database CHECK limits mirror the form definition', () => {
        for (const [name, spec] of Object.entries(form.fields)) {
          if (spec.type === 'choice') continue;
          const match = new RegExp(`char_length\\(${spec.column}\\) BETWEEN \\d+ AND (\\d+)`).exec(created[0].block);
          assert.ok(match, `${name}: no length CHECK on ${spec.column}`);
          const expected = spec.type === 'email' ? Math.min(spec.maxLength, 254) : spec.maxLength;
          assert.equal(Number(match[1]), expected, `${name}: database limit vs form limit`);
        }
      });

      test('database option lists equal the form\'s option lists', () => {
        for (const [name, spec] of Object.entries(form.fields)) {
          if (spec.type !== 'choice') continue;
          const match = new RegExp(`${spec.column}\\s+IN \\(([^)]+)\\)`).exec(created[0].block);
          assert.ok(match, `${name}: no option CHECK on ${spec.column}`);
          const declared = [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
          assert.deepEqual(declared, [...spec.options], `${name}: options in the database vs the form`);
        }
      });

      test('email columns that the form lower-cases are enforced lower-case in the database', () => {
        for (const [name, spec] of Object.entries(form.fields)) {
          if (spec.type !== 'email') continue;
          assert.equal(new RegExp(`${spec.column} = lower\\(${spec.column}\\)`).test(created[0].block), spec.lowercase, name);
        }
      });
    });
  }

  test('every application freezes its old shared table in the same migration that creates the per-form tables', () => {
    for (const app of applications) {
      const file = readdirSync(app.migrationsDir).find((f) => f.startsWith('003_'));
      assert.ok(file, `${app.slug}: no 003 migration`);
      const sql = readFileSync(path.join(app.migrationsDir, file), 'utf8');
      assert.match(sql, new RegExp(`BEFORE INSERT ON ${app.dbSchema}\\.form_submissions`));
      assert.doesNotMatch(sql, /\bDROP\s+(TABLE|SCHEMA|COLUMN)\b/i, `${app.slug}/${file} must not drop anything`);
      assert.doesNotMatch(sql, /\bDELETE\s+FROM\b|\bTRUNCATE\b/i, `${app.slug}/${file} must not delete data`);
    }
  });

  test('no new migration drops, truncates or deletes anything', () => {
    const dirs = [PLATFORM_MIGRATIONS.migrationsDir, ...applications.map((a) => a.migrationsDir)];
    for (const dir of dirs) {
      for (const file of readdirSync(dir).filter((f) => /^(00[3-9]|0[1-9]\d)_.*\.sql$/.test(f))) {
        const sql = readFileSync(path.join(dir, file), 'utf8').replace(/--.*$/gm, '');
        assert.doesNotMatch(sql, /\bDROP\s+(TABLE|SCHEMA|COLUMN)\b/i, `${file} drops something`);
        assert.doesNotMatch(sql, /\bTRUNCATE\b/i, `${file} truncates`);
        assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i, `${file} deletes rows`);
      }
    }
  });

  test('the migration key of each application is stable and unique', () => {
    const keys = applications.map((a) => a.migrationKey);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(applications.find((a) => a.slug === 'epiwell').migrationKey, 'epi-well', 'Epi Well keeps its original migration history key');
  });
});
