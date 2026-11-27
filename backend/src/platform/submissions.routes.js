/**
 * Unified public submission endpoint:
 *
 *   POST /api/v1/submissions
 *   { "application": "qaegis", "formType": "contact-sales", "data": { ...form fields } }
 *
 * The envelope identifies the application and form; `data` is exactly the
 * body the per-application endpoint (POST /api/v1/<app>/forms/<type>)
 * accepts. The request is then run through THAT application's own handler
 * chain: its allowed origins, its rate-limit counters (shared with the
 * per-application endpoint), its validation and its storage. Nothing
 * application-specific is implemented here.
 */
import { Router } from 'express';
import { AppError } from '../shared/utils/AppError.js';
import { requireJson } from '../shared/middleware/requireJson.js';
import { methodNotAllowed } from '../shared/middleware/security.js';
import { runChain } from './runChain.js';

const ENVELOPE_KEYS = new Set(['application', 'formType', 'data']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function parseEnvelope(body, applicationsBySlug) {
  if (body === undefined) {
    throw new AppError('Validation failed', 400, [
      { field: null, code: 'empty_submission', message: 'Submission is empty' },
    ]);
  }
  if (!isPlainObject(body)) {
    throw new AppError('Validation failed', 400, [
      { field: null, code: 'invalid_body', message: 'Request body must be a JSON object' },
    ]);
  }

  if (Object.keys(body).length === 0) {
    throw new AppError('Validation failed', 400, [
      { field: null, code: 'empty_submission', message: 'Submission is empty' },
    ]);
  }

  const errors = [];
  for (const key of Object.keys(body).filter((k) => !ENVELOPE_KEYS.has(k)).slice(0, 10)) {
    errors.push({ field: key.slice(0, 64), code: 'unexpected_field', message: 'Field is not allowed' });
  }

  const { application, formType, data } = body;
  let app = null;
  if (application === undefined) {
    errors.push({ field: 'application', code: 'required', message: 'Field is required' });
  } else if (typeof application !== 'string') {
    errors.push({ field: 'application', code: 'invalid_type', message: 'Field must be a string' });
  } else {
    app = applicationsBySlug.get(application) ?? null;
    if (!app) errors.push({ field: 'application', code: 'unknown_application', message: 'Unknown application' });
  }

  if (formType === undefined) {
    errors.push({ field: 'formType', code: 'required', message: 'Field is required' });
  } else if (typeof formType !== 'string') {
    errors.push({ field: 'formType', code: 'invalid_type', message: 'Field must be a string' });
  } else if (app && !app.formHandlers.has(formType)) {
    errors.push({ field: 'formType', code: 'unknown_form_type', message: 'Unknown form type for this application' });
  }

  if (data === undefined) {
    errors.push({ field: 'data', code: 'required', message: 'Field is required' });
  } else if (!isPlainObject(data)) {
    errors.push({ field: 'data', code: 'invalid_type', message: 'Field must be a JSON object' });
  }

  if (errors.length > 0) throw new AppError('Validation failed', 400, errors);
  return { app, formType, data };
}

export function createSubmissionsRouter(applications) {
  const applicationsBySlug = new Map(applications.map((a) => [a.slug, a]));
  const router = Router();

  router
    .route('/')
    .post(requireJson, (req, res, next) => {
      const { app, formType, data } = parseEnvelope(req.body, applicationsBySlug);
      req.body = data;
      runChain(app.formHandlers.get(formType), req, res, next);
    })
    .all(methodNotAllowed(['POST']));

  // Path-based convenience endpoint: POST /api/v1/submissions/:application/:formType
  router
    .route('/:application/:formType')
    .post(requireJson, (req, res, next) => {
      const { application, formType } = req.params;
      const app = applicationsBySlug.get(application);
      if (!app) {
        return res.status(404).json({
          status: 'error',
          message: `Application not found: ${application}`,
        });
      }
      if (!app.formHandlers.has(formType)) {
        return res.status(404).json({
          status: 'error',
          message: `Form type not found: ${formType}`,
        });
      }
      runChain(app.formHandlers.get(formType), req, res, next);
    })
    .all(methodNotAllowed(['POST']));

  return router;
}
