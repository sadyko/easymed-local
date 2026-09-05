# Control Plane v2, Stage ① — Permanent Delete + the Clinic Board

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it possible to permanently delete a retired clinic without ever letting its id be
reissued, and replace the panel's clinics table with a warm card board that shows what needs
attention first.

**Architecture:** A `deleted_clinics` tombstone table plus a `BEFORE INSERT` trigger on `clinics`
is the safety mechanism — id reuse becomes impossible at the schema level, not merely by
convention. `DELETE /cp/v1/admin/clinics/:id` refuses anything not already retired and anything
still parenting a filial. On the front end, `panel-clinics-list.js` becomes a card board; every
decision it makes (which band a clinic belongs in, how to draw a version chip) is a pure
function in `panel-logic.js` with its own test.

**Tech Stack:** Node 24, better-sqlite3 13, Express 5, plain browser ES modules, hand-written
CSS. No build step, no new dependencies.

**Spec:** `docs/specs/2026-09-05-control-plane-v2-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `control-plane/server/db/migrations/010_deleted_clinics.sql` | **Create.** Tombstone table, resurrection trigger, `clinics.retired_at`. |
| `control-plane/server/db/migrations/010.test.js` | **Create.** Pins what the schema guarantees on its own. |
| `control-plane/server/routes/admin.js` | **Modify.** `nextClinicId` honours tombstones; `retire` stamps `retired_at`; new `DELETE /clinics/:id`; `GET /clinics` gains fields; route table entry. |
| `control-plane/server/routes/admin.test.js` | **Modify.** Delete refusals, delete success, new list fields. |
| `control-plane/public/panel-logic.js` | **Modify.** `attentionReasons`, `clinicBand`, `versionChip`, `formatStat`, `formatRetiredAt`. |
| `control-plane/public/panel-logic.test.js` | **Modify.** Pure-function tests for all five. |
| `control-plane/public/panel-api.js` | **Modify.** `deleteClinic()`. |
| `control-plane/public/panel-clinics-list.js` | **Rewrite.** The card board. |
| `control-plane/public/panel-card-menu.js` | **Create.** The ••• menu and the delete confirmation dialog. |
| `control-plane/public/panel.css` | **Modify.** Warm token values; board, card, menu and dialog styles. |

**Test command** (from the repo root, `Desktop/implementation workflow/easymed.local`):

```bash
node --test control-plane/server/db/migrations/010.test.js
```

The whole control-plane suite — note the explicit file list; `node --test <directory>` is broken
on Windows + Node 24:

```bash
node --test $(find control-plane -name "*.test.js" -not -path "*/node_modules/*" | tr '\n' ' ')
```

Baseline before this plan: **452 pass, 0 fail**.

---

## Task 1: Migration 010 — the tombstone, the trigger, `retired_at`

**Files:**
- Create: `control-plane/server/db/migrations/010.test.js`
- Create: `control-plane/server/db/migrations/010_deleted_clinics.sql`

- [ ] **Step 1: Write the failing test**

Create `control-plane/server/db/migrations/010.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { createEnrollmentCode } from '../../services/enrollment.js';

// CONTROL_PLANE_V2 — deleted_clinics is the reason a hard DELETE is safe at all.
//
// 001_registry.sql states the danger in its own words: clinic_id is baked into
// every signed licence, and routes/admin.js:nextClinicId allocates
// max(numeric suffix) + 1 read straight off the clinics table. Delete the
// newest clinic and the next one created takes its number back; the deleted
// clinic's licence file — still on its old computer — then verifies against a
// different clinic. These tests are about what the SCHEMA guarantees on its
// own, with no route involved, because the route is not the only thing that
// will ever insert into clinics.

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('010: a deleted clinic_id can never be inserted again', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-000009', name: 'Last Test Clinic' });
  db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run('c-000009');
  db.prepare('INSERT INTO deleted_clinics (clinic_id, name, deleted_by) VALUES (?,?,?)')
    .run('c-000009', 'Last Test Clinic', 'vendor');

  // The trigger, not the application. A future route, a hand-run INSERT and a
  // replayed backup must all hit the same wall.
  assert.throws(
    () => createEnrollmentCode(db, { clinicId: 'c-000009', name: 'A Different Clinic' }),
    /permanently deleted/i,
  );
});

