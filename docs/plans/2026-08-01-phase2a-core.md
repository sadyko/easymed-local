# Easy-Med Local — Phase 2a-core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the local Supabase-compatible data layer — a client that speaks the app's existing query language, a server endpoint that runs those queries against SQLite **only within a strict allow-list**, an RPC dispatcher, and an auth bridge to Phase 1 sessions. All unit-tested without a browser. This is the foundation the parked admin app will run on (wired up in the next slice, 2a-shell).

**Architecture:** `public/js/supabase.js` becomes a local client. Its `.from()` builds a **query descriptor** (plain JSON) POSTed to `POST /api/db`; the server compiles the descriptor to one parameterized better-sqlite3 statement, rejecting anything the allow-list registry doesn't explicitly permit. `.rpc()` → `POST /api/rpc/:name`. `.auth` → Phase 1 `/api/auth`. `.channel/.storage` → safe stubs.

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3 (all from Phase 1). No new deps.

**Design source:** `docs/specs/2026-08-01-phase2-compat-layer-design.md`. Branch: `phase2a-compat-layer`, no remote (commit only).

**Security invariant (the whole point — every task preserves it):** the browser can only touch tables/columns/operations/embeds that `server/db/schema-registry.js` explicitly declares, gated by the session role. Unknown anything → 4xx, never a silent partial or a raw SQL error. Identifiers are validated against the registry and never string-interpolated from the request; all values are bound parameters. No unfiltered UPDATE/DELETE ever compiles.

---

## The query descriptor (client ⇄ server contract)

Both sides agree on this JSON shape. The client builder emits it; the server compiles it.

```js
{
  table:   'patients',                 // required
  op:      'select'|'insert'|'update'|'delete',
  columns: '*' | 'id,full_name,branches(name)',  // PostgREST projection string (select/returning)
  filters: [ { col:'id', op:'eq', val: 5 }, { col:'status', op:'in', val:['a','b'] } ],
  order:   [ { col:'created_at', asc:false } ],
  limit:   50,
  offset:  0,
  count:   'exact'|null,               // when set, response includes total count ignoring limit
  single:  null|'single'|'maybe',      // .single() → exactly 1 (else error); .maybeSingle() → 0-or-1
  values:  {…} | [ {…}, … ],           // insert/update payload
  returning: true|false                // whether .select() was chained after a write
}
```
Filter `op` ∈ `eq,neq,in,gt,gte,lt,lte,ilike,is,contains`. (`or`,`not`,`match` are rare — see Task 3 notes; unsupported ops → 400 "unsupported filter".)

Response (HTTP 200 on success): `{ data, count }` where data is an array (or object when `single`). Validation/permission failure: HTTP 4xx `{ error:{ code, message } }`. The client wraps both into supabase-js's `{ data, error }`.

---

### Task 1: Core-flow schema migration

**Files:**
- Create: `server/db/migrations/002_core_patient_flow.sql`
- Test: `server/db/migrations/002.test.js`

Reverse-engineered from client code (see design doc). Single-clinic: no `company_id`. Keep `branch_id`.

- [ ] **Step 1: Write the failing test** — `server/db/migrations/002.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('002 creates core tables, seeds one branch, and auto-generates patient MRN', () => {
  const db = openDb(':memory:');
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['branches','patients','payers','referral_sources']) assert.ok(tables.includes(t), `missing ${t}`);

  // exactly one seeded branch
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branches').get().n, 1);

  // MRN auto-assigned on insert when not supplied
  const info = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Test Patient', 1)").run();
  const row = db.prepare('SELECT mrn FROM patients WHERE id = ?').get(info.lastInsertRowid);
  assert.match(row.mrn, /^P-\d{2}-\d{5}$/);

  // second insert gets a different MRN
  const info2 = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Two', 1)").run();
  assert.notEqual(db.prepare('SELECT mrn FROM patients WHERE id=?').get(info2.lastInsertRowid).mrn, row.mrn);
});
```

- [ ] **Step 2: Run — fail** (`npm test`): tables missing.

- [ ] **Step 3: Implement** — `server/db/migrations/002_core_patient_flow.sql`:

```sql
CREATE TABLE branches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  license_number TEXT NOT NULL DEFAULT '',
  is_24_7     INTEGER NOT NULL DEFAULT 0,
  working_hours TEXT NOT NULL DEFAULT '{}',   -- JSON
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO branches (name) VALUES ('Main Branch');

CREATE TABLE payers (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'insurance', -- insurance|corporate|government
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE referral_sources (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE patients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn           TEXT UNIQUE,
  full_name     TEXT NOT NULL,
  first_name    TEXT NOT NULL DEFAULT '',
  last_name     TEXT NOT NULL DEFAULT '',
  middle_name   TEXT NOT NULL DEFAULT '',
  date_of_birth TEXT,                        -- ISO date
  gender        TEXT NOT NULL DEFAULT 'other' CHECK (gender IN ('male','female','other')),
  blood_type    TEXT NOT NULL DEFAULT 'unknown',
  phone         TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  national_id   TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  nationality   TEXT NOT NULL DEFAULT '',
  occupation    TEXT NOT NULL DEFAULT '',
  emergency_contact_name  TEXT NOT NULL DEFAULT '',
  emergency_contact_phone TEXT NOT NULL DEFAULT '',
  allergies         TEXT NOT NULL DEFAULT '',
  chronic_conditions TEXT NOT NULL DEFAULT '',
  branch_id         INTEGER REFERENCES branches(id),
  primary_doctor_id INTEGER REFERENCES users(id),
  payer_id          INTEGER REFERENCES payers(id),
  referral_source_id INTEGER REFERENCES referral_sources(id),
  notes             TEXT NOT NULL DEFAULT '',
  photo_url         TEXT NOT NULL DEFAULT '',
  active            INTEGER NOT NULL DEFAULT 1,
  registration_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_patients_branch ON patients(branch_id);
CREATE INDEX idx_patients_phone ON patients(phone);

-- MRN autogen: P-<2-digit-year>-<5-digit-sequence>, assigned when NULL.
-- Sequence is per-year, zero-padded; collisions avoided by the UNIQUE index.
CREATE TRIGGER patients_mrn_autogen AFTER INSERT ON patients
WHEN NEW.mrn IS NULL
BEGIN
  UPDATE patients
     SET mrn = 'P-' || substr(strftime('%Y','now'),3,2) || '-' ||
               substr('00000' || (
                 SELECT COUNT(*) FROM patients
                  WHERE mrn LIKE 'P-' || substr(strftime('%Y','now'),3,2) || '-%'
               ), -5)
   WHERE id = NEW.id;
END;
```

- [ ] **Step 4: Run — pass** (`npm test`, all prior + this).
- [ ] **Step 5: Commit** — `git add server/db/migrations/002_core_patient_flow.sql server/db/migrations/002.test.js` → `git commit -m "feat: core patient-flow schema (branches, patients+MRN, payers, referral_sources)"`

**Note for reviewer:** the MRN trigger's COUNT-based sequence can race under true concurrency, but better-sqlite3 is synchronous/single-writer, so inserts serialize. The UNIQUE index is the backstop. Acceptable for a single-clinic local server.

---

### Task 2: Allow-list registry

**Files:**
- Create: `server/db/schema-registry.js`
- Test: `server/db/schema-registry.test.js`

This file IS the security policy. Deny by default.

- [ ] **Step 1: Write the failing test** — `server/db/schema-registry.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, tableEntry, canRead, canWrite, readableColumns, filterAllowed, embedEntry } from './schema-registry.js';

test('registry denies unknown tables and enforces per-role ops', () => {
  assert.equal(tableEntry('secret_table'), null);
  assert.equal(tableEntry('patients').table, 'patients');

  // roles
  assert.ok(canRead('patients', 'registrar'));
  assert.ok(canRead('patients', 'doctor'));
  assert.ok(canWrite('patients', 'insert', 'registrar'));
  assert.ok(!canWrite('patients', 'insert', 'doctor'));   // doctors don't create patients
  assert.ok(!canWrite('patients', 'delete', 'admin'));    // nobody deletes via generic endpoint
});

test('readableColumns is an explicit allow-list; filters and embeds are gated', () => {
  const cols = readableColumns('patients');
  assert.ok(cols.includes('full_name'));
  assert.ok(!cols.includes('password_hash')); // patients has none, but principle: only declared cols
  assert.ok(filterAllowed('patients', 'phone'));
  assert.ok(!filterAllowed('patients', 'notes'));   // not a declared filter column
  assert.equal(embedEntry('patients', 'branches').fk, 'branch_id');
  assert.equal(embedEntry('patients', 'nonsense'), null);
});
```

