/**
 * Generic, schema-driven form validation engine.
 *
 * This module is reusable infrastructure only: it knows how to validate a
 * field of a given *type*, but it contains no form definitions and no
 * application-specific rules. Each application declares its own forms with
 * `defineForm()` inside its own folder.
 *
 * Validation errors never echo the submitted values back to the client.
 */

export const FieldType = Object.freeze({
  TEXT: 'text',
  EMAIL: 'email',
  URL: 'url',
  /** One of a fixed list of options (exact match after trimming). */
  CHOICE: 'choice',
});

/** Outcome of the anti-spam checks (honeypot / timing). */
export const Rejection = Object.freeze({
  SPAM: 'spam',
  EXPIRED: 'expired',
});

const FORM_TYPE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Name of the optional client timestamp (epoch ms) used by timing checks. */
export const FORM_STARTED_AT_FIELD = 'formStartedAt';

const MAX_REPORTED_UNEXPECTED_FIELDS = 10;
const MAX_REPORTED_FIELD_NAME_LENGTH = 64;
const EMAIL_MAX_LENGTH = 254;

// Single-line fields: no control characters at all (incl. newlines).
const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001F\u007F]/;
// Multi-line fields: allow \t, \n, \r; forbid every other control character.
const MULTI_LINE_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// Pragmatic email check: local@domain.tld with RFC-style label rules.
const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidEmail(value) {
  if (value.length > EMAIL_MAX_LENGTH) return false;
  const [local] = value.split('@');
  return local.length <= 64 && EMAIL_PATTERN.test(value);
}

/** Accepts "example.com" or "https://example.com/path"; only http(s). */
function isValidWebsite(value) {
  if (/\s/.test(value)) return false;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host);
}

function safeFieldName(name) {
  return name.length > MAX_REPORTED_FIELD_NAME_LENGTH
    ? `${name.slice(0, MAX_REPORTED_FIELD_NAME_LENGTH)}…`
    : name;
}

function normalizeFieldSpec(type, name, spec) {
  if (!FIELD_NAME_PATTERN.test(name)) {
    throw new Error(`Form "${type}": invalid field name "${name}".`);
  }
  if (!Object.values(FieldType).includes(spec?.type)) {
    throw new Error(`Form "${type}": field "${name}" has unknown type "${spec?.type}".`);
  }
  if (!Number.isInteger(spec.maxLength) || spec.maxLength <= 0) {
    throw new Error(`Form "${type}": field "${name}" needs a positive integer maxLength.`);
  }

  let options;
  if (spec.type === FieldType.CHOICE) {
    if (!Array.isArray(spec.options) || spec.options.length === 0) {
      throw new Error(`Form "${type}": choice field "${name}" needs a non-empty options list.`);
    }
    if (new Set(spec.options).size !== spec.options.length) {
      throw new Error(`Form "${type}": choice field "${name}" has duplicate options.`);
    }
    for (const option of spec.options) {
      if (typeof option !== 'string' || option.trim() !== option || option === '' || option.length > spec.maxLength) {
        throw new Error(`Form "${type}": choice field "${name}" has an invalid option.`);
      }
    }
    options = Object.freeze([...spec.options]);
  } else if (spec.options !== undefined) {
    throw new Error(`Form "${type}": only choice fields may declare options ("${name}").`);
  }

  let blockedDomains;
  if (spec.blockedDomains !== undefined) {
    if (spec.type !== FieldType.EMAIL) {
      throw new Error(`Form "${type}": blockedDomains is only valid on email fields ("${name}").`);
    }
    for (const domain of spec.blockedDomains) {
      if (!DOMAIN_PATTERN.test(domain)) {
        throw new Error(`Form "${type}": invalid blocked domain "${domain}".`);
      }
    }
    blockedDomains = Object.freeze(new Set(spec.blockedDomains));
  }

  if (spec.lowercase !== undefined && spec.type !== FieldType.EMAIL) {
    throw new Error(`Form "${type}": lowercase is only valid on email fields ("${name}").`);
  }

  return Object.freeze({
    type: spec.type,
    required: spec.required === true,
    maxLength: spec.maxLength,
    multiline: spec.multiline === true,
    lowercase: spec.lowercase === true,
    options,
    blockedDomains,
  });
}

