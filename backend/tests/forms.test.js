import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { errorHandler } from '../src/shared/middleware/errorHandler.js';
import { database } from '../src/shared/database/index.js';
import { submissionInserts } from './helpers/insert.js';

let server;
let baseUrl;
const logLines = [];
// Every query the app sends to the (mocked) database: { text, params }
const queries = [];
let queryImpl;
const defaultQueryImpl = async () => ({ rows: [], rowCount: 1 });

before(async () => {
  // Capture all log output so we can assert no personal data is logged.
  mock.method(console, 'log', (line) => logLines.push(String(line)));
  mock.method(console, 'error', (line) => logLines.push(String(line)));

  // Replace the database with an in-test recorder. No real database is used.
  queryImpl = defaultQueryImpl;
  mock.method(database, 'query', async (text, params) => {
    queries.push({ text, params });
    return queryImpl(text, params);
  });

  // Rate limiting is disabled here because these tests send many requests
  // from one address to exercise validation. Rate limiting has its own suite
  // (tests/rate-limit.test.js).
  server = createApp({ rateLimitStore: null }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  mock.restoreAll();
  await new Promise((resolve) => server.close(resolve));
});

async function post(path, body, { contentType = 'application/json', raw } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: contentType ? { 'content-type': contentType } : {},
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------- fixtures

const FORMS = [
  {
    application: 'epineon',
    formType: 'demo',
    path: '/api/v1/epineon/forms/demo',
    emailField: 'email',
    required: ['name', 'email', 'company', 'product'],
    valid: {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company: 'Analytical Engines Ltd',
      role: 'CTO',
      product: 'EPICRYPT',
      message: 'Reporting and\nintegrations',
    },
  },
  {
    application: 'epineon',
    formType: 'sales',
    path: '/api/v1/epineon/forms/sales',
    emailField: 'email',
    required: ['name', 'email', 'company', 'product', 'useCase', 'message'],
    valid: {
      name: 'Grace Hopper',
      email: 'grace@example.org',
      company: 'Compilers Inc',
      product: 'Multiple products',
      useCase: 'Enterprise AI security',
      message: 'Please contact us about enterprise pricing.',
    },
  },
  {
    application: 'epineon',
    formType: 'partnerships',
    path: '/api/v1/epineon/forms/partnerships',
    emailField: 'email',
    required: ['name', 'email', 'organization', 'nature'],
    valid: {
      name: 'Alan Turing',
      email: 'alan@example.co.uk',
      organization: 'Bletchley Ventures',
      nature: 'Strategic investment',
    },
  },
  {
    application: 'qaegis',
    formType: 'contact-sales',
    path: '/api/v1/qaegis/forms/contact-sales',
    emailField: 'workEmail',
    required: ['firstName', 'lastName', 'workEmail', 'userRange', 'message'],
    valid: {
      firstName: 'Katherine',
      lastName: 'Johnson',
      workEmail: 'katherine@example.com',
      companyWebsite: 'example.com',
      userRange: '51-250',
      message: 'SSO and audit logs',
    },
  },
  {
    application: 'epiwell',
    formType: 'waitlist',
    path: '/api/v1/epiwell/forms/waitlist',
    emailField: 'email',
    required: ['email'],
    valid: { email: 'waitlist.member@example.com' },
  },
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ------------------------------------------------------- per-form behaviour

for (const form of FORMS) {
  describe(`${form.application} / ${form.formType}`, () => {
    test('accepts a valid submission with the correct response structure', async () => {
      const { status, body } = await post(form.path, form.valid);
      assert.equal(status, 201);
      assert.deepEqual(Object.keys(body).sort(), ['data', 'message', 'status']);
      assert.equal(body.status, 'success');
      assert.equal(body.message, 'Form submitted successfully');
      assert.deepEqual(Object.keys(body.data).sort(), [
        'application',
        'formType',
        'receivedAt',
        'submissionId',
      ]);
      assert.equal(body.data.application, form.application);
      assert.equal(body.data.formType, form.formType);
      assert.match(body.data.submissionId, UUID_PATTERN);
      assert.equal(new Date(body.data.receivedAt).toISOString(), body.data.receivedAt);
    });

    test('never echoes submitted personal data in the response', async () => {
      const { body } = await post(form.path, form.valid);
      const serialized = JSON.stringify(body);
      for (const value of Object.values(form.valid)) {
        assert.ok(!serialized.includes(value), `response leaked "${value}"`);
      }
    });

    test('accepts a submission with only the required fields', async () => {
      const minimal = Object.fromEntries(form.required.map((f) => [f, form.valid[f]]));
      const { status } = await post(form.path, minimal);
      assert.equal(status, 201);
    });

    test('issues a unique submission ID per submission', async () => {
      const a = await post(form.path, form.valid);
      const b = await post(form.path, form.valid);
      assert.notEqual(a.body.data.submissionId, b.body.data.submissionId);
    });

    for (const field of form.required) {
      test(`rejects a missing required field: ${field}`, async () => {
        const payload = { ...form.valid };
        delete payload[field];
        const { status, body } = await post(form.path, payload);
        assert.equal(status, 400);
        assert.equal(body.status, 'error');
        assert.equal(body.message, 'Validation failed');
        if (Object.keys(payload).length === 0) {
          // Single-field form (Epi Well waitlist): removing its only field leaves an empty body.
          assert.deepEqual(body.details, [{ field: null, code: 'empty_submission', message: 'Submission is empty' }]);
        } else {
          assert.deepEqual(body.details, [{ field, code: 'required', message: 'Field is required' }]);
        }
      });
    }

    test('treats whitespace-only required fields as missing', async () => {
      const field = form.required[0];
      const { status, body } = await post(form.path, { ...form.valid, [field]: '   \t ' });
      assert.equal(status, 400);
      assert.equal(body.details[0].field, field);
      assert.equal(body.details[0].code, 'required');
    });

    for (const badEmail of ['not-an-email', 'a@b', 'a@@example.com', 'a b@example.com', '@example.com', 'a..b@example.com']) {
      test(`rejects invalid email "${badEmail}"`, async () => {
        const { status, body } = await post(form.path, { ...form.valid, [form.emailField]: badEmail });
        assert.equal(status, 400);
        assert.deepEqual(body.details, [
          { field: form.emailField, code: 'invalid_email', message: 'Field must be a valid email address' },
        ]);
        assert.ok(!JSON.stringify(body).includes(badEmail), 'error echoed the submitted value');
      });
    }

    test('rejects unexpected fields', async () => {
      const { status, body } = await post(form.path, { ...form.valid, isAdmin: 'true' });
      assert.equal(status, 400);
      assert.deepEqual(body.details, [
        { field: 'isAdmin', code: 'unexpected_field', message: 'Field is not allowed' },
      ]);
    });

    test('rejects an empty JSON object', async () => {
      const { status, body } = await post(form.path, {});
      assert.equal(status, 400);
      assert.equal(body.details[0].code, 'empty_submission');
    });

    test('rejects a request with no body', async () => {
      const { status, body } = await post(form.path, undefined, { contentType: null });
      assert.equal(status, 400);
      assert.equal(body.details[0].code, 'empty_submission');
    });
  });
}

// --------------------------------------------------------------- sanitation

describe('input sanitation', () => {
  const demo = FORMS[0];

  test('trims surrounding whitespace before accepting', async () => {
    const { status } = await post(demo.path, {
      ...demo.valid,
      name: '   Ada Lovelace   ',
      email: '  ada@example.com\t',
    });
    assert.equal(status, 201);
  });

  test('rejects non-string field values', async () => {
    const { status, body } = await post(demo.path, { ...demo.valid, name: { $gt: '' }, company: 42 });
    assert.equal(status, 400);
    assert.deepEqual(
      body.details.map((d) => [d.field, d.code]),
      [['name', 'invalid_type'], ['company', 'invalid_type']],
    );
  });

  test('rejects values exceeding the maximum length', async () => {
    const { status, body } = await post(demo.path, { ...demo.valid, name: 'x'.repeat(121) });
    assert.equal(status, 400);
    assert.equal(body.details[0].code, 'too_long');
  });

  test('rejects newlines in single-line fields but allows them in multi-line fields', async () => {
    const bad = await post(demo.path, { ...demo.valid, name: 'Ada\nLovelace' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.details[0].code, 'invalid_characters');

    const ok = await post(demo.path, { ...demo.valid, message: 'line 1\nline 2' });
    assert.equal(ok.status, 201);
  });

  test('rejects control characters', async () => {
    const { status, body } = await post(demo.path, { ...demo.valid, company: 'Acme\u0000Corp' });
    assert.equal(status, 400);
    assert.equal(body.details[0].code, 'invalid_characters');
  });

  test('rejects prototype-pollution keys as unexpected fields', async () => {
    const raw = JSON.stringify(demo.valid).replace(/}$/, ',"__proto__":{"polluted":"yes"}}');
    const { status, body } = await post(demo.path, undefined, { raw });
    assert.equal(status, 400);
    assert.equal(body.details[0].field, '__proto__');
    assert.equal(({}).polluted, undefined);
  });

  test('rejects JSON arrays and primitives', async () => {
    const arr = await post(demo.path, [demo.valid]);
    assert.equal(arr.status, 400);
    assert.equal(arr.body.details[0].code, 'invalid_body');

    const prim = await post(demo.path, undefined, { raw: '"hello"' });
    assert.equal(prim.status, 400);
  });

  test('rejects malformed JSON', async () => {
    const { status, body } = await post(demo.path, undefined, { raw: '{"name": ' });
    assert.equal(status, 400);
    assert.equal(body.message, 'Malformed JSON in request body');
  });

  test('rejects non-JSON content types with 415', async () => {
    const { status, body } = await post(demo.path, undefined, {
      contentType: 'application/x-www-form-urlencoded',
      raw: 'name=Ada',
    });
    assert.equal(status, 415);
    assert.equal(body.status, 'error');
  });

  test('rejects bodies over the size limit with 413', async () => {
    const { status, body } = await post(demo.path, { ...demo.valid, role: 'x'.repeat(200 * 1024) });
    assert.equal(status, 413);
    assert.equal(body.message, 'Request body is too large');
  });

  test('caps the number of reported unexpected fields', async () => {
    const extra = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`extra${i}`, 'x']));
    const { status, body } = await post(demo.path, { ...demo.valid, ...extra });
    assert.equal(status, 400);
    assert.equal(body.details.length, 11);
  });

  describe('QAegis companyWebsite', () => {
    const qa = FORMS[3];
    for (const site of ['example.com', 'https://www.example.com', 'http://sub.example.co.uk/about']) {
      test(`accepts "${site}"`, async () => {
        const { status } = await post(qa.path, { ...qa.valid, companyWebsite: site });
        assert.equal(status, 201);
      });
    }
    for (const site of ['javascript:alert(1)', 'ftp://example.com', 'not a site', 'localhost', 'https://user:pw@example.com']) {
      test(`rejects "${site}"`, async () => {
        const { status, body } = await post(qa.path, { ...qa.valid, companyWebsite: site });
        assert.equal(status, 400);
        assert.equal(body.details[0].code, 'invalid_url');
      });
    }
  });
});