- [ ] **Step 2: Run — fail.**

- [ ] **Step 3: Implement** — `server/db/schema-registry.js`. Structure per table: `read` (roles + columns), `write` ({insert,update,delete}: roles + columns), `filters` (columns usable in WHERE), `embed` (name → {table, fk, columns}). Provide the helper functions used by the test AND by Task 3. Seed entries for `patients`, `branches`, `payers`, `referral_sources`, `users` (read-only projection: id, full_name, username, role — NEVER password_hash), `services`/`service_types`/`service_categories` (read-only for now). Example shape:

```js
const ALL_STAFF = ['admin','registrar','doctor','cashier','lab','nurse','inventory'];

export const REGISTRY = {
  patients: {
    read:   { roles: ALL_STAFF, columns: ['id','mrn','full_name','first_name','last_name','middle_name',
              'date_of_birth','gender','blood_type','phone','email','national_id','address','nationality',
              'occupation','emergency_contact_name','emergency_contact_phone','allergies','chronic_conditions',
              'branch_id','primary_doctor_id','payer_id','referral_source_id','notes','photo_url','active',
              'registration_date','created_by','created_at','updated_at'] },
    write:  {
      insert: { roles: ['admin','registrar'], columns: ['full_name','first_name','last_name','middle_name',
                'date_of_birth','gender','blood_type','phone','email','national_id','address','nationality',
                'occupation','emergency_contact_name','emergency_contact_phone','allergies','chronic_conditions',
                'branch_id','primary_doctor_id','payer_id','referral_source_id','notes','photo_url'] },
      update: { roles: ['admin','registrar'], columns: [/* same as insert */] },
      delete: { roles: [] },
    },
    filters: ['id','mrn','phone','national_id','full_name','branch_id','primary_doctor_id','active','created_at'],
    embed:   { branches: { table:'branches', fk:'branch_id', columns:['id','name'] },
               payers:   { table:'payers',   fk:'payer_id',  columns:['id','name'] } },
  },
  branches: { read:{roles:ALL_STAFF, columns:['id','name','phone','address','is_24_7','working_hours','active']},
              write:{ insert:{roles:['admin'],columns:['name','phone','address','license_number','is_24_7','working_hours']},
                      update:{roles:['admin'],columns:['name','phone','address','license_number','is_24_7','working_hours','active']},
                      delete:{roles:[]} },
              filters:['id','active'], embed:{} },
  payers:    { read:{roles:ALL_STAFF,columns:['id','name','kind','active']},
               write:{insert:{roles:['admin'],columns:['name','kind']},update:{roles:['admin'],columns:['name','kind','active']},delete:{roles:[]}},
               filters:['id','active','kind'], embed:{} },
  referral_sources: { read:{roles:ALL_STAFF,columns:['id','name','category','active']},
               write:{insert:{roles:['admin','registrar'],columns:['name','category']},update:{roles:['admin'],columns:['name','category','active']},delete:{roles:[]}},
               filters:['id','active'], embed:{} },
  users:     { read:{roles:ALL_STAFF, columns:['id','username','full_name','role','is_active']},
               write:{insert:{roles:[]},update:{roles:[]},delete:{roles:[]}}, // users are managed via /api/users only
               filters:['id','role','is_active'], embed:{} },
};

export function tableEntry(t) { return Object.prototype.hasOwnProperty.call(REGISTRY, t) ? { table: t, ...REGISTRY[t] } : null; }
export function canRead(t, role) { const e = REGISTRY[t]; return !!e && e.read.roles.includes(role); }
export function canWrite(t, op, role) { const e = REGISTRY[t]; return !!e && !!e.write[op] && e.write[op].roles.includes(role); }
export function readableColumns(t) { return REGISTRY[t] ? [...REGISTRY[t].read.columns] : []; }
export function writableColumns(t, op) { const e = REGISTRY[t]; return e && e.write[op] ? [...e.write[op].columns] : []; }
export function filterAllowed(t, col) { return !!REGISTRY[t] && REGISTRY[t].filters.includes(col); }
export function embedEntry(t, name) { const e = REGISTRY[t]; return e && e.embed[name] ? e.embed[name] : null; }
```

- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit** — `git add server/db/schema-registry.js server/db/schema-registry.test.js` → `git commit -m "feat: allow-list schema registry (deny-by-default table/column/role policy)"`

---

### Task 3: Query compiler + `/api/db` endpoint

**Files:**
- Create: `server/db/query-compiler.js` (pure: descriptor + role → {sql, params} or throws), `server/routes/db.js`
- Modify: `server/app.js` (mount `/api/db` behind requireAuth)
- Test: `server/db/query-compiler.test.js`, extend `server/app.test.js`

This is the security-critical core — most detailed task. The compiler is PURE and heavily unit-tested; the route is a thin wrapper.

- [ ] **Step 1: Write failing tests** — `server/db/query-compiler.test.js` (compiler-level, no HTTP):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, CompileError } from './query-compiler.js';

const asRegistrar = { role: 'registrar', id: 1 };

test('select expands * to declared columns and binds filters', () => {
  const { sql, params } = compile({ table:'patients', op:'select', columns:'*',
    filters:[{col:'branch_id',op:'eq',val:1}], order:[{col:'created_at',asc:false}], limit:20 }, asRegistrar);
  assert.match(sql, /^SELECT /);
  assert.doesNotMatch(sql, /\*/);            // no raw star
  assert.match(sql, /WHERE "branch_id" = \?/);
  assert.match(sql, /ORDER BY "created_at" DESC/);
  assert.match(sql, /LIMIT 20/);
  assert.deepEqual(params, [1]);
});

test('unknown table, column, filter, op, or role are rejected', () => {
  assert.throws(() => compile({table:'secrets',op:'select',columns:'*'}, asRegistrar), CompileError);
  assert.throws(() => compile({table:'patients',op:'select',columns:'ssn'}, asRegistrar), /column/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'*',filters:[{col:'notes',op:'eq',val:'x'}]}, asRegistrar), /filter/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'*',filters:[{col:'id',op:'evil',val:1}]}, asRegistrar), /operator/);
  assert.throws(() => compile({table:'patients',op:'insert',values:{full_name:'x'}}, {role:'doctor'}), /not allowed/);
});

test('insert accepts only writable columns and rejects extras', () => {
  const { sql, params } = compile({table:'patients',op:'insert',values:{full_name:'Ann',phone:'123'},returning:true}, asRegistrar);
  assert.match(sql, /INSERT INTO "patients"/);
  assert.ok(params.includes('Ann') && params.includes('123'));
  assert.throws(() => compile({table:'patients',op:'insert',values:{full_name:'Ann',is_super:true}}, asRegistrar), /column/);
});

test('update and delete REQUIRE a filter (no mass mutation)', () => {
  assert.throws(() => compile({table:'patients',op:'update',values:{phone:'9'}}, asRegistrar), /filter/);
  const ok = compile({table:'patients',op:'update',values:{phone:'9'},filters:[{col:'id',op:'eq',val:3}]}, asRegistrar);
  assert.match(ok.sql, /UPDATE "patients" SET/);
  assert.match(ok.sql, /WHERE "id" = \?/);
  assert.throws(() => compile({table:'patients',op:'delete',filters:[{col:'id',op:'eq',val:3}]}, {role:'admin'}), /not allowed/); // delete role empty
});

test('embedded select uses a declared join only', () => {
  const { sql } = compile({table:'patients',op:'select',columns:'id,full_name,branches(name)'}, asRegistrar);
  assert.match(sql, /LEFT JOIN "branches"/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'id,evil(secret)'}, asRegistrar), /embed/);
});

