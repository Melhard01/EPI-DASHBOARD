/**
 * Strict query-string and body parsing for the admin API.
 * Unknown or repeated parameters are rejected (400) rather than ignored.
 */
import { AppError } from '../../shared/utils/AppError.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

export const param = {
  int: ({ min, max, fallback }) => (raw, name) => {
    if (raw === undefined) return fallback;
    if (!/^\d{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) {
      throw { field: name, code: 'invalid_value', message: `Must be an integer from ${min} to ${max}` };
    }
    return Number(raw);
  },
  oneOf: (values, fallback) => (raw, name) => {
    if (raw === undefined) return fallback;
    if (!values.includes(raw)) {
      throw { field: name, code: 'invalid_value', message: `Must be one of: ${values.join(', ')}` };
    }
    return raw;
  },
  boolean: () => (raw, name) => {
    if (raw === undefined) return undefined;
    if (raw !== 'true' && raw !== 'false') {
      throw { field: name, code: 'invalid_value', message: 'Must be true or false' };
    }
    return raw === 'true';
  },
  text: ({ max }) => (raw, name) => {
    if (raw === undefined) return undefined;
    const value = raw.trim();
    if (value === '') return undefined;
    if (value.length > max || /[\u0000-\u001F\u007F]/.test(value)) {
      throw { field: name, code: 'invalid_value', message: `Must be at most ${max} printable characters` };
    }
    return value;
  },
  timestamp: () => (raw, name) => {
    if (raw === undefined) return undefined;
    // ISO 8601 date or date-time only (no free-form date parsing).
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw)) {
      throw { field: name, code: 'invalid_value', message: 'Must be an ISO 8601 date or date-time' };
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw { field: name, code: 'invalid_value', message: 'Must be a valid date' };
    }
    return date.toISOString();
  },
  list: (values) => (raw, name) => {
    if (raw === undefined) return undefined;
    const items = raw.split(',').map((v) => v.trim()).filter(Boolean);
    if (items.length === 0 || items.length > values.length || new Set(items).size !== items.length
      || !items.every((v) => values.includes(v))) {
      throw { field: name, code: 'invalid_value', message: `Must be a comma-separated list of: ${values.join(', ')}` };
    }
    return items;
  },
};

/** Parses req.query against a spec of { name: parser }. Throws AppError(400). */
export function parseQuery(query, spec) {
  const errors = [];
  const result = {};
  for (const key of Object.keys(query)) {
    if (!Object.hasOwn(spec, key)) {
      errors.push({ field: key.slice(0, 64), code: 'unexpected_parameter', message: 'Parameter is not allowed' });
    }
  }
  for (const [name, parse] of Object.entries(spec)) {
    const raw = query[name];
    if (raw !== undefined && typeof raw !== 'string') {
      errors.push({ field: name, code: 'invalid_value', message: 'Parameter must appear once' });
      continue;
    }
    try {
      result[name] = parse(raw, name);
    } catch (detail) {
      if (detail instanceof Error) throw detail;
      errors.push(detail);
    }
  }
  if (errors.length > 0) throw new AppError('Invalid query parameters', 400, errors);
  return result;
}

/**
 * Validates a JSON body against allowed keys. Returns the body.
 * Throws AppError(400) for non-objects, unknown keys or an empty object.
 */
export function requireBodyKeys(body, allowedKeys, { requireOne = true } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Validation failed', 400, [
      { field: null, code: 'invalid_body', message: 'Request body must be a JSON object' },
    ]);
  }
  const unexpected = Object.keys(body).filter((k) => !allowedKeys.includes(k));
  if (unexpected.length > 0) {
    throw new AppError('Validation failed', 400, unexpected.slice(0, 10).map((k) => ({
      field: k.slice(0, 64), code: 'unexpected_field', message: 'Field is not allowed',
    })));
  }
  if (requireOne && !allowedKeys.some((k) => body[k] !== undefined)) {
    throw new AppError('Validation failed', 400, [
      { field: null, code: 'empty_update', message: `Provide at least one of: ${allowedKeys.join(', ')}` },
    ]);
  }
  return body;
}
