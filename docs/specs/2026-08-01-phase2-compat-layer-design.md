# Easy-Med Local — Phase 2 Compatibility-Layer Design

Date: 2026-08-01
Status: strategy chosen by user (local Supabase-compatible layer + allow-list)
Builds on: `2026-08-01-local-backend-design.md` (Phase 1 foundation, now on `main`)

## Why this approach

The parked admin app has ~665 database calls across 52 files, all in one
consistent PostgREST-style shape (`supabase.from(t).select().eq().order()…`),
plus 25 `.rpc()` calls, 1 realtime channel, and Supabase Auth/Storage usage.
Hand-converting every call site is enormous and leaves the app broken for
months. Instead we keep the call-site shape and replace what it talks to.

**Nothing here depends on Supabase or the network.** `public/js/supabase.js`
becomes a local client that talks only to our Express server.

## The three shims (client side: `public/js/supabase.js` rewrite)

1. **`.from(table)` query builder** — reproduces the chainable subset the app
   actually uses (measured): `select, insert, update, upsert, delete, eq, neq,
   in, gt, gte, lt, lte, ilike, or, not, contains, match, order, limit, range,
   single, maybeSingle, count:'exact'`, and embedded selects
   (`select('*, rel(col)')`). Each chain builds a plain **query descriptor**
   object and, when awaited, POSTs it to `/api/db`. Returns supabase-js's
   `{ data, error }` shape so call sites are unchanged.
2. **`.rpc(name, args)`** — POSTs to `/api/rpc/:name`. Server implements each
   named function for real (see below). Unimplemented name → `{ data:null,
   error:{message:'RPC not implemented: name'} }` so a missing one fails loud
   but localized.
3. **`.channel()/.auth/.storage`** —
   - `.channel(...)`: no-op stub with a working `.subscribe()/.unsubscribe()`;
     realtime degrades to manual/polling refresh (only 1 call site, nav badges).
   - `.auth`: bridged to Phase 1 session cookies — `getSession`/`getUser` call
     `/api/auth/me`, `signInWithPassword` → `/api/auth/login`, `signOut` →
     `/api/auth/logout`, `updateUser` (password) → users API. Returns the
     shapes auth.js expects.
   - `.storage`: local file storage under `data/uploads/` via `/api/files`
     (deferred to a later Phase-2 slice; stub returns a clear error until then).

## The server: generic query translator + allow-list (the security boundary)

`POST /api/db` receives a query descriptor and, **only if the allow-list
permits it**, compiles it to a single parameterized better-sqlite3 statement.
This endpoint is behind `requireAuth` (Phase 1 session cookie).

**Allow-list registry** (`server/db/schema-registry.js`) — deny by default.
For every exposed table:
```
patients: {
  read:   { roles: ['admin','registrar','doctor','cashier','nurse'],
            columns: [ ...explicit list... ] },
  insert: { roles: ['admin','registrar'],       columns: [ ... ] },
  update: { roles: ['admin','registrar'],        columns: [ ... ] },
  delete: { roles: [] },                         // nobody via generic endpoint
  filters: ['id','mrn','phone','branch_id', ...],// columns allowed in WHERE
  embed:   ['branches','payers'],                // allowed relational joins
}
```
Rules enforced server-side on every request:
- Unknown table, column, filter column, embed, or operation → **403**, never a
  silent partial. The browser cannot read or write anything not declared here.
- Role gate per operation (the session's role must be listed).
- `select('*')` expands to the table's declared readable columns only —
  columns outside the list are never returned even if asked for.
- Writes: only declared-writable columns are accepted; anything else → 400.
- All values are bound parameters; identifiers (table/column) are validated
  against the registry, never interpolated from the request.

This registry **is** the local equivalent of the old RLS policies, in one
readable file, enforced in one place.

## RPCs (`server/services/rpc/`)

The 25 functions are reimplemented as Express handlers, each a real
transaction. They are business logic, not queries — money/stock integrity
lives here (dispense stock, claim/release discount, issue queue numbers…).
Ported incrementally; a module isn't "done" until the RPCs it needs exist.
Client-side money math (invoice totals, deposit balances) moves server-side
into these handlers so the browser can't post an inconsistent total.

## Boot/shell rewiring (single-clinic)

- Delete tenant/subdomain logic: `clinic-context.js` (subdomain slug, CLINIC
  globals), `tenant-tables.js`, the `TENANT_LOCK`/wrong-clinic gate in
  `admin.js`, tenant-scoped username hack in `auth.js`.
- Rewrite `auth.js` login/rehydrate against `/api/auth` (via the `.auth` shim).
- Drop SaaS surfaces already found dead or removable: `renderNotifications`
  subscription/upgrade branch, `upgrade-modal.js`, trial banners. Keep
  `clinic-flags.js` but back it with a local settings read.
- **Branches are kept** (they're intrinsic to the app — branch_id is
  everywhere); a single seeded branch is the default. Not the same as
  multi-tenant company_id, which stays deleted.

## Phasing within Phase 2

- **2a (first slice, this plan):** the compatibility layer + allow-list + auth
  bridge + shell rewiring, proven by bringing **Patients (list + view +
  register)** fully live end-to-end. Schema migrations for patients, branches,
  and the reference tables that path needs.
- **2b:** Visits / appointments / consultation workspace.
- **2c:** Invoices / cashier / payments / deposits + their RPCs (money paths,
  server-side totals).
- **2d:** Inventory / labs / inpatient + remaining RPCs; local file storage.

## Success criteria for 2a

Offline: log in through the real admin shell (not the Phase-1 stub page),
land on the dashboard, open Patients, register a patient, see them in the
list and reopen their card — all data in `data/easymed.db`, every `/api/db`
request checked against the allow-list, zero calls to any external host.
