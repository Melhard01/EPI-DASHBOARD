# Central Backend API

One Node.js / Express API (the `backend/` application) that serves three independent websites — **Epineon**, **QAegis** and **Epi Well** — and one unified admin dashboard (the separate React application in `frontend/`). Data lives in Neon PostgreSQL: one schema per website and **one dedicated table per form**.

> **What changed in this version** (breaking for any caller written against the previous one; nothing is connected yet, so no site is affected):
> - every form has **its own table** (`epineon.demo_submissions`, …); the shared `form_submissions` tables are frozen
> - **Epi Well is now `epiwell`**: URL `/api/v1/epiwell/...`, schema `epiwell`, CORS variable `CORS_ORIGINS_EPIWELL`
> - admin item URLs include the form: `/api/v1/admin/submissions/:application/:formType/:id`
> - submissions have an **`isRead`** boolean (alongside `readAt` / `readBy`)
> - audit entries carry the exact **`formType`**; rate-limit counters live in `platform_admin`

```
Epineon + QAegis + Epi Well      (public forms)
          │   POST /api/v1/submissions   or   POST /api/v1/<app>/forms/<form>
          ▼
 Central API (Express)  ── rate limits · origin rules · validation · anti-spam
          │
          ▼
 Neon PostgreSQL   epineon.* │ qaegis.* │ epiwell.* │ platform_admin.*
          ▲
          │   /api/v1/admin/*      (Cloudflare Access login + per-application permissions)
 Unified Admin Dashboard (React, frontend/)
```

