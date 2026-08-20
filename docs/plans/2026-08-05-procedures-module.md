# Procedures Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A service marked "Procedure" routes to a nurse work queue (Процедуры) instead of the doctor, with pay-first gating, performer stamping, and consumables dispensing — per `docs/specs/2026-08-05-procedures-module-design.md`.

**Architecture:** One migration adds `services.is_procedure` + performer-stamp columns on `visit_services` and grants the `procedures` section to admin/doctor/nurse roles. The compat schema registry exposes the new columns and two `users` embeds. The parked cloud view `public/js/admin/views/procedures.js` (already imported and routed in `admin.js`, case `'procedures'`) is converted to the local query pattern used by `laboratory.js` (flat select + batched visit/patient lookup, local RPC names). A NAV entry makes it visible; the existing `isModuleAllowed()` gate hides it from roles without the section.

**Tech Stack:** Node 24 + Express 5 + better-sqlite3 (server), vanilla ES-module frontend talking to the local Supabase-compat layer (`supabase.from(...)` → `/api/db`). Tests: `node:test`.

**Facts you'd otherwise have to discover** (verified against the codebase):
- Migrations: `server/db/migrations/NNN_name.sql`, applied sorted, `.sql` only; tests live next to them as `NNN.test.js`.
- `users` columns: `username, password_hash, full_name, role` (roles: admin, registrar, doctor, cashier, lab, nurse, inventory).
- Local RPC names (server/services/rpc/index.js): `dispense_item` (args `{ product_id, quantity, visit_id }`, roles admin/doctor/nurse/inventory) and `void_dispense` (args `{ visit_service_id }`, roles admin/inventory — Task 2 adds nurse/doctor).
- The compat layer supports only single-hop embeds registered in `server/db/schema-registry.js`; embed keys are alias names (`assignee(full_name)` in a select resolves via registry key `assignee`).
- Cashier already flips `visit_services.status` → `'queued'` on payment for all linked rows (`cashier.js` ~line 1765) — procedures inherit the pay-first release with zero changes.
- The sidebar `NAV` in `public/js/admin.js` is filtered per role by `isModuleAllowed(item.id)`; NAV id must equal the permission section key (`procedures` already exists in `public/js/admin/permissions.js:32`).
- Icon `Drop` exists in `public/js/admin/icons.js`; `Tag(text, { kind })` supports kinds `info`, `warn`, `ok`.
- The spec deferred "where does the doctor cabinet exclude procedure rows" — answer: **nowhere, by design**. The local doctor cabinet (`doctor-room.js`) is visit-based; its per-visit service list is informational (shows labs the same way). The parked cloud `consultation.js` is not routed in `admin.js`, so no exclusion edit exists in this plan.

---

## File structure

```
server/db/migrations/016_procedures.sql        (new)  schema + role grants
server/db/migrations/016.test.js               (new)  migration test
server/db/schema-registry.js                   (edit) expose columns + embeds
server/db/schema-registry.procedures.test.js   (new)  registry test
server/services/rpc/inventory.js               (edit) VOID_ROLES += nurse, doctor
public/js/admin/views/services.js              (edit) Procedure checkbox + badge
public/js/admin/views/procedures.js            (edit) convert parked view to local
public/js/admin.js                             (edit) NAV entry + breadcrumb
public/js/admin/views/visit-modal.js           (edit) performer-required guard
public/js/admin/views/visit-bill.js            (edit) block unassigned procedure add
public/js/admin/views/doctor-room.js           (edit) 'procedure' chip in order modal
```

All work happens in `easymed.uz/` (the git repo). Create a feature branch first.

---

### Task 1: Migration 016 — schema + role grants