// ------------------------------------------------------------ isolation

describe('cross-application isolation', () => {
  const [demo, sales, partnerships, qaegis, waitlist] = FORMS;

  test('an Epineon form is not reachable under QAegis', async () => {
    const { status } = await post('/api/v1/qaegis/forms/demo', demo.valid);
    assert.equal(status, 404);
  });

  test('the QAegis form is not reachable under Epineon', async () => {
    const { status } = await post('/api/v1/epineon/forms/contact-sales', qaegis.valid);
    assert.equal(status, 404);
  });

  test("other applications' form types are not reachable under Epi Well", async () => {
    for (const type of ['demo', 'sales', 'partnerships', 'contact-sales']) {
      const { status } = await post(`/api/v1/epiwell/forms/${type}`, demo.valid);
      assert.equal(status, 404, `epiwell/forms/${type} should not exist`);
    }
  });

  test('the Epi Well waitlist is not reachable under another application', async () => {
    for (const slug of ['epineon', 'qaegis']) {
      const { status } = await post(`/api/v1/${slug}/forms/waitlist`, waitlist.valid);
      assert.equal(status, 404, `${slug}/forms/waitlist should not exist`);
    }
  });

  test('a QAegis payload is rejected by an Epineon form', async () => {
    // "companyWebsite" is a real field on QAegis but Epineon's honeypot, so leave it out here.
    const { companyWebsite: _omit, ...payload } = qaegis.valid;
    const { status, body } = await post(sales.path, payload);
    assert.equal(status, 400);
    const unexpected = body.details.filter((d) => d.code === 'unexpected_field').map((d) => d.field);
    assert.deepEqual(unexpected.sort(), ['firstName', 'lastName', 'userRange', 'workEmail']);
  });

  test('a QAegis payload that fills Epineon\'s honeypot field is silently rejected as spam', async () => {
    const { status, body } = await post(sales.path, qaegis.valid);
    assert.equal(status, 400);
    assert.deepEqual(body, { status: 'error', message: 'Your message could not be sent. Please try again.' });
  });

  test('forms within one application are isolated from each other', async () => {
    // Partnerships uses `organization`/`nature`; Demo uses `company`/`product`.
    const { status } = await post(demo.path, partnerships.valid);
    assert.equal(status, 400);
  });

  test('client cannot override application, formType or submissionId', async () => {
    const { status, body } = await post(qaegis.path, {
      ...qaegis.valid,
      application: 'epineon',
      formType: 'demo',
      submissionId: 'attacker-chosen',
    });
    assert.equal(status, 400);
    assert.deepEqual(
      body.details.map((d) => d.field).sort(),
      ['application', 'formType', 'submissionId'],
    );
  });

  test('each submission is attributed to the application that owns the endpoint', async () => {
    const e = await post(demo.path, demo.valid);
    const q = await post(qaegis.path, qaegis.valid);
    assert.equal(e.body.data.application, 'epineon');
    assert.equal(q.body.data.application, 'qaegis');
  });
});

