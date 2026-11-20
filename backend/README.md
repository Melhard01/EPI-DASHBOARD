# Backend: Central API

One Node.js / Express REST API for three independent websites — **Epineon**, **QAegis**, **Epi Well** — and the unified admin dashboard (`../frontend`). It owns all business logic, validation, permissions and database access. Data lives in Neon PostgreSQL: **one schema per website and one table per form**.

> How this fits with the dashboard, how to run both, and the production design: [`../docs/DEVELOPMENT_GUIDE.md`](../docs/DEVELOPMENT_GUIDE.md). Every endpoint: [`../docs/API_DOCUMENTATION.md`](../docs/API_DOCUMENTATION.md).

**Status:** complete locally and fully tested; **nothing is deployed** and no website or dashboard is connected yet. Hosting target: Cloudflare (see the development guide for what remains).

## Stack

Node.js 24 (`nvm use`) · Express 5 · `pg` (raw parameterized SQL, no ORM) · Neon PostgreSQL · Cloudflare Access for admin sign-in. Two runtime dependencies, everything else is a Node built-in that also exists on Cloudflare Workers.

## Quick start

```bash
nvm use && npm install
cp .env.example .env          # set DATABASE_URL (a DEVELOPMENT database!) and the dev auth settings
npm run db:migrate            # creates all schemas and tables (safe to re-run)
npm run admin:create -- you@example.com "Your Name"     # first Super Admin
npm run dev                   # http://localhost:3000
```

Minimal `.env` for local development with the dashboard:

```ini
NODE_ENV=development
DATABASE_URL=postgresql://USER:PASSWORD@HOST/central_backend_dev?sslmode=verify-full
AUTH_MODE=dev
ADMIN_ALLOWED_ORIGINS=http://localhost:5173
```

| Script | |
|---|---|
| `npm run dev` / `npm start` | run the API (with / without file watching) |
| `npm run db:migrate` | apply pending SQL migrations (platform first, then each website) |
| `npm run admin:create -- <email> ["Name"]` | create (or promote) a Super Admin — the only way to bootstrap the first admin |
| `npm run dev:token -- <email>` | print a development admin token (`AUTH_MODE=dev` only) |
| `npm test` | all tests, **without a database** (database mocked) |
| `npm run test:db` | all tests **including real-database suites**, serially, against `TEST_DATABASE_URL` |

## Configuration

Loaded from the environment (a local `.env` is read for development; real variables win). Invalid or insecure settings stop the server from starting.

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `PORT` | `3000` | local port |
| `DATABASE_URL` | — (required in production) | PostgreSQL URL; remote databases **must** use `sslmode=verify-full` |
| `DB_POOL_MAX` | `5` | connections per instance |
| `TEST_DATABASE_URL` | — | the dedicated **test** database (`central_backend_test`). Tests never use `DATABASE_URL`. |
| `AUTH_MODE` | `cloudflare-access` if `ACCESS_TEAM_DOMAIN` set, else `none` | `cloudflare-access` (required in production), `dev` (local tokens), `none` (admin API answers 503) |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | — | Cloudflare Access team domain and application AUD tag |
| `ADMIN_ALLOWED_ORIGINS` | — | the dashboard's origin(s), comma-separated; production `https` only |
| `CORS_ORIGINS_EPINEON`, `_QAEGIS`, `_EPIWELL` | — | each website's own origin(s) |
| `CLIENT_IP_SOURCE` | `socket` | `socket` (local), `cloudflare-worker`, `cloudflare-proxy`; production requires a `cloudflare-*` value |
| `RATE_LIMIT_STORE` | `postgres` if a database is set | `postgres` (required in production) or `memory` |
| `RATE_LIMIT_SECRET` | random per process (dev) | 32+ characters, hashes client IPs; required in production |
| `BODY_LIMIT` | `100kb` | maximum JSON body |
| `REQUEST_LOGGING` | `true` | set `false` to silence request logs |
| `DEV_ACCESS_JWKS_PATH` | `.dev-access/jwks.json` | public keys for `AUTH_MODE=dev` tokens |

## Endpoints (summary)

| Method | Path | |
|---|---|---|
| GET | `/api/health`, `/api/health/database`, `/api/v1/<app>/health` | health |
| POST | `/api/v1/epineon/forms/{demo,sales,partnerships}` | Epineon forms |
| POST | `/api/v1/qaegis/forms/contact-sales` | QAegis form |
| POST | `/api/v1/epiwell/forms/waitlist` | Epi Well waitlist |
| POST | `/api/v1/submissions` | any form, by `{ application, formType, data }` |
| GET | `/api/v1/admin/me` | the signed-in admin and their websites |
| GET | `/api/v1/admin/submissions` | list, search, filter, sort, paginate |
| GET · PATCH · DELETE | `/api/v1/admin/submissions/:application/:formType/:id` | view, update status / read, delete |
| GET | `/api/v1/admin/stats` | statistics (per website and combined) |
| GET · POST · PATCH | `/api/v1/admin/users[/:id]` | manage admins (Super Admin) |
| GET | `/api/v1/admin/audit` | audit log (Super Admin) |