**Files:**
- Create: `server/db/migrations/016.test.js`
- Create: `server/db/migrations/016_procedures.sql`

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b feat/procedures
```

- [ ] **Step 2: Write the failing migration test**

Create `server/db/migrations/016.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('016 adds procedure columns and grants the procedures section', () => {
  const db = openDb(':memory:'); migrate(db);

  // services.is_procedure exists, defaults to 0
  const sid = db.prepare("INSERT INTO services (name, price, is_procedure) VALUES ('IV drip', 50000, 1)").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT is_procedure FROM services WHERE id=?').get(sid).is_procedure, 1);
  const plain = db.prepare("INSERT INTO services (name, price) VALUES ('Consultation', 100000)").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT is_procedure FROM services WHERE id=?').get(plain).is_procedure, 0);

  // visit_services gained notes + verified stamp columns
  const uid = db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('n1', 'x', 'Nurse One', 'nurse')").run().lastInsertRowid;
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Patient')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-08-05T09:00:00Z')").run(pid).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, ?, 1, 50000, 50000, 'queued')").run(vid, sid).lastInsertRowid;
  db.prepare("UPDATE visit_services SET status='completed', notes='deltoid, no reaction', verified_at='2026-08-05T10:00:00Z', verified_by=? WHERE id=?").run(uid, vs);
  const row = db.prepare('SELECT notes, verified_at, verified_by FROM visit_services WHERE id=?').get(vs);
  assert.equal(row.notes, 'deltoid, no reaction');
  assert.equal(row.verified_at, '2026-08-05T10:00:00Z');
  assert.equal(row.verified_by, uid);

  // role_permissions: admin/doctor/nurse gained the procedures section…
  for (const role of ['admin', 'doctor', 'nurse']) {
    const p = JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role=?').get(role).permissions);
    assert.ok(p.sections.includes('procedures'), role + ' should have procedures section');
    assert.equal(p.levels.procedures, role === 'admin' ? 'admin' : 'editor');
  }
  // …and nobody else did
  for (const role of ['registrar', 'cashier', 'lab']) {
    const p = JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role=?').get(role).permissions);
    assert.ok(!p.sections.includes('procedures'), role + ' must not have procedures');
  }
});
```

- [ ] **Step 3: Run the test — verify it fails**

Run: `node --test server/db/migrations/016.test.js`
Expected: FAIL — `SqliteError: table services has no column named is_procedure`

- [ ] **Step 4: Write the migration**

Create `server/db/migrations/016_procedures.sql`:

```sql
-- Procedures module (spec: docs/specs/2026-08-05-procedures-module-design.md).
-- A service with is_procedure=1 routes to the Procedures queue, not the doctor.
ALTER TABLE services       ADD COLUMN is_procedure INTEGER NOT NULL DEFAULT 0;

-- Performer stamp + note for procedure rows (cloud column names, so the parked
-- view maps over with minimal edits; labs may adopt them later).
ALTER TABLE visit_services ADD COLUMN notes       TEXT NOT NULL DEFAULT '';
ALTER TABLE visit_services ADD COLUMN verified_at TEXT;
ALTER TABLE visit_services ADD COLUMN verified_by INTEGER REFERENCES users(id);

-- Grant the Procedures section: admin manages, doctor/nurse perform.
-- JSON patch, not overwrite — admins may have customized permissions at runtime.
UPDATE role_permissions SET
  permissions = json_insert(
    json_set(permissions, '$.levels.procedures',
             CASE role WHEN 'admin' THEN 'admin' ELSE 'editor' END),
    '$.sections[#]', 'procedures'),
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
WHERE role IN ('admin', 'doctor', 'nurse')
  AND instr(permissions, '"procedures"') = 0;
```

- [ ] **Step 5: Run the test — verify it passes**

Run: `node --test server/db/migrations/016.test.js`
Expected: PASS (1 test, 0 failures)

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all tests pass, 0 failures (migration must not break 001–015 tests)

- [ ] **Step 7: Commit**

```bash
git add server/db/migrations/016_procedures.sql server/db/migrations/016.test.js
git commit -m "feat: procedures schema — is_procedure flag, performer stamp, role grants"
```

---

### Task 2: Compat registry + nurse void permission

**Files:**
- Create: `server/db/schema-registry.procedures.test.js`
- Modify: `server/db/schema-registry.js` (services entry ~line 38, visit_services entry ~line 49, visits entry ~line 26)
- Modify: `server/services/rpc/inventory.js:16`

- [ ] **Step 1: Write the failing registry test**

Create `server/db/schema-registry.procedures.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, canWrite, embedEntry, readableColumns } from './schema-registry.js';

