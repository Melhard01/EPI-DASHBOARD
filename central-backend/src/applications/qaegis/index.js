/**
 * QAegis application module: the only file the platform imports.
 */
import { fileURLToPath } from 'node:url';
import router from './routes/index.js';
import { formHandlers } from './routes/forms.routes.js';
import { config } from './config/index.js';

export const qaegis = Object.freeze({
  slug: config.slug,
  name: config.name,
  dbSchema: config.dbSchema,
  migrationsDir: fileURLToPath(new URL('./database/migrations/', import.meta.url)),
  router,
  /** Form types this application accepts (also used to validate admin filters). */
  formTypes: Object.freeze([...formHandlers.keys()]),
  /** form type -> handler chain, shared with POST /api/v1/submissions. */
  formHandlers,
});
