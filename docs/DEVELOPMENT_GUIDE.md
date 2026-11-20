# Development Guide

How the system is built, how to run both applications on your machine, how to test them, and how to change them safely. For endpoints see [API_DOCUMENTATION.md](API_DOCUMENTATION.md); for each application see [`backend/README.md`](../backend/README.md) and [`frontend/README.md`](../frontend/README.md).

## 1. What this is

Two **independent applications** that only meet over HTTP:

```
Epineon + QAegis + Epi Well              (visitors fill in forms)
          │  POST /api/v1/<site>/forms/<form>
          ▼
  backend/   Node.js + Express REST API  ──►  Neon PostgreSQL
          ▲                                   one schema per website,
          │  GET/PATCH/DELETE /api/v1/admin/*  one table per form
  frontend/  React + Vite admin dashboard
          (signed in through Cloudflare Access)
```

| | `backend/` | `frontend/` |
|---|---|---|
| Role | all business logic, validation, permissions, database | interface only |
| Stack | Node 24, Express 5, `pg`, SQL migrations | React 19, Vite, React Router, TanStack Query, Tailwind |
| Talks to | Neon PostgreSQL (TLS, verified) | the backend's REST API, nothing else |
| Secrets | database URL, rate-limit key, Access settings | **none** (only public `VITE_` settings) |
| Tests | `npm test` · `npm run test:db` | `npm test` · `npm run test:integration` |

Rules that keep them independent:

- The browser **never connects to Neon** and never receives a database credential or an API secret.
- The backend owns every rule. The dashboard *displays* what the backend allows and shows the backend's own validation messages; it does not re-implement rules. Hiding a button is a convenience, never the protection.
- There is **no shared code** between the two folders (no workspace, no shared package). The contract is the REST API in [API_DOCUMENTATION.md](API_DOCUMENTATION.md).
- Both are plain npm projects and can be built, tested, deployed and versioned separately.

## 2. Repository layout

```
EPI DASHBOARD/
├── backend/            Express API (src/, scripts/, tests/, .env, package.json)
├── frontend/           React dashboard (src/, tests/, .env.local, package.json)
└── docs/               API_DOCUMENTATION.md, DEVELOPMENT_GUIDE.md
```

## 3. Data flow

**A visitor submits a form** (public, no login):

```
website page ─► POST /api/v1/<site>/forms/<form>        (CORS: only that site's origin)
   backend: HTTPS check → client IP (Cloudflare) → origin check → rate limit (Postgres)
            → validate (field rules, honeypot, timing) → INSERT into the form's own table
   ◄─ 201 { application, formType, submissionId, receivedAt }   (no submitted data)
```

**An administrator uses the dashboard:**

```
browser ─► https://admin.<domain>/            Cloudflare Access login (email code / SSO / MFA)
        ─► GET /  (static React app)
        ─► GET /api/v1/admin/me               same hostname ⇒ same origin ⇒ no CORS;
              Cloudflare adds the signed Cf-Access-Jwt-Assertion header at the edge
   backend: verify the token itself (signature, issuer, audience, expiry)
            → look the email up in platform_admin.admin_users → which websites?
   ◄─ { email, isSuperAdmin, applications:[{slug,name,formTypes}] }
   React builds its menu from that answer, then calls /submissions, /stats, ... each of
   which the backend authorizes again, per website, on every request.
```

## 4. Run both applications locally

**You need:** Node 24 (`nvm install 24`; each folder has an `.nvmrc`, so `nvm use` picks it), npm, and a PostgreSQL database you may freely change.

> ⚠️ **Use a development database, not production.** The easiest is a separate database in the same Neon project (for example `central_backend_dev`), created from the Neon console. Never point `DATABASE_URL` at production while developing.

### 4.1 Backend (terminal 1)

```bash
cd backend
nvm use
npm install
cp .env.example .env
```

Edit `backend/.env`:

