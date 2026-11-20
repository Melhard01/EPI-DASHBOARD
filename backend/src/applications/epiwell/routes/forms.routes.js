import { Router } from 'express';
import { requireJson } from '../../../shared/middleware/requireJson.js';
import { methodNotAllowed } from '../../../shared/middleware/security.js';
import { requireAllowedOrigin } from '../../../shared/security/cors.js';
import { rateLimit } from '../../../shared/security/rateLimit.js';
import { createFormHandler } from '../controllers/form.controller.js';
import { forms } from '../forms/index.js';
import { config } from '../config/index.js';
import { formRateLimits } from '../config/rate-limits.js';

/**
 * Epi Well form routes: POST /api/v1/epiwell/forms/<form-type>
 *
 * Per form, ONE handler chain is built and used by both entry points:
 *   - POST /api/v1/epiwell/forms/<type>        (this router)
 *   - POST /api/v1/submissions                (platform, by application/formType)
 * Sharing the chain means the same origin check, the same rate-limit
 * counters (scope "epiwell:<form>") and the same validation apply either way.
 *
 * Chain: allowed origin -> rate limit -> JSON content-type -> validate + store.
 * Rate limiting runs before validation, so invalid submissions are counted too.
 */
const router = Router();

/** @type {Map<string, Function[]>} form type -> handler chain */
export const formHandlers = new Map();
const usedTables = new Set();

for (const form of forms) {
  if (formHandlers.has(form.type)) {
    throw new Error(`Epi Well: duplicate form type "${form.type}"`);
  }

  // One dedicated table per form: never missing, never shared with another form.
  if (!form.table) {
    throw new Error(`Epi Well: form "${form.type}" has no table configured`);
  }
  if (usedTables.has(form.table)) {
    throw new Error(`Epi Well: table "${form.table}" is used by more than one form`);
  }
  usedTables.add(form.table);

  const rules = formRateLimits[form.type];
  if (!rules) {
    throw new Error(`Epi Well: no rate limits configured for form "${form.type}"`);
  }

  const chain = Object.freeze([
    requireAllowedOrigin(config.slug),
    rateLimit({ scope: `${config.slug}:${form.type}`, rules }),
    requireJson,
    createFormHandler(form),
  ]);
  formHandlers.set(form.type, chain);

  router
    .route(`/${form.type}`)
    .post(...chain)
    .all(methodNotAllowed(['POST']));
}

for (const type of Object.keys(formRateLimits)) {
  if (!formHandlers.has(type)) {
    throw new Error(`Epi Well: rate limits configured for unknown form "${type}"`);
  }
}

export default router;
