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
 * QAegis form routes: POST /api/v1/qaegis/forms/<form-type>
 *
 * Per form, ONE handler chain is built and used by both entry points:
 *   - POST /api/v1/qaegis/forms/<type>        (this router)
 *   - POST /api/v1/submissions                (platform, by application/formType)
 * Sharing the chain means the same origin check, the same rate-limit
 * counters (scope "qaegis:<form>") and the same validation apply either way.
 *
 * Chain: allowed origin -> rate limit -> JSON content-type -> validate + store.
 * Rate limiting runs before validation, so invalid submissions are counted too.
 */
const router = Router();

/** @type {Map<string, Function[]>} form type -> handler chain */
export const formHandlers = new Map();

for (const form of forms) {
  if (formHandlers.has(form.type)) {
    throw new Error(`QAegis: duplicate form type "${form.type}"`);
  }

  const rules = formRateLimits[form.type];
  if (!rules) {
    throw new Error(`QAegis: no rate limits configured for form "${form.type}"`);
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
    throw new Error(`QAegis: rate limits configured for unknown form "${type}"`);
  }
}

export default router;