test('010: the tombstone does not block any other id', () => {
  const db = freshDb();
  db.prepare('INSERT INTO deleted_clinics (clinic_id, name) VALUES (?,?)').run('c-000009', 'Gone');
  createEnrollmentCode(db, { clinicId: 'c-000010', name: 'Fine' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clinics').get().n, 1);
});

test('010: a tombstone records who and when, and stamps itself', () => {
  const db = freshDb();
  db.prepare('INSERT INTO deleted_clinics (clinic_id, name, deleted_by) VALUES (?,?,?)')
    .run('c-000008', 'test on laptop', 'vendor');
  const row = db.prepare('SELECT * FROM deleted_clinics WHERE clinic_id = ?').get('c-000008');
  assert.equal(row.name, 'test on laptop');
  assert.equal(row.deleted_by, 'vendor');
  assert.match(row.deleted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    'deleted_at defaults to a UTC timestamp, same shape as clinics.created_at');
});

test('010: one id cannot be tombstoned twice', () => {
  const db = freshDb();
  const ins = db.prepare('INSERT INTO deleted_clinics (clinic_id, name) VALUES (?,?)');
  ins.run('c-000008', 'test on laptop');
  assert.throws(() => ins.run('c-000008', 'test on laptop'), /UNIQUE|PRIMARY/i);
});

test('010: the tombstone holds no patient data and no credential', () => {
  const db = freshDb();
  const cols = db.prepare('PRAGMA table_info(deleted_clinics)').all().map((c) => c.name).sort();
  // Same guarantee 001 and 005 state as a schema fact. install_token and
  // unlock_secret must die with the row, never be preserved in the tombstone.
  assert.deepEqual(cols, ['clinic_id', 'deleted_at', 'deleted_by', 'name']);
});

test('010: retired_at exists and is null for clinics retired before this migration', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-000008', name: 'test on laptop' });
  db.prepare('UPDATE clinics SET active = 0 WHERE clinic_id = ?').run('c-000008');
  const row = db.prepare('SELECT retired_at FROM clinics WHERE clinic_id = ?').get('c-000008');
  assert.equal(row.retired_at, null,
    'no backfill: a date we do not know must read as unknown, never as today');
});

test('010: migrate() is idempotent — a second run is a no-op', () => {
  const db = freshDb();
  migrate(db);
  migrate(db);
  const n = db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE name = '010_deleted_clinics.sql'").get().n;
  assert.equal(n, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test control-plane/server/db/migrations/010.test.js
```

Expected: FAIL — `no such table: deleted_clinics`.

- [ ] **Step 3: Write the migration**

Create `control-plane/server/db/migrations/010_deleted_clinics.sql`:

```sql
-- CONTROL_PLANE_V2 (docs/specs/2026-09-05-control-plane-v2-design.md) — what
-- makes a hard DELETE of a clinic safe.
--
-- 001_registry.sql wrote down the danger and then declined to guard it: "Nothing
-- in this schema forbids a hard DELETE — migrations/001.test.js pins that
-- deleting and re-inserting the same clinic_id is currently possible — but the
-- application is expected to never do it for a live clinic." The owner now wants
-- a Delete button, so "expected to never" is no longer good enough.
--
-- THE DANGER, precisely: routes/admin.js:nextClinicId() allocates the next id as
-- max(numeric suffix seen in `clinics`) + 1. Delete c-000009 and the next clinic
-- created is c-000009 again. services/control/licence.js verifies a licence by
-- clinic_id, so the deleted clinic's licence file — still sitting on its old
-- computer, still signed, still inside its validity window — would verify
-- against the new clinic and grant it whatever the old one was entitled to.
--
-- The fix is a graveyard: an id that has been deleted is remembered forever, and
-- may never be issued again to anything.
CREATE TABLE deleted_clinics (
  clinic_id  TEXT PRIMARY KEY,
  -- Last known name. NOT for lookup — for the human reading the audit trail six
  -- months later, who needs "test on laptop" and not just "c-000008".
  name       TEXT,
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- vendor_users.username. Deliberately TEXT and not a foreign key: this row
  -- must outlive the vendor account that made it, exactly as `checkins` outlives
  -- the clinic row it describes.
  deleted_by TEXT
);

-- THE SECOND LINE, and the reason this is a trigger rather than an `if` in a
-- route. routes/admin.js will consult this table, but the route is not the only
-- thing that will ever insert into `clinics`: a future route, a support fix run
-- by hand at 2am, or an old backup replayed over this database. Every one of
-- those paths must hit the same wall, so the wall is in the schema.
--
-- ABORT, not IGNORE: a caller trying to resurrect a deleted clinic has made a
-- mistake worth hearing about. routes/admin.js turns it into a 409.
CREATE TRIGGER clinics_no_resurrection
BEFORE INSERT ON clinics
WHEN EXISTS (SELECT 1 FROM deleted_clinics WHERE clinic_id = NEW.clinic_id)
BEGIN
  SELECT RAISE(ABORT, 'clinic_id was permanently deleted and can never be reissued');
END;

-- When a clinic was retired, so a retired card can say "Retired 31 Aug 2026".
--
-- NO BACKFILL, deliberately. Clinics already retired (c-000008 on the live
-- registry) have no recorded date, and inventing one — created_at, or today —
-- would print a confident wrong answer. NULL renders as "date unknown", which is
-- true.
ALTER TABLE clinics ADD COLUMN retired_at TEXT;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test control-plane/server/db/migrations/010.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Run the whole suite — the trigger must not disturb anything**

```bash
node --test $(find control-plane -name "*.test.js" -not -path "*/node_modules/*" | tr '\n' ' ')
```

Expected: 459 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add control-plane/server/db/migrations/010_deleted_clinics.sql control-plane/server/db/migrations/010.test.js
git commit -m "feat(control-plane): deleted_clinics tombstone + resurrection trigger

A deleted clinic_id can never be reissued. Without this, deleting the
newest clinic hands its number to the next one created, and the deleted
clinic's still-valid signed licence verifies against the new row."
```

---

## Task 2: `nextClinicId` must skip tombstoned numbers

The trigger stops a collision being *written*. It does not stop `nextClinicId` proposing one —
which would surface as `createClinic` exhausting its five retries and throwing a 500 on a
perfectly ordinary "New clinic" click.

**Files:**
- Modify: `control-plane/server/routes/admin.js:126-136` (`nextClinicId`)
- Test: `control-plane/server/routes/admin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `control-plane/server/routes/admin.test.js`:

```js
// --- CONTROL_PLANE_V2: id allocation must step over the graveyard ------------

test('a tombstoned clinic id is never proposed again', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);

  // Highest id in the registry, then deleted — exactly the dangerous shape.
  enrol(db, 'c-000009', 'Last Test Clinic');
  db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run('c-000009');
  db.prepare('INSERT INTO deleted_clinics (clinic_id, name) VALUES (?,?)')
    .run('c-000009', 'Last Test Clinic');

  const res = await req(server, 'POST', ADMIN_BASE + '/clinics', {
    cookie, body: { name: 'A Different Clinic' },
  });
  assert.equal(res.status, 201);
  const { clinic_id } = await res.json();
  assert.notEqual(clinic_id, 'c-000009', 'the graveyard must be counted, not just the living');
  assert.equal(clinic_id, 'c-000010');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test control-plane/server/routes/admin.test.js
```

Expected: FAIL — the request 500s, or returns `c-000009`.

- [ ] **Step 3: Change `nextClinicId`**

In `control-plane/server/routes/admin.js`, replace the body of `nextClinicId`:

```js
// The next unused c-NNNNNN id, derived from the highest numeric suffix seen
// today. This is a display convenience (clinic_id has no format CHECK — see
// migrations/001_registry.sql) so the non-technical owner never has to invent
// or type one; createClinic() below still retries on an actual collision
// rather than trusting this count alone.
//
// CONTROL_PLANE_V2 — the UNION is not optional. deleted_clinics holds ids that
// no longer exist in `clinics` but may never be issued again (see
// migrations/010_deleted_clinics.sql). Counting only the living would propose a
// number the trigger then refuses, five times over, and turn an ordinary "New
// clinic" click into a 500.
function nextClinicId(db) {
  const rows = db.prepare(
    'SELECT clinic_id FROM clinics UNION SELECT clinic_id FROM deleted_clinics'
  ).all();
  let max = 0;
  for (const { clinic_id } of rows) {
    const m = /^c-(\d{6,})$/.exec(clinic_id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c-${String(max + 1).padStart(6, '0')}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test control-plane/server/routes/admin.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/server/routes/admin.js control-plane/server/routes/admin.test.js
git commit -m "fix(control-plane): allocate clinic ids over living rows AND tombstones"
```

---

## Task 3: Retiring a clinic records when

**Files:**
- Modify: `control-plane/server/routes/admin.js:357-370` (the retire route)
- Test: `control-plane/server/routes/admin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `control-plane/server/routes/admin.test.js`:

```js
test('retiring a clinic stamps retired_at, and re-retiring does not move it', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1', 'Clinic One');

  await req(server, 'POST', ADMIN_BASE + '/clinics/c-1/retire', { cookie, body: {} });
  const first = db.prepare('SELECT active, retired_at FROM clinics WHERE clinic_id = ?').get('c-1');
  assert.equal(first.active, 0);
  assert.match(first.retired_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  // Idempotent: clicking Retire on an already-retired clinic must not rewrite
  // the date to today. The date is evidence of when it happened.
  db.prepare("UPDATE clinics SET retired_at = '2026-01-01T00:00:00Z' WHERE clinic_id = 'c-1'").run();
  await req(server, 'POST', ADMIN_BASE + '/clinics/c-1/retire', { cookie, body: {} });
  const second = db.prepare('SELECT retired_at FROM clinics WHERE clinic_id = ?').get('c-1');
  assert.equal(second.retired_at, '2026-01-01T00:00:00Z');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test control-plane/server/routes/admin.test.js
```

Expected: FAIL — `retired_at` is null.

- [ ] **Step 3: Update the retire route**

In `control-plane/server/routes/admin.js`, replace the single UPDATE inside
`r.post('/clinics/:id/retire', ...)`:

```js
    // CONTROL_PLANE_V2 — COALESCE, so re-retiring an already-retired clinic
    // never rewrites the date. retired_at is evidence of when it happened, and
    // a second click must not quietly relabel a decision made in August as one
    // made today.
    db.prepare(
      "UPDATE clinics SET active = 0, retired_at = COALESCE(retired_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE clinic_id = ?"
    ).run(clinic.clinic_id);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test control-plane/server/routes/admin.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/server/routes/admin.js control-plane/server/routes/admin.test.js
git commit -m "feat(control-plane): record when a clinic was retired"
```

---

## Task 4: `DELETE /clinics/:id` — the three refusals

**Files:**
- Modify: `control-plane/server/routes/admin.js` (route table at `:47`, new `conflict` helper near `bad`/`notFound` at `:74`, new route after the retire route)
- Test: `control-plane/server/routes/admin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `control-plane/server/routes/admin.test.js`:

```js
// --- CONTROL_PLANE_V2: DELETE refuses more often than it accepts -------------

test('DELETE refuses an unknown clinic', async (t) => {
  const { server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const res = await req(server, 'DELETE', ADMIN_BASE + '/clinics/c-nope', { cookie });
  assert.equal(res.status, 404);
});

test('DELETE refuses a clinic that is still active', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1', 'Clinic One');

  const res = await req(server, 'DELETE', ADMIN_BASE + '/clinics/c-1', { cookie });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error.message, /retire/i, 'the message must say what to do first');
  assert.ok(db.prepare('SELECT 1 FROM clinics WHERE clinic_id = ?').get('c-1'), 'nothing deleted');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deleted_clinics').get().n, 0, 'no tombstone either');
});

test('DELETE refuses a parent that still has filials, and names the count', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1', 'Main Clinic');
  enrol(db, 'c-1-b1', 'Filial One');
  db.prepare('UPDATE clinics SET parent_clinic_id = ? WHERE clinic_id = ?').run('c-1', 'c-1-b1');
  db.prepare('UPDATE clinics SET active = 0 WHERE clinic_id = ?').run('c-1');

  const res = await req(server, 'DELETE', ADMIN_BASE + '/clinics/c-1', { cookie });
  assert.equal(res.status, 409);
  const body = await res.json();
  // foreign_keys is ON (db/connection.js:17) and clinics.parent_clinic_id has no
  // ON DELETE clause, so without this check the owner sees a raw
  // SQLITE_CONSTRAINT_FOREIGNKEY string instead of an instruction.
  assert.match(body.error.message, /1 filial/i);
  assert.ok(db.prepare('SELECT 1 FROM clinics WHERE clinic_id = ?').get('c-1'));
});

test('DELETE is in ADMIN_ROUTE_TABLE, so the anonymous-caller sweep covers it', () => {
  assert.ok(
    ADMIN_ROUTE_TABLE.some((r) => r.method === 'DELETE' && r.path === '/clinics/:id'),
    'a route missing from this table ships unprotected — see the table header',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test control-plane/server/routes/admin.test.js
```

Expected: FAIL — 404 for every case (no DELETE route exists), and the route-table assertion fails.

- [ ] **Step 3: Add the route-table entry**

In `control-plane/server/routes/admin.js`, add to `ADMIN_ROUTE_TABLE` immediately after the
`/clinics/:id/retire` line:

```js
  { method: 'DELETE', path: '/clinics/:id' },
```

- [ ] **Step 4: Add a `conflict` helper**

In `control-plane/server/routes/admin.js`, immediately after `function bad(res, message)`:

```js
// 409, not 400: the request is well-formed and the caller is allowed to make it
// — the CURRENT STATE of the clinic is what refuses. The panel shows this
// message verbatim, so every one of them is written as an instruction ("Retire
// this clinic before deleting it"), never as a diagnosis.
function conflict(res, message) {
  return res.status(409).json({ error: { code: 'conflict', message } });
}
```

- [ ] **Step 5: Add the route with its refusals only**

In `control-plane/server/routes/admin.js`, immediately after the `/clinics/:id/retire` route:

```js
  // CONTROL_PLANE_V2 — the delete 001_registry.sql said the application must
  // never do. It is safe now, and only now, because migrations/010 remembers
  // every id ever deleted and a trigger refuses to reissue one.
  r.delete('/clinics/:id', (req, res) => {
    const clinic = db.prepare('SELECT clinic_id, name, active FROM clinics WHERE clinic_id = ?')
      .get(req.params.id);
    if (!clinic) return notFound(res, 'Clinic not found.');

    // TWO STEPS, ALWAYS. Retire stops the licence renewing and is reversible by
    // hand; delete is not reversible by anything. Requiring the first before the
    // second means no single click can destroy a clinic that is still working.
    if (clinic.active) return conflict(res, 'Retire this clinic before deleting it.');

    // foreign_keys is ON (db/connection.js:17) and clinics.parent_clinic_id
    // carries no ON DELETE clause, so deleting a parent with filials raises
    // SQLITE_CONSTRAINT_FOREIGNKEY. Checked here so the owner reads an
    // instruction instead of a database error string.
    const filials = db.prepare('SELECT COUNT(*) n FROM clinics WHERE parent_clinic_id = ?')
      .get(clinic.clinic_id).n;
    if (filials > 0) {
      return conflict(res, `This clinic has ${filials} filial${filials === 1 ? '' : 's'}. Delete or reassign them first.`);
    }

    return res.json({ ok: true });   // Task 5 replaces this with the real work
  });
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
node --test control-plane/server/routes/admin.test.js
```

Expected: PASS, including the pre-existing "every route in ADMIN_ROUTE_TABLE rejects an
anonymous caller with 401" sweep, which now covers DELETE.

- [ ] **Step 7: Commit**

```bash
git add control-plane/server/routes/admin.js control-plane/server/routes/admin.test.js
git commit -m "feat(control-plane): DELETE /clinics/:id — refusals and route-table entry"
```

---

## Task 5: `DELETE /clinics/:id` — what is destroyed, what survives

**Files:**
- Modify: `control-plane/server/routes/admin.js` (the route from Task 4)
- Test: `control-plane/server/routes/admin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `control-plane/server/routes/admin.test.js`:

```js
test('DELETE destroys the clinic and its credentials, keeps the evidence', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const token = enrol(db, 'c-000009', 'Last Test Clinic');

  db.prepare("INSERT INTO clinic_modules (clinic_id, module_key) VALUES ('c-000009','crm')").run();
  db.prepare("INSERT INTO module_requests (clinic_id, module_key, requested_at) VALUES ('c-000009','crm','2026-08-20T00:00:00Z')").run();
  db.prepare('INSERT INTO relay_tokens (token, clinic_id, relay_id) VALUES (?,?,?)')
    .run('tok-1', 'c-000009', 'b3'.repeat(16));
  checkIn(db, { installToken: token, version: '0.8.0', fingerprint: 'fp-1' });
  assert.ok(db.prepare('SELECT COUNT(*) n FROM checkins').get().n > 0, 'sanity: a check-in exists');

  await req(server, 'POST', ADMIN_BASE + '/clinics/c-000009/retire', { cookie, body: {} });
  const res = await req(server, 'DELETE', ADMIN_BASE + '/clinics/c-000009', { cookie });
  assert.equal(res.status, 200);

  // Gone.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clinics WHERE clinic_id = ?').get('c-000009').n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clinic_modules WHERE clinic_id = ?').get('c-000009').n, 0,
    'ON DELETE CASCADE (001_registry.sql)');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_tokens WHERE clinic_id = ?').get('c-000009').n, 0,
    'a credential must never outlive the identity it speaks for (006_relay_tokens.sql)');

  // Kept.
  assert.ok(db.prepare('SELECT COUNT(*) n FROM checkins WHERE clinic_id = ?').get('c-000009').n > 0,
    'check-in history is evidence for a billing dispute — 001 keeps it uncascaded on purpose');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM module_requests WHERE clinic_id = ?').get('c-000009').n, 1,
    'GET /requests already LEFT JOINs for exactly this case');

  // Tombstoned, with the name and the vendor recorded.
  const grave = db.prepare('SELECT * FROM deleted_clinics WHERE clinic_id = ?').get('c-000009');
  assert.equal(grave.name, 'Last Test Clinic');
  assert.equal(grave.deleted_by, 'vendor');
});

test('a deleted clinic cannot be resurrected under its old id', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-000009', 'Last Test Clinic');
  await req(server, 'POST', ADMIN_BASE + '/clinics/c-000009/retire', { cookie, body: {} });
  await req(server, 'DELETE', ADMIN_BASE + '/clinics/c-000009', { cookie });

  // THE WHOLE POINT. The old clinic's signed licence names c-000009 and is
  // still on its computer; if a new clinic could take that id, that licence
  // would unlock it.
  const res = await req(server, 'POST', ADMIN_BASE + '/clinics', {
    cookie, body: { name: 'A Different Clinic' },
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).clinic_id, 'c-000010');

  assert.throws(
    () => db.prepare("INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES ('c-000009','Forced','x')").run(),
    /permanently deleted/i,
    'even a direct INSERT must be refused — the trigger is the second line',
  );
});

test('DELETE leaves nothing behind if any part of it fails', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1', 'Clinic One');
  await req(server, 'POST', ADMIN_BASE + '/clinics/c-1/retire', { cookie, body: {} });
  // Pre-place the tombstone so the INSERT inside the transaction collides.
  db.prepare('INSERT INTO deleted_clinics (clinic_id, name) VALUES (?,?)').run('c-1', 'Clinic One');

  const res = await req(server, 'DELETE', ADMIN_BASE + '/clinics/c-1', { cookie });
  assert.equal(res.status, 500);
  assert.ok(db.prepare('SELECT 1 FROM clinics WHERE clinic_id = ?').get('c-1'),
    'the clinic row must survive a failed delete — one transaction, all or nothing');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test control-plane/server/routes/admin.test.js
```

Expected: FAIL — the clinic row is still present after DELETE (the Task 4 stub only refuses).

- [ ] **Step 3: Replace the stub with the real work**

In `control-plane/server/routes/admin.js`, replace the line
`return res.json({ ok: true });   // Task 5 replaces this with the real work` with:

```js
    // ONE TRANSACTION. A tombstone without a delete would lock an id that still
    // has a live clinic on it; a delete without a tombstone is exactly the
    // resurrection bug this feature exists to prevent. Neither may happen alone.
    //
    // clinic_modules, relay_tokens and relay_blobs all declare ON DELETE
    // CASCADE and are cleared by the engine. checkins and module_requests carry
    // no foreign key — deliberately, see 001_registry.sql — and survive as the
    // record of what this clinic did.
    db.transaction(() => {
      db.prepare('INSERT INTO deleted_clinics (clinic_id, name, deleted_by) VALUES (?,?,?)')
        .run(clinic.clinic_id, clinic.name, req.vendorUser.username);
      db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run(clinic.clinic_id);
    })();

    res.json({ ok: true, deleted: clinic.clinic_id });
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test control-plane/server/routes/admin.test.js
```

Expected: PASS.

- [ ] **Step 5: Run the whole suite**

```bash
node --test $(find control-plane -name "*.test.js" -not -path "*/node_modules/*" | tr '\n' ' ')
```

Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add control-plane/server/routes/admin.js control-plane/server/routes/admin.test.js
git commit -m "feat(control-plane): permanent delete — cascade the clinic, keep the evidence"
```

---

## Task 6: `GET /clinics` — filials, ring, pin, retired date

**Files:**
- Modify: `control-plane/server/routes/admin.js:223-241` (`GET /clinics`)
- Test: `control-plane/server/routes/admin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `control-plane/server/routes/admin.test.js`:

```js
test('GET /clinics carries the family, the ring, the pin and the retired date', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1', 'Main Clinic');
  enrol(db, 'c-1-b1', 'Filial One');
  enrol(db, 'c-1-b2', 'Filial Two');
  db.prepare("UPDATE clinics SET parent_clinic_id = 'c-1' WHERE clinic_id IN ('c-1-b1','c-1-b2')").run();
  db.prepare("UPDATE clinics SET ring = 0, pinned_version = '0.6.8' WHERE clinic_id = 'c-1'").run();
  db.prepare("UPDATE clinics SET active = 0, retired_at = '2026-08-31T07:49:45Z' WHERE clinic_id = 'c-1-b2'").run();

  const res = await req(server, 'GET', ADMIN_BASE + '/clinics', { cookie });
  const { clinics } = await res.json();
  const by = Object.fromEntries(clinics.map((c) => [c.id, c]));

  assert.equal(by['c-1'].filial_count, 2);
  assert.equal(by['c-1'].parent_clinic_id, null);
  assert.equal(by['c-1'].ring, 0);
  assert.equal(by['c-1'].pinned_version, '0.6.8');

  assert.equal(by['c-1-b1'].parent_clinic_id, 'c-1');
  assert.equal(by['c-1-b1'].filial_count, 0);

  assert.equal(by['c-1-b2'].retired_at, '2026-08-31T07:49:45Z');
  assert.equal(by['c-1-b2'].active, false);
});

test('GET /clinics still leaks no credential', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const token = enrol(db, 'c-1', 'Clinic One');
  const res = await req(server, 'GET', ADMIN_BASE + '/clinics', { cookie });
  const raw = JSON.stringify(await res.json());
  // The list grew several columns in this task. install_token and unlock_secret
  // must not have come along with them.
  assert.ok(!raw.includes(token), 'install_token must never reach the panel');
  const secret = db.prepare('SELECT unlock_secret FROM clinics WHERE clinic_id = ?').get('c-1').unlock_secret;
  assert.ok(!raw.includes(secret), 'unlock_secret must never reach the panel');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test control-plane/server/routes/admin.test.js
```

Expected: FAIL — `filial_count` is `undefined`.

- [ ] **Step 3: Widen the query and the response**

In `control-plane/server/routes/admin.js`, replace the body of `r.get('/clinics', ...)`:

```js
  r.get('/clinics', (req, res) => {
    const rows = db.prepare(
      `SELECT clinic_id, name, subscription, subscription_until, last_seen_at, last_version,
              active, retired_at, parent_clinic_id, ring, pinned_version
       FROM clinics ORDER BY name COLLATE NOCASE`
    ).all();

    // CONTROL_PLANE_V2 — one grouped query, not one per row. The board draws a
    // "2 filials" line on every card, and a per-row COUNT here is the same
    // quadratic shape this route's own header warns against.
    const filialCounts = new Map(
      db.prepare(
        `SELECT parent_clinic_id AS parent, COUNT(*) AS n FROM clinics
         WHERE parent_clinic_id IS NOT NULL GROUP BY parent_clinic_id`
      ).all().map((r2) => [r2.parent, r2.n])
    );

    const clinics = rows.map((c) => ({
      id: c.clinic_id,
      name: c.name,
      subscription: c.subscription,
      subscription_until: c.subscription_until,
      modules: clinicModules(db, c.clinic_id),
      last_seen_at: c.last_seen_at,
      last_version: c.last_version,
      fingerprint_changed: lastCheckinFlaggedChange(db, c.clinic_id),
      open_request_count: openRequestCount(db, c.clinic_id),
      active: !!c.active,
      retired_at: c.retired_at,
      parent_clinic_id: c.parent_clinic_id,
      filial_count: filialCounts.get(c.clinic_id) || 0,
      ring: c.ring,
      pinned_version: c.pinned_version,
    }));
    res.json({ clinics });
  });
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test control-plane/server/routes/admin.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/server/routes/admin.js control-plane/server/routes/admin.test.js
git commit -m "feat(control-plane): list clinics with family, ring, pin and retired date"
```

---

## Task 7: `GET /clinics` — stats and update distance, without N+1

**Files:**
- Modify: `control-plane/server/routes/admin.js` (import, two new helpers, `GET /clinics`)
- Test: `control-plane/server/routes/admin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `control-plane/server/routes/admin.test.js`:

```js
test('GET /clinics carries each clinic newest reported stats', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const a = enrol(db, 'c-1', 'Reports Stats');
  enrol(db, 'c-2', 'Never Installed');

  checkIn(db, { installToken: a, version: '0.8.0', stats: { patients_total: 1240, visits_today: 38 } });
  checkIn(db, { installToken: a, version: '0.8.0' });   // newer, but carries none

  const res = await req(server, 'GET', ADMIN_BASE + '/clinics', { cookie });
  const by = Object.fromEntries((await res.json()).clinics.map((c) => [c.id, c]));

  assert.deepEqual(by['c-1'].latest_stats, { patients_total: 1240, visits_today: 38 },
    'the newest check-in that CARRIES stats wins, not simply the newest check-in');
  assert.ok(by['c-1'].latest_stats_at);

  assert.equal(by['c-2'].latest_stats, null,
    'a clinic that never checked in reports null — the board draws it as an em dash, never as 0');
});

test('GET /clinics says how many releases behind each clinic is', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const a = enrol(db, 'c-1', 'Current');
  const b = enrol(db, 'c-2', 'Behind');
  enrol(db, 'c-3', 'Never Installed');

  const rel = db.prepare('INSERT INTO releases (version, ring, halted) VALUES (?,?,?)');
  rel.run('0.6.8', 2, 0);
  rel.run('0.7.2', 2, 0);
  rel.run('0.8.0', 2, 0);
  rel.run('0.9.0', -1, 0);   // registered, never published — nobody is "behind" it
  rel.run('0.8.5', 2, 1);    // halted — likewise

  checkIn(db, { installToken: a, version: '0.8.0' });
  checkIn(db, { installToken: b, version: '0.6.8' });

  const res = await req(server, 'GET', ADMIN_BASE + '/clinics', { cookie });
  const by = Object.fromEntries((await res.json()).clinics.map((c) => [c.id, c]));

  assert.equal(by['c-1'].versions_behind, 0);
  assert.equal(by['c-2'].versions_behind, 2, '0.7.2 and 0.8.0 — not the unpublished or halted ones');
  assert.equal(by['c-3'].versions_behind, null, 'unknown version means unknown distance, not zero');
});

