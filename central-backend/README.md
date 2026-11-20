# Central Backend

A single Node.js/Express backend that serves several independent websites:

| Application | Slug       | Base path              |
|-------------|------------|------------------------|
| Epineon     | `epineon`  | `/api/v1/epineon`      |
| QAegis      | `qaegis`   | `/api/v1/qaegis`       |
| Epi Well    | `epi-well` | `/api/v1/epi-well`     |

Each website is an isolated module with its own routes, controllers, services and
configuration. A small shared layer provides generic infrastructure only (logging,
error handling, configuration). It never contains application business logic.

> **Status:** Step 5. The API is complete for the three websites and one unified admin
> dashboard: public forms matching the live sites (rate limited, origin-enforced, with
> honeypot and timing checks), a central **Admin API** with Cloudflare Access login and
> per-application permissions, stored in PostgreSQL (Neon) with one schema per application.
> **Nothing is deployed, no website or dashboard is connected yet.**
>
> Documentation: [`docs/API_DOCUMENTATION.md`](docs/API_DOCUMENTATION.md) (every endpoint,
> database, auth, permissions) and [`DEVELOPMENT_GUIDE.md`](DEVELOPMENT_GUIDE.md)
> (architecture, data flow, workflows).

---

## Tech stack

- Node.js ≥ 20.12 (ES Modules)
- Express 5
- PostgreSQL on Neon, through the `pg` driver (raw parameterized SQL, no ORM)
- npm
- Node's built-in test runner (`node:test`) and `.env` loader (`process.loadEnvFile`)