// ------------------------------------------------------------ persistence

const SCHEMAS = { epineon: 'epineon', qaegis: 'qaegis', epiwell: 'epiwell' };
// Every form has its OWN table (one table per form, never shared).
const TABLES = {
  demo: 'demo_submissions',
  sales: 'sales_submissions',
  partnerships: 'partnerships_submissions',
  'contact-sales': 'contact_sales_submissions',
  waitlist: 'waitlist_submissions',
};
const columnOf = (field) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe('persistence: one dedicated table per form', () => {
  for (const form of FORMS) {
    test(`${form.application}/${form.formType} stores exactly one row in ${SCHEMAS[form.application]}.${TABLES[form.formType]}`, async () => {
      queries.length = 0;
      const { status, body } = await post(form.path, {
        ...form.valid,
        [form.required[0]]: `  ${form.valid[form.required[0]]}  `,
      });
      assert.equal(status, 201);
      const inserts = submissionInserts(queries);
      assert.equal(inserts.length, 1);
      assert.equal(queries.length, 1, 'no other statement ran');

      const { schema, table, row } = inserts[0];
      assert.equal(schema, SCHEMAS[form.application]);
      assert.equal(table, TABLES[form.formType]);
      // Values are parameterized, never interpolated into the SQL text.
      for (const value of Object.values(form.valid)) assert.ok(!queries[0].text.includes(value));

      assert.equal(row.id, body.data.submissionId);
      assert.equal(row.created_at, body.data.receivedAt);
      // Each field lands in its own column, trimmed and validated; nothing else is written.
      const fieldColumns = Object.keys(row).filter((c) => c !== 'id' && c !== 'created_at').sort();
      assert.deepEqual(fieldColumns, Object.keys(form.valid).map(columnOf).sort());
      for (const [field, value] of Object.entries(form.valid)) assert.equal(row[columnOf(field)], value, field);
      // The old shared-table columns do not exist any more.
      assert.ok(!('application' in row) && !('form_type' in row) && !('data' in row));
    });
  }

  test('no form ever writes to another form\'s table or another application\'s schema', async () => {
    queries.length = 0;
    for (const form of FORMS) await post(form.path, form.valid);
    const inserts = submissionInserts(queries);
    assert.equal(inserts.length, FORMS.length);
    assert.equal(queries.length, FORMS.length);
    assert.equal(new Set(inserts.map((i) => `${i.schema}.${i.table}`)).size, FORMS.length, 'five forms, five different tables');
    inserts.forEach((insert, i) => {
      assert.equal(`${insert.schema}.${insert.table}`, `${SCHEMAS[FORMS[i].application]}.${TABLES[FORMS[i].formType]}`);
    });
    for (const { text } of queries) {
      assert.ok(!/form_submissions/.test(text), 'the old shared table is never written to');
    }
  });

  test('invalid submissions never reach the database', async () => {
    queries.length = 0;
    await post(FORMS[0].path, {});
    await post(FORMS[0].path, { ...FORMS[0].valid, email: 'bad' });
    await post(FORMS[3].path, { ...FORMS[3].valid, extra: 'x' });
    assert.equal(queries.length, 0);
  });

  test('a database failure returns a generic 500 and no receipt', async () => {
    queryImpl = async () => {
      const err = new Error('connection to host db.internal:5432 failed: password authentication failed');
      err.code = '28P01';
      throw err;
    };
    try {
      const { status, body } = await post(FORMS[3].path, FORMS[3].valid);
      assert.equal(status, 500);
      assert.deepEqual(body, { status: 'error', message: 'Internal Server Error' });
    } finally {
      queryImpl = defaultQueryImpl;
    }
  });
});