test('versions are compared numerically per segment, not as strings', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const a = enrol(db, 'c-1', 'Nine');
  db.prepare('INSERT INTO releases (version, ring, halted) VALUES (?,?,?)').run('0.10.0', 2, 0);
  checkIn(db, { installToken: a, version: '0.9.0' });

  const res = await req(server, 'GET', ADMIN_BASE + '/clinics', { cookie });
  const by = Object.fromEntries((await res.json()).clinics.map((c) => [c.id, c]));
  assert.equal(by['c-1'].versions_behind, 1, '0.10.0 is newer than 0.9.0 — a string compare gets this backwards');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test control-plane/server/routes/admin.test.js
```

Expected: FAIL — `latest_stats` is `undefined`.

- [ ] **Step 3: Add the import**

At the top of `control-plane/server/routes/admin.js`, alongside the other cross-package imports:

```js
// Same module services/rings.js imports it from — never a third copy. Comparing
// versions numerically per segment ("0.10.0" is newer than "0.9.0") is exactly
// the kind of function that goes subtly wrong when re-typed.
import { compareVersions } from '../../../scripts/build-bundle.mjs';
```

- [ ] **Step 4: Add the two helpers**

In `control-plane/server/routes/admin.js`, next to the existing `latestStats` helper (`:202`):

```js
// CONTROL_PLANE_V2 — the list's answer to latestStats(), for every clinic at
// once. latestStats() walks one clinic's whole check-in history; calling it per
// row turns a list render into N history scans.
//
// The window function bounds the work at RECENT_CHECKINS_SCANNED rows per
// clinic. That is a deliberate, documented difference from latestStats(): a
// clinic whose last ten check-ins all carried no stats reads as "—" on the
// board, while GET /clinics/:id still finds the older figure. The board is a
// glance; the clinic page is the record.
const RECENT_CHECKINS_SCANNED = 10;

function latestStatsForAll(db) {
  const rows = db.prepare(
    `SELECT clinic_id, at, payload FROM (
       SELECT clinic_id, at, payload,
              ROW_NUMBER() OVER (PARTITION BY clinic_id ORDER BY at DESC, id DESC) AS rn
       FROM checkins
     ) WHERE rn <= ?
     ORDER BY clinic_id, rn`
  ).all(RECENT_CHECKINS_SCANNED);

  const out = new Map();
  for (const row of rows) {
    if (out.has(row.clinic_id)) continue;   // already found this clinic's newest with stats
    let payload;
    try { payload = JSON.parse(row.payload); } catch { continue; }
    if (payload && payload.stats && typeof payload.stats === 'object' && Object.keys(payload.stats).length) {
      out.set(row.clinic_id, { stats: payload.stats, at: row.at });
    }
  }
  return out;
}

// Versions a clinic could actually be offered today: published to some ring and
// not halted. A registered-but-unpublished release (ring -1) or a halted one is
// something NOBODY is behind — saying otherwise would put an amber chip on a
// clinic that is doing exactly what it was told.
function offerableVersionsDesc(db) {
  return db.prepare('SELECT version FROM releases WHERE ring >= 0 AND halted = 0').all()
    .map((r2) => r2.version)
    .sort((a, b) => compareVersions(b, a));
}

function versionsBehind(offerable, installed) {
  if (!installed) return null;   // never checked in — unknown distance, not zero
  return offerable.filter((v) => compareVersions(v, installed) > 0).length;
}
```

- [ ] **Step 5: Use them in `GET /clinics`**

In `control-plane/server/routes/admin.js`, inside `r.get('/clinics', ...)`, add after the
`filialCounts` map:

```js
    const statsByClinic = latestStatsForAll(db);
    const offerable = offerableVersionsDesc(db);
```

and add three fields to the object built in `rows.map(...)`, after `pinned_version`:

```js
      latest_stats: statsByClinic.get(c.clinic_id)?.stats ?? null,
      latest_stats_at: statsByClinic.get(c.clinic_id)?.at ?? null,
      versions_behind: versionsBehind(offerable, c.last_version),
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
node --test control-plane/server/routes/admin.test.js
```

Expected: PASS.

- [ ] **Step 7: Run the whole suite**

```bash
node --test $(find control-plane -name "*.test.js" -not -path "*/node_modules/*" | tr '\n' ' ')
```

Expected: 0 fail.

- [ ] **Step 8: Commit**

```bash
git add control-plane/server/routes/admin.js control-plane/server/routes/admin.test.js
git commit -m "feat(control-plane): clinic list carries stats and update distance

Both computed in one grouped pass. Version comparison reuses the
comparator rings.js already uses rather than a third copy."
```

---

## Task 8: The board's decisions, as pure functions

**Files:**
- Modify: `control-plane/public/panel-logic.js`
- Test: `control-plane/public/panel-logic.test.js`

- [ ] **Step 1: Write the failing test**

Append to `control-plane/public/panel-logic.test.js`:

```js
// --- CONTROL_PLANE_V2: which band a card belongs in --------------------------

const NOW = new Date('2026-09-05T12:00:00Z');

function clinic(over = {}) {
  return {
    active: true, subscription: 'active', subscription_until: null,
    last_seen_at: '2026-09-05T11:32:00Z', versions_behind: 0, ...over,
  };
}

test('attentionReasons: a healthy clinic needs nothing', () => {
  assert.deepEqual(attentionReasons(clinic(), NOW), []);
});

test('attentionReasons: never installed is its own reason', () => {
  // The live registry has three of these — codes issued in August, never
  // claimed. They are not "quiet", they never arrived.
  assert.deepEqual(attentionReasons(clinic({ last_seen_at: null }), NOW), ['never installed']);
});

test('attentionReasons: silence past a week', () => {
  assert.deepEqual(attentionReasons(clinic({ last_seen_at: '2026-09-01T00:00:00Z' }), NOW), []);
  assert.deepEqual(attentionReasons(clinic({ last_seen_at: '2026-08-20T00:00:00Z' }), NOW), ['gone quiet']);
});

test('attentionReasons: money', () => {
  assert.deepEqual(attentionReasons(clinic({ subscription: 'unpaid' }), NOW), ['unpaid']);
  assert.deepEqual(attentionReasons(clinic({ subscription_until: '2026-09-20' }), NOW),
    ['subscription ends in 15 days']);
  assert.deepEqual(attentionReasons(clinic({ subscription_until: '2026-08-01' }), NOW),
    ['subscription lapsed']);
  assert.deepEqual(attentionReasons(clinic({ subscription_until: '2027-08-24' }), NOW), []);
});

test('attentionReasons: three or more releases behind', () => {
  assert.deepEqual(attentionReasons(clinic({ versions_behind: 2 }), NOW), []);
  assert.deepEqual(attentionReasons(clinic({ versions_behind: 3 }), NOW), ['far behind on updates']);
  assert.deepEqual(attentionReasons(clinic({ versions_behind: null }), NOW), [],
    'unknown distance is not a reason to raise an alarm');
});

test('clinicBand: retired wins over every other reason', () => {
  assert.equal(clinicBand(clinic({ active: false, last_seen_at: null, subscription: 'unpaid' }), NOW), 'retired');
  assert.equal(clinicBand(clinic(), NOW), 'live');
  assert.equal(clinicBand(clinic({ subscription: 'unpaid' }), NOW), 'attention');
});

test('versionChip: current, behind, far behind, unknown', () => {
  assert.deepEqual(versionChip(0), { label: 'current', tone: 'ok' });
  assert.deepEqual(versionChip(1), { label: '1 behind', tone: 'warn' });
  assert.deepEqual(versionChip(2), { label: '2 behind', tone: 'warn' });
  assert.deepEqual(versionChip(3), { label: 'far behind', tone: 'bad' });
  assert.equal(versionChip(null), null);
  assert.equal(versionChip(undefined), null);
});

test('formatStat: an em dash for absent, never a zero', () => {
  // A 0 here reads as "this clinic billed nothing today", which is a different
  // and alarming claim from "this clinic does not report that figure".
  assert.equal(formatStat(null), '—');
  assert.equal(formatStat(undefined), '—');
  assert.equal(formatStat(NaN), '—');
  assert.equal(formatStat(0), '0');
  assert.equal(formatStat(96), '96');
  assert.equal(formatStat(1240), '1 240');
  assert.equal(formatStat(6400000), '6.4M');
  assert.equal(formatStat(2000000), '2M');
});

test('formatRetiredAt: unknown stays unknown', () => {
  // Migration 010 deliberately does not backfill. Printing today's date for a
  // clinic retired in August would be a confident lie.
  assert.equal(formatRetiredAt(null), 'date unknown');
  assert.equal(formatRetiredAt('not-a-date'), 'date unknown');
  assert.equal(formatRetiredAt('2026-08-31T07:49:45Z'), '31 Aug 2026');
});
```

The file already opens with a one-name-per-line import block starting
`import {\n  STALE_THRESHOLD_MS,\n  SELLABLE_MODULES,\n  lastSeenSeverity,` … . Keep that style
and add five lines to it, before the closing `} from './panel-logic.js';`:

```js
  attentionReasons,
  clinicBand,
  versionChip,
  formatStat,
  formatRetiredAt,
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test control-plane/public/panel-logic.test.js
```

Expected: FAIL — `attentionReasons is not a function`.

- [ ] **Step 3: Implement them**

Append to `control-plane/public/panel-logic.js`:

```js
// --- CONTROL_PLANE_V2: the board's bands -------------------------------------
//
// Every rule the card board applies lives here, as a pure function with a test,
// for the same reason the rest of this file does: a rule embedded in a render
// function can only be checked by looking at a screen.

export const QUIET_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPIRING_WITHIN_DAYS = 30;
export const FAR_BEHIND_RELEASES = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

// Whole days from `now` to a YYYY-MM-DD, inclusive of the day itself — matching
// subscriptionBadge() above and services/checkin.js's own parseDateOnly, which
// is what actually decides whether a licence is re-armed. Null for anything
// unparseable, so a malformed date never becomes a confident countdown.
function daysUntilDateOnly(until, now) {
  if (typeof until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return null;
  const end = Date.parse(until + 'T00:00:00Z');
  if (Number.isNaN(end)) return null;
  const today = Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  return Math.round((end - today) / DAY_MS);
}

/**
 * Why this clinic is in the "needs attention" band, in the owner's words.
 * An empty array means nothing is wrong.
 */
export function attentionReasons(clinic, now = new Date()) {
  const out = [];

  if (!clinic.last_seen_at) {
    // Distinct from "gone quiet": these never arrived at all. The live registry
    // holds three — enrollment codes issued in August and never claimed.
    out.push('never installed');
  } else {
    const seen = Date.parse(clinic.last_seen_at);
    if (Number.isFinite(seen) && now.getTime() - seen > QUIET_AFTER_MS) out.push('gone quiet');
  }

  if (clinic.subscription !== 'active') {
    out.push('unpaid');
  } else {
    const days = daysUntilDateOnly(clinic.subscription_until, now);
    if (days !== null && days <= EXPIRING_WITHIN_DAYS) {
      out.push(days < 0 ? 'subscription lapsed' : `subscription ends in ${days} days`);
    }
  }

  // null means the clinic has never reported a version — unknown distance. An
  // unknown is not an alarm.
  if (typeof clinic.versions_behind === 'number' && clinic.versions_behind >= FAR_BEHIND_RELEASES) {
    out.push('far behind on updates');
  }

  return out;
}

/** 'retired' | 'attention' | 'live' — which band this card is drawn in. */
export function clinicBand(clinic, now = new Date()) {
  // Retired first and unconditionally: a retired clinic is not a problem to
  // solve, it is a decision already taken. Ranking it by its faults would fill
  // the top of the board with clinics the owner has finished with.
  if (!clinic.active) return 'retired';
  return attentionReasons(clinic, now).length > 0 ? 'attention' : 'live';
}

/** The chip beside a clinic's version, or null when the distance is unknown. */
export function versionChip(versionsBehind) {
  if (typeof versionsBehind !== 'number' || !Number.isFinite(versionsBehind)) return null;
  if (versionsBehind <= 0) return { label: 'current', tone: 'ok' };
  if (versionsBehind >= FAR_BEHIND_RELEASES) return { label: 'far behind', tone: 'bad' };
  return { label: `${versionsBehind} behind`, tone: 'warn' };
}

/**
 * A counter for the card's stats strip. Absent reads as an em dash, NEVER as 0:
 * "0 billed today" is a different and alarming claim from "this clinic does not
 * report that figure" — and three clinics on the live registry report nothing
 * at all.
 */
export function formatStat(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) {
    return String(Number((value / 1_000_000).toFixed(1))) + 'M';
  }
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** "31 Aug 2026", or "date unknown" — migration 010 deliberately backfills nothing. */
export function formatRetiredAt(iso) {
  if (!iso) return 'date unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'date unknown';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test control-plane/public/panel-logic.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/public/panel-logic.js control-plane/public/panel-logic.test.js
git commit -m "feat(panel): band, version chip and stat formatting as pure functions"
```

---

## Task 9: The warm palette

**Files:**
- Modify: `control-plane/public/panel.css`

No test — this is colour. It is verified by opening the panel.

- [ ] **Step 1: Replace the token block**

In `control-plane/public/panel.css`, replace the header comment and the whole `:root { ... }`
block at the top with:

```css
/* Easy-Med — Control Plane panel (settings.easymed.uz/cp/).

   CONTROL_PLANE_V2 — warm clinical, replacing the dark palette this file was
   born with. That palette was copied verbatim from platform-console's
   css/setting.css so the two consoles would read as one product; this is a
   deliberate divergence from it, on the owner's instruction and against a
   design reference they supplied. The house rule it now follows instead: a
   medical product is calm and clinical, never harsh dark or black-on-white,
   and never uses an emoji where a line icon belongs.

   Every colour in this file is a token. Nothing below re-states a hex. */

:root {
    --bg:        #faf6ef;   /* cream ground */
    --bg-2:      #ffffff;   /* cards */
    --bg-3:      #f4f0e8;   /* inset: inputs, wells, table headers */
    --line:      #ede6da;
    --line-2:    #ddd3c3;
    --ink:       #2a2621;
    --ink-2:     #6e6558;
    --ink-3:     #8c8377;
    --teal:      #f2c14e;   /* the accent — amber now, name kept so no rule below has to change */
    --teal-2:    #d9a832;
    --amber:     #d98e4a;   /* warning */
    --red:       #c4645a;   /* danger */
    --green:     #5b8c6e;   /* ok */
    --blue:      #5e7b93;
    --shadow:    0 8px 28px rgba(42,38,33,0.10);

    /* Accent-on-light needs a readable foreground of its own: white text on
       #f2c14e fails contrast, which the dark palette never had to think about. */
    --on-accent: #493a12;
    --accent-soft: #fdf0d0;
}
```

- [ ] **Step 2: Find every colour that is not a token**

```bash
grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(' control-plane/public/panel.css | grep -v '^\s*[0-9]*:\s*--'
```

Expected: a handful of hits (gradients on `.boot-logo` and `.gate-btn`, focus rings using
`rgba(25,181,156,...)`, any `color: white`). Each one is a colour the token swap did **not**
reach and will look wrong on cream.

- [ ] **Step 3: Fix each hit**

Replace each with a token. These five are the ones that will look worst if missed — every one of
them was written for a dark ground:

```css
/* was: white glyph on the accent gradient */
.boot-logo { background: linear-gradient(135deg, var(--teal), var(--teal-2)); color: var(--on-accent); }

/* was: rgba(25,181,156,0.18) — the old teal at 18% */
.gate-input:focus { border-color: var(--teal); box-shadow: 0 0 0 3px var(--accent-soft); }

/* was: color: white */
.gate-btn { background: linear-gradient(180deg, var(--teal), var(--teal-2)); color: var(--on-accent); }
.btn.primary { background: linear-gradient(180deg, var(--teal), var(--teal-2)); border-color: transparent; color: var(--on-accent); }

/* was: rgba(215,80,80,0.16) background with #ffb4b4 text — a dark-mode pink,
   illegible on cream. */
.btn.danger { background: #f8e4e1; border-color: #e8c4bf; color: #9c4b42; }
.btn.danger:hover:not(:disabled) { background: #f2d6d2; }

/* was: rgba(25,181,156,0.16) background with var(--teal) text — the old teal
   tint, now an amber-on-amber smear. */
.mod-chip { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
            font-weight: 600; margin: 1px 3px 1px 0; background: var(--bg-3); color: var(--ink-2); }
```

Apply the same substitution to every remaining hit from Step 2: `white` on an accent background
becomes `var(--on-accent)`; any teal-tinted `rgba()` becomes `var(--accent-soft)`.

- [ ] **Step 4: Verify by eye**

```bash
node control-plane/server/index.js
```

Open `http://localhost:8095/cp/`. Check the login screen, then sign in and check the clinics
table and one clinic page. Every surface should be cream or white; no text should be
low-contrast; no button should be white-on-amber.

- [ ] **Step 5: Commit**

```bash
git add control-plane/public/panel.css
git commit -m "feat(panel): warm clinical palette

Deliberate divergence from platform-console's dark tokens, on the owner's
instruction and against their design reference."
```

---

## Task 10: The clinic board

**Files:**
- Modify: `control-plane/public/panel-api.js`
- Rewrite: `control-plane/public/panel-clinics-list.js`
- Modify: `control-plane/public/panel.css` (append the board styles)

- [ ] **Step 1: Add the API call**

In `control-plane/public/panel-api.js`, in the `cp` object, immediately after `retire`:

```js
  deleteClinic: (id) => request('DELETE', `/admin/clinics/${encodeURIComponent(id)}`),
```

- [ ] **Step 2: Append the board styles to `panel.css`**

```css
/* --- CONTROL_PLANE_V2: the clinic board ------------------------------------ */

.board-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
/* The existing search styling is scoped to .filterbar, which the board replaced —
   restated here rather than widening that selector, so the clinic page's own
   filter bar keeps its current sizing. */
.board-bar input.search { flex: 1; min-width: 220px; padding: 8px 12px; background: var(--bg-2);
                          border: 1px solid var(--line); color: var(--ink); border-radius: 8px;
                          font-size: 13px; outline: none; }
.board-bar input.search:focus { border-color: var(--teal); box-shadow: 0 0 0 3px var(--accent-soft); }

/* Pressed state for the two toggles. .btn has no `on` variant yet — .nav-link
   does, but that one is styled for the navbar. */
.btn.on { background: var(--accent-soft); border-color: var(--teal); color: var(--on-accent); }

.band { display: flex; align-items: center; gap: 10px; margin: 0 0 12px;
        font-size: 11px; font-weight: 700; letter-spacing: .09em;
        text-transform: uppercase; color: var(--ink-3); }
.band .rule { flex: 1; height: 1px; background: var(--line); }
.band .count { color: var(--ink-3); font-weight: 600; letter-spacing: 0; }

.deck { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 12px; margin-bottom: 26px; }

.cc { position: relative; background: var(--bg-2); border: 1px solid var(--line);
      border-radius: 13px; padding: 14px; cursor: pointer;
      transition: border-color .12s, box-shadow .12s; }
.cc:hover { border-color: var(--line-2); box-shadow: var(--shadow); }
.cc.attention { border-color: #ebc9a6; box-shadow: 0 0 0 3px #fbf0e2; }
.cc.retired { opacity: .62; }
.cc.new { border-style: dashed; display: grid; place-items: center; min-height: 150px;
          color: var(--ink-3); text-align: center; }

.cc-head { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 10px; }
.cc-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex: none; }
.cc-dot.ok { background: var(--green); }
.cc-dot.warn { background: var(--amber); }
.cc-dot.bad { background: var(--red); }
.cc-dot.mute { background: var(--ink-3); }
.cc-name { font-weight: 650; font-size: 14px; line-height: 1.25; }
.cc-sub { font-size: 11px; color: var(--ink-3); margin-top: 2px; }
.cc-kebab { margin-left: auto; flex: none; background: none; border: 0; cursor: pointer;
            color: var(--ink-3); padding: 2px 6px; border-radius: 6px; font-size: 15px;
            line-height: 1; letter-spacing: 1px; }
.cc-kebab:hover { background: var(--bg-3); color: var(--ink); }

.cc-fact { display: flex; justify-content: space-between; gap: 10px;
           font-size: 12px; color: var(--ink-3); line-height: 1.9; }
.cc-fact b { color: var(--ink); font-weight: 600; }

.cc-stats { display: flex; gap: 16px; margin-top: 11px; padding-top: 11px;
            border-top: 1px solid var(--line); }
.cc-stats div { font-size: 10px; color: var(--ink-3); }
.cc-stats b { display: block; font-size: 15px; color: var(--ink); font-weight: 700; line-height: 1.3; }

.cc-mods { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
.cc-mods .mod-chip { font-size: 10px; padding: 2px 8px; border-radius: 6px;
                     background: var(--bg-3); color: var(--ink-2); }
.cc-mods .none { font-size: 10px; color: var(--ink-3); }

.chip { font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 20px;
        background: var(--accent-soft); color: var(--on-accent); }
.chip.ok { background: #e4efe7; color: #3f6b50; }
.chip.warn { background: var(--accent-soft); color: var(--on-accent); }
.chip.bad { background: #f8e4e1; color: #9c4b42; }

/* Compact: the same board with the lower two thirds of each card hidden. */
.deck.compact .cc-stats, .deck.compact .cc-mods { display: none; }
```

- [ ] **Step 3: Rewrite `panel-clinics-list.js`**

Replace the whole file with:

```js
// CONTROL_PLANE_PANEL_V2 — the clinics board. Cards, not rows, grouped into
// bands so the clinics that need a decision are the ones at the top of the
// screen.
//
// Every rule this file applies — which band, which chip, how a number reads —
// is a pure function in panel-logic.js with its own test. This file only
// decides what the markup looks like, which is the part a test cannot check
// anyway.
//
// Renders once per navigation to #clinics; search and the two toggles filter
// the already-fetched array, no re-fetch per keystroke. Everything drawn per
// card is a field already on the /admin/clinics response — no per-card lookup
// into another array, which is what would make a 200-clinic board quadratic.

import { cp, ApiError } from './panel-api.js';
import { esc } from './panel-dom.js';
import {
  formatLastSeen, subscriptionBadge, clinicBand, attentionReasons,
  versionChip, formatStat, formatRetiredAt,
} from './panel-logic.js';
import { openNewClinicModal } from './panel-new-clinic.js';
import { openCardMenu } from './panel-card-menu.js';

const BANDS = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'live', label: 'Live' },
  { key: 'retired', label: 'Retired' },
];

// The three counters the owner reads at a glance. Names must exist in
// server/services/control/metrics.js COUNTERS; an unknown name is simply
// absent from a clinic's payload and renders as an em dash, never as 0.
const CARD_STATS = [
  { key: 'patients_total', label: 'patients' },
  { key: 'visits_today', label: 'visits today' },
  { key: 'billed_today', label: 'billed today' },
];

export async function renderClinicsList(root) {
  root.innerHTML = `
    <div class="board-bar">
      <input class="search" id="cl-search" placeholder="Search by name or clinic id…">
      <button class="btn small" id="cl-compact" type="button">Compact</button>
      <button class="btn small" id="cl-retired" type="button">Show retired</button>
      <button class="btn primary" id="cl-new" type="button">New clinic</button>
    </div>
    <div id="cl-board"><div class="row-loading"><div class="spinner"></div>Loading clinics…</div></div>
  `;

  let rows = [];
  let search = '';
  let compact = false;
  let showRetired = false;

  root.querySelector('#cl-new').addEventListener('click', () => openNewClinicModal({ onCreated: load }));
  root.querySelector('#cl-search').addEventListener('input', (e) => {
    search = e.target.value.trim().toLowerCase();
    paint();
  });
  root.querySelector('#cl-compact').addEventListener('click', (e) => {
    compact = !compact;
    e.currentTarget.classList.toggle('on', compact);
    paint();
  });
  root.querySelector('#cl-retired').addEventListener('click', (e) => {
    showRetired = !showRetired;
    e.currentTarget.classList.toggle('on', showRetired);
    paint();
  });

  function dotTone(clinic, band) {
    if (band === 'retired') return 'mute';
    const reasons = attentionReasons(clinic);
    if (!reasons.length) return 'ok';
    // Never installed, lapsed money and a long silence are the ones worth the
    // strongest colour; a subscription ending in three weeks is not.
    const severe = reasons.some((r) => r === 'never installed' || r === 'unpaid'
      || r === 'subscription lapsed' || r === 'far behind on updates');
    return severe ? 'bad' : 'warn';
  }

  function subLine(c) {
    const bits = [c.id];
    if (c.parent_clinic_id) {
      const parent = rows.find((r) => r.id === c.parent_clinic_id);
      bits.push(`filial of ${parent ? parent.name : c.parent_clinic_id}`);
    } else if (c.filial_count > 0) {
      bits.push(`${c.filial_count} filial${c.filial_count === 1 ? '' : 's'}`);
    }
    return bits.map(esc).join(' · ');
  }

  function cardHtml(c, band) {
    const chip = versionChip(c.versions_behind);
    const sub = subscriptionBadge(c.subscription, c.subscription_until);
    const stats = c.latest_stats || {};

    const factsHtml = band === 'retired'
      ? `<div class="cc-fact"><span>Version</span><b>${esc(c.last_version || '—')}</b></div>
         <div class="cc-fact"><span>Retired</span><b>${esc(formatRetiredAt(c.retired_at))}</b></div>
         <div class="cc-fact"><span>Last seen</span><b>${esc(formatLastSeen(c.last_seen_at))}</b></div>`
      : `<div class="cc-fact"><span>Version</span><b>${esc(c.last_version || '—')}${
            chip ? ` <span class="chip ${chip.tone}">${esc(chip.label)}</span>` : ''
         }</b></div>
         <div class="cc-fact"><span>Subscription</span><b><span class="chip ${sub.tone === 'ok' ? 'ok' : 'bad'}">${esc(sub.label)}</span></b></div>
         <div class="cc-fact"><span>Last seen</span><b>${esc(formatLastSeen(c.last_seen_at))}</b></div>`;

    const statsHtml = CARD_STATS.map((s) =>
      `<div><b>${esc(formatStat(stats[s.key]))}</b>${esc(s.label)}</div>`).join('');

    const modsHtml = c.modules.length
      ? c.modules.map((m) => `<span class="mod-chip">${esc(m)}</span>`).join('')
      : '<span class="none">no modules</span>';

    return `
      <div class="cc ${band === 'attention' ? 'attention' : ''} ${band === 'retired' ? 'retired' : ''}" data-card data-id="${esc(c.id)}">
        <div class="cc-head">
          <span class="cc-dot ${dotTone(c, band)}"></span>
          <div style="min-width:0">
            <div class="cc-name">${esc(c.name)}</div>
            <div class="cc-sub">${subLine(c)}</div>
          </div>
          <button class="cc-kebab" data-menu type="button" aria-label="Actions for ${esc(c.name)}">•••</button>
        </div>
        ${factsHtml}
        <div class="cc-stats">${statsHtml}</div>
        <div class="cc-mods">${modsHtml}</div>
      </div>`;
  }

  function paint() {
    const board = root.querySelector('#cl-board');
    if (!board) return;   // navigated away while a fetch was in flight

    let visible = rows;
    if (search) {
      visible = visible.filter((c) => c.name.toLowerCase().includes(search) || c.id.toLowerCase().includes(search));
    }

    const grouped = { attention: [], live: [], retired: [] };
    for (const c of visible) grouped[clinicBand(c)].push(c);
    if (!showRetired) grouped.retired = [];

    if (visible.length === 0) {
      board.innerHTML = `<div class="card"><div class="empty">${
        rows.length === 0 ? 'No clinics yet.' : 'No clinics match this search.'
      }</div></div>`;
      return;
    }

    const deckClass = `deck${compact ? ' compact' : ''}`;
    board.innerHTML = BANDS.map(({ key, label }) => {
      const list = grouped[key];
      // The New-clinic tile lives at the end of whichever band is drawn first,
      // so it is always on screen without being a fifth thing to scan.
      const isFirst = key === BANDS.find((b) => grouped[b.key].length > 0)?.key;
      if (!list.length && !isFirst) return '';
      const newTile = isFirst
        ? `<div class="cc new" data-new><div><div style="font-size:22px;line-height:1">+</div><div style="font-size:11px;margin-top:6px">New clinic</div></div></div>`
        : '';
      return `
        <p class="band">${esc(label)}<span class="rule"></span><span class="count">${list.length}</span></p>
        <div class="${deckClass}">${list.map((c) => cardHtml(c, key)).join('')}${newTile}</div>`;
    }).join('');

    board.querySelectorAll('[data-new]').forEach((el) => {
      el.addEventListener('click', () => openNewClinicModal({ onCreated: load }));
    });
    board.querySelectorAll('[data-card]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-menu]')) return;   // the kebab is not a navigation
        location.hash = `#clinics/${encodeURIComponent(el.dataset.id)}`;
      });
    });
    board.querySelectorAll('[data-menu]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = btn.closest('[data-card]');
        const clinic = rows.find((c) => c.id === card.dataset.id);
        openCardMenu({ anchor: card, clinic, onChanged: load });
      });
    });
  }

  async function load() {
    const board = root.querySelector('#cl-board');
    try {
      const data = await cp.clinics();
      rows = data.clinics.slice().sort((a, b) => a.name.localeCompare(b.name));
      paint();
    } catch (e) {
      // A 401 is already handled by the panel-wide session-expired hook (the
      // login screen takes over); anything else must show a real message here
      // instead of leaving the spinner running forever.
      if (!(e instanceof ApiError) || e.status !== 401) {
        if (board) {
          board.innerHTML = `<div class="card"><div class="load-err">Failed to load clinics: ${esc(e.message)}<br><button class="btn small" id="cl-retry">Retry</button></div></div>`;
          const retry = root.querySelector('#cl-retry');
          if (retry) retry.addEventListener('click', load);
        }
      }
    }
  }

  await load();
}
```

- [ ] **Step 4: Verify by eye — the board will not render until Task 11 exists**

`panel-card-menu.js` is imported above and does not exist yet, so the module fails to load.
That is expected; Task 11 creates it. Do not run the panel between these two tasks.

- [ ] **Step 5: Commit**

```bash
git add control-plane/public/panel-api.js control-plane/public/panel-clinics-list.js control-plane/public/panel.css
git commit -m "feat(panel): clinics board — cards grouped by what needs a decision"
```

---

## Task 11: The ••• menu and the delete confirmation

**Files:**
- Create: `control-plane/public/panel-card-menu.js`
- Modify: `control-plane/public/panel.css` (append the menu and dialog styles)

- [ ] **Step 1: Append the styles**

```css
/* --- CONTROL_PLANE_V2: card menu + destructive confirmation ----------------- */

