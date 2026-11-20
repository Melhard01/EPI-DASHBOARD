# Development Guide

How the central backend is built, how data flows through it, and how to work on it safely. For the endpoint reference see [`docs/API_DOCUMENTATION.md`](docs/API_DOCUMENTATION.md); for setup basics and security notes see [`README.md`](README.md).

## 1. What this is

One Node.js / Express API in front of one Neon PostgreSQL database, serving three independent websites (**Epineon**, **QAegis**, **Epi Well**) and one unified admin dashboard. Hosting target: **Cloudflare**. Nothing is deployed yet and no website or dashboard is connected yet.

Design goals, in priority order:

1. **Application isolation.** One website's forms, rules, data and admins can never touch another's.
2. **Security by default.** Strict validation, rate limits, enforced origins, HTTPS/TLS, no personal data in logs or errors, server-side permissions.
3. **Small and boring.** Two runtime dependencies (`express`, `pg`); everything else is Node built-ins that also exist on Cloudflare Workers.

## 2. Architecture

```
src/
├── applications/                 ONE FOLDER PER WEBSITE (independent)
│   ├── index.js                  registry: the only list of applications
│   └── <app>/
│       ├── index.js              descriptor: slug, schema, formTypes, formHandlers, router
│       ├── config/               index.js (name, slug, dbSchema) · rate-limits.js
│       ├── forms/                *.form.js definitions + index.js registry
│       ├── routes/               health + forms routes (builds the per-form handler chains)
│       ├── controllers/  services/  repositories/
│       └── database/migrations/  this application's SQL, schema <app> only
├── platform/                     CROSS-APPLICATION FEATURES (generic; no app imports)
│   ├── submissions.routes.js     POST /api/v1/submissions
│   ├── runChain.js               reuses an application's own handler chain
│   └── admin/                    router · authenticate · permissions · repositories · params
├── shared/                       INFRASTRUCTURE ONLY (no business rules)
│   ├── config/env.js             validated configuration, production safety rules
│   ├── database/                 pool, migration runner, platform migrations/
│   ├── middleware/               security headers, request id, HTTPS, errors, logging
│   ├── security/                 client IP trust, CORS, rate limiting, Cloudflare Access JWT
│   └── utils/                    validation engine, AppError, response helpers, logger
├── app.js                        createApp(): builds the Express app (does not listen)
└── server.js                     local entry point
```

**Import rules (enforced by `tests/isolation.test.js`):**

- an application imports only itself and `shared/`; never another application, never `platform/`
- `platform/` imports only `shared/`; never an application (it receives applications as arguments) and never hard-codes a schema name
- `shared/` imports neither

Anything that must differ per website — field names, limits, option lists, honeypot name, rate limits, allowed origins — lives in that website's folder or environment variables. `shared/` and `platform/` contain the *mechanisms*.

## 3. Request flow

### Public submission

```
Browser (website origin)
  → [OPTIONS preflight]  cors()                              204 for an allowed origin
  → POST /api/v1/<app>/forms/<type>   or   POST /api/v1/submissions
      requestId → securityHeaders → requestLogger → cors
      → clientIdentity          trusted client IP (Cloudflare) — see README "Client IP trust"
      → requireHttps            production only; 403, never a redirect
      → express.json            100 kB, objects only, no compression
      → [/submissions only]     requireJson → parse envelope → pick the application's chain
      → the application's chain (identical for both entry points):
          requireAllowedOrigin(<app>)     403 unless the Origin is one of THIS app's websites
          rateLimit(<app>:<form>)         atomic Postgres counters, 429 + headers
          requireJson                     415 otherwise
          form handler → form.service:
              validateSubmission          honeypot → timing → unknown fields → each field
              createSubmission            server sets application, formType, id, time
              saveSubmission              INSERT INTO <app schema>.form_submissions
      → 201 receipt (no personal data)
```

### Admin request