/**
 * Declares a form. Throws at startup if the definition itself is invalid,
 * so misconfigured forms are caught before the server accepts traffic.
 *
 * @param {object} definition
 * @param {string} definition.type kebab-case form type (URL segment)
 * @param {Record<string, {
 *   type: 'text'|'email'|'url'|'choice', required?: boolean, maxLength: number,
 *   multiline?: boolean, options?: string[], lowercase?: boolean, blockedDomains?: string[]
 * }>} definition.fields
 * @param {string} [definition.honeypot] name of a hidden anti-bot field that
 *   must be absent or empty; a filled honeypot rejects the submission
 * @param {{ minMs: number, maxMs: number }} [definition.timing] optional
 *   check of the client's `formStartedAt` (epoch ms): faster than minMs is
 *   treated as a bot, older than maxMs as an expired form
 */
export function defineForm({ type, fields, honeypot, timing }) {
  if (!FORM_TYPE_PATTERN.test(type ?? '')) {
    throw new Error(`Invalid form type "${type}". Use lowercase kebab-case.`);
  }
  if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
    throw new Error(`Form "${type}" must declare at least one field.`);
  }

  const normalizedFields = {};
  for (const [name, spec] of Object.entries(fields)) {
    normalizedFields[name] = normalizeFieldSpec(type, name, spec);
  }

  if (honeypot !== undefined) {
    if (!FIELD_NAME_PATTERN.test(honeypot) || Object.hasOwn(normalizedFields, honeypot)) {
      throw new Error(`Form "${type}": honeypot must be a valid name that is not a real field.`);
    }
  }
  if (Object.hasOwn(normalizedFields, FORM_STARTED_AT_FIELD)) {
    throw new Error(`Form "${type}": "${FORM_STARTED_AT_FIELD}" is reserved.`);
  }

  let normalizedTiming;
  if (timing !== undefined) {
    const { minMs, maxMs } = timing;
    if (!Number.isInteger(minMs) || !Number.isInteger(maxMs) || minMs < 0 || maxMs <= minMs) {
      throw new Error(`Form "${type}": timing needs integer minMs < maxMs.`);
    }
    normalizedTiming = Object.freeze({ minMs, maxMs });
  }

  return Object.freeze({
    type,
    fields: Object.freeze(normalizedFields),
    honeypot: honeypot ?? null,
    timing: normalizedTiming ?? null,
  });
}

function honeypotIsFilled(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true; // any non-string value in a hidden text field is a bot
}

/**
 * Checks the client's form-start timestamp. Mirrors the live Epineon site:
 * the timestamp is optional; too fast means a bot, too old means expired.
 * A timestamp in the future (client clock ahead) cannot be judged and is
 * accepted; omitting it entirely is accepted too, so this costs no security.
 */
function checkTiming(timing, value, now) {
  if (value === undefined || value === null) return { ok: true };
  const startedAt = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) {
    return { error: { field: FORM_STARTED_AT_FIELD, code: 'invalid_type', message: 'Field must be a timestamp' } };
  }
  const elapsed = now - startedAt;
  if (elapsed < 0) return { ok: true };
  if (elapsed < timing.minMs) return { rejected: Rejection.SPAM };
  if (elapsed > timing.maxMs) return { rejected: Rejection.EXPIRED };
  return { ok: true };
}