.cardmenu { position: absolute; top: 38px; right: 10px; z-index: 20; width: 172px;
            background: var(--bg-2); border: 1px solid var(--line); border-radius: 10px;
            box-shadow: var(--shadow); padding: 5px; }
.cardmenu button { display: block; width: 100%; text-align: left; background: none;
                   border: 0; cursor: pointer; font: inherit; font-size: 12.5px;
                   color: var(--ink); padding: 7px 10px; border-radius: 7px; }
.cardmenu button:hover { background: var(--bg-3); }
.cardmenu button.danger { color: var(--red); }
.cardmenu hr { border: 0; border-top: 1px solid var(--line); margin: 5px 0; }

.modal-back { position: fixed; inset: 0; background: rgba(42,38,33,.34);
              display: grid; place-items: center; z-index: 100; padding: 20px; }
.confirm { background: var(--bg-2); border: 1px solid var(--line); border-radius: 15px;
           padding: 22px; width: 100%; max-width: 420px; box-shadow: var(--shadow); }
.confirm h2 { margin: 0 0 8px; font-size: 17px; }
.confirm p { margin: 0 0 12px; color: var(--ink-3); font-size: 13px; line-height: 1.65; }
.confirm .keeps { background: var(--bg-3); border-radius: 10px; padding: 11px 13px;
                  font-size: 12px; color: var(--ink-2); line-height: 1.75; margin-bottom: 14px; }