The target host is **Cloudflare**. Nothing is deployed yet. See
[Cloudflare deployment notes](#cloudflare-deployment-notes) for what was verified and
what still has to change before the app runs on Workers.

---

## Architecture

```
                   ┌──────────────────────────────────────────────┐
  HTTP request ──► │ app.js                                       │
                   │  ├─ requestLogger, express.json  (shared)    │
                   │  ├─ GET /api/health              (platform)  │
                   │  ├─ /api/v1/epineon/*  ─► epineon module     │
                   │  ├─ /api/v1/qaegis/*   ─► qaegis module      │
                   │  ├─ /api/v1/epi-well/* ─► epi-well module    │
                   │  ├─ notFound                     (shared)    │
                   │  └─ errorHandler                 (shared)    │
                   └──────────────────────────────────────────────┘

  Inside each application module:
     routes  ─►  controllers  ─►  services  ─►  config
     (URLs)      (HTTP in/out)    (logic)       (settings)
```

### Isolation rules

1. **An application only imports from itself, from `src/shared`, or from npm packages.**
   It never imports another application's code.
2. **`src/shared` never imports application code** and holds no business logic.
3. **Applications are registered in one place** (`src/applications/index.js`) and are
   mounted by the platform at `/api/v1/<slug>`. Each slug is a separate URL namespace.
4. **Each application's only public surface is its `index.js`**, which exports
   `{ slug, name, router }`.

Rules 1 and 2 are enforced automatically by `tests/isolation.test.js`. The test suite
fails if anyone adds a cross-application import.

### Project structure

```
central-backend/
├── src/
│   ├── applications/
│   │   ├── index.js              # Registry of all applications
│   │   ├── epineon/
│   │   │   ├── index.js          # Module entry: exports { slug, name, router }
│   │   │   ├── routes/           # index.js (health + /forms), forms.routes.js
│   │   │   ├── controllers/      # health.controller.js, form.controller.js
│   │   │   ├── services/         # health.service.js, form.service.js
│   │   │   ├── forms/            # demo/sales/partnerships .form.js + index.js registry
│   │   │   ├── repositories/     # submission.repository.js (SQL for this app only)
│   │   │   ├── database/migrations/  # 001_create_form_submissions.sql
│   │   │   └── config/           # App settings (index.js) + rate-limits.js
│   │   ├── qaegis/               # Same layout; forms/contact-sales.form.js
│   │   └── epi-well/             # Same layout; forms/ registry is empty for now
│   │
│   ├── platform/                 # cross-application features (generic)
│   │   ├── submissions.routes.js # POST /api/v1/submissions
│   │   └── admin/                # Admin API: router, auth, permissions, repositories
│   │
│   ├── shared/
│   │   ├── database/             # Connection pool, migration runner, platform migrations/
│   │   ├── middleware/           # requestLogger, notFound, errorHandler, requireJson, security
│   │   ├── security/             # client IP trust, CORS, rate limiter, Cloudflare Access JWT
│   │   ├── utils/                # AppError, response, logger, validation, submission
│   │   └── config/               # Platform env config (env.js)
│   │
│   ├── app.js                    # createApp(): builds the Express app (no listen)
│   └── server.js                 # Local entry point: starts the HTTP server
│
├── docs/
│   └── API_DOCUMENTATION.md
├── scripts/
│   ├── migrate.js                # npm run db:migrate
│   ├── create-super-admin.js     # npm run admin:create -- <email>
│   └── dev-token.js              # npm run dev:token -- <email>  (AUTH_MODE=dev only)
├── tests/
│   ├── database.integration.test.js  # Opt-in, real DB (TEST_DATABASE_URL)
│   ├── health.test.js            # Health endpoint tests
│   ├── forms.test.js             # Form submission, validation, isolation, security
│   ├── rate-limit.test.js        # Limits, 429, headers, reset, independence, failures
│   ├── security.test.js          # Client IP trust, HTTPS, headers, 405, prod config, TLS
│   ├── submissions.test.js       # Unified endpoint, CORS, honeypot/timing, waitlist
│   ├── validation.test.js        # Validation engine features
│   ├── access.test.js            # Cloudflare Access JWT verification
│   ├── admin-auth.test.js        # Admin auth + per-application SQL scoping (no database)
│   ├── admin.test.js             # Admin API against a real test database (npm run test:db)
│   └── isolation.test.js         # Architecture boundary tests
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

### Purpose of each folder

| Folder | Purpose |
|---|---|
| `src/applications/` | One sub-folder per website. Each one is independently maintainable. |
| `src/applications/<app>/routes/` | Declares the app's endpoints and maps them to controllers. |
| `src/applications/<app>/controllers/` | Reads the request, calls services, formats the response. Contains no business logic. |
| `src/applications/<app>/services/` | The app's business logic. Framework-agnostic and easy to unit test. |
| `src/applications/<app>/forms/` | The app's form definitions (fields and rules) and its form registry. |
| `src/applications/<app>/repositories/` | The app's data access. Only queries the app's own schema. |
| `src/applications/<app>/database/migrations/` | The app's SQL migrations, which create and alter only its own schema. |
| `src/shared/database/` | Generic connection pool, transactions and the migration runner. Contains no application SQL. |
| `src/applications/<app>/config/` | Constants and settings that belong only to this app. |
| `src/shared/middleware/` | Cross-cutting Express middleware used by the platform. |
| `src/shared/utils/` | Generic helpers: error class, response envelope, logger. |
| `src/shared/config/` | Platform-level environment variables, validated at startup. |
| `tests/` | Automated tests (`node:test`). |

### Conventions

- **Response envelope.** Successful responses use `{ "status": "success", "message": ..., ...data }`.
  Error responses use `{ "status": "error", "message": ... }`. Use `sendSuccess()` from
  `shared/utils/response.js`.
- **Errors.** Throw `new AppError(message, statusCode)` for expected failures. Anything
  else becomes a 500. Express 5 forwards errors from `async` handlers to the central
  handler automatically, so `try/catch` boilerplate is not needed. A 500 response is
  always `{"status":"error","message":"Internal Server Error"}`, in every environment.
  The real error and stack trace go to the server log only.
- **Logging.** One JSON line is written per request (method, path, status, duration).
  Set `REQUEST_LOGGING=false` to turn it off. It is disabled automatically under `NODE_ENV=test`.

---

## Getting started

### 1. Install dependencies

```bash
cd central-backend
npm install
```

### 2. Configure the environment (optional)

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `PORT` | `3000` | Port for the local server |
| `REQUEST_LOGGING` | `true` | Set to `false` to disable request logs |
| `BODY_LIMIT` | `100kb` | Maximum JSON body size (`b`, `kb` or `mb`) |
| `DATABASE_URL` | none (required in production) | PostgreSQL connection string. Use `sslmode=verify-full`. |
| `DB_POOL_MAX` | `5` | Maximum database connections per server instance |
| `TEST_DATABASE_URL` | none | Dedicated test database (`central_backend_test`). Tests never use `DATABASE_URL`. |
| `AUTH_MODE` | `cloudflare-access` if `ACCESS_TEAM_DOMAIN` is set, else `none` | `cloudflare-access` (required in production), `dev` (local tokens), `none` (admin API answers 503) |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | none | Cloudflare Access team domain (`https://<team>.cloudflareaccess.com`) and application AUD tag |
| `ADMIN_ALLOWED_ORIGINS` | none | Dashboard origin(s), comma-separated. Production: `https` only. |
| `CORS_ORIGINS_EPINEON` / `_QAEGIS` / `_EPI_WELL` | none | Each website's allowed origins. Production: `https` only. |
| `CLIENT_IP_SOURCE` | `socket` | `socket` (local), `cloudflare-worker` or `cloudflare-proxy`. Production requires a `cloudflare-*` value. |
| `RATE_LIMIT_STORE` | `postgres` if a DB is set, else `memory` | `postgres` is required in production |
| `RATE_LIMIT_SECRET` | random per process (dev only) | 32+ characters, used to HMAC-hash client IPs. Required in production. |

Real environment variables take precedence over values in `.env`.

### 3. Create the database tables

```bash
npm run db:migrate   # safe to re-run; already-applied migrations are skipped
```

### 4. Run

```bash
npm run dev     # development, auto-restarts on file changes (node --watch)
npm start       # plain start
npm test        # the whole suite without a database (database mocked)
npm run test:db # also the real-database suites, against TEST_DATABASE_URL (central_backend_test)
```

The server listens on `http://localhost:3000` by default.

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Platform health check |
| GET | `/api/v1/epineon/health` | Epineon health check |
| GET | `/api/v1/qaegis/health` | QAegis health check |
| GET | `/api/v1/epi-well/health` | Epi Well health check |
| GET | `/api/health/database` | Database connectivity (200 or 503, never exposes details) |
| POST | `/api/v1/epineon/forms/demo` | Epineon: Demo request |
| POST | `/api/v1/epineon/forms/sales` | Epineon: Sales & Enterprise |
| POST | `/api/v1/epineon/forms/partnerships` | Epineon: Partnerships & Ventures |
| POST | `/api/v1/qaegis/forms/contact-sales` | QAegis: Contact Sales / Enterprise Access |
| POST | `/api/v1/epi-well/forms/waitlist` | Epi Well: Waitlist |
| POST | `/api/v1/submissions` | Any of the above, by `{ application, formType, data }` |
| GET | `/api/v1/admin/me` | Admin: identity and accessible applications |
| GET | `/api/v1/admin/submissions` | Admin: list, search, filter, sort, paginate |
| GET / PATCH / DELETE | `/api/v1/admin/submissions/:application/:id` | Admin: view, update status/read, delete |
| GET | `/api/v1/admin/stats` | Admin: per-application and combined statistics |
| GET / POST / PATCH | `/api/v1/admin/users[/:id]` | Super Admin: manage admins and their applications |
| GET | `/api/v1/admin/audit` | Super Admin: audit log |

Full details, parameters and examples: [`docs/API_DOCUMENTATION.md`](docs/API_DOCUMENTATION.md).

Example:

```bash
curl http://localhost:3000/api/health
# {"status":"success","message":"Central Backend is running"}

curl http://localhost:3000/api/v1/epineon/health
# {"status":"success","message":"Epineon API is running","application":"epineon",
#  "name":"Epineon","version":"v1","timestamp":"2026-11-19T11:04:44.330Z"}
```

Unknown routes return `404` with `{"status":"error","message":"Route not found: GET /..."}`.

---

## Form management

### How a submission flows

```
POST /api/v1/<app>/forms/<type>
  → requestId, securityHeaders, requestLogger                     shared
  → clientIdentity (trusted client IP, see Security)              shared
  → requireHttps (production only: 403 for plain HTTP)            shared
  → express.json (body size limit, no compression, objects only)  shared
  → rateLimit (<app>'s own limits, scope "<app>:<type>")          shared engine, app config
  → requireJson (415 if the Content-Type is not JSON)             shared
  → <app>/routes/forms.routes.js (one route per registered form)  app
  → <app>/controllers/form.controller.js                          app
  → <app>/services/form.service.js
       ├─ validateSubmission(form, body)                          shared engine
       ├─ createSubmission({ application: <app's own slug>, ... }) shared
       └─ saveSubmission()  → INSERT INTO <app schema>.form_submissions
  → 201 receipt (no personal data), sent only after the row is stored
```

### Form fields

Field names, limits and option lists match the live websites. Everything not marked
*optional* is required; all values are JSON strings. The full tables are in
[`docs/API_DOCUMENTATION.md`](docs/API_DOCUMENTATION.md#33-forms).

| Endpoint | Fields |
|---|---|
| `epineon/forms/demo` | `name`, `email`, `company`, `role` *(optional)*, `product` *(one of 8 options)*, `message` *(optional)* |
| `epineon/forms/sales` | the demo fields plus `useCase` *(one of 5 options)*, with `message` required |
| `epineon/forms/partnerships` | `name`, `email`, `organization`, `nature` |
| `qaegis/forms/contact-sales` | `firstName`, `lastName`, `workEmail`, `companyWebsite` *(optional)*, `userRange` *(`1-50`, `51-250`, `251-1000`, `1000+`)*, `message` |
| `epi-well/forms/waitlist` | `email` *(lower-cased, disposable domains refused, one per address)* |

Every form also accepts a hidden **honeypot** field (Epineon `companyWebsite`; QAegis and Epi Well
`website`; it must stay empty) and an optional `formStartedAt` timestamp (faster than 2 s or older
than 24 h is rejected). Both trip silently: the response is generic and nothing is stored.

### Validation rules

- The body must be a non-empty JSON object sent with `Content-Type: application/json`.
- **Unknown fields are rejected.** This includes `application`, `formType`,
  `submissionId` and `__proto__`. (Only the form's own honeypot and `formStartedAt` are extra.)
- Values are trimmed. A blank required field counts as missing, and a blank optional
  field is ignored.
- Each field has a maximum length. Single-line fields reject newlines and control
  characters. Multi-line fields allow newlines and tabs.
- Email and website fields are format-checked.
- Error messages never repeat back the value that was submitted.

### Responses

Success (`201 Created`):

```json
{
  "status": "success",
  "message": "Form submitted successfully",
  "data": {
    "application": "qaegis",
    "formType": "contact-sales",
    "submissionId": "639eed12-afec-4c06-97d3-c5a8cd98683b",
    "receivedAt": "2026-11-19T11:21:50.788Z"
  }
}
```

Validation failure (`400 Bad Request`):

```json
{
  "status": "error",
  "message": "Validation failed",
  "details": [
    { "field": "workEmail", "code": "invalid_email", "message": "Field must be a valid email address" },
    { "field": "isAdmin", "code": "unexpected_field", "message": "Field is not allowed" }
  ]
}
```

Error codes: `required`, `invalid_type`, `too_long`, `invalid_characters`,
`invalid_email`, `invalid_url`, `unexpected_field`, `empty_submission`, `invalid_body`.

Other statuses:
- `404` for an unknown application or form type
- `405` (with an `Allow` header) for a wrong method on a known route, e.g. `GET` on a form
- `429` when the rate limit is exceeded, `503` if limits can't be checked
- `403` for plain HTTP or a request that bypassed Cloudflare (production)
- `413` when the body is over `BODY_LIMIT`
- `415` when the body is not JSON
- `400` for malformed JSON

### Adding a form to an existing application

1. Create `src/applications/<app>/forms/<type>.form.js`:

   ```js
   import { defineForm, FieldType } from '../../../shared/utils/validation.js';

   export const exampleForm = defineForm({
     type: 'example', // URL segment, lowercase kebab-case
     fields: {
       fullName: { type: FieldType.TEXT, required: true, maxLength: 100 },
       email: { type: FieldType.EMAIL, required: true, maxLength: 254 },
       notes: { type: FieldType.TEXT, maxLength: 2000, multiline: true },
     },
   });
   ```

2. Add it to the array in `src/applications/<app>/forms/index.js`.
3. Add test cases in `tests/forms.test.js`.

The form is now served at `POST /api/v1/<app>/forms/example`. A form definition with
mistakes (bad type, missing `maxLength`, duplicate form type) stops the server at
startup instead of failing at runtime.

---

## Database

### Layout: one schema per application

| Application | Schema | Table |
|---|---|---|
| Epineon | `epineon` | `epineon.form_submissions` |
| QAegis | `qaegis` | `qaegis.form_submissions` |
| Epi Well | `epi_well` | `epi_well.form_submissions` (the waitlist) |
| platform | `platform_admin` | `admin_users`, `admin_app_access`, `audit_log` (append-only) |
| platform | `platform_security` | `platform_security.rate_limit_counters` (rate limiting; no personal data) |
| platform | `public` | `public.schema_migrations` (tracks applied migrations) |

`form_submissions` columns:
- `submission_id` (uuid, primary key)
- `application` (constrained to the owning app)
- `form_type`
- `data` (jsonb, the validated and trimmed fields)
- `received_at`, `stored_at`
- `status` (`new`, `in_progress`, `replied`, `closed`, `archived`), `updated_at` (trigger)
- `read_at`, `read_by`, `status_changed_at`, `status_changed_by`

### How isolation is enforced
- **Schemas.** Each app's schema name lives in its own `config/index.js`. Its
  repository can only build queries against that schema.
- **Database constraints.** A `CHECK` constraint means a row in `qaegis.form_submissions`
  can only have `application = 'qaegis'`, even if code tried otherwise.
- **Tests.** The isolation tests fail if:
  - two apps share a schema
  - a migration references another app's schema
  - any app's request writes outside its own schema

### Migrations
- Files are named `src/applications/<app>/database/migrations/NNN_description.sql` and
  applied in order by `npm run db:migrate`.
- Each file runs in its own transaction and is recorded with a checksum in
  `public.schema_migrations`.
- **Never edit an applied migration.** Add a new numbered file instead. The runner
  refuses to continue if an applied file has changed.
- Migrations are run by hand, not when the server starts. That keeps schema changes
  out of serverless cold starts.

### Safety
- All values are passed as query parameters. Schema names come only from config and are
  validated against a strict pattern.
- Database errors return a generic `500`. Only the error code and message are logged,
  never query parameters.
- The pool is small (`DB_POOL_MAX`) and has connection, statement and query timeouts.
- TLS uses full certificate verification (`sslmode=verify-full`), and SCRAM channel
  binding is used when the URL asks for it.
- The test suite never connects to `DATABASE_URL`.

---

## Security

### Rate limiting

Every form endpoint is limited per client network address. Each form on each website
has its own counter, under the scope `<app>:<form>`, with limits from that app's
`config/rate-limits.js`:

| Endpoint | Limits per client |
|---|---|
| `epineon/forms/demo` | 5 per 10 min, 20 per day |
| `epineon/forms/sales` | 5 per 10 min, 20 per day |
| `epineon/forms/partnerships` | 3 per 10 min, 10 per day |
| `qaegis/forms/contact-sales` | 5 per 10 min, 20 per day |
| `epi-well/forms/waitlist` | 5 per 10 min, 20 per day |

- **Counted before validation.** Invalid submissions use up the limit too, so the API
  can't be probed for free. A limited request is never validated or stored.
- **Responses.**
  - Every response carries `RateLimit-Policy`, `RateLimit-Limit`, `RateLimit-Remaining`
    and `RateLimit-Reset`, following the IETF draft.
  - Over the limit, the request gets `429 {"status":"error","message":"Too many requests. Please try again later."}`
    plus a `Retry-After` header.
- **Store.** Production uses PostgreSQL, through the table
  `platform_security.rate_limit_counters`:
  - One atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` per request. The row lock
    serializes concurrent requests, so the limit can't be bypassed by sending requests
    in parallel.
  - Window boundaries use the database clock, so all instances agree.
  - Expired rows are cleaned up in small batches.
  - If the store is unavailable, the endpoint fails closed with `503`.
- **Privacy.** Raw IPs are never stored or logged. The key is
  `HMAC-SHA256(RATE_LIMIT_SECRET, normalized IP)`. IPv6 addresses are grouped by `/64`,
  so rotating addresses inside one subscriber network doesn't bypass the limit.

**Why PostgreSQL?** The other options:
- An in-memory store is per instance or isolate, so it's only used in tests.
- The Workers Rate Limiting binding is approximate and per Cloudflare location, only
  supports 10- or 60-second windows, and returns no remaining or reset information.
- Durable Objects are exact but are Workers-only new infrastructure.

PostgreSQL is exact, works today on Node.js and later on Workers via Hyperdrive, and
needs no new infrastructure. The store sits behind a small interface (`hit()`), so a
Durable Object store can replace it later. **Recommended edge layer:** a Cloudflare WAF
rate-limiting rule on `/api/v1/*/forms/*`, as a generous first filter so floods never
reach Neon.

### Client IP trust (`CLIENT_IP_SOURCE`)

| Mode | Use | Client IP comes from |
|---|---|---|
| `socket` | local development only | The TCP peer. `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP` and `True-Client-IP` are all ignored. |
| `cloudflare-worker` | app runs on Cloudflare Workers | `CF-Connecting-IP`, set by Cloudflare's edge |
| `cloudflare-proxy` | Node origin behind Cloudflare's proxy | `CF-Connecting-IP`, **only** when the TCP peer is in Cloudflare's published IP ranges (`shared/security/cloudflareIpRanges.js`). Any other request gets `403`. |

- `X-Forwarded-For` is never used, because clients can prepend fake entries to it.
- Express's `trust proxy` stays off.
- A missing, malformed or duplicated `CF-Connecting-IP` header gets `400`.

### HTTPS and TLS

- **Production always enforces HTTPS.** Plain HTTP gets `403 {"message":"HTTPS is required"}`.
  It is **never redirected**: by the time a redirect could happen, the request had
  already been sent in plaintext.
- **Protocol detection.** HTTPS is recognized from a TLS socket or from
  `X-Forwarded-Proto`. That header is trusted only from Cloudflare, which overwrites any
  value the client sends.
- **HSTS.** Production sends `Strict-Transport-Security: max-age=63072000; includeSubDomains`.
  Add `preload` only after a deliberate decision for the whole domain.
- **Database TLS.**
  - Any non-localhost `DATABASE_URL` must use `sslmode=verify-full`, which verifies the
    certificate and hostname. Otherwise the server refuses to start.
  - Parameters that disable verification are rejected.
  - Error messages never contain the URL.
- **Production startup checks.** The server refuses to start without:
  - a Cloudflare IP mode
  - the Postgres rate limiter
  - a 32-character-or-longer `RATE_LIMIT_SECRET`
  - a verified-TLS database URL
- **Local exception.** Plain HTTP and a localhost database without TLS are allowed only
  outside production.

### HTTP hardening

- **Security headers on every response:**
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; …`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cache-Control: no-store`
  - `X-Request-Id`, generated by the server and never taken from the client

  There is no `X-Powered-By` and no `ETag`.
- **Wrong methods.** A wrong method on a known route gets `405` with an `Allow` header.
  `OPTIONS` is also `405` until CORS is added in Step 5.
- **Body handling.**
  - 100 kb body limit.
  - Compressed bodies are refused with `415`, preventing decompression bombs.
  - Unsupported charsets are refused.
  - Top-level JSON must be an object or array.
- **Error responses.** Errors from Express or Node itself (for example a malformed URL)
  get a generic message. A `500` never includes details.
- **Logs** contain request ID, method, path (without the query string), status, duration
  and non-personal metadata. They never contain bodies, headers, query strings or IP
  addresses.

---

## Cloudflare deployment notes

These were researched in Step 4. **Nothing has been migrated or deployed.**

1. **Running Express on Workers.**
   - Cloudflare Workers can run a `node:http` server through `httpServerHandler` from
     `cloudflare:node`.
   - This needs the `nodejs_compat` flag and a compatibility date of 2025-09-01 or later
     (the HTTP server modules are enabled automatically from that date).
   - `createApp()` is already separate from `listen()`, so an entry point is a few lines.
   - Workers' `req.socket` is a stand-in object, so use `CLIENT_IP_SOURCE=cloudflare-worker`.
   - **Verify in staging:** that `CF-Connecting-IP` and `X-Forwarded-Proto` reach Express
     as expected under `httpServerHandler`. The docs don't state it explicitly.
2. **Database connections must change for Workers.**
   - Workers forbid reusing I/O objects across requests, and Hyperdrive's docs warn that
     a global driver pool causes stale-connection failures.
   - On Workers, `shared/database/index.js` must create a `pg` client per request, with
     Hyperdrive doing the pooling. That needs pg 8.16.3 or later; we have 8.23.1.
   - All SQL already goes through the single `database` object, so this change is
     contained in one file.
3. **Hyperdrive TLS.**
   - Hyperdrive always encrypts its connection to Neon.
   - Its default `require` mode checks the certificate against the public web certificate
     authorities. `verify-full`, which also checks the hostname, needs Neon's CA uploaded
     to Hyperdrive.
   - The `sslmode=verify-full` startup check will need a Hyperdrive-aware exception when
     moving to Workers.
4. **Other Workers adjustments.**
   - `shared/config/env.js` reads `.env` through `node:fs`. On Workers, configuration
     comes from bindings and secrets, so that needs an adapter.
   - `node:crypto` (`createHmac`, `randomUUID`, `randomBytes`) is provided by `nodejs_compat`.
   - The IP utilities deliberately avoid `node:net`.
5. **Cloudflare dashboard settings.**
   - SSL/TLS mode **Full (strict)** if a Node origin is used, or use a Cloudflare Tunnel.
   - Minimum TLS 1.2.
   - HSTS.
   - A WAF custom rule blocking `not ssl` requests to the API hostname, because "Always
     Use HTTPS" would redirect them, which we don't want for an API.
   - The WAF rate-limiting rule described above.
   - For `cloudflare-proxy` mode, the origin must only accept traffic from Cloudflare.

---

## Adding another application

Example: a new website called **Acme** with the slug `acme`.

1. **Create the module folders:**

   ```bash
   mkdir -p src/applications/acme/{routes,controllers,services,config}
   ```

2. **Add the config.** Create `src/applications/acme/config/index.js`:

   ```js
   export const config = Object.freeze({ slug: 'acme', name: 'Acme', apiVersion: 'v1', dbSchema: 'acme' });
   ```

3. **Add services, controllers, routes and forms.** Copy `routes/`, `controllers/`,
   `services/` and `forms/index.js` from `epi-well` (the simplest app, with an empty form
   registry). Update the names in comments and error messages. Each app keeps its own
   copy, so it can change independently. Imports must only reference `acme` and
   `shared` files.

4. **Add the database pieces.**
   - Add `dbSchema: 'acme'` to the config.
   - Copy `repositories/` and `database/migrations/001_create_form_submissions.sql`
     from `epi-well`, replacing `epi_well` / `epi-well` with `acme`.
   - Copy `epi-well/index.js` (it exports `slug`, `name`, `dbSchema`, `migrationsDir`
     and `router`) and rename the export to `acme`.
   - Copy `config/rate-limits.js` from `epi-well` and add one entry per form. The server
     refuses to start if a form has no limits.
   - Run `npm run db:migrate`.

5. **Register it** in `src/applications/index.js`:

   ```js
   import { acme } from './acme/index.js';
   export const applications = Object.freeze([epineon, qaegis, epiWell, acme]);
   ```

6. **Add tests** (for example, extend the `apps` list in `tests/health.test.js`) and run `npm test`.

The new API is now available at `/api/v1/acme/*`. No other application is affected.
The platform throws an error at startup if two applications share a slug.