test('procedures registry: new columns exposed', () => {
  assert.ok(readableColumns('services').includes('is_procedure'));
  assert.ok(REGISTRY.services.write.insert.columns.includes('is_procedure'));
  assert.ok(REGISTRY.services.write.update.columns.includes('is_procedure'));
  const vs = REGISTRY.visit_services;
  for (const c of ['notes', 'verified_at', 'verified_by']) {
    assert.ok(vs.read.columns.includes(c), 'read ' + c);
    assert.ok(vs.write.update.columns.includes(c), 'update ' + c);
  }
});

test('procedures registry: nurse can update visit_services (perform)', () => {
  assert.ok(canWrite('visit_services', 'update', 'nurse'));
});

test('procedures registry: performer embeds resolve to users', () => {
  assert.equal(embedEntry('visit_services', 'assignee').table, 'users');
  assert.equal(embedEntry('visit_services', 'assignee').fk, 'doctor_id');
  assert.equal(embedEntry('visit_services', 'performer').table, 'users');
  assert.equal(embedEntry('visit_services', 'performer').fk, 'verified_by');
  assert.ok(embedEntry('visit_services', 'services').columns.includes('is_procedure'));
  assert.ok(embedEntry('visits', 'patients').columns.includes('date_of_birth'));
  assert.ok(embedEntry('visits', 'patients').columns.includes('gender'));
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `node --test server/db/schema-registry.procedures.test.js`
Expected: FAIL — `is_procedure` not in readable columns

- [ ] **Step 3: Edit `server/db/schema-registry.js`**

In the **services** entry, add `'is_procedure'` after `'is_lab'` in all three column lists (read, write.insert, write.update). Each list currently reads:

```
'is_lab','specimen','result_unit','ref_low','ref_high','ref_text'
```

becomes:

```
'is_lab','is_procedure','specimen','result_unit','ref_low','ref_high','ref_text'
```

In the **visit_services** entry, replace the read/update/embed parts:

```js
    read:  { roles: ALL_STAFF, columns: ['id','visit_id','service_id','clinic_item_id','doctor_id','quantity','unit_price','total','status','invoice_item_id','created_by','created_at'] },
```
becomes
```js
    read:  { roles: ALL_STAFF, columns: ['id','visit_id','service_id','clinic_item_id','doctor_id','quantity','unit_price','total','status','invoice_item_id','notes','verified_at','verified_by','created_by','created_at'] },
```

```js
             update: { roles: ['admin','registrar','doctor','lab'], columns: ['status','doctor_id'] },
```
becomes
```js
             update: { roles: ['admin','registrar','doctor','lab','nurse'], columns: ['status','doctor_id','notes','verified_at','verified_by'] },
```

```js
    embed:   { services: { table:'services', fk:'service_id', columns:['id','name','price','is_lab','result_unit','ref_low','ref_high','ref_text','specimen'] },
               products: { table:'products', fk:'clinic_item_id', columns:['id','name','unit'] } },
```
becomes
```js
    embed:   { services: { table:'services', fk:'service_id', columns:['id','name','price','is_lab','is_procedure','result_unit','ref_low','ref_high','ref_text','specimen'] },
               products: { table:'products', fk:'clinic_item_id', columns:['id','name','unit'] },
               assignee: { table:'users', fk:'doctor_id',   columns:['id','full_name'] },
               performer:{ table:'users', fk:'verified_by', columns:['id','full_name'] } },
```

In the **visits** entry's embed, extend the patients columns:

```js
    embed:   { patients: { table:'patients', fk:'patient_id', columns:['id','mrn','full_name','first_name','last_name','middle_name','phone'] },
```
becomes
```js
    embed:   { patients: { table:'patients', fk:'patient_id', columns:['id','mrn','full_name','first_name','last_name','middle_name','phone','date_of_birth','gender'] },
```

- [ ] **Step 4: Let nurses/doctors void a dispensed consumable**

In `server/services/rpc/inventory.js` line 16:

```js
const VOID_ROLES = ['admin', 'inventory'];
```
becomes
```js
const VOID_ROLES = ['admin', 'inventory', 'doctor', 'nurse'];   // PROC_LOCAL_V1 — performers undo their own dispensing in the procedure modal
```

(Voids stay fully ledgered in `stock_movements`, so this widens who can undo, not auditability.)

- [ ] **Step 5: Run the test — verify it passes, then the whole suite**

Run: `node --test server/db/schema-registry.procedures.test.js` → PASS (3 tests)
Run: `npm test` → all pass, 0 failures

- [ ] **Step 6: Commit**

```bash
git add server/db/schema-registry.js server/db/schema-registry.procedures.test.js server/services/rpc/inventory.js
git commit -m "feat: expose procedure columns and performer embeds through the compat registry"
```

---

### Task 3: Services settings — Procedure checkbox + badge

**Files:**
- Modify: `public/js/admin/views/services.js` (list row ~line 133, form inputs ~line 159, save payload ~line 200, form body ~line 244)

No JS test harness exists for the frontend; verification is manual (Step 5).

- [ ] **Step 1: Add the badge in the services list** (line ~133)

```js
h('td', { class: 'cell-strong' }, s.name || '—', s.is_lab ? h('span', { style: { marginLeft: '8px' } }, Tag('Lab', { kind: 'info' })) : null),
```
becomes
```js
h('td', { class: 'cell-strong' }, s.name || '—',
    s.is_lab ? h('span', { style: { marginLeft: '8px' } }, Tag('Lab', { kind: 'info' })) : null,
    s.is_procedure ? h('span', { style: { marginLeft: '8px' } }, Tag('Procedure', { kind: 'warn' })) : null),
```

- [ ] **Step 2: Add the checkbox input + mutual exclusivity** (after the `isLabChk` declaration at line ~159)

```js
    const isLabChk  = h('input', { type: 'checkbox', checked: svc ? !!svc.is_lab : false });
```
becomes
```js
    const isLabChk  = h('input', { type: 'checkbox', checked: svc ? !!svc.is_lab : false });
    // PROC_LOCAL_V1 — a service is either a lab test or a procedure, never both.
    const isProcChk = h('input', { type: 'checkbox', checked: svc ? !!svc.is_procedure : false });
    isProcChk.addEventListener('change', () => { if (isProcChk.checked) { isLabChk.checked = false; isLabChk.dispatchEvent(new Event('change')); } });
```

And inside the **existing** `isLabChk` change listener (line ~177), add one line so checking Lab unchecks Procedure:

```js
    isLabChk.addEventListener('change', () => {
        labFieldsEl.style.display = isLabChk.checked ? 'flex' : 'none';
```
becomes
```js
    isLabChk.addEventListener('change', () => {
        if (isLabChk.checked) isProcChk.checked = false;
        labFieldsEl.style.display = isLabChk.checked ? 'flex' : 'none';
```

- [ ] **Step 3: Save the flag** (payload at line ~200)

```js
                is_lab:           isLabChk.checked ? 1 : 0,
```
becomes
```js
                is_lab:           isLabChk.checked ? 1 : 0,
                is_procedure:     isProcChk.checked ? 1 : 0,
```

- [ ] **Step 4: Render the form row** (line ~244)

```js
            checkField('Is lab test', isLabChk),
```
becomes
```js
            checkField('Is lab test', isLabChk),
            checkField('Is procedure (nurse queue)', isProcChk),
```

- [ ] **Step 5: Manual verification**

Run: `npm start`, open `http://localhost:8000`, log in as admin → Settings → Services.
Expected: create a service "IV drip", tick "Is procedure" — saving succeeds, the list shows a **Procedure** badge; ticking "Is lab test" in edit unchecks "Is procedure" and vice-versa.

- [ ] **Step 6: Commit**

```bash
git add public/js/admin/views/services.js
git commit -m "feat: mark services as procedures in Settings (checkbox + badge)"
```

---

### Task 4: Convert the Procedures worklist to the local backend

**Files:**
- Modify: `public/js/admin/views/procedures.js` (header lines 1–5, import line 8, `load()` lines 34–70, void call line ~165, dispense call line ~178, `loadProcItems` lines ~234–245, empty-state line ~103)

The rest of the file (paint, rowEl, the «Выполнить процедуру» modal, styles, `complete()`) already works against the compat layer — leave it untouched.

- [ ] **Step 1: Rewrite the header comment** (lines 1–5)

```js
// Procedures — nurse work queue for procedure-type services (injections, IV, manipulations).
// SERVICE_ROUTING_V2: a service whose department.kind = 'procedure' lands HERE, not the
// doctor cabinet (consultation.js). Per-department-team — a nurse sees procedures for THEIR
// department (users.department_id); admin/owner and unassigned nurses see all. Branch
// isolation is enforced by RLS on visit_services (via the parent visit's branch).
```
becomes
```js
// Procedures — nurse work queue for procedure-type services (injections, IV, manipulations).
// PROC_LOCAL_V1: a service with services.is_procedure=1 lands HERE, not the doctor cabinet.
// Scope: assigned-performer — a nurse/doctor sees procedures assigned to them
// (visit_services.doctor_id); admins see all assigned rows. Unassigned rows are hidden,
// so every insert path must set a performer (see insertVisitServiceRow guard).
```

- [ ] **Step 2: Drop the unused import** (line 8)

```js
import { hasRestriction, scopedProviderId } from '../permissions.js';
```
becomes
```js
import { scopedProviderId } from '../permissions.js';
```

- [ ] **Step 3: Replace `load()`** (lines 34–70, the whole function) with:

```js
async function load() {
    // PROC_LOCAL_V1 — local backend: flat select + batched patient lookup
    // (the compat layer has no 2-hop embeds; mirrors laboratory.js).
    const { data, error } = await supabase.from('visit_services')
        .select('id, status, notes, created_at, visit_id, service_id, doctor_id, quantity, verified_at, verified_by, services(name,is_procedure), assignee(full_name), performer(full_name)')
        .in('status', ['added', 'queued', 'in_progress', 'completed'])
        .order('id', { ascending: false })
        .limit(300);
    if (error) {
        console.warn('[procedures]', error.message);
        toast('Не удалось загрузить процедуры: ' + error.message, 'fail');
        state.rows = []; return;
    }
    const rows = (data || [])
        .filter(r => r.services && Number(r.services.is_procedure) === 1)
        .filter(r => r.doctor_id != null && (state.showAll || r.doctor_id === state.providerId));

    // Batch patient/visit info — keyed by visit_id, like laboratory.js.
    const visitIds = [...new Set(rows.map(r => r.visit_id).filter(Boolean))];
    const visitMap = {};
    if (visitIds.length) {
        const { data: vs, error: ve } = await supabase.from('visits')
            .select('id, visit_date, patient_id, patients(full_name,last_name,first_name,mrn,phone,date_of_birth,gender)')
            .in('id', visitIds);
        if (ve) toast('Не удалось загрузить пациентов: ' + ve.message, 'fail');
        for (const v of (vs || [])) visitMap[v.id] = v;
    }

    state.rows = rows.map(r => {
        const v = visitMap[r.visit_id] || {};
        const p = v.patients || {};
        return {
            id: r.id, status: r.status, notes: r.notes || '',
            service: r.services?.name || '—',
            patient: [p.last_name, p.first_name].filter(Boolean).join(' ').trim() || p.full_name || '—',
            phone: p.phone || '', doctor: r.assignee?.full_name || '',
            when: v.visit_date || r.created_at,
            doneAt: r.verified_at || null, doneBy: r.performer?.full_name || '',
            visit_id: r.visit_id || null, patient_id: v.patient_id || null,
            mrn: p.mrn || '', dob: p.date_of_birth || null, sex: p.gender || null,
            doctor_id: r.doctor_id || null,
        };
    });
}
```

- [ ] **Step 4: Fix the empty-state text** (line ~103)

```js
                q ? 'Ничего не найдено' : state.showAll ? 'Нет процедур в этой категории' : 'Нет процедур для вашего отдела'));
```
becomes
```js
                q ? 'Ничего не найдено' : state.showAll ? 'Нет процедур в этой категории' : 'Нет назначенных вам процедур'));
```

- [ ] **Step 5: Switch the void call to the local RPC** (line ~165)

```js
                            try { const { error } = await supabase.rpc('void_dispensed_visit_item', { p_line: it.id }); if (error) throw error; toast('Товар возвращён на склад.'); await refreshItems(); }
```
becomes
```js
                            try { const { error } = await supabase.rpc('void_dispense', { visit_service_id: it.id }); if (error) throw error; toast('Товар возвращён на склад.'); await refreshItems(); }
```

- [ ] **Step 6: Switch the dispense call to the local RPC** (line ~178)

```js
                        const { error } = await supabase.rpc('dispense_visit_item', { p_visit_id: r.visit_id, p_item_id: item.id, p_qty: Number(qty), p_doctor_id: r.doctor_id || null });
```
becomes
```js
                        const { error } = await supabase.rpc('dispense_item', { visit_id: r.visit_id, product_id: item.id, quantity: Number(qty) });
```

- [ ] **Step 7: Replace `loadProcItems()`** (lines ~234–245, the whole function) with:

```js
async function loadProcItems(visitId) {
    if (!visitId) return [];
    const { data, error } = await supabase.from('visit_services')
        .select('id, quantity, unit_price, invoice_item_id, clinic_item_id, products(name, unit)')
        .eq('visit_id', visitId);
    if (error) { console.warn('[procedures] items:', error.message); return []; }
    return (data || []).filter(x => x.clinic_item_id != null).map(x => {
        const qty = Number(x.quantity ?? 1), price = Number(x.unit_price ?? 0);
        return { id: x.id, invoiced: !!x.invoice_item_id, qty, total: price * qty,
            name: (x.products?.name || 'Товар') + (x.products?.unit ? ' (' + x.products.unit + ')' : '') };
    });
}
```

(`.not('clinic_item_id','is',null)` is gone — `clinic_item_id` is not a registered filter, so the null-filter moved client-side.)

- [ ] **Step 8: Commit**

```bash
git add public/js/admin/views/procedures.js
git commit -m "feat: convert Procedures worklist to the local backend"
```

---

### Task 5: Sidebar entry + breadcrumb

**Files:**
- Modify: `public/js/admin.js` (NAV ~line 79, breadcrumb map ~line 106)

- [ ] **Step 1: Add the NAV item** (line ~79)

```js
    { id: 'labs',     label: 'Laboratory', icon: 'Flask' },   // LABS_UI_V1
```
becomes
```js
    { id: 'labs',     label: 'Laboratory', icon: 'Flask' },   // LABS_UI_V1
    { id: 'procedures', label: 'Procedures', icon: 'Drop' },   // PROC_LOCAL_V1 — Процедуры (nurse queue)
```

(`case 'procedures'` already exists in the router at line ~781; `isModuleAllowed('procedures')` gates visibility via the role grants from Task 1.)

- [ ] **Step 2: Add the breadcrumb entry** — in the same file find the map that contains `'doctor-room': ['Clinical', "Doctor's room"],   // DOCTOR_ROOM_V1` (~line 106) and add below it:

```js
    'procedures': ['Clinical', 'Procedures'],   // PROC_LOCAL_V1
```

- [ ] **Step 3: Manual verification**

Run: `npm start`. Log in as **admin**: sidebar shows "Procedures" under Clinical; clicking it renders the «Процедуры» page (empty queue). Log in as a **registrar** user: the entry is absent.

- [ ] **Step 4: Commit**

```bash
git add public/js/admin.js
git commit -m "feat: procedures sidebar entry, gated by role permissions"
```

---

### Task 6: Performer guards at the insert paths

Unassigned procedure rows are invisible in every queue, so each path that inserts a `visit_services` row must either set a performer or refuse.

**Files:**
- Modify: `public/js/admin/views/visit-modal.js` (`insertVisitServiceRow`, ~line 1701)
- Modify: `public/js/admin/views/visit-bill.js` (`loadServiceOptions` ~line 135, add handler ~line 148)
- Modify: `public/js/admin/views/doctor-room.js` (order modal list ~line 220, services select ~line 246)

- [ ] **Step 1: Central guard in the registrar flow** — in `visit-modal.js`, inside `insertVisitServiceRow`, after the `created_by` stamping lines:

```js
async function insertVisitServiceRow(row) {
    const uid = currentUser()?.id || null;
    let payload = { ...row };
    if (uid && payload.created_by === undefined) payload.created_by = uid;
```
becomes
```js
async function insertVisitServiceRow(row) {
    const uid = currentUser()?.id || null;
    let payload = { ...row };
    if (uid && payload.created_by === undefined) payload.created_by = uid;
    // PROC_LOCAL_V1 — procedures must carry a performer: unassigned rows are
    // invisible in every queue (Procedures shows assigned-only), so block early.
    if (payload.doctor_id == null && payload.service_id != null) {
        const { data: svc } = await supabase.from('services')
            .select('is_procedure').eq('id', payload.service_id).single();
        if (svc && Number(svc.is_procedure) === 1) {
            return { error: { message: 'Это процедура — выберите исполнителя (врача или медсестру), иначе она не попадёт в очередь процедур.' } };
        }
    }
```

(Both insert call sites — lines ~909 and ~1034 — funnel through this function and already surface `res.error.message` as a toast.)

- [ ] **Step 2: Block unassigned adds from the bill** — in `visit-bill.js`, the bill's quick-add has no performer picker, so procedures are refused there. Extend the options query (~line 136):

```js
                .select('id,name,price').eq('active', 1).order('name');
```
becomes
```js
                .select('id,name,price,is_procedure').eq('active', 1).order('name');
```

three lines below, carry the flag on the option:

```js
                addSelect.appendChild(h('option', { value: s.id, dataset: { price: String(s.price) } },
```
becomes
```js
                addSelect.appendChild(h('option', { value: s.id, dataset: { price: String(s.price), proc: String(s.is_procedure || 0) } },
```

and in the add handler (~line 148), right after `const price = ...`:

```js
        const opt = addSelect.selectedOptions[0];
        const price = Number(opt && opt.dataset.price) || 0;
```
becomes
```js
        const opt = addSelect.selectedOptions[0];
        const price = Number(opt && opt.dataset.price) || 0;
        if (Number(opt && opt.dataset.proc) === 1) { toast('Это процедура — добавьте её через карточку визита и выберите исполнителя.', 'fail'); return; }
```

- [ ] **Step 3: Doctor-room chip (informational)** — doctor-ordered rows already get a performer (`doctor_id: visit.doctor_id || myId()`, line ~229 — no guard needed). Just make procedures recognizable in the order modal. Line ~246:

```js
    supabase.from('services').select('id, name, price, is_lab').eq('active', 1).order('name').limit(500).then(({ data, error }) => {
```
becomes
```js
    supabase.from('services').select('id, name, price, is_lab, is_procedure').eq('active', 1).order('name').limit(500).then(({ data, error }) => {
```

and the list row (~line 220):

```js
                h('span', null, s.name, s.is_lab ? h('span', { class: 'muted', style: { fontSize: '10px', marginLeft: '6px' } }, 'lab') : null),
```
becomes
```js
                h('span', null, s.name,
                    s.is_lab ? h('span', { class: 'muted', style: { fontSize: '10px', marginLeft: '6px' } }, 'lab') : null,
                    s.is_procedure ? h('span', { class: 'muted', style: { fontSize: '10px', marginLeft: '6px' } }, 'procedure') : null),
```

- [ ] **Step 4: Commit**

```bash
git add public/js/admin/views/visit-modal.js public/js/admin/views/visit-bill.js public/js/admin/views/doctor-room.js
git commit -m "feat: require a performer on procedure orders at every insert path"
```

---

### Task 7: Full verification pass

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, 0 failures.

- [ ] **Step 2: End-to-end acceptance** (spec success criteria; `npm start`, `http://localhost:8000`)

1. Admin → Settings → Services: create "Инъекция в/м" with **Is procedure** checked, price 30 000.
2. Admin → Settings → Users: ensure a `nurse` user exists (create `nurse1`).
3. Registrar: register a visit for a patient, add "Инъекция в/м" **with performer = nurse1** (adding without a performer must be refused with the performer toast).
4. Log in as `nurse1` → Procedures: the row shows status **Назначено · Ожидает кассу**, no perform button.
5. Cashier: create the invoice for the visit and take payment.
6. `nurse1` → Procedures: row is now **В очереди** with a «Выполнить» button. Open it, add a stock product (e.g. «Шприц 5мл» — receive stock first under Inventory if empty), write a note, press «Отметить выполненной».
7. Verify: row shows ✓ nurse1 + timestamp; Inventory shows the stock decrement; the doctor's room visit card lists the line with status `completed`.
8. Log in as a **second** nurse: the queue is empty (assigned-only scoping). As **admin**: the row is visible.
9. Registrar login: no Procedures entry in the sidebar.

- [ ] **Step 3: Update project docs**

Add one line to `CLAUDE.md` under "Current status": `- Procedures module (Процедуры): nurse queue with pay-first gating — see docs/specs/2026-08-05-procedures-module-design.md`.

- [ ] **Step 4: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs: note procedures module in project status"
```

Then use superpowers:finishing-a-development-branch to integrate `feat/procedures`.