.confirm .keeps b { color: var(--ink); }
.confirm input { width: 100%; padding: 10px 12px; background: var(--bg-3); color: var(--ink);
                 border: 1px solid var(--line); border-radius: 9px; font: inherit;
                 font-size: 13px; outline: none; margin-bottom: 14px; }
.confirm input:focus { border-color: var(--teal); box-shadow: 0 0 0 3px var(--accent-soft); }
.confirm .err { color: var(--red); font-size: 12.5px; min-height: 18px; margin: 0 0 8px; }
.confirm .row { display: flex; gap: 9px; justify-content: flex-end; }
.confirm .btn.danger { background: var(--red); color: var(--bg-2); border-color: var(--red); }
.confirm .btn.danger:disabled { opacity: .45; cursor: not-allowed; }
```

- [ ] **Step 2: Create `panel-card-menu.js`**

```js
// CONTROL_PLANE_PANEL_V2 — the ••• menu on a board card, and the confirmation
// in front of a permanent delete.
//
// THE ONE RULE THIS FILE ENFORCES: "Delete permanently" is offered only on a
// clinic that is ALREADY RETIRED. The server refuses anyway (routes/admin.js
// answers 409 "Retire this clinic before deleting it"), and that refusal is the
// real guarantee — this is the second copy, so the owner never sees a button
// that is going to say no.
//
// Retire and delete are two decisions, days apart if the owner likes. Nothing
// here collapses them into one click.

