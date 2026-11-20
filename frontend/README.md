# Frontend: Central Admin Dashboard

The unified admin dashboard for Epineon, QAegis and Epi Well. A React single-page app that talks to the backend **only through its REST API** — it has no database access, no credentials and no business rules of its own.

> Part of a two-application system. How the pieces fit together, how to run both, and the production design are in [`docs/DEVELOPMENT_GUIDE.md`](../docs/DEVELOPMENT_GUIDE.md). Endpoints: [`docs/API_DOCUMENTATION.md`](../docs/API_DOCUMENTATION.md).

## Stack

React 19 · Vite · React Router · TanStack Query (loading / error / caching) · Tailwind CSS 4 · Recharts (charts, loaded on demand) · Lucide icons. **No UI-kit and no Axios**: the browser's `fetch` behind one small client.

Requires **Node 24** (`nvm use`; see `.nvmrc`).

## Run it

```bash
npm install
cp .env.example .env.local        # then see "Configuration"
npm run dev                       # http://localhost:5173
```

It needs the backend running (see the development guide, section 4). In short:

```bash
# terminal 1: backend/  (AUTH_MODE=dev, a development database)
npm run dev
# create a token:     npm run -s dev:token -- you@example.com
# put it in frontend/.env.local as DEV_ACCESS_TOKEN=...
```

| Script | |
|---|---|
| `npm run dev` | dev server with the `/api` proxy |
| `npm run build` | production build into `dist/` |
| `npm run preview` | serve the build locally (same proxy) |
| `npm run lint` | ESLint |
| `npm test` | component and unit tests (no backend needed) |
| `npm run test:integration` | frontend ⇄ **real** backend + database (see Testing) |

## Configuration

Only two settings reach the browser, and both are public (`VITE_` variables are bundled into the code):

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | *(empty = same origin)* | where API requests go. Leave empty: in production `/api/*` is routed to the backend on the same hostname; in development Vite proxies it. |
| `VITE_ACCESS_LOGOUT_URL` | *(none)* | Cloudflare Access sign-out link shown in Settings |

Development-only variables (read by `vite.config.js` **in Node**, never bundled): `DEV_API_TARGET` (default `http://localhost:3000`) and `DEV_ACCESS_TOKEN`. **Never put a secret, a token or a database URL in a `VITE_` variable.** A test builds the app with fake secrets in the environment and proves none of them appears in the output.

## How it talks to the backend

`src/api/client.js` is the only place that calls `fetch`; `src/api/endpoints.js` lists the admin endpoints. The browser sends no credentials of its own: **Cloudflare Access** authenticates it and adds the signed identity header at the edge (in development, the Vite proxy plays that role). The client:

- unwraps the backend's `{ status, message, data }` envelope and turns failures into `ApiError` (status, safe message, per-field validation details);
- treats an expired Access session (a redirect to the login page) as "session expired";
- never retries or hides errors: they reach the UI's error states.

## Permissions

`GET /api/v1/admin/me` tells the app who is signed in and which websites and forms they may use. The UI **shows only that**: the sidebar, overview, filters and settings. Route guards (`src/auth/guards.jsx`) refuse other websites' pages and the Team / Audit pages (Super Admin only) before asking the server for anything. The **backend enforces the same rules on every request**, so hiding is a convenience, not the protection.

| | Super Admin | Website admin |
|---|---|---|
| Overview, submissions, statistics | all websites | own website(s) only |
| Change status, mark read, delete | all | own website(s) only |
| Team management, Audit logs | ✅ | ❌ |

## Pages

| Route | Page |
|---|---|
| `/` | **Overview**: totals, unread, period activity, submissions-per-day chart, status distribution, per-website cards, recent submissions |
| `/submissions` | **All submissions** across the websites you can access |
| `/apps/:application/:formType` | **One form** — Epineon Demo / Sales / Partnerships, QAegis Contact Sales, Epi Well Waitlist (built from `/me`, so new forms appear automatically) |
| `/team` | **Team management** (Super Admin): add, edit, enable / disable administrators and their websites |
| `/audit` | **Audit logs** (Super Admin) |
| `/settings` | account, role, accessible websites, theme, sign-out |

Submissions pages share one component: search, status / read / date / website / form filters, sorting, pagination, a detail drawer (status, mark read/unread, reply by email, delete with confirmation). Filters, page and the open submission live in the **URL**, so views can be bookmarked and shared. Every data view has **loading, empty and error** states. The layout is responsive: sidebar on desktop, slide-over menu on tablet and phone, tables that drop secondary columns on small screens. Light / dark / system theme.

## Project layout

```
src/
├── api/            client.js (fetch + ApiError) · endpoints.js
├── auth/           SessionProvider (calls /me) · guards (RequireSession / Application / SuperAdmin)
├── layouts/        DashboardLayout (sidebar + mobile menu)
├── pages/          Overview · Submissions · TeamManagement · AuditLogs · Settings · StatusPages
├── components/
│   ├── ui/         Button · Card · Badge · Field · Pagination · Overlay (dialog/drawer) · States
│   ├── submissions/  SubmissionsView · Filters · Table · Drawer
│   └── charts/     DailyChart · WebsiteChart · StatusBars   (Recharts is lazy-loaded)
├── lib/            labels · format · theme · session
└── config.js · queryClient.js · main.jsx · App.jsx
tests/              component tests (+ an in-memory fake API) and integration/
```

## Testing

- **`npm test`** — 120 tests with Vitest, React Testing Library and MSW. They run the real app against an in-memory **fake of the admin API that enforces the same permission rules**, so they cover: the API client (errors, session expiry, URL encoding), session states, protected routes, permission-dependent navigation, every page's loading / empty / error states, filters, pagination, the detail drawer, status updates, deletion, the team form with the *server's* validation messages, charts' text alternatives, and dialog accessibility (focus, Escape, stacking).
- **`npm run test:integration`** — 60 tests where the frontend's **real API client talks to the real backend and a real PostgreSQL database** (the backend is started as a separate process in `AUTH_MODE=dev` with real signed tokens). Covers authentication (forged, expired, wrong-audience tokens), every cross-website permission attempt, all five public forms and the unified endpoint, honeypot / origin / rate limits, list / search / pagination, updates, deletion, statistics, team management, audit — plus the Vite dev proxy and a scan proving the production build contains no secrets.

```bash
INTEGRATION_DATABASE_URL="postgresql://…/central_backend_test?sslmode=verify-full" npm run test:integration
```

`INTEGRATION_DATABASE_URL` must be a **dedicated test database** (its name must contain "test"): the suite empties its tables. It starts the backend from `../backend` (override with `BACKEND_DIR`).

## Build and deployment notes (nothing is deployed yet)

`npm run build` creates a static site in `dist/` (about 110 kB of JavaScript gzipped; the charts load on demand). Host it on the **same hostname** as the API (`/api/*` routed to the backend) behind Cloudflare Access. Serve it with a strict CSP (`script-src 'self'`; the build has no inline scripts) — see the development guide, section 7.

## Troubleshooting

| | |
|---|---|
| "Please sign in again" | development token missing or expired (8 h): create a new one in the backend and restart `npm run dev` |
| "No access to this dashboard" | the signed-in email is not an active administrator |
| Blank page / network error | the backend is not running, or `DEV_API_TARGET` points elsewhere |
| Tooling errors about Node | use Node 24 (`nvm use`) |