```ini
NODE_ENV=development
DATABASE_URL=postgresql://USER:PASSWORD@HOST/central_backend_dev?sslmode=verify-full
AUTH_MODE=dev                                   # local tokens instead of Cloudflare Access
ADMIN_ALLOWED_ORIGINS=http://localhost:5173     # the dashboard's address
```

Then:

```bash
npm run db:migrate                              # creates every table (safe to re-run)
npm run admin:create -- you@example.com "Your Name"   # the first Super Admin
npm run dev                                     # API on http://localhost:3000
```

### 4.2 Frontend (terminal 2)

```bash
cd backend && npm run -s dev:token -- you@example.com   # prints a development token (valid 8 hours)
```

```bash
cd frontend
nvm use
npm install
cp .env.example .env.local
```

Put the token into `frontend/.env.local`:

```ini
DEV_ACCESS_TOKEN=<the token printed above>
```

```bash
npm run dev                                     # dashboard on http://localhost:5173
```

Open <http://localhost:5173>. The dev server forwards `/api` to the backend and adds the token in Node, the way Cloudflare Access adds it in production: the **browser never sees the token**. When the token expires (8 h) you get "Please sign in again": create a new token and restart the dev server.

### 4.3 Try a submission

```bash
curl -X POST http://localhost:3000/api/v1/epiwell/forms/waitlist \
  -H 'Content-Type: application/json' -d '{"email":"someone@example.com"}'
```

It appears in the dashboard (Overview, All submissions, Epi Well → Waitlist). To test from a real website page, add its origin to the backend (`CORS_ORIGINS_EPINEON=http://localhost:4000`, …).

## 5. Authentication and permissions