import { cp, ApiError } from './panel-api.js';
import { esc } from './panel-dom.js';

let openMenu = null;

function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
  document.removeEventListener('click', closeMenu);
  document.removeEventListener('keydown', onEsc);
}

function onEsc(e) { if (e.key === 'Escape') closeMenu(); }

/**
 * @param {object}   args
 * @param {Element}  args.anchor    the card element the menu hangs off
 * @param {object}   args.clinic    a row from GET /admin/clinics
 * @param {function} args.onChanged called after any action that changed the server
 */
export function openCardMenu({ anchor, clinic, onChanged }) {
  closeMenu();

  const items = clinic.active
    ? [
        { key: 'open', label: 'Open' },
        { key: 'unlock', label: 'Unlock code…' },
        { sep: true },
        { key: 'retire', label: 'Retire', danger: true },
      ]
    : [
        { key: 'open', label: 'Open' },
        { sep: true },
        { key: 'delete', label: 'Delete permanently', danger: true },
      ];

  const menu = document.createElement('div');
  menu.className = 'cardmenu';
  menu.innerHTML = items.map((it) => it.sep
    ? '<hr>'
    : `<button type="button" data-act="${it.key}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`
  ).join('');

  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeMenu();
    if (act === 'open' || act === 'unlock') {
      // Both land on the clinic page; the unlock tool lives there already.
      location.hash = `#clinics/${encodeURIComponent(clinic.id)}`;
    } else if (act === 'retire') {
      confirmRetire(clinic, onChanged);
    } else if (act === 'delete') {
      confirmDelete(clinic, onChanged);
    }
  });

  anchor.appendChild(menu);
  openMenu = menu;
  // Deferred, or this same click closes the menu it just opened.
  setTimeout(() => {
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', onEsc);
  }, 0);
}