test('in / ilike / gte operators compile with correct SQL and params', () => {
  const r = compile({table:'patients',op:'select',columns:'id',filters:[
    {col:'id',op:'in',val:[1,2,3]}, {col:'full_name',op:'ilike',val:'%an%'}, {col:'created_at',op:'gte',val:'2026-01-01'}]}, asRegistrar);
  assert.match(r.sql, /"id" IN \(\?, ?\?, ?\?\)/);
  assert.match(r.sql, /"full_name" LIKE \? COLLATE NOCASE|"full_name" LIKE \?/i);
  assert.match(r.sql, /"created_at" >= \?/);
  assert.deepEqual(r.params, [1,2,3,'%an%','2026-01-01']);
});
```

Then extend `server/app.test.js` with an HTTP round-trip through a real logged-in session (reuse the existing `startServer`/`post` helpers; create a patient and read it back via `/api/db`):

```js
test('/api/db enforces the registry over HTTP', async () => {
  const { server, base } = await startServer();
  try {
    let res = await post(base, '/api/auth/login', { username:'boss', password:'password1' });
    const admin = res.headers.get('set-cookie').split(';')[0];

    // insert a patient via the generic endpoint (admin is allowed)
    res = await fetch(`${base}/api/db`, { method:'POST',
      headers:{ 'Content-Type':'application/json', Cookie: admin },
      body: JSON.stringify({ table:'patients', op:'insert', values:{ full_name:'Jane Roe', phone:'555' }, returning:true, single:'single' }) });
    assert.equal(res.status, 200);
    const created = (await res.json()).data;
    assert.equal(created.full_name, 'Jane Roe');
    assert.match(created.mrn, /^P-\d{2}-\d{5}$/);

    // read it back
    res = await fetch(`${base}/api/db`, { method:'POST',
      headers:{ 'Content-Type':'application/json', Cookie: admin },
      body: JSON.stringify({ table:'patients', op:'select', columns:'*', filters:[{col:'id',op:'eq',val:created.id}], single:'single' }) });
    assert.equal((await res.json()).data.phone, '555');

    // unknown table → 403, unauthenticated → 401
    res = await fetch(`${base}/api/db`, { method:'POST', headers:{ 'Content-Type':'application/json', Cookie: admin },
      body: JSON.stringify({ table:'sqlite_master', op:'select', columns:'*' }) });
    assert.equal(res.status, 403);
    res = await fetch(`${base}/api/db`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ table:'patients', op:'select', columns:'*' }) });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run — fail.**

- [ ] **Step 3: Implement** the compiler and route. Compiler rules (implement exactly):
  - `CompileError extends Error` with a `status` (400 for bad shape, 403 for permission). Throw it; the route maps `.status`.
  - Validate table via `tableEntry`; role via `canRead`/`canWrite`. Missing → CompileError 403.
  - **select:** parse `columns` — split top-level by commas; a bare name must be in `readableColumns` (else 400); `name(subcols)` is an embed — look up `embedEntry`, LEFT JOIN on `base.fk = embed.table.id`, project `embed.columns` (validated) as `embedname.col`. `*` expands to all readable base columns. Build `SELECT ... FROM "table"`. Filters: each `col` must pass `filterAllowed`; map op→SQL (`eq`→`=`, `neq`→`!=`, `gt/gte/lt/lte`→`> >= < <=`, `in`→`IN (?,…)`, `ilike`→`LIKE ? COLLATE NOCASE`, `is`→`IS ?`, `contains`→treat as LIKE %val%). Unsupported op → 400. `order` cols must be readable. `limit`/`offset` integers. Quote every identifier with double-quotes after whitelisting (defense in depth). Return `{sql, params, meta:{single, count, table}}`.
  - **insert:** `values` keys ⊆ `writableColumns(insert)` (extra → 400). Build parameterized INSERT. If `returning`, the route does a follow-up SELECT of readable columns by `last_insert_rowid()`.
  - **update:** same column check; **require ≥1 filter** (else 400 "update requires a filter"); build `UPDATE … SET … WHERE …`; also set `updated_at` if the table has it. Returning via follow-up select of affected ids.
  - **delete:** role check (registry gives nobody delete → 403 in practice); require filter.
  - The route `server/routes/db.js`: `requireAuth`; `try { const compiled = compile(req.body, req.user); … run with better-sqlite3; handle single/maybe/count } catch (e) { status = e.status||500 }`. `single:'single'` with ≠1 row → 400/404 per supabase semantics (choose 406-like 400 with code 'not_single'); `maybe` → null when 0.

- [ ] **Step 4: Mount in `server/app.js`** — `import { dbRoutes } from './routes/db.js';` and `app.use('/api/db', requireAuth, dbRoutes(db));` (import `requireAuth` from middleware). Place BEFORE the `/api` 404 catch-all.

- [ ] **Step 5: Run — pass** (compiler unit tests + HTTP test + all prior).
- [ ] **Step 6: Commit** — stage the 4 files → `git commit -m "feat: allow-list-gated query compiler and /api/db endpoint"`

