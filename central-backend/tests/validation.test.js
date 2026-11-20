/**
 * Unit tests for the shared validation engine's Step 5 features:
 * choice fields, email lowercasing, blocked domains, honeypot, timing checks,
 * and definition-time (startup) errors.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { defineForm, validateSubmission, FieldType, Rejection } from '../src/shared/utils/validation.js';

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const HOUR = 3_600_000;

const form = defineForm({
  type: 'sample',
  fields: {
    name: { type: FieldType.TEXT, required: true, maxLength: 50 },
    email: {
      type: FieldType.EMAIL,
      required: true,
      maxLength: 254,
      lowercase: true,
      blockedDomains: ['mailinator.com', 'yopmail.com'],
    },
    size: { type: FieldType.CHOICE, required: true, maxLength: 20, options: ['1-50', '51-250', '1000+'] },
    note: { type: FieldType.TEXT, required: false, maxLength: 100 },
  },
  honeypot: 'website',
  timing: { minMs: 2_000, maxMs: 24 * HOUR },
});

const valid = { name: 'Ada', email: 'Ada@Example.COM', size: '51-250' };
const check = (body, options = {}) => validateSubmission(form, body, { now: NOW, ...options });

describe('choice fields', () => {
  test('accept exactly the listed options (after trimming)', () => {
    for (const size of ['1-50', '51-250', '1000+', '  1000+  ']) {
      assert.equal(check({ ...valid, size }).data.size, size.trim());
    }
  });

  test('reject anything else, without echoing the value', () => {
    for (const size of ['1-51', '1-50x', '1000', 'ALL', "'; DROP TABLE x;--", '51-250,1000+']) {
      const result = check({ ...valid, size });
      assert.deepEqual(result.errors, [
        { field: 'size', code: 'invalid_option', message: 'Field must be one of the allowed options' },
      ]);
      assert.ok(!JSON.stringify(result).includes('DROP'));
    }
  });

  test('are case-sensitive and reject non-strings', () => {
    assert.equal(check({ ...valid, size: '1000+' }).errors, undefined);
    assert.equal(check({ ...valid, size: 1000 }).errors[0].code, 'invalid_type');
    assert.equal(check({ ...valid, size: ['1-50'] }).errors[0].code, 'invalid_type');
    assert.equal(check({ ...valid, size: '' }).errors[0].code, 'required');
  });
});

describe('email normalization and blocking', () => {
  test('lowercases emails when the field asks for it', () => {
    assert.equal(check(valid).data.email, 'ada@example.com');
  });

  test('blocks disposable domains, case-insensitively, with a safe message', () => {
    for (const email of ['x@mailinator.com', 'x@MAILINATOR.com', 'x@yopmail.com']) {
      const result = check({ ...valid, email });
      assert.deepEqual(result.errors, [
        { field: 'email', code: 'blocked_domain', message: 'Disposable email addresses are not accepted' },
      ]);
    }
  });

  test('does not block lookalike or sub-domains of other providers', () => {
    assert.equal(check({ ...valid, email: 'x@mailinator.com.example.org' }).errors, undefined);
    assert.equal(check({ ...valid, email: 'x@notyopmail.com' }).errors, undefined);
  });
});

describe('honeypot', () => {
  test('an absent, empty or whitespace honeypot is accepted and never stored', () => {
    for (const website of [undefined, '', '   ', null]) {
      const result = check({ ...valid, ...(website === undefined ? {} : { website }) });
      assert.deepEqual(result.data, { name: 'Ada', email: 'ada@example.com', size: '51-250' });
    }
  });

  test('a filled honeypot (any non-empty value or non-string) rejects as spam', () => {
    for (const website of ['http://spam.example', 'x', 0, 1, true, {}, ['a']]) {
      assert.deepEqual(check({ ...valid, website }), { rejected: Rejection.SPAM });
    }
  });

  test('is checked before field validation, so it reveals nothing about other errors', () => {
    assert.deepEqual(check({ website: 'spam', email: 'not-an-email' }), { rejected: Rejection.SPAM });
  });

  test('a honeypot field name is only allowed on forms that declare it', () => {
    const plain = defineForm({ type: 'plain', fields: { a: { type: FieldType.TEXT, maxLength: 5 } } });
    const result = validateSubmission(plain, { a: 'x', website: '' }, { now: NOW });
    assert.deepEqual(result.errors, [{ field: 'website', code: 'unexpected_field', message: 'Field is not allowed' }]);
  });
});

describe('timing check (formStartedAt)', () => {
  test('is optional', () => {
    assert.ok(check(valid).data);
  });

  test('accepts a human-speed submission, as a number or numeric string', () => {
    assert.ok(check({ ...valid, formStartedAt: NOW - 30_000 }).data);
    assert.ok(check({ ...valid, formStartedAt: String(NOW - 30_000) }).data);
  });

  test('rejects too fast (< 2 s) as spam', () => {
    assert.deepEqual(check({ ...valid, formStartedAt: NOW - 500 }), { rejected: Rejection.SPAM });
    assert.deepEqual(check({ ...valid, formStartedAt: NOW - 1_999 }), { rejected: Rejection.SPAM });
    assert.ok(check({ ...valid, formStartedAt: NOW - 2_000 }).data);
  });

  test('rejects stale (> 24 h) as expired', () => {
    assert.deepEqual(check({ ...valid, formStartedAt: NOW - 24 * HOUR - 1 }), { rejected: Rejection.EXPIRED });
    assert.ok(check({ ...valid, formStartedAt: NOW - 24 * HOUR }).data);
  });

  test('a timestamp in the future (client clock ahead) is not judged', () => {
    assert.ok(check({ ...valid, formStartedAt: NOW + 60_000 }).data);
  });

  test('rejects malformed timestamps as a validation error', () => {
    for (const formStartedAt of ['yesterday', '12.5e3', -5, 0, true, {}, [1], 'Infinity']) {
      const result = check({ ...valid, formStartedAt });
      assert.equal(result.errors?.[0]?.field, 'formStartedAt', JSON.stringify(formStartedAt));
      assert.equal(result.errors[0].code, 'invalid_type');
    }
  });

  test('the timestamp is never stored with the submission', () => {
    assert.equal(Object.hasOwn(check({ ...valid, formStartedAt: NOW - 30_000 }).data, 'formStartedAt'), false);
  });

  test('is rejected on forms that do not declare timing', () => {
    const plain = defineForm({ type: 'plain', fields: { a: { type: FieldType.TEXT, maxLength: 5 } } });
    const result = validateSubmission(plain, { a: 'x', formStartedAt: NOW - 30_000 }, { now: NOW });
    assert.equal(result.errors[0].code, 'unexpected_field');
  });
});

describe('empty submissions', () => {
  test('a body with only the honeypot and timestamp counts as empty', () => {
    const result = check({ website: '', formStartedAt: NOW - 30_000 });
    assert.equal(result.errors[0].code, 'required');
    assert.deepEqual(
      validateSubmission(
        defineForm({
          type: 'one',
          fields: { a: { type: FieldType.TEXT, maxLength: 5 } },
          honeypot: 'website',
        }),
        { website: '' },
      ).errors,
      [{ field: null, code: 'empty_submission', message: 'Submission is empty' }],
    );
  });
});

describe('definition-time errors (fail at startup, not at request time)', () => {
  const base = { type: 'x', fields: { a: { type: FieldType.TEXT, maxLength: 5 } } };

  test('choice fields need a valid, duplicate-free option list within maxLength', () => {
    const choice = (spec) => ({ ...base, fields: { a: { type: FieldType.CHOICE, maxLength: 5, ...spec } } });
    assert.throws(() => defineForm(choice({})), /options/);
    assert.throws(() => defineForm(choice({ options: [] })), /options/);
    assert.throws(() => defineForm(choice({ options: ['a', 'a'] })), /duplicate/);
    assert.throws(() => defineForm(choice({ options: [' a'] })), /invalid option/);
    assert.throws(() => defineForm(choice({ options: ['toolongvalue'] })), /invalid option/);
    assert.throws(() => defineForm(choice({ options: [5] })), /invalid option/);
  });

  test('options, blockedDomains and lowercase are restricted to the right field types', () => {
    assert.throws(() => defineForm({ ...base, fields: { a: { type: FieldType.TEXT, maxLength: 5, options: ['x'] } } }), /only choice/);
    assert.throws(() => defineForm({ ...base, fields: { a: { type: FieldType.TEXT, maxLength: 5, blockedDomains: ['x.com'] } } }), /email/);
    assert.throws(() => defineForm({ ...base, fields: { a: { type: FieldType.TEXT, maxLength: 5, lowercase: true } } }), /email/);
    assert.throws(
      () => defineForm({ ...base, fields: { a: { type: FieldType.EMAIL, maxLength: 50, blockedDomains: ['Bad Domain'] } } }),
      /blocked domain/,
    );
  });

  test('honeypot and timing must be well formed and must not collide with real fields', () => {
    assert.throws(() => defineForm({ ...base, honeypot: 'a' }), /honeypot/);
    assert.throws(() => defineForm({ ...base, honeypot: 'bad name' }), /honeypot/);
    assert.throws(() => defineForm({ ...base, timing: { minMs: 5, maxMs: 5 } }), /timing/);
    assert.throws(() => defineForm({ ...base, timing: { minMs: -1, maxMs: 5 } }), /timing/);
    assert.throws(() => defineForm({ ...base, timing: { minMs: 1.5, maxMs: 5 } }), /timing/);
    assert.throws(
      () => defineForm({ type: 'x', fields: { formStartedAt: { type: FieldType.TEXT, maxLength: 5 } } }),
      /reserved/,
    );
  });
});