// ------------------------------------------------------------ endpoints

describe('invalid endpoints', () => {
  test('unknown form type returns 404', async () => {
    const { status, body } = await post('/api/v1/epineon/forms/does-not-exist', {});
    assert.equal(status, 404);
    assert.equal(body.status, 'error');
  });

  test('unknown application returns 404', async () => {
    const { status } = await post('/api/v1/unknown-app/forms/demo', FORMS[0].valid);
    assert.equal(status, 404);
  });

  test('GET on a form endpoint returns 405 with an Allow header', async () => {
    const res = await fetch(`${baseUrl}/api/v1/epineon/forms/demo`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
    assert.deepEqual(await res.json(), { status: 'error', message: 'Method not allowed' });
  });

  test('form endpoints are not reachable without the version prefix', async () => {
    const { status } = await post('/api/epineon/forms/demo', FORMS[0].valid);
    assert.equal(status, 404);
  });
});

// ------------------------------------------------------------ security

describe('logging and error safety', () => {
  test('logs contain submission metadata but no personal data', async () => {
    logLines.length = 0;
    for (const form of FORMS) await post(form.path, form.valid);

    const joined = logLines.join('\n');
    assert.ok(joined.includes('form submission stored'));
    for (const form of FORMS) {
      for (const value of Object.values(form.valid)) {
        assert.ok(!joined.includes(value), `log leaked "${value}"`);
      }
    }
  });

  test('unexpected errors never expose internal details to the client', () => {
    const err = new Error('secret connection string: postgres://user:pass@host');
    let captured;
    const res = {
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        captured = payload;
        return this;
      },
    };
    errorHandler(err, { method: 'POST', originalUrl: '/x' }, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.deepEqual(captured, { status: 'error', message: 'Internal Server Error' });
  });
});
