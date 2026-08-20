# Easy-Med Local — Backend Design

Date: 2026-08-01
Status: agreed with user (backend stack, LAN model, single-clinic scope, no landing, IP-only access)

## Context

This project is a standalone, fully local clinic management system (HIS). It
started from a copy of the easymed.uz frontend, but all server/Supabase
artifacts have been removed and the production keys are gone. The frontend
still calls the (now disconnected) Supabase client throughout `js/`. This spec
defines the backend that replaces it.

## Goal

A clinic runs Easy-Med entirely on its own computers with **no internet at
any point** — install, daily use, and backups all work offline.

## Decisions already made (with user)

1. **Stack:** Node.js + Express + better-sqlite3 (SQLite database).
2. **Deployment:** one "server PC" in the clinic; other PCs (reception,
   doctors, cashier, lab) use the app through a browser over LAN/Wi-Fi.
3. **Scope:** single clinic. All multi-tenant SaaS machinery is dropped.
4. **No landing page:** the app opens directly on the login screen.
5. **No domains or subdomains — IP only.** The app is reached at
   `http://localhost:8000` on the server PC and `http://<server-ip>:8000`
   from other PCs. The app must never care what hostname is used.

## Non-goals (explicitly removed concepts)

- No Supabase, no cloud services, no CDN assets, no telemetry.
- No landing/marketing page, no pricing/tariffs, no clinic sign-up flow.
- No platform super-admin console (`setting.html` and `js/setting/`).
- No subscriptions, upgrade prompts, Telegram integration.
- No domain/subdomain/workspace-slug logic anywhere (gateway subdomain
  detection, workspace lookup, `*.easymed.uz` addresses).
- No multi-company tenancy (`company_id`, JWT hooks, RLS equivalents).

## Architecture

```
Clinic LAN (no internet needed)
┌─────────────────────────────────────────────┐
│  Server PC (Windows)                        │
│  ┌───────────────────────────────────────┐  │
│  │ Node.js app (single process)          │  │
│  │  • serves frontend (HTML/CSS/JS)      │  │
│  │  • REST API under /api/...            │  │
│  │  • session auth (cookies)             │  │
│  │  • SQLite file: data/easymed.db       │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
        ▲ http://<server-ip>:8000
        │
  Reception PC · Doctor PCs · Cashier PC · Lab PC (browser only)
```

One process, one port, one database file. Frontend and API share the same
origin, so there is no CORS configuration and no absolute URLs in the client —
all requests are relative (`/api/...`).

## Repository layout (target)

```
easymed.uz/
  server/
    index.js            — entry point: static serving + API + startup migrate
    routes/             — one file per module (auth, patients, visits, ...)
    db/
      connection.js     — better-sqlite3 setup (WAL, foreign_keys ON)
      migrate.js        — runs numbered migrations at startup
      migrations/       — 001_init.sql, 002_..., append-only
    middleware/         — session auth, role guard, error handler
    services/           — business logic (invoicing, stock, shifts)
  public/  (today's frontend: admin.html, css/, js/, vendored assets)
  data/                 — easymed.db (gitignored)
  backups/              — daily DB copies (gitignored)
  scripts/              — start/installation helpers
```

(Exact split of `public/` vs current root layout is decided in the
implementation plan; the principle is: server code and served files are
clearly separated, data and backups are outside version control.)

## Database

- SQLite via better-sqlite3, WAL mode (many readers + one writer fits a
  clinic), `foreign_keys = ON`, all timestamps UTC ISO-8601.
- Schema is a **fresh simplified rebuild**, not a port of the old Postgres
  schema: users/roles, branches, patients, services (catalog + categories),
  appointments, visits + visit services, invoices/payments/deposits, labs,
  inpatient (wards/beds/admissions), inventory (products/stock/movements),
  cash shifts, audit log. No `company_id` anywhere.
- Numbered `.sql` migrations applied automatically at server startup inside a
  transaction; applied names recorded in a `schema_migrations` table. Updating
  the app never requires manual database steps.
- Money and stock operations run in transactions (better-sqlite3
  `db.transaction()`), so a crash or power cut cannot leave half-finished
  invoices, payments, or stock movements.

## Authentication and permissions

- Local accounts: username + bcrypt password hash in the `users` table.
- Login creates a server-side session; browser holds an HttpOnly session
  cookie. Sessions stored in SQLite so a server restart does not log
  everyone out.
- Roles (admin, registrar, doctor, cashier, lab, nurse, inventory, ...) are
  enforced **server-side** by route-level guards — the API refuses requests
  the role does not permit, regardless of what the UI shows.
- First-run bootstrap: if the database has no users, the server prints a
  one-time generated admin password to the console (never a fixed default).

## Frontend conversion

- `js/supabase.js` is replaced by `js/api.js`: a small fetch wrapper with
  relative URLs, JSON handling, and a single 401-redirect-to-login behavior.
  `js/config.js` disappears (nothing to configure).
- Conversion is **module by module** — each session converts one screen/module
  from Supabase calls to `/api` calls, so the app becomes usable
  progressively. Order follows the phases below.
- Deleted from the frontend (Phase 1): `index.html`, `js/landing.js`,
  `oferta.html`, `setting.html`, `js/setting/`, `js/clinic-signup.js`,
  subdomain/workspace logic in `js/admin/gateway.js` and
  `js/admin/clinic-context.js`, upgrade/tariff UI, support/telegram widgets.
- Root URL `/` serves the login page; after sign-in, the dashboard.

## Offline completeness

Every external asset is vendored into the project: Google Fonts are replaced
by locally stored font files, any CDN-loaded script (the esm.sh Supabase
import disappears with the rewrite; `js/vendor/` already holds xlsx and
fflate) must exist locally. Acceptance check: the app fully works with the
network cable unplugged and Wi-Fi off (except LAN).

## Error handling

- API errors return a consistent JSON shape `{ error: { code, message } }`
  with proper HTTP status; the client shows human-readable toasts (reusing
  the app's existing notification UI).
- Server-side validation on every write (the UI is not trusted).
- Unhandled server errors are logged to a local rotating log file and return
  a generic 500 — the process is supervised so it restarts on crash.

## Testing

- `node:test` unit tests for business logic in `server/services/`
  (invoicing math, stock movements, shift closing).
- Lightweight API smoke tests (login → create patient → create visit →
  invoice → pay) runnable with one command against a temporary DB file.

## Backups and operations (Windows)

- Automatic daily backup: copy `data/easymed.db` (via SQLite backup API) into
  `backups/easymed-YYYY-MM-DD.db`, keep a bounded number; restoring = putting
  a file back. Manual "Backup now" button in admin settings later.
- Server PC gets a **static LAN IP**; a firewall rule allows inbound port 8000.
- Autostart via Windows Task Scheduler (or NSSM service) — documented in a
  one-page `SETUP.md` update written in plain language.

## Phases

1. **Foundation** — server skeleton (static + `/api/health`), DB with
   migrations, login/logout/session, user management screen, SaaS/landing
   deletions listed above.
2. **Core flow** — patients → services catalog → appointments/visits →
   invoices & payments.
3. **Departments** — labs, inpatient, cash shifts, inventory/procurement.
4. **Polish** — reports, backups UI, autostart packaging, LAN setup guide,
   full offline acceptance pass.

## Success criteria

- With internet disconnected: a receptionist on another PC can log in via the
  server's IP, register a patient, create a visit, and take a payment; the
  cashier and doctor see the same data live from their own PCs.
- The word "supabase" and any domain name appear nowhere in the running code.
- The entire clinic dataset is one file that a non-technical person can back
  up by copying.
