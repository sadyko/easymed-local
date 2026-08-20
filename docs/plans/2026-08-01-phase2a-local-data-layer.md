# Easy-Med Local — Phase 2a (Local Data Layer + Patients) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The parked admin app boots against the local API with working login, and the Patients + Registration modules are fully usable (register, search, edit patients) — the first real clinic function running offline.

**Architecture decision (recorded):** Scouting showed ~71% of the app's 665
Supabase call sites are uniform CRUD, funneled through a small query-builder
method surface. Instead of hand-rewriting 665 sites, Phase 2a builds:
1. a **generic, permission-guarded table API** on the server
   (`/api/db/:table`) with PostgREST-style filters and embedded relations, and
2. a **local compatibility shim** replacing `public/js/supabase.js` that
   implements the query-builder subset the app actually uses and speaks to
   that API with session cookies.
Modules then convert by being *enabled and verified*, not rewritten. Money
math and stock RPCs move server-side deliberately in later sub-phases
(2b: cashier/invoices, 2c: departments). Supabase itself is fully gone —
the shim is ~350 lines of our own code, no CDN imports.

**Verified shim surface (grep counts):** eq 613, in 114, gte 37, not 19, or 17,
ilike 14, lte 12, lt 11, gt 7, neq 7, order 196, limit 126, range 1, single 59,
maybeSingle 22, select 487 (19 with `count:'exact'`, ~20 files with embedded
relations incl. aliases `users:doctor_id(full_name)` and one nested level),
insert 121, update 133, upsert 3, delete 91, rpc 36 (25 distinct fns).

**Scope of 2a:** NAV trimmed to Patients + Registration (registrar panel).
Everything else stays hidden/disabled until its sub-phase. RPCs return 501
with a clear message (none are needed by patients/registration). File
uploads (patient photo) degrade gracefully to "no photo" until 2b.

**Tech stack:** unchanged (Node 24, Express 5, better-sqlite3, vanilla ESM).

**Key scout findings used here** (file:line refs are pre-surgery):
- Boot: `public/admin.html:82-84` three script tags; `public/js/admin.js:2204-2234` boot();
  login decision at `admin.js:2218-2219` (rehydrateUserFromSession → showLogin).
- Delete-list (single-clinic): `initClinicContext` call + tenant-lock block
  `admin.js:2246-2258`, `denyWrongClinic/showWrongClinic` `admin.js:2266-2298`,
  verification gate `admin.js:2225-2228, 2236-2239`, `renderNotifications` call
  `admin.js:2231-2233`; files `public/js/admin/clinic-context.js`,
  `tenant-tables.js`, `upgrade-modal.js`, `notifications.js`,
  `verify-banner.js` (dead import), `setup-checklist.js` (dead import);
  `<script>` tags for `support-widget.js`, `onboarding.js`.
- Auth: `public/js/admin/auth.js` is 100% supabase.auth (signInWithPassword via
  fake email `usernameToEmail` :51-56, tenant-scoped :47-63); actor shape from
  `actorFromUser` :220-244; permissions read `roles` table via
  `applyActorPermissions` `admin.js:1663-1707`.
- Nav: static `NAV` array `admin.js:63-96`; route switch `admin.js:744-807`;
  static imports of all 53 views `admin.js:28-58`.
- Patients module needs NO view edits: `views/patients.js` (0 supabase calls,
  all via `admin/data.js`), `views/registration.js` (5 direct + data.js +
  storage.js photo upload), `views/registrar-panel.js` (0).

---

## Target file structure (new/changed)