function validateField(name, spec, raw) {
  if (raw === undefined || raw === null) {
    return spec.required ? { error: { field: name, code: 'required', message: 'Field is required' } } : {};
  }
  if (typeof raw !== 'string') {
    return { error: { field: name, code: 'invalid_type', message: 'Field must be a string' } };
  }

  let value = raw.trim();
  if (value === '') {
    return spec.required ? { error: { field: name, code: 'required', message: 'Field is required' } } : {};
  }
  if (value.length > spec.maxLength) {
    return {
      error: { field: name, code: 'too_long', message: `Field must be at most ${spec.maxLength} characters` },
    };
  }
  const forbidden = spec.multiline ? MULTI_LINE_FORBIDDEN : SINGLE_LINE_FORBIDDEN;
  if (forbidden.test(value)) {
    return { error: { field: name, code: 'invalid_characters', message: 'Field contains invalid characters' } };
  }

  switch (spec.type) {
    case FieldType.EMAIL: {
      if (!isValidEmail(value)) {
        return { error: { field: name, code: 'invalid_email', message: 'Field must be a valid email address' } };
      }
      if (spec.lowercase) value = value.toLowerCase();
      const domain = value.slice(value.lastIndexOf('@') + 1).toLowerCase();
      if (spec.blockedDomains?.has(domain)) {
        return {
          error: { field: name, code: 'blocked_domain', message: 'Disposable email addresses are not accepted' },
        };
      }
      break;
    }
    case FieldType.URL:
      if (!isValidWebsite(value)) {
        return { error: { field: name, code: 'invalid_url', message: 'Field must be a valid website address' } };
      }
      break;
    case FieldType.CHOICE:
      if (!spec.options.includes(value)) {
        return { error: { field: name, code: 'invalid_option', message: 'Field must be one of the allowed options' } };
      }
      break;
    default:
      break;
  }

  return { value };
}

/**
 * Validates and sanitizes an untrusted request body against a form definition.
 *
 * @param {object} form result of defineForm()
 * @param {unknown} body untrusted request body
 * @param {{ now?: number }} [options] epoch ms (injectable for tests)
 * @returns {{ data: Record<string,string> }
 *   | { errors: Array<{field: string|null, code: string, message: string}> }
 *   | { rejected: 'spam'|'expired' }}
 */
export function validateSubmission(form, body, { now = Date.now() } = {}) {
  if (body === undefined) {
    return { errors: [{ field: null, code: 'empty_submission', message: 'Submission is empty' }] };
  }
  if (!isPlainObject(body)) {
    return {
      errors: [{ field: null, code: 'invalid_body', message: 'Request body must be a JSON object' }],
    };
  }

  const keys = Object.keys(body);
  if (keys.length === 0) {
    return { errors: [{ field: null, code: 'empty_submission', message: 'Submission is empty' }] };
  }

  // 1. Anti-spam checks run first. A tripped check returns a deliberately
  //    uninformative rejection, so a bot cannot tell which trap it hit.
  if (form.honeypot && honeypotIsFilled(body[form.honeypot])) {
    return { rejected: Rejection.SPAM };
  }
  const errors = [];
  if (form.timing) {
    const timing = checkTiming(form.timing, body[FORM_STARTED_AT_FIELD], now);
    if (timing.rejected) return { rejected: timing.rejected };
    if (timing.error) errors.push(timing.error);
  }

  // 2. Reject anything the form does not declare (including __proto__ etc.).
  //    The honeypot and timestamp are accepted only on forms that use them.
  const allowedExtras = new Set();
  if (form.honeypot) allowedExtras.add(form.honeypot);
  if (form.timing) allowedExtras.add(FORM_STARTED_AT_FIELD);

  const unexpected = keys.filter((key) => !Object.hasOwn(form.fields, key) && !allowedExtras.has(key));
  for (const key of unexpected.slice(0, MAX_REPORTED_UNEXPECTED_FIELDS)) {
    errors.push({ field: safeFieldName(key), code: 'unexpected_field', message: 'Field is not allowed' });
  }
  if (unexpected.length > MAX_REPORTED_UNEXPECTED_FIELDS) {
    errors.push({
      field: null,
      code: 'unexpected_field',
      message: `${unexpected.length - MAX_REPORTED_UNEXPECTED_FIELDS} more unexpected fields`,
    });
  }

  // 3. Validate every declared field
  const data = Object.create(null);
  for (const [name, spec] of Object.entries(form.fields)) {
    const raw = Object.hasOwn(body, name) ? body[name] : undefined;
    const result = validateField(name, spec, raw);
    if (result.error) errors.push(result.error);
    else if (result.value !== undefined) data[name] = result.value;
  }

  // An object containing only the honeypot / timestamp is still empty.
  if (errors.length === 0 && Object.keys(data).length === 0 && keys.every((k) => allowedExtras.has(k))) {
    return { errors: [{ field: null, code: 'empty_submission', message: 'Submission is empty' }] };
  }

  return errors.length > 0 ? { errors } : { data: { ...data } };
}