---

### Task 4: RPC dispatcher

**Files:**
- Create: `server/routes/rpc.js`, `server/services/rpc/index.js` (registry, empty for now)
- Modify: `server/app.js`
- Test: extend `server/app.test.js`

- [ ] **Step 1: Failing test** — append to `server/app.test.js`:

```js
test('/api/rpc: unknown function is a clean 501, auth required', async () => {
  const { server, base } = await startServer();
  try {
    let res = await post(base, '/api/auth/login', { username:'boss', password:'password1' });
    const admin = res.headers.get('set-cookie').split(';')[0];
    res = await fetch(`${base}/api/rpc/does_not_exist`, { method:'POST',
      headers:{ 'Content-Type':'application/json', Cookie: admin }, body:'{}' });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).error.code, 'rpc_not_implemented');
    // unauth
    res = await fetch(`${base}/api/rpc/does_not_exist`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** — `server/services/rpc/index.js` exports `RPC = {}` (map name → `(db, args, user) => result`) and `getRpc(name)`. `server/routes/rpc.js`: `requireAuth`; look up `getRpc(req.params.name)`; if absent → 501 `{error:{code:'rpc_not_implemented', message:'RPC not implemented: '+name}}`; else run inside try/catch, return `{ data }`. Mount `app.use('/api/rpc', requireAuth, rpcRoutes(db));` before the `/api` 404.
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat: rpc dispatcher (empty registry; unimplemented → 501)"`

---

### Task 5: Local client query builder

**Files:**
- Create: `public/js/db-client.js` (pure, browser+node compatible — no DOM), `server/../` N/A
- Test: `public/js/db-client.test.js` (runs in node via node:test; uses a fetch stub)

The chainable builder that emits the descriptor. Testable in node by injecting a fake `fetch`.

- [ ] **Step 1: Failing test** — `public/js/db-client.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDbClient } from './db-client.js';

function fakeFetch(captured) {
  return async (url, opts) => { captured.url = url; captured.body = JSON.parse(opts.body);
    return { ok:true, status:200, json: async () => ({ data:[{id:1}], count:1 }) }; };
}

test('builds a select descriptor from the chain', async () => {
  const cap = {}; const db = makeDbClient({ fetch: fakeFetch(cap), base:'/api/db' });
  const { data, error } = await db.from('patients').select('id,full_name').eq('branch_id',2).order('created_at',{ascending:false}).limit(10);
  assert.equal(error, null);
  assert.deepEqual(data, [{id:1}]);
  assert.equal(cap.body.table, 'patients');
  assert.equal(cap.body.op, 'select');
  assert.equal(cap.body.columns, 'id,full_name');
  assert.deepEqual(cap.body.filters, [{col:'branch_id',op:'eq',val:2}]);
  assert.deepEqual(cap.body.order, [{col:'created_at',asc:false}]);
  assert.equal(cap.body.limit, 10);
});

test('single() and maybeSingle() set the mode and unwrap data', async () => {
  const cap = {}; const db = makeDbClient({ fetch: async (u,o)=>{cap.body=JSON.parse(o.body); return {ok:true,status:200,json:async()=>({data:{id:9}})};}, base:'/api/db' });
  const { data } = await db.from('patients').select('*').eq('id',9).single();
  assert.equal(cap.body.single, 'single');
  assert.deepEqual(data, {id:9});
});

test('insert/update/delete build the right op and returning flag', async () => {
  const cap = {}; const db = makeDbClient({ fetch: async (u,o)=>{cap.body=JSON.parse(o.body); return {ok:true,status:200,json:async()=>({data:[{id:1}]})};}, base:'/api/db' });
  await db.from('patients').insert({ full_name:'A' }).select();
  assert.equal(cap.body.op, 'insert'); assert.equal(cap.body.returning, true);
  await db.from('patients').update({ phone:'5' }).eq('id',1);
  assert.equal(cap.body.op, 'update'); assert.deepEqual(cap.body.values, { phone:'5' });
  await db.from('patients').delete().eq('id',1);
  assert.equal(cap.body.op, 'delete');
});

test('http error becomes { data:null, error }', async () => {
  const db = makeDbClient({ fetch: async ()=>({ ok:false, status:403, json: async ()=>({error:{code:'forbidden',message:'no'}}) }), base:'/api/db' });
  const { data, error } = await db.from('patients').select('*');
  assert.equal(data, null); assert.equal(error.message, 'no');
});
```

- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** — `public/js/db-client.js`: `makeDbClient({fetch, base})` returns `{ from(table) }`. `from` returns a builder object that is **thenable** (has `.then`) so `await` triggers the POST. Chain methods (`select,insert,update,upsert,delete,eq,neq,in_,in,gt,gte,lt,lte,ilike,is,contains,order,limit,range,single,maybeSingle`) mutate an internal descriptor and `return this`. `select()` after insert/update sets `returning=true`. On await: POST descriptor to `base`; parse; return supabase-shape `{data,error,count}`; on `single`, unwrap `data` to the object or surface the error. Keep it small; only the methods the app actually uses (from the scout counts).
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit** — `git add public/js/db-client.js public/js/db-client.test.js` → `git commit -m "feat: local Supabase-shaped query-builder client"`

---

### Task 6: Rewrite `public/js/supabase.js` as the local client (from/rpc/auth/channel/storage)

**Files:**
- Rewrite: `public/js/supabase.js`
- Create: `public/js/db-auth.js` (the `.auth` bridge, small + testable)
- Test: `public/js/db-auth.test.js`

- [ ] **Step 1: Failing test** — `public/js/db-auth.test.js` (auth bridge maps to /api/auth, node-testable with fake fetch): assert `signInWithPassword({email,password})` POSTs username+password to `/api/auth/login` and returns `{data:{session,user}, error}` shape; `getUser()` GETs `/api/auth/me`; `signOut()` POSTs `/api/auth/logout`. (Username↔email: the app passes a synthetic email; the bridge strips it back to a username — for local login the username IS what the user types; document that auth.js will be simplified in 2a-shell to pass the raw username.)

- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** `public/js/db-auth.js` (bridge) then rewrite `public/js/supabase.js` to export `supabase` = `{ from: dbClient.from, rpc, channel, auth, storage }`:
  - `from` ← `makeDbClient({ fetch: window.fetch.bind(window), base:'/api/db' })`.
  - `rpc(name,args)` → POST `/api/rpc/name`, return `{data,error}`.
  - `channel()` → stub `{ on(){return this;}, subscribe(){return this;}, unsubscribe(){} }`.
  - `auth` ← the bridge (getSession/getUser/signInWithPassword/signOut/updateUser/onAuthStateChange no-op-ish).
  - `storage` → `{ from(){ return { upload:async()=>({data:null,error:new Error('local storage not enabled yet')}), … } } }` (clear not-yet errors; wired in a later slice).
  - Keep the existing `pingSupabase`/`subscribeAuth` exports as thin shims so current importers don't break.
- [ ] **Step 4: Run — pass** (`npm test`; also `node --check public/js/supabase.js`).
- [ ] **Step 5: Commit** — `git commit -m "feat: local supabase.js (from/rpc/auth bridge, channel+storage stubs)"`

---

## After 2a-core

Run the full suite (`npm test`), then a final review of the whole slice (compiler security, registry completeness, client/server descriptor agreement). **Do NOT delete `public/js/config.js` yet** — it is imported by the old `supabase.js`; the rewrite drops that import, after which `config.js` is dead and gets removed in 2a-shell.

**2a-shell (next plan, not this one):** delete `clinic-context.js`/`tenant-tables.js`, rewrite `auth.js` to pass raw usernames to the bridge, strip the tenant-lock + SaaS notification/upgrade surfaces, register the `patients` embeds/filters the real screens need, and wire the boot so the actual admin app logs in via session and brings **Patients** live end-to-end in the browser (the human verifies). Add whatever registry entries the patient screens exercise that aren't covered yet.

## Self-review notes
- Security invariant enforced centrally in the compiler (Task 3), policy declared in one file (Task 2); every unknown identifier/op/role path has an explicit negative test.
- Descriptor contract is symmetric: client tests (Task 5) and server tests (Task 3) assert the same field names/shapes.
- No new dependencies. Everything unit-testable headlessly; browser wiring deferred to 2a-shell where the human can verify.
- Deferred: embeds beyond one level, `.or()/.match()` (rare — add when a converted screen needs them), storage, the 25 RPCs (added per-module in 2b–2d).