```
server/
  db/migrations/002_core_clinic.sql      (new — patients/visits/services/... schema)
  services/tables.js                     (new — table permission map + introspection)
  services/dbapi.js                      (new — filter parsing, select/embed engine, writes)
  routes/db.js                           (new — /api/db/:table router)
  routes/rpc.js                          (new — /api/rpc/:fn registry, 501 default)
  dbapi.test.js                          (new — API-level tests)
public/
  js/supabase.js                         (REWRITTEN — local compat shim, no CDN)
  js/config.js                           (DELETED)
  js/admin/gateway.js                    (REWRITTEN — cookie fetch, no JWT)
  js/admin/auth.js                       (SURGERY — /api/auth instead of supabase.auth)
  js/admin/clinic-context.js             (REWRITTEN — static local stub)
  js/admin/tenant-tables.js              (DELETED)
  js/admin/notifications.js, upgrade-modal.js, verify-banner.js,
    setup-checklist.js, support-widget.js, onboarding.js   (DELETED)
  js/admin.js                            (SURGERY — boot, NAV trim, imports)
  admin.html                             (remove 2 script tags)
  js/login.js                            (redirect target → /admin)
```

---

### Task 1: Core clinic schema (migration 002)

**Files:**
- Create: `server/db/migrations/002_core_clinic.sql`
- Test: extend `server/db/migrate.test.js`

- [ ] **Step 1: failing test** — append to `server/db/migrate.test.js`:

```js
test('002 creates core clinic tables with MRN autogeneration', () => {
  const db = openDb(':memory:');
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['branches','departments','service_types','service_categories','services',
                   'patients','visits','visit_services','invoices','invoice_items','payments','patient_deposits']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  // MRN autogen trigger: insert without mrn gets P-YY-NNNNN
  db.prepare("INSERT INTO branches (name) VALUES ('Main')").run();
  const bid = db.prepare('SELECT id FROM branches').get().id;
  db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Test Patient', ?)").run(bid);
  const mrn = db.prepare('SELECT mrn FROM patients').get().mrn;
  assert.match(mrn, /^P-\d{2}-\d{5}$/);
  // status CHECK works
  assert.throws(() => db.prepare("INSERT INTO visits (patient_id, status) VALUES (1, 'bogus')").run());
});
```

- [ ] **Step 2: run, verify fails** (`npm test` — missing tables).

- [ ] **Step 3: implement** — `server/db/migrations/002_core_clinic.sql`:

```sql
-- Core clinic schema, single-clinic (no company_id anywhere).
-- Reconstructed from the legacy client's queries; statuses match the UI's
-- state machines. INTEGER PKs (SQLite rowid); FKs ON; timestamps UTC ISO.

CREATE TABLE branches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT,
  address     TEXT,
  working_hours TEXT,             -- JSON per-weekday, as legacy jsonb
  is_24_7     INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE departments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  code        TEXT,
  kind        TEXT CHECK (kind IN ('clinical','laboratory','diagnostics','procedure','inpatient','administrative')),
  branch_id   INTEGER REFERENCES branches(id),
  head_user_id INTEGER REFERENCES users(id),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE service_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  code        TEXT,
  description TEXT,
  requires_tube INTEGER NOT NULL DEFAULT 0,
  billing_mode  TEXT NOT NULL DEFAULT 'one_time' CHECK (billing_mode IN ('one_time','continuable')),
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE service_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  code        TEXT,
  parent_id   INTEGER REFERENCES service_categories(id),
  description TEXT,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE services (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  code          TEXT,
  type_id       INTEGER REFERENCES service_types(id),
  category_id   INTEGER REFERENCES service_categories(id),
  department_id INTEGER REFERENCES departments(id),
  branch_id     INTEGER REFERENCES branches(id),
  price         NUMERIC NOT NULL DEFAULT 0,
  duration_minutes INTEGER,
  requires_doctor  INTEGER NOT NULL DEFAULT 0,
  tube_color    TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE patients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn           TEXT UNIQUE,
  full_name     TEXT NOT NULL,
  first_name    TEXT, last_name TEXT, middle_name TEXT,
  date_of_birth TEXT, gender TEXT CHECK (gender IN ('male','female','other') OR gender IS NULL),
  blood_type    TEXT, marital_status TEXT,
  phone         TEXT, email TEXT, national_id TEXT, nationality TEXT,
  occupation    TEXT, address TEXT,
  emergency_contact_name TEXT, emergency_contact_phone TEXT, emergency_contact_relation TEXT,
  legal_representative TEXT,
  allergies     TEXT, chronic_conditions TEXT, behavior_note TEXT,
  branch_id     INTEGER REFERENCES branches(id),
  primary_doctor_id INTEGER REFERENCES users(id),
  referral_source_id INTEGER,
  insurance_policy_number TEXT, insurance_expiry_date TEXT,
  registration_date TEXT, notes TEXT, photo_url TEXT,
  telegram_opt_in INTEGER NOT NULL DEFAULT 0, telegram_invited_at TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- MRN: P-<YY>-<NNNNN>, server-generated (legacy migration 003 equivalent).
CREATE TRIGGER patients_mrn_autogen AFTER INSERT ON patients
WHEN NEW.mrn IS NULL
BEGIN
  UPDATE patients SET mrn = 'P-' || strftime('%y','now') || '-' ||
    substr('00000' || (abs(random()) % 100000), -5)
  WHERE id = NEW.id;
END;

CREATE TABLE visits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id    INTEGER NOT NULL REFERENCES patients(id),
  doctor_id     INTEGER REFERENCES users(id),
  branch_id     INTEGER REFERENCES branches(id),
  service_id    INTEGER REFERENCES services(id),
  visit_date    TEXT,
  duration_minutes INTEGER,
  visit_kind    TEXT CHECK (visit_kind IN ('first','repeat') OR visit_kind IS NULL),
  visit_type    TEXT CHECK (visit_type IN ('outpatient','emergency','inpatient') OR visit_type IS NULL),
  status        TEXT NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('requested','scheduled','confirmed','arrived','in_progress','completed','cancelled','no_show')),
  coverage_type TEXT, payer_id INTEGER, payer_policy_id INTEGER,
  referral_source_id INTEGER, discount_percentage NUMERIC,
  notes TEXT, cancel_reason TEXT, cancelled_by INTEGER, cancelled_at TEXT, closed_at TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_visits_patient ON visits(patient_id);
CREATE INDEX idx_visits_date ON visits(visit_date);

CREATE TABLE visit_services (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id      INTEGER NOT NULL REFERENCES visits(id),
  service_id    INTEGER REFERENCES services(id),
  consultation_type_id INTEGER,
  doctor_id     INTEGER REFERENCES users(id),
  quantity      INTEGER NOT NULL DEFAULT 1,
  unit_price    NUMERIC NOT NULL DEFAULT 0,
  total         NUMERIC NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','in_progress','completed','cancelled')),
  invoice_item_id INTEGER,
  notes TEXT, lab_notes TEXT, scheduled_at TEXT,
  sample_collected_at TEXT, verified_by INTEGER, verified_at TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_visit_services_visit ON visit_services(visit_id);

CREATE TABLE invoices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT UNIQUE,
  visit_id      INTEGER REFERENCES visits(id),
  admission_id  INTEGER,
  patient_id    INTEGER NOT NULL REFERENCES patients(id),
  branch_id     INTEGER REFERENCES branches(id),
  subtotal      NUMERIC NOT NULL DEFAULT 0,
  discount_amount NUMERIC NOT NULL DEFAULT 0,
  total_amount  NUMERIC NOT NULL DEFAULT 0,
  paid_amount   NUMERIC NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'unpaid'
                CHECK (status IN ('unpaid','partial','paid','debt','void','refunded')),
  coverage_type TEXT, payer_id INTEGER, payer_policy_id INTEGER,
  paid_at TEXT, debt_due_date TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_invoices_patient ON invoices(patient_id);

CREATE TRIGGER invoices_number_autogen AFTER INSERT ON invoices
WHEN NEW.invoice_number IS NULL
BEGIN
  UPDATE invoices SET invoice_number = 'INV-' || strftime('%y','now') || '-' ||
    substr('00000' || NEW.id, -6)
  WHERE id = NEW.id;
END;

CREATE TABLE invoice_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id),
  service_id  INTEGER REFERENCES services(id),
  item_id     INTEGER,
  description TEXT,
  quantity    INTEGER NOT NULL DEFAULT 1,
  unit_price  NUMERIC NOT NULL DEFAULT 0,
  discount_percentage NUMERIC NOT NULL DEFAULT 0,
  total       NUMERIC NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id),
  amount      NUMERIC NOT NULL,
  method      TEXT NOT NULL CHECK (method IN ('cash','card','online','insurance','transfer','deposit','gift_card','other')),
  cashier_id  INTEGER REFERENCES users(id),
  provider_id INTEGER, fee_percent NUMERIC, fee_amount NUMERIC,
  paid_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  notes       TEXT
);

CREATE TABLE patient_deposits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  INTEGER NOT NULL REFERENCES patients(id),
  branch_id   INTEGER REFERENCES branches(id),
  deposit_number TEXT,
  amount      NUMERIC NOT NULL DEFAULT 0,
  refund_amount NUMERIC NOT NULL DEFAULT 0,
  method      TEXT CHECK (method IN ('cash','card','transfer','insurance','gift_card','other') OR method IS NULL),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','received','spent','refunded','cancelled')),
  created_by  INTEGER, created_by_name TEXT,
  received_by INTEGER, received_by_name TEXT,
  received_at TEXT, closed_at TEXT, notes TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Single-clinic bootstrap: one branch so patient registration works out of the box.
INSERT INTO branches (name) SELECT 'Main branch'
WHERE NOT EXISTS (SELECT 1 FROM branches);
```