- **Production:** Cloudflare Access signs people in; the backend verifies each request's signed token and then asks its own database which websites that person may manage (`platform_admin.admin_users` + `admin_app_access`). Setup steps are in section 7.
- **Development:** `AUTH_MODE=dev` verifies locally signed tokens through the *same* verifier code. It is refused in production.
- **Super Admin:** every website, plus Team management and the Audit log. **Website admin:** only their assigned website(s) — enforced per request by the backend, including lists, search and statistics (forbidden websites' tables are never even named in the SQL).
- Admins are created from the dashboard's *Team management* page (or `POST /api/v1/admin/users`). The very first Super Admin comes from the command line (`npm run admin:create`), because the API needs an admin to exist.

## 6. Testing

| Where | Command | What it covers | Needs |
|---|---|---|---|
| backend | `npm test` | validation, forms, rate limits, security, CORS, admin auth and SQL scoping, Access token verification, architecture rules | nothing (database mocked) |
| backend | `npm run test:db` | everything above **plus** real-PostgreSQL suites: admin API, per-form tables and constraints, concurrency, migrations, migration rehearsal with realistic old data | `TEST_DATABASE_URL` → `central_backend_test` |
| frontend | `npm test` | API client, session and route guards, permission-dependent navigation, every page (loading / empty / error states), filters, drawer, delete flow, team form, charts, accessibility basics — against an in-memory fake of the API | nothing |
| frontend | `npm run lint` · `npm run build` | code quality; production bundle | nothing |
| frontend | `npm run test:integration` | the frontend's **real API client against the real backend and a real database**: authentication (forged / expired / wrong-audience tokens), every cross-website permission attempt, all five public forms + the unified endpoint, honeypot, origin and rate limits, lists / search / pagination, status updates, delete, statistics, team management, audit log; plus the Vite dev proxy and a secret-leak scan of the production build | `INTEGRATION_DATABASE_URL` |

```bash
# backend, real database (the URL of the dedicated test database)
cd backend && npm run test:db

# frontend ⇄ backend
cd frontend
INTEGRATION_DATABASE_URL="postgresql://…/central_backend_test?sslmode=verify-full" npm run test:integration
```

**The test database is disposable and protected.** `TEST_DATABASE_URL` / `INTEGRATION_DATABASE_URL` must name a database containing "test"; the suites clear its tables and refuse to run otherwise. The backend's tests never read `DATABASE_URL`.

## 7. Production shape (designed and tested locally — **not deployed yet**)

Recommended topology, all on Cloudflare:

- `admin.<domain>` — **one Cloudflare Access application** covering the whole hostname. Static React files at `/`, and `/api/*` routed to the backend on the **same hostname**. Same origin means the browser's Access cookie just works and no CORS is involved; the edge adds `Cf-Access-Jwt-Assertion` for the backend to verify.
- `api.<domain>` — the three websites' **public** form endpoints, **not** behind Access, with CORS limited to each website's own origin.

Backend production settings (the server refuses to start without them): `NODE_ENV=production`, `DATABASE_URL` with `sslmode=verify-full`, `CLIENT_IP_SOURCE=cloudflare-worker` or `cloudflare-proxy`, `RATE_LIMIT_STORE=postgres`, a 32+ character `RATE_LIMIT_SECRET`, `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`, `ADMIN_ALLOWED_ORIGINS=https://admin.<domain>`, and `CORS_ORIGINS_EPINEON` / `_QAEGIS` / `_EPIWELL`.

Cloudflare Access setup (one time): Zero Trust → Access → Applications → *Self-hosted* → domain `admin.<domain>` → policy *Allow* for your admins' emails → copy the **AUD tag** → set `ACCESS_AUD`; your team domain is `ACCESS_TEAM_DOMAIN`. Do **not** put the public form endpoints behind Access.

### 7.1 Vercel behind Cloudflare (backend prepared, **not deployed**)

The backend is ready to run as a Vercel function: `backend/api/index.js` exports the Express app, `backend/vercel.json` rewrites `/api/*` to it (15 s max, 512 MB), `backend/.vercelignore` keeps secrets and tests out of the upload, and `engines.node` is `24.x`. In the Vercel project set **Root Directory = `backend`**.

Vercel terminates the connection, so the TCP peer is Vercel, not Cloudflare. The client IP therefore uses `CLIENT_IP_SOURCE=vercel-cloudflare`: `CF-Connecting-IP` is trusted only if (1) `X-Vercel-Forwarded-For` (set by Vercel, not overridable by clients) is a Cloudflare edge address and (2) `X-Origin-Auth` equals `ORIGIN_AUTH_SECRET`. Create the second part in Cloudflare: *Rules → Transform Rules → Modify Request Header → Set static* `X-Origin-Auth` = the secret, for the API hostname. Direct hits on `*.vercel.app`, and other Cloudflare accounts proxying to it, get 403.

Vercel environment variables: everything in the production list above, with `CLIENT_IP_SOURCE=vercel-cloudflare`, `ORIGIN_AUTH_SECRET`, a **pooled** Neon `DATABASE_URL` (`-pooler` host, `sslmode=verify-full`) and `DB_POOL_MAX=2`. Run migrations from a workstation against Neon's direct (non-pooled) host, never from the function. Cloudflare: SSL mode *Full (strict)*; keep Access on the admin path only, never on the public form paths.

Verify on the first **preview** deployment (cannot be proven offline): that Express receives the original `/api/v1/...` path after the rewrite, and that the Cloudflare headers arrive (`GET /api/health` through Cloudflare returns 200, directly on `*.vercel.app` returns 403).

Frontend hosting needs a strict content-security policy such as `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'` (the build has no inline scripts, which the integration suite checks).

**Still to do before the first deployment** (deliberately not started): run the Hyperdrive work for Cloudflare Workers (per-request `pg` client instead of a global pool, configuration from Workers bindings instead of `.env`, a Hyperdrive-aware TLS check, and confirming in staging that `CF-Connecting-IP` / `X-Forwarded-Proto` reach Express); apply the migrations to the production database (**snapshot row counts and checksums before and after**; the migration rehearsal test shows what to expect).

## 8. Working with the database

- **Never edit an applied migration** — the runner stores a checksum and refuses. Add the next numbered file instead.
- Keep migrations **additive**. An application's migrations may touch only its own schema; platform migrations only `platform_*` (a test enforces both, and that no new migration drops, truncates or deletes anything).
- One table per form: a form's table is named in its definition (`table: 'demo_submissions'`); the server refuses to start if two forms share one or a form has none.
- Before and after changing a real database take a snapshot (row counts and checksums) and compare.

## 9. Common changes

**Add a form to a website** (backend only — the dashboard picks it up automatically from `/api/v1/admin/me`):
1. `backend/src/applications/<site>/forms/<type>.form.js` with `defineForm({ type, table, fields, honeypot?, timing? })`.
2. Register it in that folder's `forms/index.js`; add its limits to `config/rate-limits.js`.
3. A migration `NNN_*.sql` in the site's `database/migrations/` that creates its table (columns = fields, plus the common workflow columns). The architecture tests compare the SQL with the form definition: columns, nullability, length limits and option lists.
4. Optional: friendly names in `frontend/src/lib/labels.js` (otherwise a readable fallback such as "Press Kit Request" is used).

**Add a website:** create `backend/src/applications/<slug>/` (copy `epiwell`, the simplest), register it in `applications/index.js`, add `CORS_ORIGINS_<SLUG>`, grant admins access from Team management. The dashboard shows it automatically.

**Add a status:** new migration changing every application's status `CHECK`s, `backend/src/platform/admin/statuses.js`, and `STATUSES` in `frontend/src/lib/labels.js`; a backend test fails if the SQL and the list drift apart.

**Add a dashboard page:** a component in `frontend/src/pages/`, a route in `App.jsx`, a link in `layouts/DashboardLayout.jsx`, a wrapper in `src/api/endpoints.js`. Use `RequireSuperAdmin` / `useSession()` to decide what to show — and make sure the backend endpoint enforces the same rule.

## 10. Security checklist for changes

- Every backend route has a method handler, strict parameter parsing and (if public) a rate limit and origin rule. Admin routes authorize **before** querying and write an audit entry for any change.
- Never log request bodies, headers, query strings, IP addresses, tokens or emails; never put submitted values in error messages.
- Frontend: nothing secret in `VITE_` variables (they are public); no token handling; render server text as text (React escapes it); links built from stored values only for `http(s)`.
- New dependency? Backend: must work on Cloudflare Workers (`nodejs_compat`). Both: justify it, run `npm audit`.

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Dashboard says "Please sign in again" in development | no or expired `DEV_ACCESS_TOKEN`, or the backend is not in `AUTH_MODE=dev`. Create a token, put it in `frontend/.env.local`, restart `npm run dev`. |
| "No access to this dashboard" | the signed-in email is not an active admin: `npm run admin:create -- <email>` (first admin) or add it in Team management. |
| Changes fail with `403 Origin ...` | the dashboard's address is not in the backend's `ADMIN_ALLOWED_ORIGINS`. |
| A website's form fails with `403 Origin not allowed` | add the website's origin to its `CORS_ORIGINS_<APP>`. |
| `429` while testing forms | the rate limit (e.g. 5 per 10 minutes per form); wait for `Retry-After` or use another client address. |
| Vite / tests complain about the Node version | `nvm use` (Node 24). Node 20 is end-of-life and too old for the current tooling. |
| `npm test` in the backend: "TEST_DATABASE_URL not set" suites skipped | expected for `npm test`; use `npm run test:db`. |

## 12. Known limitations and next steps

- **Not deployed**; Cloudflare Workers adaptation still to do (section 7).
- **No email notifications** (QAegis currently emails sales through Resend).
- **Historical submissions** live in three Supabase projects and are not imported.
- **Roles** are "website admin" or "Super Admin"; no read-only role yet. Website admins cannot manage other admins.
- **Search** is a substring match (`ILIKE`) over submission values; fine for form volumes, not for millions of rows.
- **No CSV export** yet (the live QAegis dashboard has one).
- **Database account:** the app connects as the database owner; a restricted runtime role (no DDL) with the owner reserved for migrations would limit the blast radius.
- **Old shared tables** (`form_submissions`) are frozen and empty; drop them only after a deliberate review.
