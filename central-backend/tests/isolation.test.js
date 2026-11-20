/**
 * Architecture guard: enforces module boundaries.
 *
 * - An application may import from itself, from src/shared, or from packages.
 * - An application may NOT import from another application.
 * - src/shared may NOT import from any application.
 */
import { test } from 'node:test';
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
    const others = applications.filter((a) => a !== app).map((a) => a.dbSchema);
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
      assert.ok(sql.includes(`${app.dbSchema}.`), `${app.slug}/${file} should use schema "${app.dbSchema}"`);
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
        !new RegExp(`\\b${app.dbSchema}\\.form_submissions`).test(source),
        `${path.relative(srcDir, file)} hard-codes ${app.dbSchema}`,
      );
    }
  }
});

test('submission statuses in the admin API match every application\'s CHECK constraint', async () => {
  const { SUBMISSION_STATUSES } = await import('../src/platform/admin/statuses.js');
  for (const app of applications) {
    const sql = readFileSync(path.join(app.migrationsDir, '002_add_submission_workflow.sql'), 'utf8');
    const match = /CHECK \(status IN \(([^)]+)\)\)/.exec(sql);
    assert.ok(match, `${app.slug}: status CHECK not found`);
    const declared = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(declared, [...SUBMISSION_STATUSES], app.slug);
  }
});