- [1. Conventions](#1-conventions)
- [2. Authentication and permissions](#2-authentication-and-permissions)
- [3. Public endpoints](#3-public-endpoints)
- [4. Admin endpoints](#4-admin-endpoints)
- [5. Database structure](#5-database-structure)
- [6. How each website uses the API](#6-how-each-website-uses-the-api)
- [7. Error reference](#7-error-reference)

---

## 1. Conventions

**Base URL.** `https://<api-host>` in production (HTTPS only). `http://localhost:3000` in local development.

**Format.** JSON only. Requests with a body must send `Content-Type: application/json`. Bodies are limited to 100 kB. Compressed request bodies are refused.

**Response envelope.**

```jsonc
// success
{ "status": "success", "message": "…", "data": { … } }
// error
{ "status": "error", "message": "…", "details": [ … ] }   // "details" only for validation errors
```

Success responses that return a record or a page put it under `data`. Error messages are generic and never echo submitted values, tokens, credentials or internal errors.

**Headers on every response:** `X-Request-Id` (server-generated, for support and logs), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive `Content-Security-Policy`, and (production) `Strict-Transport-Security`.

**Rate-limit headers** (public form endpoints): `RateLimit-Policy`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds), and `Retry-After` on 429.

**Pagination** (admin lists): `page` (from 1) and `pageSize` (1–100). Every list returns

```json
{ "items": [ … ], "pagination": { "page": 1, "pageSize": 25, "total": 11, "totalPages": 1 } }
```

**Timestamps** are ISO 8601 UTC (`2026-11-19T11:21:50.788Z`). **IDs** are UUIDs.

**Strictness.** Unknown JSON fields and unknown or repeated query parameters are rejected with `400`, never silently ignored.

---

## 2. Authentication and permissions

### Public endpoints

No authentication. They are protected by **rate limiting**, **per-application origin rules (CORS)**, validation and anti-spam checks (sections 3.4–3.6).

### Admin endpoints

Admins sign in through **Cloudflare Access** (email one-time code or SSO, optionally MFA). Access puts a signed JWT in the `Cf-Access-Jwt-Assertion` header of every request. The API **verifies it itself** — never trusting the header blindly:

| Check | Rule |
|---|---|
| Signature | RS256, key chosen by `kid` from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached, refreshed on rotation) |
| Issuer | exactly the configured team domain |
| Audience | contains this API's Access application AUD tag |
| Time | `exp` in the future, `nbf` not in the future (60 s leeway) |
| Identity | must contain an `email` (service tokens are refused) |

A verified email is then looked up in `platform_admin.admin_users`. **Cloudflare decides who may sign in; this table decides who is an admin and for which websites.**

| Situation | Response |
|---|---|
| No `Cf-Access-Jwt-Assertion` header | `401 Authentication required` |
| Invalid, forged, expired or wrong-audience token | `401 Invalid or expired credentials` (one message for all causes) |
| Valid identity that is not an active admin, or a disabled admin | `403 Not authorized` |
| Admin authentication not configured on this server | `503 Admin authentication is not configured` |

### Access levels

| Level | How it is stored | Can do |
|---|---|---|
| **Super Admin** | `admin_users.is_super_admin = true` | Everything, on all three websites, plus managing admins and reading the audit log |
| **Application admin** | one `admin_app_access` row per website | Read, search, update status and **delete** submissions of **their own website(s) only**; statistics for those websites |

A person can hold several website grants (e.g. Epineon + QAegis). There is no implicit "all websites" access except Super Admin.

### How permissions are enforced (server-side, per request)

1. The caller's permitted websites are resolved from the database on **every request** (disabling an admin or revoking a grant takes effect immediately).
2. **Single-record routes** (`/submissions/:application/:formType/:id`) check the website **before any query runs** → `403` for a website the caller may not access. A submission ID is only ever looked up in the one table of the form named in the path, so an ID from another website **or another form** is `404`.
3. **List and statistics routes** build their SQL **only from the permitted websites' form tables**. A forbidden website's tables are never named in the query, so it cannot leak through a filter, sort or search bug. Explicitly asking for a forbidden website (`?application=qaegis`) is a `403`, never a silently filtered answer.
4. **Admin management and audit** are Super Admin only (`403` otherwise, before any query).
5. Requests that change data must also carry an allowed dashboard `Origin` header (CSRF defense in depth, see 4.1).

Safety rules for admin management: nobody can disable or demote themselves, and at least one active Super Admin always remains. Admins are disabled, never deleted, so audit entries always name a person.

### Bootstrapping the first Super Admin

The Admin API needs an existing admin, so the first one is created from the command line by someone with database access:

```bash
npm run admin:create -- you@example.com "Your Name"
```

The email must be the one that signs in through Cloudflare Access. See `DEVELOPMENT_GUIDE.md` for the Access setup.

---

## 3. Public endpoints

### 3.1 Health

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `200 {"status":"success","message":"Central Backend is running"}` |
| GET | `/api/health/database` | `200 Database is reachable`, `503 Database is not configured` / `Database is unreachable`. Never exposes connection details. |
| GET | `/api/v1/{epineon,qaegis,epiwell}/health` | Identifies the application, version and time. |

### 3.2 Submit a form

Two equivalent ways. Both run the **same** origin check, rate limit, validation and storage for the target application, and share the same rate-limit counters.

#### `POST /api/v1/<application>/forms/<formType>`

The body is the form's fields (section 3.3).

```bash
curl -X POST https://api.example.com/api/v1/qaegis/forms/contact-sales \
  -H 'Content-Type: application/json' -H 'Origin: https://qaegis.example' \
  -d '{"firstName":"Katherine","lastName":"Johnson","workEmail":"k@example.com",
       "companyWebsite":"example.com","userRange":"51-250","message":"SSO and audit logs"}'
```

#### `POST /api/v1/submissions`

Identifies the website and form in the body; `data` is exactly what the per-form endpoint accepts.

```json
{ "application": "epineon", "formType": "demo", "data": { "name": "Ada", "email": "ada@example.com", "company": "Analytical Engines", "product": "EPICRYPT" } }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `application` | string | yes | `epineon`, `qaegis` or `epiwell` |
| `formType` | string | yes | must belong to that application (see 3.3) |
| `data` | object | yes | the form's fields |

No other top-level field is accepted. The application, form type, submission ID and timestamp are **always set by the server**; a client cannot choose them (sending `application`, `formType` or `submissionId` inside `data` is rejected as an unexpected field).

**Success — `201 Created`** (never contains submitted data):

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

**Database:** one `INSERT` into **that form's own table** (e.g. `epineon.demo_submissions`; status `new`, unread, one column per field), plus one atomic upsert into `platform_admin.rate_limit_counters` per time window. The receipt is returned only after the row is stored.

**Errors:** `400` validation / spam / expired form, `403` origin not allowed, `404` unknown route, `405` wrong method, `409` duplicate waitlist email, `413` body too large, `415` not JSON, `429` rate limited, `500` internal (generic), `503` rate-limit store unavailable (fails closed).

### 3.3 Forms

Limits and option lists match the live websites. `*` = required. All values must be JSON **strings**. Values are trimmed. Single-line fields reject newlines and control characters; *multi-line* fields allow newlines and tabs.

#### Epineon — `epineon`

| Form | `formType` | Endpoint |
|---|---|---|
| Demo request | `demo` | `POST /api/v1/epineon/forms/demo` |
| Sales & Enterprise | `sales` | `POST /api/v1/epineon/forms/sales` |
| Partnerships & Ventures | `partnerships` | `POST /api/v1/epineon/forms/partnerships` |

| Field | `demo` | `sales` | `partnerships` | Rules |
|---|:-:|:-:|:-:|---|
| `name` | * | * | * | ≤ 120 |
| `email` | * | * | * | valid email, ≤ 254, **stored lower-cased** |
| `company` | * | * | | ≤ 160 |
| `organization` | | | * | ≤ 160 |
| `role` | ○ | ○ | | ≤ 120, free text |
| `product` | * | * | | one of: `EPICRYPT`, `EPIQUANTUM`, `EPIWELL`, `EPI LeGallet`, `Epitrust`, `SoulChain`, `Multiple products`, `Not sure yet` |
| `useCase` | | * | | one of: `Enterprise AI security`, `Health & wellness`, `Future intelligence / upskilling`, `Multiple ecosystems`, `Other` |
| `message` | ○ | * | | ≤ 5000, multi-line ("What would you like to see?" on `demo`) |
| `nature` | | | * | ≤ 5000, multi-line |
| `companyWebsite` | honeypot | honeypot | honeypot | **must be absent or empty** (3.5) |
| `formStartedAt` | ○ | ○ | ○ | epoch milliseconds when the form was shown (3.5) |

#### QAegis — `qaegis`

`POST /api/v1/qaegis/forms/contact-sales` (`formType` = `contact-sales`)

| Field | Rules |
|---|---|
| `firstName` * | ≤ 120 |
| `lastName` * | ≤ 120 |
| `workEmail` * | valid email (effective maximum 254 characters) |
| `companyWebsite` | optional, `example.com` or an `http(s)://` URL, ≤ 500. **A real field here, not a honeypot.** |
| `userRange` * | one of `1-50`, `51-250`, `251-1000`, `1000+` |
| `message` * | ≤ 10 000, multi-line |
| `website` | honeypot, must be absent or empty |
| `formStartedAt` | optional timestamp (3.5) |

#### Epi Well — `epiwell`

`POST /api/v1/epiwell/forms/waitlist` (`formType` = `waitlist`)

| Field | Rules |
|---|---|
| `email` * | valid email ≤ 254, **stored lower-cased**; the disposable domains `mailinator.com`, `guerrillamail.com`, `tempmail.com`, `throwaway.email`, `yopmail.com` are refused (`blocked_domain`) |
| `website` | honeypot, must be absent or empty |
| `formStartedAt` | optional timestamp (3.5) |

One waitlist entry per email address, case-insensitively, enforced by a unique index. A repeat returns `409 {"message":"This email is already on the waitlist."}`.

### 3.4 Validation errors

`400` with `"message": "Validation failed"` and a `details` list. Submitted values are never echoed.

```json
{
  "status": "error",
  "message": "Validation failed",
  "details": [
    { "field": "email", "code": "invalid_email", "message": "Field must be a valid email address" },
    { "field": "isAdmin", "code": "unexpected_field", "message": "Field is not allowed" }
  ]
}
```

| `code` | Meaning |
|---|---|
| `required` | missing, `null` or blank |
| `invalid_type` | not a string |
| `too_long` | over the field's maximum |
| `invalid_characters` | control characters (or newlines in a single-line field) |
| `invalid_email` / `invalid_url` | malformed |
| `invalid_option` | not one of the allowed options |
| `blocked_domain` | disposable email domain |
| `unexpected_field` | a field the form does not define (at most 10 are reported) |
| `empty_submission` | empty body or `{}` |
| `invalid_body` | not a JSON object |

Unified endpoint only: `unknown_application`, `unknown_form_type`.

### 3.5 Honeypot and timing checks

Anti-bot checks mirror the live Epineon site. Both trip **silently**: the response is deliberately uninformative, so a bot cannot tell which trap it hit, and **nothing is stored**.

- **Honeypot.** Each form names one hidden field (Epineon `companyWebsite`; QAegis and Epi Well `website`). Real visitors never fill it. If it contains anything, the request returns `400 {"message":"Your message could not be sent. Please try again."}`.
- **Timing.** If `formStartedAt` is sent (epoch ms from when the form was displayed): faster than **2 s** → the same generic `400` as the honeypot; older than **24 h** → `400 "This form expired. Please reload and try again."`. It is optional, a future timestamp is ignored, and a malformed value is a normal validation error. The timestamp is never stored.

Both fields are accepted only on forms that define them. Rejected requests still use up the rate limit and are logged **without any submitted data**.

### 3.6 Rate limits

Counted per client network address (IPv6 grouped by /64), per application **and** form, **before** validation (invalid and spam requests count too). Limits are independent per form and defined in each application's `config/rate-limits.js`.

| Form | Limits per client |
|---|---|
| `epineon/demo`, `epineon/sales` | 5 per 10 minutes, 20 per day |
| `epineon/partnerships` | 3 per 10 minutes, 10 per day |
| `qaegis/contact-sales` | 5 per 10 minutes, 20 per day |
| `epiwell/waitlist` | 5 per 10 minutes, 20 per day |

Exceeding a limit returns `429 {"message":"Too many requests. Please try again later."}` with `Retry-After`. The two entry points share counters, so using both does not double the allowance.

### 3.7 CORS and origin rules

Each website may call **only its own** form endpoints. Configure allowed origins per application (`CORS_ORIGINS_EPINEON`, `CORS_ORIGINS_QAEGIS`, `CORS_ORIGINS_EPIWELL`).

- Preflight (`OPTIONS`) is answered `204` for an allowed origin with `Access-Control-Allow-Origin: <that origin>` (never `*`), `Allow-Methods: POST`, `Allow-Headers: content-type`, `Max-Age: 600`. Other origins, methods or headers get `403`.
- The origin is **enforced**, not just advertised: a browser request from another origin gets `403 Origin not allowed` and **nothing is stored**. This also applies to `POST /api/v1/submissions`, which checks the *target* application's origins (an Epineon page cannot post to QAegis).
- Requests without an `Origin` header (server-to-server, curl) are allowed on public endpoints — they are not cross-site browser requests, and they are still rate limited.
- Exposed response headers: `RateLimit-*`, `Retry-After`, `X-Request-Id`.
- Production allows `https` origins only.

---

## 4. Admin endpoints

Prefix: `/api/v1/admin`. All routes need the Cloudflare Access header (section 2). **Examples below omit it.**

### 4.1 Common rules

- **Origin.** Any `Origin` header must be an allowed dashboard origin (`ADMIN_ALLOWED_ORIGINS`); requests that change data (`POST`, `PATCH`, `DELETE`) **must** send one. A foreign origin gets `403 Origin not allowed`. This is checked **before** authentication.
- **CORS.** Admin preflights are allowed only from dashboard origins, with credentials and the `Cf-Access-Jwt-Assertion` header.
- **Per-application permission** as described in section 2. Responses for forbidden applications are `403 You do not have access to this application`.
- **Statuses.** `new`, `in_progress`, `replied`, `closed`, `archived`. Whether a submission has been *read* is tracked separately: `isRead` (boolean) with `readAt` / `readBy` (who read it first).

**Submission object**

```json
{
  "application": "qaegis",
  "formType": "contact-sales",
  "submissionId": "6a2f78b1-c16f-4542-b0bd-c519fb1d3c56",
  "status": "new",
  "isRead": false,
  "data": { "firstName": "Katherine", "lastName": "Johnson", "workEmail": "k@example.com", "userRange": "51-250", "message": "SSO" },
  "receivedAt": "2026-11-19T16:21:28.768Z",
  "updatedAt": "2026-11-19T16:21:28.768Z",
  "readAt": null,
  "readBy": null,
  "statusChangedAt": null,
  "statusChangedBy": null
}
```

### 4.2 `GET /me`

The signed-in admin and what they may use. Use it to build the dashboard's navigation.

```json
{ "status": "success", "message": "Authenticated", "data": {
  "id": "ed39cdce-…", "email": "admin@example.com", "displayName": "Admin", "isSuperAdmin": false,
  "applications": [ { "slug": "epineon", "name": "Epineon", "formTypes": ["demo", "sales", "partnerships"] } ],
  "statuses": ["new", "in_progress", "replied", "closed", "archived"] } }
```

**Database:** one read of `platform_admin.admin_users` + `admin_app_access`; `last_seen_at` is refreshed at most every 5 minutes.

### 4.3 `GET /submissions` — list, search, filter, sort, paginate

Combined across every application the caller may access.

| Parameter | Values | Default |
|---|---|---|
| `application` | comma-separated slugs. Forbidden slug → **403** | all permitted |
| `formType` | a form type; only applications that have it are searched | any |
| `status` | one status | any |
| `unread` | `true` / `false` | any |
| `from` / `to` | ISO 8601 date or date-time; `from` inclusive, `to` exclusive | none |
| `q` | text ≤ 200. Case-insensitive **substring of any field value** (not field names), or an exact submission ID. `%` and `_` are literal. | none |
| `sort` | `receivedAt`, `updatedAt`, `status`, `formType`, `application` | `receivedAt` |
| `dir` | `asc`, `desc` | `desc` |
| `page` | 1–100000 | `1` |
| `pageSize` | 1–100 | `25` |

```bash
GET /api/v1/admin/submissions?application=qaegis,epiwell&status=new&unread=true&q=quokka&sort=receivedAt&dir=desc&page=1&pageSize=25
```

`200` → `data: { items: [Submission…], pagination }`. A caller with no applications gets an empty page. Unknown, repeated or malformed parameters → `400` with `details`.

**Database:** two read queries (count + page) over a `UNION ALL` of the **form tables** of the permitted applications (only the tables of a given `formType` when it is filtered). Each table's columns are rebuilt into the `data` object under the form's field names. Values are bound parameters; sort columns come from a whitelist.

### 4.4 `GET /submissions/:application/:formType/:id`

One submission. **Viewing does not mark it read** (use `PATCH`). `404` if the application or form is unknown, or if the ID does not exist **in that form's table**.

**Database:** one read of that form's table (e.g. `qaegis.contact_sales_submissions`).

### 4.5 `PATCH /submissions/:application/:formType/:id`

```json
{ "status": "replied", "read": true }
```

At least one of `status` (a valid status) or `read` (boolean). **No other field can be changed** — `data`, IDs, application, timestamps and the like are rejected (`unexpected_field`).

- A status change records `statusChangedAt` and `statusChangedBy`.
- `read: true` sets `isRead`, `readAt` and `readBy`; if already read, the **first reader is kept**. `read: false` clears all three.
- `updatedAt` is maintained by a database trigger.
- A request that changes nothing succeeds and writes no audit entry.

`200` → the updated Submission. **Database:** one transaction: `SELECT … FOR UPDATE`, `UPDATE` of that form's table, and one `platform_admin.audit_log` entry per real change (`submission.status_changed` with `{from,to}`, `submission.marked_read`, `submission.marked_unread`). Concurrent updates are serialized.

### 4.6 `DELETE /submissions/:application/:formType/:id`

Permanent (hard) delete of the row and its personal data. Allowed for admins of that application and Super Admins.

`200 {"status":"success","message":"Submission deleted"}`; `404` if missing (a second delete is `404`).

**Database:** one transaction: `DELETE` from that form's table and an audit entry `submission.deleted` (with `application`, `formType`, the ID, and `{ formType, status }` as details) — **no personal data** is kept in the audit log.

### 4.7 `GET /stats`

| Parameter | Values | Default |
|---|---|---|
| `application` | comma-separated slugs (forbidden → 403) | all permitted |
| `days` | 1–365 (window ends today, UTC) | `30` |

```json
{ "status": "success", "message": "Statistics retrieved", "data": {
  "days": 30,
  "applications": {
    "epineon": {
      "total": 5, "unread": 2, "receivedInPeriod": 4,
      "byStatus": { "new": 1, "in_progress": 1, "replied": 1, "closed": 1, "archived": 1 },
      "byFormType": { "demo": 3, "sales": 1, "partnerships": 1 },
      "daily": [ { "date": "2026-11-19", "count": 1 } ]
    }
  },
  "combined": {
    "total": 11, "unread": 6, "receivedInPeriod": 10,
    "byStatus": { "new": 4, "in_progress": 2, "replied": 2, "closed": 1, "archived": 2 },
    "byApplication": { "epineon": 5, "qaegis": 3, "epiwell": 3 },
    "daily": [ { "date": "2026-11-19", "count": 3 } ]
  } } }
```

`daily` has exactly one entry per day of the window (zero-filled). `applications` and `combined` only cover applications the caller may access.

**Database:** read-only aggregate queries, one per permitted application.

### 4.8 Admin management — Super Admin only

| Method | Path | Purpose |
|---|---|---|
| GET | `/users` | List admins with their applications |
| POST | `/users` | Create an admin |
| PATCH | `/users/:id` | Change name, Super Admin flag, status or applications |

**`POST /users`** body: `email` (required, normalized to lower case), `displayName` (optional, ≤ 120), `isSuperAdmin` (optional boolean), `applications` (list of slugs; required and non-empty unless `isSuperAdmin`). Returns `201` with the admin. `409` if the email exists (case-insensitive).

**`PATCH /users/:id`** body — at least one of `displayName` (string or `null`), `isSuperAdmin`, `status` (`active` | `disabled`), `applications` (the **full new list**; grants and revocations take effect on the next request). `409` for self-disable / self-demote or removing the last Super Admin. Admins cannot be deleted.

```json
{ "id": "…", "email": "new@example.com", "displayName": "New Person", "isSuperAdmin": false,
  "status": "active", "applications": ["qaegis"], "createdAt": "…", "updatedAt": "…", "lastSeenAt": null }
```

**Database:** `platform_admin.admin_users` and `admin_app_access`, in one transaction with an audit entry (`admin_user.created`, `admin_user.updated`).

### 4.9 `GET /audit` — Super Admin only

| Parameter | Values | Default |
|---|---|---|
| `application` | a slug | any |
| `action` | e.g. `submission.deleted` | any |
| `page`, `pageSize` | as above (pageSize default 50) | |

Newest first. Items: `id, at, actorId, actorEmail, action, application, formType, submissionId, targetUserId, details`. Actions: `submission.status_changed`, `submission.marked_read`, `submission.marked_unread`, `submission.deleted`, `admin_user.created`, `admin_user.updated`, `admin_user.bootstrapped`. The table is **append-only**: the database rejects `UPDATE`, `DELETE` and `TRUNCATE`.

---

## 5. Database structure

Neon PostgreSQL. **No application's data shares a table or a schema with another's, and no two forms share a table.** All connections use TLS with certificate and hostname verification (`sslmode=verify-full`).

| Schema | Tables | Purpose |
|---|---|---|
| `epineon` | `demo_submissions`, `sales_submissions`, `partnerships_submissions` | Epineon forms, one table each |
| `qaegis` | `contact_sales_submissions` | QAegis "Contact Sales / Enterprise Access" |
| `epiwell` | `waitlist_submissions` | Epi Well waitlist |
| `platform_admin` | `admin_users`, `admin_app_access`, `audit_log`, `rate_limit_counters` | Administrators, per-application access, audit trail, rate-limit counters |
| `public` | `schema_migrations` | Applied migrations with checksums |

The old shared tables (`epineon.form_submissions`, `qaegis.form_submissions`, `epiwell.form_submissions`) still exist, **frozen** (a trigger rejects inserts) and untouched, as a record of the previous design. They are not read or written by the application.

### Columns of every submission table

Each table has the form's own fields (one column per field, `snake_case`) plus:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | server-generated (returned as `submissionId`) |
| `status` | text | `new` (default) `in_progress` `replied` `closed` `archived` — `CHECK` |
| `is_read` | boolean | default `false` |
| `read_at`, `read_by` | timestamptz, uuid | who read it first; `CHECK` that `is_read`, `read_at` and `read_by` agree |
| `status_changed_at`, `status_changed_by` | timestamptz, uuid | last status change |
| `created_at` | timestamptz | server time of receipt (returned as `receivedAt`) |
| `updated_at` | timestamptz | maintained by a trigger |

There is no `application`, `form_type` or `data` column: **the table itself identifies the website and the form**, so a row can never be mistaken for another form's. Indexes on every table: `(created_at DESC)`, `(status, created_at DESC)`, and a partial index on unread rows.

### Form-specific columns and constraints

Limits and option lists mirror the live websites and are enforced by the database as well as by the API (a test keeps the SQL and the form definitions in sync).

| Table | Columns (`?` = optional, NULL when left blank) |
|---|---|
| `epineon.demo_submissions` | `name` ≤120, `email` (lower-case), `company` ≤160, `role`? ≤120, `product` (8 options), `message`? ≤5000 |
| `epineon.sales_submissions` | as demo, plus `use_case` (5 options); `message` required |
| `epineon.partnerships_submissions` | `name`, `email`, `organization` ≤160, `nature` ≤5000 |
| `qaegis.contact_sales_submissions` | `first_name`, `last_name` ≤120, `work_email`, `company_website`? ≤500, `user_range` (`1-50` `51-250` `251-1000` `1000+`), `message` ≤10000 |
| `epiwell.waitlist_submissions` | `email` (lower-case, **unique**, case-insensitively) |

### `platform_admin`

- **`admin_users`** — `id`, `email` (unique, lower-case), `display_name`, `is_super_admin`, `status` (`active`|`disabled`), `created_by`, `created_at`, `updated_at`, `last_seen_at`.
- **`admin_app_access`** — `(user_id, application)` primary key, `granted_by`, `granted_at`. Cascades when a user is removed.
- **`audit_log`** — `id`, `at`, `actor_id`, `action`, `application`, `form_type`, `submission_id`, `target_user_id`, `details` (jsonb). Never contains submission contents. Append-only by trigger.
- **`rate_limit_counters`** — hashed client keys only; no personal data.

### Migrations

`npm run db:migrate` (in `backend/`) applies, in order: platform migrations, then each application's. Files are `NNN_name.sql`, forward-only, one transaction each, recorded with a SHA-256 checksum. **Never edit an applied migration** — the runner refuses and you add a new numbered file instead.

| Migration | What it does |
|---|---|
| `001` (each application) | the original shared `form_submissions` table |
| `002` (each application, platform) | workflow columns; `platform_admin` |
| `platform/003` | fix of an audit constraint |
| `003` (each application) | **the per-form tables**: creates them, copies any rows from the old shared table (same IDs and timestamps), verifies that nothing was lost (aborting and rolling back otherwise), then freezes the old table |
| `epiwell/003` | additionally renames the schema `epi_well` → `epiwell` (metadata only) |
| `platform/004` | moves `rate_limit_counters` into `platform_admin`; adds `audit_log.form_type`; re-points access rows from the old Epi Well slug |

All of these are additive: **no table, column or row is dropped or rewritten.** A rehearsal test (`backend/tests/migration-rehearsal.test.js`) rebuilds the old structure with realistic data, migrates it, and proves the copy is exact, the old tables are untouched, and a bad row aborts everything.

Epi Well's migration history stays recorded under its original key `epi-well` (the application's `migrationKey`), so renaming its URL slug never re-runs old migrations.

---

## 6. How each website uses the API

The websites call the API from the browser (or their server) with `fetch`. **Nothing is connected yet**; this is the contract for when each site is switched over.

### Epineon

```js
await fetch(`${API}/api/v1/epineon/forms/sales`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name, email, company, role, product, useCase, message,
    companyWebsite: honeypotValue,        // hidden input, must stay empty
    formStartedAt,                        // Date.now() when the form first rendered
  }),
});
```

**Differences from the live Epineon site:** `role`, `product`, `useCase` and `nature` are sent as **separate fields** (the live site folds them into `message`); the form ids are `demo`, `sales`, `partnerships` in the URL (not `formId` in the body); `subject` and `sourcePath` are not sent; the response is the envelope in 3.2.

### QAegis

```js
await fetch(`${API}/api/v1/qaegis/forms/contact-sales`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ firstName, lastName, workEmail, companyWebsite, userRange, message }),
});
```

**Differences from the live QAegis site:** no `/api/csrf` token round-trip is needed (cross-site abuse is blocked by the enforced origin rules and rate limits); success is the `201` envelope rather than `{ "ok": true }`; validation errors use `details[]` (`field`, `code`, `message`) rather than a single `field`; the `Retry-After` header on 429 is unchanged. The site's Resend email notification is **not** reproduced by this backend.

### Epi Well

```js
const res = await fetch(`${API}/api/v1/epiwell/forms/waitlist`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, website: honeypotValue, formStartedAt }),
});
if (res.status === 409) showMessage('This email is already on the waitlist.');
```

**Differences from the live Epi Well site:** submissions go to this API (the live site writes straight to Supabase from the browser); duplicates are `409` (the live site maps Postgres `23505` to the same message); disposable domains are refused with `400 blocked_domain`.

### Handling responses (all sites)

| Status | Meaning for the UI |
|---|---|
| `201` | Show the success state. |
| `400` | Show `details[].field` errors; the generic spam/expired message is shown as is. |
| `403` | Origin not allowed — a configuration problem, not user-fixable. |
| `409` | Epi Well only: already on the waitlist. |
| `429` | Wait `Retry-After` seconds. |
| `5xx` | Show a "try again later" message. |

### Unified admin dashboard

One dashboard origin, one Cloudflare Access login. After sign-in it calls `GET /me`, shows only the returned applications, and uses `/submissions`, `/stats`, `PATCH`/`DELETE` for the work. Super Admins additionally get `/users` and `/audit`. Every permission is enforced by this API; hiding buttons in the UI is a convenience only.

---

## 7. Error reference

| Status | When | Body `message` |
|---|---|---|
| 400 | Validation failed; spam or expired form; malformed JSON; invalid query parameters | `Validation failed` / `Invalid query parameters` / generic spam text / `Malformed JSON in request body` |
| 401 | Admin: missing or invalid Access token | `Authentication required` / `Invalid or expired credentials` |
| 403 | Origin not allowed; HTTPS required; request bypassed Cloudflare; not an admin; application not permitted; Super Admin required | `Origin not allowed` / `HTTPS is required` / `Forbidden` / `Not authorized` / `You do not have access to this application` / `Super Admin access required` |
| 404 | Unknown route, application, form type, submission or admin user | `Route not found: …` / `Submission not found` … |
| 405 | Wrong method (with `Allow` header) | `Method not allowed` |
| 409 | Duplicate waitlist email; duplicate admin email; lock-out protection | specific message |
| 413 | Body over 100 kB | `Request body is too large` |
| 415 | Not JSON, compressed body, unsupported charset | `Content-Type must be application/json` … |
| 429 | Rate limit exceeded (`Retry-After`) | `Too many requests. Please try again later.` |
| 500 | Unexpected error (details only in server logs) | `Internal Server Error` |
| 503 | Rate-limit store down (fails closed); admin auth not configured; database not configured | `Service temporarily unavailable` / `Admin authentication is not configured` |