- [ ] **Step 4: run, verify passes.** Delete `data/easymed.db*` first so the dev DB picks up 002 cleanly on next start (dev data is disposable; the bootstrap admin regenerates).
- [ ] **Step 5: commit** — `git add server/db; git commit -m "feat: core clinic schema (patients, visits, billing) with MRN/invoice autogen"`

---

### Task 2: Table permission map + introspection (`server/services/tables.js`)

**Files:** Create `server/services/tables.js`; test `server/services/tables.test.js`

- [ ] **Step 1: failing test** — `server/services/tables.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { tableAccess, columnsOf, fkOf } from './tables.js';

test('tableAccess enforces the whitelist per role', () => {
  assert.equal(tableAccess('patients', 'registrar', 'read'), true);
  assert.equal(tableAccess('patients', 'registrar', 'write'), true);
  assert.equal(tableAccess('users', 'registrar', 'read'), true);   // needed for doctor pickers
  assert.equal(tableAccess('users', 'registrar', 'write'), false); // users API is the only writer
  assert.equal(tableAccess('sqlite_master', 'admin', 'read'), false);
  assert.equal(tableAccess('nonexistent', 'admin', 'read'), false);
});

test('columnsOf and fkOf introspect the schema', () => {
  const db = openDb(':memory:'); migrate(db);
  assert.ok(columnsOf(db, 'patients').includes('mrn'));
  const fks = fkOf(db, 'visits');
  assert.equal(fks.find(f => f.from === 'patient_id').table, 'patients');
});
```

- [ ] **Step 2: run, fails.**
- [ ] **Step 3: implement** — `server/services/tables.js`:

```js
// Whitelist of tables reachable through the generic /api/db API, with
// per-role access. THIS REPLACES the old system's Postgres RLS — every
// table exposed to the client MUST be listed here deliberately.
// 'read'/'write' are arrays of roles, or 'all' (any authenticated user).
// users is read-only here: writes go through the validated /api/users routes.
import { VALID_ROLES } from './roles.js';

const TABLES = {
  branches:           { read: 'all', write: ['admin'] },
  departments:        { read: 'all', write: ['admin'] },
  service_types:      { read: 'all', write: ['admin'] },
  service_categories: { read: 'all', write: ['admin'] },
  services:           { read: 'all', write: ['admin'] },
  users:              { read: 'all', write: [] },
  patients:           { read: 'all', write: ['admin', 'registrar', 'doctor', 'nurse'] },
  visits:             { read: 'all', write: ['admin', 'registrar', 'doctor', 'nurse'] },
  visit_services:     { read: 'all', write: ['admin', 'registrar', 'doctor', 'nurse', 'lab'] },
  invoices:           { read: 'all', write: ['admin', 'cashier', 'registrar'] },
  invoice_items:      { read: 'all', write: ['admin', 'cashier', 'registrar'] },
  payments:           { read: 'all', write: ['admin', 'cashier'] },
  patient_deposits:   { read: 'all', write: ['admin', 'cashier'] },
};

export function tableAccess(table, role, mode) {
  const t = TABLES[table];
  if (!t || !VALID_ROLES.includes(role)) return false;
  const rule = t[mode];
  return rule === 'all' || (Array.isArray(rule) && rule.includes(role));
}

export function knownTables() { return Object.keys(TABLES); }

// Introspection (cached per table — schema only changes at startup migrations).
const colCache = new Map();
export function columnsOf(db, table) {
  if (!colCache.has(table)) {
    colCache.set(table, db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map(c => c.name));
  }
  return colCache.get(table);
}

const fkCache = new Map();
export function fkOf(db, table) {
  if (!fkCache.has(table)) {
    fkCache.set(table, db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`).all()
      .map(f => ({ from: f.from, table: f.table, to: f.to })));
  }
  return fkCache.get(table);
}
```

Note: table names in PRAGMA come only from the internal whitelist (never user
input reaches a PRAGMA directly — routes validate against `knownTables()` first),
and `users` sits in the same DB so joins/embeds work.

- [ ] **Step 4: run, passes. Step 5: commit** — `"feat: table whitelist with per-role access and schema introspection"`

---

### Task 3: Generic DB read API (filters, order, count, embeds)

**Files:** Create `server/services/dbapi.js`, `server/routes/db.js`; modify `server/app.js` (mount); test `server/dbapi.test.js`

The query protocol (shim → server), designed to carry the PostgREST subset:

```
GET /api/db/:table?select=<cols-and-embeds>&where=<json>&order=<json>&limit=N&offset=N&count=exact
  where  = JSON array of [column, op, value] with op in
           eq|neq|in|gt|gte|lt|lte|ilike|is|not.eq|not.in|not.is
           plus ["or", <json-array-of-clauses>] for or-groups
  select = PostgREST-ish string: "*, rooms(name, floors(name)), users:doctor_id(full_name)"