## Architecture

```
src/
├── applications/            ONE FOLDER PER WEBSITE (independent)
│   ├── epineon/  qaegis/  epiwell/
│   │   ├── forms/           field definitions: columns, limits, options, honeypot, timing
│   │   ├── config/          app settings + rate-limits.js
│   │   ├── routes/ controllers/ services/ repositories/
│   │   └── database/migrations/   this website's SQL (its own schema only)
│   └── index.js             registry of applications
├── platform/                cross-application features (generic; never imports an application)
│   ├── submissions.routes.js    POST /api/v1/submissions
│   └── admin/               Admin API: router, authenticate, permissions, repositories
├── shared/                  infrastructure only: config, database, middleware, security, utils
├── app.js                   createApp() (does not listen)
└── server.js                local entry point
scripts/                     migrate · create-super-admin · dev-token
tests/                       see "Testing"
```

Import rules, enforced by `tests/isolation.test.js`: a website imports only itself and `shared/`; `platform/` imports only `shared/`; `shared/` imports neither; no schema names are hard-coded in `platform/`.

## Data model

| Schema | Tables |
|---|---|
| `epineon` | `demo_submissions`, `sales_submissions`, `partnerships_submissions` |
| `qaegis` | `contact_sales_submissions` |
| `epiwell` | `waitlist_submissions` |
| `platform_admin` | `admin_users`, `admin_app_access`, `audit_log`, `rate_limit_counters` |

- **One table per form**, named in the form's definition; the server refuses to start if two forms share a table or one has none. A form's insert statement names exactly one table.
- Each table has the form's fields as columns plus `id`, `status`, `is_read`, `read_at/by`, `status_changed_at/by`, `created_at`, `updated_at`. Field limits and option lists are also enforced by database `CHECK`s that mirror the live sites (tests keep SQL and form definitions in sync).
- The earlier shared `form_submissions` tables are **frozen and kept** (inserts rejected), never dropped.
- Migrations are forward-only SQL with checksums; **never edit an applied one**. All are additive (no drop, truncate or delete), and a rehearsal test proves a migration of realistic old data is exact and a bad row rolls everything back. Details: API documentation, section 5.

## Security

- **Rate limiting** — Postgres-backed and atomic (one `INSERT … ON CONFLICT` per request), per website, per form and per client; IPs are stored only as HMACs (IPv6 grouped by /64). Over the limit: `429` with `Retry-After` and `RateLimit-*` headers. If the store is down the endpoint fails closed (`503`).
- **Client IP** — never from `X-Forwarded-For`. `CLIENT_IP_SOURCE=cloudflare-worker` trusts `CF-Connecting-IP`; `cloudflare-proxy` trusts it only from Cloudflare's published edge ranges.
- **Origins / CORS** — each website may call only its own form endpoints; origins are *enforced*, not just advertised (unified endpoint included). Admin changes must come from an allowed dashboard origin.
- **Spam** — per-form honeypot and timing checks; both fail silently and store nothing.
- **Admin authentication** — Cloudflare Access JWT verified here (RS256 signature by `kid`, issuer, audience, expiry), then authorized per website from `platform_admin`; disabling an admin takes effect on the next request. Lists, statistics and single-record routes only ever build SQL from the websites the caller may use.
- **Transport** — HTTPS required in production (rejected, never redirected; HSTS); database TLS with `verify-full`; startup refuses insecure production settings.
- **Hardening** — strict JSON (100 kB, no compression), strict query parameters (unknown or repeated ones are rejected), 405 with `Allow`, security headers, safe generic errors (never stack traces or internals), logs without bodies, headers, query strings, IPs, tokens or emails.

## Testing

| Command | Covers |
|---|---|
| `npm test` (387 tests) | forms and validation (per-form tables, honeypot, timing), unified endpoint, CORS, rate limits, security / HTTPS / production config, Cloudflare Access token verification (forged, tampered, algorithm-confusion), admin authentication and per-website SQL scoping, architecture and migration rules, static checks that SQL matches form definitions |
| `npm run test:db` (509 tests) | the above **plus**, on a real PostgreSQL test database: the whole Admin API (scoping, filters, search, pagination, updates, deletes, stats, users, audit, concurrency), table structure and constraints, atomic rate limits, TLS, and the migration rehearsal with realistic old data |

`TEST_DATABASE_URL` must point at a dedicated database named `central_backend_test`; the real-database suites clear its tables and refuse to run elsewhere. The frontend's own tests (including a real frontend ⇄ backend suite) live in `../frontend`.

## Adding a website or a form

See the development guide, section 9. In short: a form is one definition file + one migration + a rate limit; a website is a copy of `applications/epiwell/` plus `CORS_ORIGINS_<SLUG>`. The dashboard needs no change for either.