```
Dashboard (dashboard origin) + Cloudflare Access login
  → /api/v1/admin/*
      requestId → … → clientIdentity → requireHttps → cors → express.json
      → requireAdminOrigin        foreign Origin 403; changes must send an allowed Origin
      → authenticateAdmin         verify Access JWT (signature, iss, aud, exp) → look up
                                   platform_admin.admin_users (active?) + app access
      → route handler:
          appFromPath / resolveApplications   403 BEFORE any query for forbidden apps
          requireSuperAdmin                   for /users and /audit
          repository (SQL built only from permitted schemas, values as parameters)
          [changes] one transaction: UPDATE/DELETE + audit_log entry
      → { status, message, data }
```

## 4. Authentication with Cloudflare Access

Why Access: no passwords or sessions to store and secure, MFA and SSO for free (up to 50 users), and it fits the Cloudflare hosting. The API still verifies every token itself (`shared/security/cloudflareAccess.js`) and keeps authorization (who is an admin of what) in its own database.

### One-time setup (Cloudflare dashboard)

1. **Zero Trust → Settings → Authentication**: enable a login method (One-time PIN is the simplest; add Google or Microsoft if wanted). Note your **team domain**, `https://<team>.cloudflareaccess.com`.
2. **Zero Trust → Access → Applications → Add → Self-hosted**:
   - Application domain: the API hostname with the path `/api/v1/admin`
   - Policy: **Allow** for the email addresses (or domain) of your admins. Require MFA if you like.
   - Open the application and copy its **Application Audience (AUD) tag**.
3. Do **not** put the public form endpoints (`/api/v1/submissions`, `/api/v1/*/forms/*`) behind Access — the websites' visitors must be able to submit.
4. Production environment (see `.env.example`):
   ```
   ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
   ACCESS_AUD=<the AUD tag>
   ADMIN_ALLOWED_ORIGINS=https://<dashboard-origin>
   ```
5. Create the first Super Admin (the email must match a person allowed by the Access policy):
   ```bash
   npm run admin:create -- you@example.com "Your Name"
   ```
   Everything after that (adding admins, granting websites) is done through `POST /users` and `PATCH /users/:id`.

Production **refuses to start** without Access configured. Staying in sync with Access: if Access allows someone who is not in `admin_users`, they get `403`; if an admin is disabled in `admin_users`, they lose access on their next request even though Access still lets them sign in.

### Local development without Cloudflare

`AUTH_MODE=dev` verifies locally signed tokens through the *same* verifier code. It is refused in production.

```bash
# .env:  AUTH_MODE=dev   ADMIN_ALLOWED_ORIGINS=http://localhost:5173
npm run admin:create -- me@example.com          # needs DATABASE_URL (use a development database)
TOKEN=$(npm run -s dev:token -- me@example.com)  # keys are created in .dev-access/ (git-ignored)
npm run dev
curl -H "Cf-Access-Jwt-Assertion: $TOKEN" http://localhost:3000/api/v1/admin/me
```

## 5. Permissions

Defined in `src/platform/admin/permissions.js` and exercised by `tests/admin-auth.test.js` (SQL inspection, no database) and `tests/admin.test.js` (real database).

- Super Admin → all applications, `/users`, `/audit`.
- Application admin → submissions and statistics of the applications in `admin_app_access`; delete included.
- To add a new *role* (for example a read-only viewer), extend `admin_app_access` with a role column in a new migration, load it in `authenticate.js`, and add a rule in `permissions.js`. Every write route already goes through a single permission check, so the change is small.

## 6. Running and testing

```bash
npm install
cp .env.example .env            # then edit
npm run db:migrate              # platform + application migrations (safe to re-run)
npm run dev                     # http://localhost:3000
```

| Command | What it runs |
|---|---|
| `npm test` | The whole suite **without a database** (database mocked). Fast; runs anywhere. |
| `npm run test:db` | Everything, serially, **including real-database tests** against `TEST_DATABASE_URL` (loaded from `.env`). |

**Test database.** `TEST_DATABASE_URL` must point to a dedicated database (here `central_backend_test` in the same Neon project). The real-database suites refuse to run unless the database is named `central_backend_test` and differs from `DATABASE_URL`, because they clear tables to get exact counts. Tests **never** read `DATABASE_URL`.

Test files:

| File | Covers |
|---|---|
| `forms.test.js` | the four live-site forms: validation, sanitation, isolation, persistence (mocked DB), logging |
| `submissions.test.js` | `POST /api/v1/submissions`, shared rate limits, origin enforcement, CORS, honeypot/timing, waitlist |
| `validation.test.js` | validation engine: choices, blocked domains, honeypot, timing, definition errors |
| `rate-limit.test.js`, `security.test.js` | limits, 429s, client IP trust, HTTPS, headers, production config |
| `access.test.js` | Cloudflare Access JWT verification incl. forged / tampered / confused-algorithm tokens |
| `admin-auth.test.js` | admin authentication and per-application SQL scoping, no database |
| `admin.test.js` | full Admin API against Postgres: scoping, filters, search, pagination, updates, deletes, stats, users, audit, constraints, concurrency |
| `database.integration.test.js` | real-database storage, rate-limit atomicity and reset, TLS |
| `isolation.test.js` | import boundaries, schema boundaries, migration rules, status vocabulary |

## 7. Working with the database

- **Never edit an applied migration.** The runner stores a checksum and refuses to continue. Add `NNN_description.sql` instead (step 5 did this when `003` fixed a constraint from `002`).
- Keep migrations **additive** (add columns with defaults, add tables and indexes). Do not drop or retype columns that hold data without an explicit, reviewed plan.
- An application's migrations may only touch its own schema; platform migrations only `platform_*` schemas (a test enforces both).
- Before and after changing a real database, take a snapshot (row counts and checksums of the tables) and compare. Migrations are applied by hand with `npm run db:migrate`, not at server start.
- Use parameters for every value. Schema names come only from application config and pass `assertSafeIdentifier`.

## 8. Common changes

### Add a form to an existing website
1. `src/applications/<app>/forms/<type>.form.js` using `defineForm()` (types: `text`, `email`, `url`, `choice`; options `multiline`, `lowercase`, `blockedDomains`; `honeypot`, `timing`).
2. Add it to `forms/index.js` and add its limits to `config/rate-limits.js` (the server refuses to start without them).
3. It is immediately served at `POST /api/v1/<app>/forms/<type>` **and** accepted by `POST /api/v1/submissions`, and appears in `/admin/me`, filters and statistics. Add tests to `forms.test.js`.

### Add a website
Follow "Adding another application" in the README, then add `CORS_ORIGINS_<APP>` for its origins. Admins get access through `admin_app_access` — no code change in `platform/`.

### Allow a website origin
Set `CORS_ORIGINS_<APP>=https://site.example,https://www.site.example` (comma-separated, production `https` only) and redeploy.

### Add a submission status
Change the `CHECK` constraint in a **new** migration for every application schema, update `src/platform/admin/statuses.js`, and update the docs. `isolation.test.js` fails if the two drift apart.

## 9. Security checklist for changes

- New route? It needs an origin rule, a method handler (`methodNotAllowed`), strict parameter parsing and, if public, a rate limit.
- New admin route? It must go through `authenticateAdmin`, resolve the application *before* querying, and write an audit entry for any change. Add a cross-application test.
- Never log request bodies, headers, query strings, IPs, tokens or emails. Never put submitted values in error messages.
- New dependency? Check it runs on Cloudflare Workers (`nodejs_compat`) and justify it.

## 10. Known limitations and next steps

- **Not deployed.** Moving to Cloudflare Workers still requires: a per-request `pg` client with Hyperdrive instead of the global pool, a configuration adapter instead of `.env`, a Hyperdrive-aware TLS check, and confirming in staging that `CF-Connecting-IP` and `X-Forwarded-Proto` reach Express under `httpServerHandler`.
- **No email notifications.** QAegis currently emails sales through Resend; this backend does not.
- **Historical data** lives in three Supabase projects and is not imported.
- **Roles** are per-website admin or Super Admin; there is no read-only role yet (section 5).
- **Search** is a substring match over submission values (`ILIKE`); fine for form volumes, not for millions of rows (a trigram index is the next step).
- **No CSV export** yet (the live QAegis dashboard has one).
- **Database account.** The app connects as the database owner; a restricted runtime role (no DDL) with the owner reserved for migrations would limit the blast radius.