// --- retire ------------------------------------------------------------------

async function confirmRetire(clinic, onChanged) {
  // Same wording the clinic page uses, deliberately — one sentence describing
  // what retiring does, in one place in the product's vocabulary.
  const ok = confirm(
    `Retire "${clinic.name}"? The clinic keeps working normally until its current licence runs out — this only stops it from renewing again. This cannot be undone from here.`
  );
  if (!ok) return;
  try {
    await cp.retire(clinic.id);
    onChanged();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    alert('Could not retire the clinic: ' + (e.message || 'unknown error'));
  }
}

// --- delete ------------------------------------------------------------------

function confirmDelete(clinic, onChanged) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="confirm" role="dialog" aria-modal="true" aria-labelledby="dl-title">
      <h2 id="dl-title">Delete “${esc(clinic.name)}” permanently?</h2>
      <p>This removes the clinic from your list for good. It cannot be undone from the panel.</p>
      <div class="keeps">
        <b>Kept:</b> its check-in history, as evidence for any billing question.<br>
        <b>Kept:</b> the id <b>${esc(clinic.id)}</b>, reserved forever so no old licence can ever come back to life.
      </div>
      <p style="margin-bottom:8px">Type the clinic's name to confirm:</p>
      <input id="dl-name" autocomplete="off" spellcheck="false" placeholder="${esc(clinic.name)}">
      <p class="err" id="dl-err"></p>
      <div class="row">
        <button class="btn" id="dl-cancel" type="button">Cancel</button>
        <button class="btn danger" id="dl-go" type="button" disabled>Delete permanently</button>
      </div>
    </div>`;
  document.body.appendChild(back);

  const input = back.querySelector('#dl-name');
  const go = back.querySelector('#dl-go');
  const err = back.querySelector('#dl-err');
  const close = () => back.remove();

  back.querySelector('#dl-cancel').addEventListener('click', close);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  // Typed exactly, trimmed for stray whitespace only. Not case-folded: this is
  // the last gate in front of an irreversible action, and reading the name back
  // character by character is the point of asking.
  input.addEventListener('input', () => { go.disabled = input.value.trim() !== clinic.name; });
  input.focus();

  go.addEventListener('click', async () => {
    go.disabled = true;
    err.textContent = '';
    try {
      await cp.deleteClinic(clinic.id);
      close();
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;   // session hook takes over
      // 409 messages from routes/admin.js are written as instructions ("This
      // clinic has 2 filials. Delete or reassign them first.") — shown verbatim.
      err.textContent = e.message || 'Could not delete the clinic.';
      go.disabled = false;
    }
  });
}
```

