/**
 * QAegis application module: the only file the platform imports.
 */
import { fileURLToPath } from 'node:url';
import router from './routes/index.js';
import { formHandlers } from './routes/forms.routes.js';
import { forms } from './forms/index.js';
import { config } from './config/index.js';

export const qaegis = Object.freeze({
  slug: config.slug,
  name: config.name,
  dbSchema: config.dbSchema,
  /** Key under which this application's migrations are recorded (stays stable across renames). */
  migrationKey: config.migrationKey ?? config.slug,
  /** Former schema names that old migrations still reference. */
  legacySchemas: config.legacySchemas ?? [],
  migrationsDir: fileURLToPath(new URL('./database/migrations/', import.meta.url)),
  router,
  /** Form types this application accepts (also used to validate admin filters). */
  formTypes: Object.freeze([...formHandlers.keys()]),
  /** Form definitions (type, own table, fields to columns), used by the generic Admin API. */
  forms,
  /** form type -> handler chain, shared with POST /api/v1/submissions. */
  formHandlers,
});
