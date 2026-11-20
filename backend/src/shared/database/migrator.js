/**
 * Generic, forward-only SQL migration runner (infrastructure only).
 *
 * Each application provides its own migrations directory. Files are named
 * `NNN_description.sql` and applied in order, one transaction per file.
 * Applied files are recorded in public.schema_migrations together with a
 * checksum. Editing an applied migration is detected and refused.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { database } from './index.js';

/**
 * Platform-owned migrations (shared security infrastructure such as rate
 * limiting). They live in their own schema and never touch application schemas.
 */
export const PLATFORM_MIGRATIONS = Object.freeze({
  slug: 'platform',
  migrationsDir: fileURLToPath(new URL('./migrations/', import.meta.url)),
});

const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;
// Arbitrary constant key so concurrent migration runs serialize.
const MIGRATION_LOCK_KEY = 482_910_337;

function listMigrationFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!MIGRATION_FILE_PATTERN.test(file)) {
      throw new Error(`Invalid migration file name "${file}" in ${dir} (expected NNN_name.sql)`);
    }
  }
  return files;
}

/**
 * @param {Array<{ slug: string, migrationsDir: string }>} targets `slug` is the stable
 *   migration key under which an application's history is recorded
 * @param {{ only?: (target: object, file: string) => boolean }} [options] `only` lets a
 *   caller apply a subset (used by the migration rehearsal test)
 * @returns {Promise<Array<{ application: string, name: string, status: 'applied'|'skipped' }>>}
 */
export async function runMigrations(targets, { only } = {}) {
  await database.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      application text        NOT NULL,
      name        text        NOT NULL,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (application, name)
    )`);

  const results = [];

  for (const { slug, migrationsDir } of targets) {
    for (const name of listMigrationFiles(migrationsDir)) {
      if (only && !only({ slug, migrationsDir }, name)) continue;
      const sql = readFileSync(path.join(migrationsDir, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      const status = await database.withTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);

        const { rows } = await client.query(
          'SELECT checksum FROM public.schema_migrations WHERE application = $1 AND name = $2',
          [slug, name],
        );
        if (rows.length > 0) {
          if (rows[0].checksum !== checksum) {
            throw new Error(
              `Migration ${slug}/${name} was modified after being applied. Create a new migration instead.`,
            );
          }
          return 'skipped';
        }

        await client.query(sql);
        await client.query(
          'INSERT INTO public.schema_migrations (application, name, checksum) VALUES ($1, $2, $3)',
          [slug, name, checksum],
        );
        return 'applied';
      });

      results.push({ application: slug, name, status });
    }
  }

  return results;
}

/**
 * The full, correctly keyed list of migration targets: platform first, then each
 * application under its stable `migrationKey` (NOT its URL slug: a renamed
 * application keeps recording its history under the original key, otherwise its
 * old migrations would be applied a second time).
 */
export function migrationTargets(applications) {
  return [
    PLATFORM_MIGRATIONS,
    ...applications.map(({ migrationKey, migrationsDir }) => ({ slug: migrationKey, migrationsDir })),
  ];
}