- [ ] **Step 3: Run the whole suite**

```bash
node --test $(find control-plane -name "*.test.js" -not -path "*/node_modules/*" | tr '\n' ' ')
```

Expected: 0 fail.

- [ ] **Step 4: Verify by hand, end to end**

```bash
node control-plane/server/index.js
```

At `http://localhost:8095/cp/`, sign in and confirm each of these:

1. The board shows bands, and a healthy clinic sits under **Live**.
2. ••• on a live clinic offers Retire, **not** Delete.
3. Retire it → it moves to **Retired** (visible only with *Show retired* on).
4. ••• on the retired clinic offers **Delete permanently**.
5. The dialog's button stays disabled until the name is typed exactly.
6. Delete it → the card disappears.
7. Create a new clinic → its id is the **next** number, not the deleted one.
8. Retire a clinic that has a filial, try to delete it → the dialog shows
   "This clinic has 1 filial. Delete or reassign them first." and the clinic stays.
9. **Compact** hides the stats and module rows; **Show retired** toggles the last band.

- [ ] **Step 5: Commit**

```bash
git add control-plane/public/panel-card-menu.js control-plane/public/panel.css
git commit -m "feat(panel): card menu with retire, and a typed-name delete confirmation"
```

---

## Task 12: Deploy Stage ① to the live control plane

Only after every step above is green and the hand check in Task 11 passed.
`/opt/easymed-cp` is **not** a git checkout — files are copied in.

- [ ] **Step 1: Back up code and registry**

```bash
ssh root@45.77.242.169 'cp -a /opt/easymed-cp /root/cp-backup-$(date +%Y%m%d-%H%M%S)'
ssh root@45.77.242.169 'cd /opt/easymed-cp && /opt/node24/bin/node -e "
const D=require(\"better-sqlite3\");
const db=new D(\"/var/lib/easymed-cp/registry.db\",{readonly:true});
db.backup(\"/root/registry-backup-\"+Date.now()+\".db\").then(()=>console.log(\"registry backed up\"));
"'
```

- [ ] **Step 2: Copy the changed files**

`scp`, never `ssh 'cat > file'` — the latter has been blocked by the permission layer before.

```bash
cd "control-plane"
scp server/db/migrations/010_deleted_clinics.sql root@45.77.242.169:/opt/easymed-cp/control-plane/server/db/migrations/
scp server/routes/admin.js root@45.77.242.169:/opt/easymed-cp/control-plane/server/routes/
scp public/panel.css public/panel-logic.js public/panel-api.js public/panel-clinics-list.js public/panel-card-menu.js \
    root@45.77.242.169:/opt/easymed-cp/control-plane/public/
```

- [ ] **Step 3: Restart and probe**

```bash
ssh root@45.77.242.169 'systemctl restart easymed-cp && sleep 2 && systemctl is-active easymed-cp'
ssh root@45.77.242.169 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8095/cp/'
ssh root@45.77.242.169 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8095/cp/v1/admin/clinics'
```

Expected: `active`, then `200`, then `401`.

- [ ] **Step 4: Confirm the migration applied**

```bash
ssh root@45.77.242.169 'cd /opt/easymed-cp && /opt/node24/bin/node -e "
const D=require(\"better-sqlite3\");
const db=new D(\"/var/lib/easymed-cp/registry.db\",{readonly:true});
console.log(db.prepare(\"SELECT name FROM schema_migrations ORDER BY name\").all().map(r=>r.name).join(\"\n\"));
console.log(\"trigger:\", db.prepare(\"SELECT COUNT(*) n FROM sqlite_master WHERE type=(\x27trigger\x27) AND name=(\x27clinics_no_resurrection\x27)\").get().n);
"'
```

Expected: `010_deleted_clinics.sql` listed, `trigger: 1`.

- [ ] **Step 5: Confirm in a browser**

Open `https://setting.easymed.uz/cp/`. The board should be warm and grouped, and the three
never-installed rows (`corelmed`, `Тестовая клиника`, `Dilshods Dev Server`) should sit under
**Needs attention** with the reason *never installed*. Leave them for the owner to retire and
delete — that is their first exercise of the new button.

---

## Definition of done for Stage ①

- Full control-plane suite green (452 baseline + the new tests, 0 fail).
- The hand check in Task 11, all nine points.
- Migration 010 applied on the live registry, trigger present.
- `https://setting.easymed.uz/cp/` serves the board and refuses anonymous API calls.

Stage ② (Dashboard, Updates screen, per-clinic ring and pin) and Stage ③ (Branches, Money) get
their own plans against the same spec.