Response: { data: [...], count: <int|null> }   (embeds nested as objects/null)
POST   /api/db/:table          { rows: [...] }              → { data: [...] }  (inserted, with ids)
PATCH  /api/db/:table          { patch: {...}, where: [...] } → { data: [...] } (updated rows)
DELETE /api/db/:table          { where: [...] }              → { data: [...] } (deleted rows)
POST   /api/db/:table/upsert   { rows: [...], onConflict: 'col' } → { data: [...] }
```

Rules: unknown columns in `where`/`order`/payloads → 400 (never silently
dropped — EXCEPT payload keys not in the table's columns, which are stripped,
matching how legacy code sends `company_id` etc.). `where` values are always
bound parameters, never interpolated. Embeds resolve via FK introspection:
`rel(cols)` matches the FK on this table pointing at `rel`; `alias:fk_col(cols)`
uses the named FK column; one nested level supported. Every request requires a
session; access via `tableAccess(table, role, mode)`.

- [ ] **Step 1: failing tests** — `server/dbapi.test.js` (API-level, follows `app.test.js` patterns: async `startServer()`, seeded admin, cookie login; also seed one branch/service/patient/visit for embed tests):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { hashPassword } from './services/auth.js';
import { createApp } from './app.js';

function seed(db) {
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('reg', hashPassword('password2'), 'Reg', 'registrar');
  db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Anna Ivanova', '+998901112233')").run();
  db.prepare("INSERT INTO patients (full_name, phone, active) VALUES ('Bob Karimov', '+998907654321', 0)").run();
  const doc = db.prepare('SELECT id FROM users WHERE username=?').get('boss').id;
  db.prepare('INSERT INTO visits (patient_id, doctor_id, status) VALUES (1, ?, ?)').run(doc, 'scheduled');
}

function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  seed(db);
  return new Promise((resolve) => {
    const server = createApp(db).listen(0, '127.0.0.1', () => {
      resolve({ db, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function login(base, username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}

const q = (obj) => new URLSearchParams(obj).toString();

test('db read: filters, order, limit, count, 401/403, unknown table/column', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await login(base, 'boss', 'password1');

    // unauthenticated
    assert.equal((await fetch(`${base}/api/db/patients`)).status, 401);
    // unknown table
    assert.equal((await fetch(`${base}/api/db/sqlite_master`, { headers: { Cookie: admin } })).status, 403);
    // basic select + where eq
    let res = await fetch(`${base}/api/db/patients?` + q({ where: JSON.stringify([['active','eq',1]]) }), { headers: { Cookie: admin } });
    let body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].full_name, 'Anna Ivanova');
    // ilike + order + count
    res = await fetch(`${base}/api/db/patients?` + q({
      where: JSON.stringify([['full_name','ilike','%iva%']]),
      order: JSON.stringify([['full_name','asc']]), count: 'exact',
    }), { headers: { Cookie: admin } });
    body = await res.json();
    assert.equal(body.count, 1);
    // in-list
    res = await fetch(`${base}/api/db/patients?` + q({ where: JSON.stringify([['id','in',[1,2]]]) }), { headers: { Cookie: admin } });
    assert.equal((await res.json()).data.length, 2);
    // unknown column → 400
    res = await fetch(`${base}/api/db/patients?` + q({ where: JSON.stringify([['nope','eq',1]]) }), { headers: { Cookie: admin } });
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

test('db read: embedded relations, aliased and nested', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await login(base, 'boss', 'password1');
    const res = await fetch(`${base}/api/db/visits?` + q({
      select: '*, patients(full_name, phone), users:doctor_id(full_name)',
    }), { headers: { Cookie: admin } });
    const { data } = await res.json();
    assert.equal(data[0].patients.full_name, 'Anna Ivanova');
    assert.equal(data[0].users.full_name, 'Boss');
  } finally { server.close(); }
});
```

- [ ] **Step 2: run, fails.**
- [ ] **Step 3: implement** `server/services/dbapi.js` + `server/routes/db.js` per the protocol above. Requirements the code must satisfy (reviewer checks each):
  - All values parameterized; column/table names validated against `columnsOf`/`knownTables` before entering SQL text; order direction restricted to asc/desc.
  - ops map: eq `=`, neq `!=`, in `IN (...)`, gt/gte/lt/lte, ilike → `LIKE ... COLLATE NOCASE` (translate `%`), is → `IS` (null only), `not.X` negations; `["or", [...]]` → parenthesized OR group (each inner clause validated the same way).
  - select column list: `*` or explicit validated columns; embeds resolved via `fkOf` (batch: collect FK ids from page rows, one `IN` query per relation, then stitch objects — NOT per-row queries); nested embeds recurse once.
  - Read route: session required (`requireAuth`), `tableAccess(table, req.user.role, 'read')` else 403; `Cache-Control: no-store` on all /api/db responses.
- [ ] **Step 4: mount in app.js** after users: `app.use('/api/db', dbRoutes(db));`
- [ ] **Step 5: run tests → green. Step 6: commit** — `"feat: generic whitelisted db read API with filters and embeds"`

---

### Task 4: Generic DB write API (insert/update/upsert/delete)

**Files:** modify `server/services/dbapi.js`, `server/routes/db.js`; extend `server/dbapi.test.js`

- [ ] **Step 1: failing tests** — append:

```js
test('db writes: insert/patch/delete with role enforcement and column stripping', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await login(base, 'boss', 'password1');
    const reg = await login(base, 'reg', 'password2');

    // registrar can create a patient; unknown keys (company_id) stripped
    let res = await fetch(`${base}/api/db/patients`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: reg },
      body: JSON.stringify({ rows: [{ full_name: 'New Person', phone: '+998900000000', company_id: 'junk' }] }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()).data[0];
    assert.ok(created.id);
    assert.match(created.mrn, /^P-\d{2}-\d{5}$/); // trigger ran, row returned fresh
    assert.ok(!('company_id' in created));

    // registrar cannot write payments
    res = await fetch(`${base}/api/db/payments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: reg },
      body: JSON.stringify({ rows: [{ invoice_id: 1, amount: 5, method: 'cash' }] }),
    });
    assert.equal(res.status, 403);

    // patch by filter returns updated rows
    res = await fetch(`${base}/api/db/patients`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ patch: { notes: 'VIP' }, where: [['id','eq',created.id]] }),
    });
    assert.equal((await res.json()).data[0].notes, 'VIP');

    // delete requires a where (refuse table wipes)
    res = await fetch(`${base}/api/db/patients`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ where: [] }),
    });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/api/db/patients`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ where: [['id','eq',created.id]] }),
    });
    assert.equal((await res.json()).data.length, 1);
  } finally { server.close(); }
});
```

- [ ] **Step 2: run, fails. Step 3: implement.** Requirements:
  - Writes require `tableAccess(..., 'write')`; every multi-row insert runs inside one `db.transaction`.
  - Insert: strip keys not in `columnsOf`; empty row after strip → 400; re-SELECT inserted rows by rowid so trigger-populated columns (mrn, invoice_number) come back.
  - PATCH/DELETE: `where` required and non-empty (400 otherwise); same filter engine as reads; return affected rows (SELECT before delete, after update).
  - Upsert: `onConflict` column must exist; implemented as `INSERT ... ON CONFLICT(col) DO UPDATE SET` with stripped keys.
- [ ] **Step 4: run → green. Step 5: commit** — `"feat: generic db write API with transactions and column stripping"`

---

### Task 5: RPC registry stub

**Files:** Create `server/routes/rpc.js`; modify `server/app.js`; extend `server/dbapi.test.js`

- [ ] **Step 1: failing test:**

```js
test('rpc: unimplemented functions return 501 with a clear message', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await login(base, 'boss', 'password1');
    const res = await fetch(`${base}/api/rpc/dispense_visit_item`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ args: {} }),
    });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).error.code, 'not_implemented');
  } finally { server.close(); }
});
```

- [ ] **Step 2: implement** — `server/routes/rpc.js`:

```js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

// Server-side functions ported from the legacy Postgres RPCs. Each entry:
// (db, user, args) => result. Registered per sub-phase as modules convert;
// unknown names 501 so the UI shows a clear "not available yet" instead of
// silently corrupting data.
export function rpcRoutes(db, registry = {}) {
  const r = Router();
  r.use(requireAuth);
  r.post('/:fn', (req, res) => {
    const fn = registry[req.params.fn];
    if (!fn) {
      return res.status(501).json({ error: { code: 'not_implemented',
        message: `Function ${req.params.fn} is not available in this version yet.` } });
    }
    res.json({ data: fn(db, req.user, (req.body || {}).args || {}) });
  });
  return r;
}
```

Mount: `app.use('/api/rpc', rpcRoutes(db));`
- [ ] **Step 3: run → green. Step 4: commit** — `"feat: rpc registry with explicit 501 for unported functions"`

---

### Task 6: Local compatibility shim (`public/js/supabase.js` rewrite)

**Files:** REWRITE `public/js/supabase.js`; DELETE `public/js/config.js`; test `server/shim.test.js` (node-side contract test importing the shim with a stubbed fetch)

The shim implements exactly the used subset (see header of this plan) as our
own ~350-line query builder that serializes to the Task 3/4 protocol. Exports
must match what the app imports today