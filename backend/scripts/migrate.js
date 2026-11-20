/**
 * Applies every application's pending SQL migrations.
 *
 *   npm run db:migrate
 *
 * Uses DATABASE_URL (or TEST_DATABASE_URL when NODE_ENV=test).
 * Safe to run repeatedly: already-applied migrations are skipped.
 */
import { applications } from '../src/applications/index.js';
import { runMigrations, migrationTargets } from '../src/shared/database/migrator.js';
import { database } from '../src/shared/database/index.js';

if (!database.isConfigured()) {
  console.error('DATABASE_URL is not set. Add it to .env first.');
  process.exit(1);
}

try {
  // Platform infrastructure first, then each application's own schema.
  const results = await runMigrations(migrationTargets(applications));
  for (const r of results) console.log(`${r.status.padEnd(7)} ${r.application}/${r.name}`);
  const applied = results.filter((r) => r.status === 'applied').length;
  console.log(`Done: ${applied} applied, ${results.length - applied} already up to date.`);
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await database.close();
}
