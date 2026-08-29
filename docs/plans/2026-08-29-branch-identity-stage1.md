# Branch Identity (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every branch a permanent identity — a letter that namespaces patient numbers forever, and a permanent activation key the clinic's own admin issues — so that later stages can move clinical data without any chance of two branches meaning different people by the same number.

**Architecture:** The clinic's main branch (the one holding the Easy-Med licence) allocates branch letters and issues branch keys. A secondary branch activates by pasting that key instead of enrolling with the vendor, so one subscription still covers the clinic. Because a non-enrolled branch has no `install_token` and therefore no credential the relay route accepts, the main branch mints a **relay-scoped token** from the control plane and embeds it in the branch key. Identity that SQL must read (the letter) lives in the database; network and pairing config stays in `data/branch-sync.json` as it does today.

**Tech Stack:** Node 24 ESM, better-sqlite3, Express 5, `node:test` with co-located `*.test.js`, vanilla ES-module frontend. No new dependencies.

**Source spec:** `docs/plans/2026-08-29-branch-architecture-stage2-design.md`

---

## Design decision made while writing this plan

The spec flagged an unresolved consequence: a secondary branch never enrols, so it has no `install_token`, and `control-plane/server/routes/relay.js` authenticates on exactly that. Three ways out were considered:

1. **Put the main branch's `install_token` in the branch key.** Rejected. That token is the clinic's whole vendor identity — it can check in, report statistics and accept updates. Handing it to every branch PC turns one leaked key into full impersonation of the clinic.
2. **Drop authentication and rely on the relay id being unguessable.** Rejected. The payload is authenticated by AES-GCM, so nobody can inject readable data, but anyone who learned a relay id could overwrite the blob and silently stop a clinic syncing. An unauthenticated write endpoint is not acceptable even when the data is opaque.
3. **Mint a relay-scoped token. Chosen.** The main branch — which *is* enrolled — asks the control plane for a token bound to its clinic and its relay id, and embeds it in the branch key. It grants relay access and nothing else, it is listed and revocable per clinic, and re-issuing a branch key rotates it.

## File structure

| File | Responsibility |
|---|---|
| `server/db/migrations/080_branch_identity.sql` | `branches.letter`, single-row `branch_identity`, letter-aware MRN trigger |
| `server/services/branch-sync/letters.js` | Allocate the next branch letter; never reuse |
| `server/services/branch-sync/letters.test.js` | Its tests |
| `server/services/branch-sync/identity.js` | Read/write this install's own branch identity |
| `server/services/branch-sync/identity.test.js` | Its tests |
| `server/services/branch-sync/pairing.js` (modify) | `EMB2-` key carrying letter + relay token; `EMB1-` still parses |
| `control-plane/server/routes/relay-token.js` | Mint / list / revoke relay-scoped tokens |
| `control-plane/server/db/migrations/006_relay_tokens.sql` | Their storage |
| `public/js/admin/views/branch-sync.js` (modify) | Branch list: name + permanent key |

---

### Task 1: Database — branch letters, this install's identity, letter-aware MRNs

**Files:**
- Create: `server/db/migrations/080_branch_identity.sql`
- Create: `server/db/migrations/080.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/db/migrations/080.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('the main branch is A, and a new branch gets its own letter column', () => {
  const db = freshDb();
  const main = db.prepare('SELECT letter FROM branches WHERE id = 1').get();
  assert.equal(main.letter, 'A', 'the seeded Main Branch must be A');
});

test('this install knows which branch it is, and starts as the main branch', () => {
  const db = freshDb();
  const me = db.prepare('SELECT * FROM branch_identity WHERE id = 1').get();
  assert.equal(me.letter, 'A');
  assert.equal(me.role, 'main');
});

test('a new patient MRN carries this install branch letter', () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Тестов Тест')").run();
  const p = db.prepare('SELECT mrn FROM patients ORDER BY id DESC LIMIT 1').get();
  assert.match(p.mrn, /^A-\d{2}-\d{5}$/, 'got ' + p.mrn);
});

test('an MRN supplied explicitly is never overwritten (the Excel importer relies on this)', () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Импорт', 'P-24-00777')").run();
  const p = db.prepare("SELECT mrn FROM patients WHERE full_name = 'Импорт'").get();
  assert.equal(p.mrn, 'P-24-00777');
});

test('numbering continues past legacy P- rows instead of restarting at 1', () => {
  const db = freshDb();
  const yy = String(new Date().getFullYear()).slice(2);
  db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)').run('Старый', `P-${yy}-00042`);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Новый')").run();
  const p = db.prepare("SELECT mrn FROM patients WHERE full_name = 'Новый'").get();
  assert.equal(p.mrn, `A-${yy}-00043`, 'must not collide with the legacy row');
});

test('a two-letter branch still numbers correctly (the suffix is the last 5 chars, not a fixed offset)', () => {
  const db = freshDb();
  const yy = String(new Date().getFullYear()).slice(2);
  db.prepare("UPDATE branch_identity SET letter = 'AB' WHERE id = 1").run();
  db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)').run('Первый', `AB-${yy}-00009`);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Второй')").run();
  const p = db.prepare("SELECT mrn FROM patients WHERE full_name = 'Второй'").get();
  assert.equal(p.mrn, `AB-${yy}-00010`);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/db/migrations/080.test.js`
Expected: FAIL — `no such column: letter`

- [ ] **Step 3: Write the migration**

```sql
-- 080_branch_identity.sql
-- BRANCH_IDENTITY_V1 — a branch needs an identity BEFORE any clinical data
-- moves between branches. Two installs both allocate patient id 1, so the row
-- id can never be the shared identity; patients.mrn (TEXT UNIQUE since 002) is,
-- and it becomes unique across branches by carrying the branch letter.
--
-- Design: docs/plans/2026-08-29-branch-architecture-stage2-design.md

ALTER TABLE branches ADD COLUMN letter TEXT;

-- The seeded 'Main Branch' from 002 is A. Every other letter is allocated by
-- letters.js, which never reuses one — reuse would give two different people
-- the same MRN years apart, which is the single failure this scheme exists to
-- prevent.
UPDATE branches SET letter = 'A' WHERE id = 1;
UPDATE branches SET letter = NULL WHERE id <> 1;

-- Which branch THIS install is. One row, id = 1, always present.
--
-- Why a table and not data/branch-sync.json, where the rest of the pairing
-- state lives: the MRN trigger below has to read the letter, and a trigger
-- cannot read a file. Network/pairing config stays in the file; identity that
-- SQL must see lives here.
CREATE TABLE branch_identity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  letter     TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'main' CHECK (role IN ('main','secondary')),
  branch_id  INTEGER REFERENCES branches(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO branch_identity (id, letter, role, branch_id) VALUES (1, 'A', 'main', 1);

-- Every letter ever issued. branches.letter alone cannot carry this: deleting a
-- branch would delete its letter and the next allocation would hand it out
-- again, giving two different people the same MRN years apart. Used by
-- letters.js (Task 2) and identity.js (Task 3).
CREATE TABLE branch_letters_spent (
  letter     TEXT PRIMARY KEY,
  issued_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO branch_letters_spent (letter) VALUES ('A');

-- MRN autogen, now branch-aware.
--
-- Two changes from 034, both deliberate:
--   * the prefix is this install's branch letter, not the literal 'P'.
--   * the number is read as the LAST FIVE characters, not substr(mrn, 6).
--     034 could assume a fixed offset because the prefix was always 'P-YY-'.
--     A branch letter may be 'A' or 'AB', so a fixed offset silently reads the
--     wrong digits the day a clinic passes 26 branches.
--
-- Legacy 'P-' rows are counted when picking the next number, so a clinic that
-- already has P-26-00042 gets A-26-00043 and never collides. Existing MRNs are
-- deliberately NOT renumbered: they are printed on cards patients carry.
DROP TRIGGER IF EXISTS patients_mrn_autogen;
CREATE TRIGGER patients_mrn_autogen AFTER INSERT ON patients
WHEN NEW.mrn IS NULL
BEGIN
  UPDATE patients
     SET mrn = (SELECT letter FROM branch_identity WHERE id = 1)
               || '-' || substr(strftime('%Y','now'), 3, 2) || '-'
               || substr('00000' || (
                    SELECT COALESCE(MAX(CAST(substr(mrn, -5) AS INTEGER)), 0) + 1
                      FROM patients
                     WHERE substr(mrn, -9, 4) = '-' || substr(strftime('%Y','now'), 3, 2) || '-'
                  ), -5)
   WHERE id = NEW.id;
END;
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test server/db/migrations/080.test.js`
Expected: PASS, 6/6

- [ ] **Step 5: Prove nothing else broke**

Run: `node --test server/db/migrations/*.test.js server/services/patients*.test.js`
Expected: `fail 0`

- [ ] **Step 6: Commit**

```bash
git add server/db/migrations/080_branch_identity.sql server/db/migrations/080.test.js
git commit -m "feat(branches): branch letters, this-install identity, letter-aware MRNs"
```

---

### Task 2: Allocate branch letters, never reusing one

**Files:**
- Create: `server/services/branch-sync/letters.js`
- Create: `server/services/branch-sync/letters.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/services/branch-sync/letters.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextLetter, allocateLetter } from './letters.js';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('letters run A, B, C ... Z, then AA, AB', () => {
  assert.equal(nextLetter([]), 'A');
  assert.equal(nextLetter(['A']), 'B');
  assert.equal(nextLetter(['A', 'B']), 'C');
  assert.equal(nextLetter(['Z']), 'AA');
  assert.equal(nextLetter(['AA']), 'AB');
  assert.equal(nextLetter(['AZ']), 'BA');
});

test('a letter is never reused, even when its branch is gone', () => {
  // The whole point: a reused letter gives two different people the same MRN
  // years apart, and nothing in the system would notice.
  assert.equal(nextLetter(['A', 'B', 'C']), 'D', 'not B, even if B was deleted');
});

test('allocation is driven by the highest letter ever issued, not by the count', () => {
  const db = freshDb();
  db.prepare("INSERT INTO branches (name, letter) VALUES ('Второй', 'B')").run();
  db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES ('B','issue')").run();
  db.prepare("DELETE FROM branches WHERE letter = 'B'").run();
  assert.equal(allocateLetter(db), 'C', 'B was used once and is spent forever');
});

test("a BURNED letter is skipped but does not drag the next letter past it", () => {
  // Migration 080 burns 'P': it is the prefix ~70,000 legacy MRNs already
  // carry, so a branch lettered P would mint numbers Stage 2 cannot tell apart
  // from the legacy ones. Burned is NOT issued — if it counted as issued, the
  // clinic's second branch would be 'Q' and everyone would wonder where B..O
  // went. Worse, the frozen 'B' case below would fail and the obvious fix
  // would be to delete the burn row, undoing the reason it exists.
  const db = freshDb();
  const spent = db.prepare('SELECT letter, kind FROM branch_letters_spent ORDER BY letter').all();
  assert.deepEqual(spent, [{ letter: 'A', kind: 'issue' }, { letter: 'P', kind: 'burn' }]);
  assert.equal(allocateLetter(db, { name: 'Второй' }), 'B', "burning P must not push past B");
});

test('a burned letter is never issued, even when allocation reaches it', () => {
  const db = freshDb();
  // Issue up to O, so the next candidate would be P.
  for (const l of 'BCDEFGHIJKLMNO') {
    db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES (?, 'issue')").run(l);
  }
  assert.equal(allocateLetter(db, { name: 'Шестнадцатый' }), 'Q', 'P is burned and must be stepped over');
});

test('allocateLetter writes the letter onto the branch row it creates', () => {
  const db = freshDb();
  const letter = allocateLetter(db, { name: 'Юнусабад' });
  const row = db.prepare('SELECT * FROM branches WHERE letter = ?').get(letter);
  assert.equal(row.name, 'Юнусабад');
  assert.equal(letter, 'B', 'A is the main branch');
});

test('a prefix already present in imported patient numbers is burned, not issued', () => {
  // Migration 080 can only burn the prefix THIS codebase ever generated ('P').
  // A clinic migrating from another system imports MRNs through Excel, and that
  // importer accepts arbitrary text — so 'B-24-00500' can already exist before
  // any branch is called B. Issuing B would then mint numbers colliding with
  // rows that are already printed. The migration cannot know these prefixes;
  // only allocation time can see them.
  const db = freshDb();
  db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Импорт', 'B-24-00500')").run();
  assert.equal(allocateLetter(db, { name: 'Второй' }), 'C', 'B is taken by imported data');
  const b = db.prepare("SELECT kind FROM branch_letters_spent WHERE letter = 'B'").get();
  assert.equal(b.kind, 'burn', 'and the reason is recorded, not recomputed next time');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/services/branch-sync/letters.test.js`
Expected: FAIL — `Cannot find module './letters.js'`

- [ ] **Step 3: Implement**

> **The code below is the DRAFT this task started from, kept as the record of
> what was proposed. It is NOT what shipped, and three things in it are wrong** —
> `server/services/branch-sync/letters.js` is the truth. The default argument
> `taken = issued` is a provable no-op that silently means "ignore every burn",
> and calling `nextLetter` with one argument returns `P` — the one letter the
> module exists never to hand out. The recursion is bounded only by however many
> poisoned prefixes an old system's Excel export happened to contain. And the
> `substr(...)` prefix probe full-scans the covering index: measured at 3.3 ms
> against 0.004 ms for a range seek on 70,000 rows. The shipped file argues all
> three out at length. Do not copy from here.

```js
// server/services/branch-sync/letters.js
//
// BRANCH_IDENTITY_V1 — the letter that namespaces a branch's patient numbers.
//
// A letter is SPENT the moment it is issued and is never handed out again, even
// after the branch that held it is deleted. Reuse would let two different people
// carry the same MRN years apart, and no part of the system would flag it — the
// numbers would simply be equal. Allocation is therefore driven by the highest
// letter ever recorded, not by how many branches currently exist.

const A = 'A'.charCodeAt(0);

// Spreadsheet-column ordering: A..Z, AA..AZ, BA.. — chosen because it stays
// short (one character for the first 26 branches, which is every clinic we
// have) and because everyone already reads it without explanation.
function toIndex(letter) {
  let n = 0;
  for (const ch of String(letter).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - A + 1);
  return n;
}

function fromIndex(n) {
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(A + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// `issued` drives WHERE WE ARE; `taken` is everything the ledger holds at all.
//
// The two differ because migration 080 BURNS 'P' — the prefix ~70,000 legacy
// MRNs already carry — without it ever having been a branch. If a burn counted
// as issued, the highest would be P and a clinic's SECOND branch would be
// lettered Q, silently skipping B..O.
export function nextLetter(issued, taken = issued) {
  const highest = (issued || []).reduce((max, l) => Math.max(max, toIndex(l)), 0);
  const blocked = new Set((taken || []).map((l) => String(l).toUpperCase()));
  let n = highest + 1;
  while (blocked.has(fromIndex(n))) n += 1;   // step over burns
  return fromIndex(n);
}

// `branch_letters_spent` records every letter ever issued, so a deleted branch
// cannot free its letter. branches.letter alone would not do: DELETE removes it.
export function allocateLetter(db, { name = '' } = {}) {
  const rows = db.prepare('SELECT letter, kind FROM branch_letters_spent').all();
  const letter = nextLetter(
    rows.filter((r) => r.kind === 'issue').map((r) => r.letter),
    rows.map((r) => r.letter),
  );

  // A prefix that already exists in this database's own patient numbers must
  // never become a branch letter: an Excel import can carry in MRNs from a
  // clinic's previous system, and 080 cannot know which prefixes those are.
  // Recorded as a burn so the knowledge accumulates in one place instead of
  // being recomputed on every allocation.
  //
  // NOTE (Stage 2): this must eventually check the FLEET's MRNs, not only this
  // install's. A poisoned prefix can sit in a SECONDARY branch's imported rows,
  // and the main branch — which allocates — would not see it here.
  const clash = db.prepare(
    "SELECT 1 FROM patients WHERE mrn IS NOT NULL AND substr(mrn, 1, length(?) + 1) = ? || '-' LIMIT 1",
  ).get(letter, letter);
  if (clash) {
    db.prepare("INSERT OR IGNORE INTO branch_letters_spent (letter, kind) VALUES (?, 'burn')").run(letter);
    return allocateLetter(db, { name });
  }

  db.transaction(() => {
    db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES (?, 'issue')").run(letter);
    if (name) db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)').run(name, letter);
  })();
  return letter;
}
```

- [ ] **Step 4: Run tests**

`branch_letters_spent` already exists — it was created in Task 1's migration, deliberately. Do **not** add it here by appending to `080_branch_identity.sql`: migrations in this repo are permanent, `migrate.js` records which have run, and an edit to an already-applied file simply never executes. Anyone who had started dev between Task 1 and Task 2 would end up with the table missing and a confusing `no such table` at runtime. If you find something genuinely missing from 080 after it has been applied anywhere, take `081_`.

Run: `node --test server/services/branch-sync/letters.test.js server/db/migrations/080.test.js`
Expected: PASS, all

- [ ] **Step 5: Commit**

```bash
git add server/services/branch-sync/letters.js server/services/branch-sync/letters.test.js
git commit -m "feat(branches): allocate branch letters, never reusing a spent one"
```

---

### Task 3: This install's own identity

**Files:**
- Create: `server/services/branch-sync/identity.js`
- Create: `server/services/branch-sync/identity.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/services/branch-sync/identity.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readIdentity, becomeSecondary } from './identity.js';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('a fresh install is the main branch, letter A', () => {
  const db = freshDb();
  assert.deepEqual(readIdentity(db), { letter: 'A', role: 'main', branch_id: 1 });
});

test('becoming a secondary branch adopts the letter the main branch issued', () => {
  const db = freshDb();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  const me = readIdentity(db);
  assert.equal(me.letter, 'C');
  assert.equal(me.role, 'secondary');
});

test('new patients here are numbered with the adopted letter', () => {
  const db = freshDb();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run();
  const p = db.prepare('SELECT mrn FROM patients ORDER BY id DESC LIMIT 1').get();
  assert.match(p.mrn, /^C-\d{2}-\d{5}$/, 'got ' + p.mrn);
});

test('adopting a letter twice is refused - an install has ONE identity', () => {
  const db = freshDb();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  assert.throws(() => becomeSecondary(db, { letter: 'D', name: 'Другой' }), /already/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/services/branch-sync/identity.test.js`
Expected: FAIL — `Cannot find module './identity.js'`

- [ ] **Step 3: Implement**

```js
// server/services/branch-sync/identity.js
//
// BRANCH_IDENTITY_V1 — which branch THIS install is.
//
// Read from the database rather than data/branch-sync.json because the MRN
// trigger (migration 080) needs the letter and a trigger cannot read a file.
// The file keeps what only JavaScript reads: addresses, secrets, keys.

export function readIdentity(db) {
  const row = db.prepare('SELECT letter, role, branch_id FROM branch_identity WHERE id = 1').get();
  return { letter: row.letter, role: row.role, branch_id: row.branch_id };
}

// Called once, when an install is activated with a branch key.
//
// Refused if this install already became a secondary branch. Changing identity
// under a database that already has patients would leave rows numbered with a
// letter this install no longer claims — two branches would then both believe
// they own those MRNs, which is precisely the collision the letter prevents.
export function becomeSecondary(db, { letter, name }) {
  const me = readIdentity(db);
  if (me.role === 'secondary') {
    throw new Error('This install is already branch ' + me.letter + ' and cannot change identity.');
  }
  db.transaction(() => {
    const info = db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)').run(name || letter, letter);
    db.prepare('INSERT OR IGNORE INTO branch_letters_spent (letter) VALUES (?)').run(letter);
    db.prepare("UPDATE branch_identity SET letter = ?, role = 'secondary', branch_id = ? WHERE id = 1")
      .run(letter, info.lastInsertRowid);
  })();
  return readIdentity(db);
}
```

- [ ] **Step 4: Run tests**

Run: `node --test server/services/branch-sync/identity.test.js`
Expected: PASS, 4/4

- [ ] **Step 5: Commit**

```bash
git add server/services/branch-sync/identity.js server/services/branch-sync/identity.test.js
git commit -m "feat(branches): this install knows which branch it is"
```

---

### Task 4: Relay-scoped tokens on the control plane

**Files:**
- Create: `control-plane/server/db/migrations/006_relay_tokens.sql`
- Create: `control-plane/server/routes/relay-token.js`
- Create: `control-plane/server/routes/relay-token.route.test.js`
- Modify: `control-plane/server/app.js` (mount it beside the relay route)
- Modify: `control-plane/server/routes/relay.js` (accept a relay token as well as an install token)

- [ ] **Step 1: Write the failing test**

```js
// control-plane/server/routes/relay-token.route.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApp } from '../app.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';

// Helpers mirror relay.route.test.js so the two read alike.
function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    srv.unref();
  });
}
const url = (srv, p) => `http://127.0.0.1:${srv.address().port}${p}`;

test('an enrolled clinic can mint a relay token for its own relay id', async (t) => {
  const { srv, installToken, relayId } = await harness(t);
  const res = await fetch(url(srv, '/cp/v1/relay-token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${installToken}` },
    body: JSON.stringify({ relay_id: relayId }),
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.match(json.token, /^[A-Za-z0-9_-]{32,}$/);
});

test('a relay token opens the relay, and nothing else', async (t) => {
  const { srv, installToken, relayId } = await harness(t);
  const mint = await (await fetch(url(srv, '/cp/v1/relay-token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${installToken}` },
    body: JSON.stringify({ relay_id: relayId }),
  })).json();

  const ok = await fetch(url(srv, `/cp/v1/relay/${relayId}`), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${mint.token}`, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('ciphertext'),
  });
  assert.equal(ok.status, 204, 'the relay accepts it');

  const denied = await fetch(url(srv, '/cp/v1/checkin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mint.token}` },
    body: JSON.stringify({}),
  });
  assert.equal(denied.status, 401, 'check-in must NOT accept a relay token');
});

test('a relay token cannot be used on a different relay id', async (t) => {
  const { srv, installToken, relayId } = await harness(t);
  const mint = await (await fetch(url(srv, '/cp/v1/relay-token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${installToken}` },
    body: JSON.stringify({ relay_id: relayId }),
  })).json();
  const other = 'f'.repeat(32);
  const res = await fetch(url(srv, `/cp/v1/relay/${other}`), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${mint.token}`, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('x'),
  });
  assert.equal(res.status, 401);
});

test('a revoked token stops working immediately', async (t) => {
  const { srv, db, installToken, relayId } = await harness(t);
  const mint = await (await fetch(url(srv, '/cp/v1/relay-token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${installToken}` },
    body: JSON.stringify({ relay_id: relayId }),
  })).json();
  db.prepare('UPDATE relay_tokens SET revoked_at = ?').run(new Date().toISOString());
  const res = await fetch(url(srv, `/cp/v1/relay/${relayId}`), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${mint.token}`, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('x'),
  });
  assert.equal(res.status, 401);
});

// Builds an enrolled clinic exactly the way relay.route.test.js does; copy that
// file's harness verbatim rather than inventing a second one, so the two tests
// cannot drift about what "an enrolled clinic" means.
async function harness(t) {
  const db = openDb(':memory:');
  migrate(db);
  const installToken = 'tok-' + Math.random().toString(36).slice(2);
  db.prepare("INSERT INTO clinics (clinic_id, name, install_token, active) VALUES ('c-000001','Тест',?,1)")
    .run(installToken);
  const srv = await listen(createApp(db));
  t.after(() => srv.close());
  return { db, srv, installToken, relayId: 'a'.repeat(32) };
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test control-plane/server/routes/relay-token.route.test.js`
Expected: FAIL — 404 on `/cp/v1/relay-token`

- [ ] **Step 3: Write the migration**

```sql
-- 006_relay_tokens.sql
-- BRANCH_IDENTITY_V1 — a credential a SECONDARY branch can use on the relay.
--
-- Why this exists: a secondary branch never enrols, so it has no install_token,
-- and routes/relay.js authenticates on exactly that. The alternatives were to
-- hand every branch the clinic's install_token (which would let any branch PC
-- impersonate the clinic completely) or to drop authentication and trust the
-- relay id to be unguessable (which would let anyone who learned one silently
-- stop a clinic syncing). Neither is acceptable, so the main branch mints a
-- token scoped to ONE relay id and to nothing else.
CREATE TABLE relay_tokens (
  token      TEXT PRIMARY KEY,
  clinic_id  TEXT NOT NULL REFERENCES clinics(clinic_id),
  relay_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_used  TEXT,
  revoked_at TEXT
);
CREATE INDEX relay_tokens_clinic ON relay_tokens (clinic_id);
```

- [ ] **Step 4: Write the route**

```js
// control-plane/server/routes/relay-token.js
//
// BRANCH_IDENTITY_V1 — mint a relay-scoped credential for a secondary branch.
//
// Presented by: the MAIN branch, with its install_token (it is the enrolled
// one). Used by: a secondary branch, which has no vendor identity of its own.
// The token reaches that branch inside the hand-carried branch key and never
// through this server.
import express from 'express';
import crypto from 'node:crypto';

export const RELAY_TOKEN_MOUNT = '/cp/v1/relay-token';

const RELAY_ID_RE = /^[0-9a-f]{32}$/;
const GENERIC_FAILURE_BODY = {
  error: { code: 'invalid_token', message: 'This install is not recognised.' },
};

function bearerToken(header) {
  const m = /^Bearer[ \t]+(\S+)$/i.exec(String(header || ''));
  return m ? m[1] : null;
}

export function relayTokenRouter(db) {
  const router = express.Router();

  router.post('/', express.json({ limit: '4kb' }), (req, res) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) return res.status(401).json(GENERIC_FAILURE_BODY);

    // Only an ENROLLED clinic may mint. Same generic 401 as checkin.js for
    // unknown/deactivated/malformed, so nobody can probe which tokens are live.
    const clinic = db.prepare('SELECT clinic_id FROM clinics WHERE install_token = ? AND active = 1').get(token);
    if (!clinic) return res.status(401).json(GENERIC_FAILURE_BODY);

    const relayId = String(req.body?.relay_id || '');
    if (!RELAY_ID_RE.test(relayId)) {
      return res.status(400).json({ error: { code: 'bad_relay_id', message: 'relay_id must be 32 hex characters.' } });
    }

    const minted = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO relay_tokens (token, clinic_id, relay_id) VALUES (?, ?, ?)')
      .run(minted, clinic.clinic_id, relayId);
    res.status(201).json({ token: minted, relay_id: relayId });
  });

  return router;
}

// Used by routes/relay.js. Returns the clinic_id this token may act for on this
// relay id, or null. Scoped deliberately: a token for one relay id is worthless
// on another, so a leaked branch key cannot reach another clinic's data.
export function clinicForRelayToken(db, token, relayId) {
  const row = db.prepare(
    'SELECT clinic_id FROM relay_tokens WHERE token = ? AND relay_id = ? AND revoked_at IS NULL',
  ).get(token, relayId);
  if (!row) return null;
  db.prepare('UPDATE relay_tokens SET last_used = ? WHERE token = ?').run(new Date().toISOString(), token);
  return row.clinic_id;
}
```

- [ ] **Step 5: Teach the relay route to accept it**

In `control-plane/server/routes/relay.js`, where the install token is looked up, fall back to a relay token **for this relay id only**:

```js
import { clinicForRelayToken } from './relay-token.js';

// ... inside the handler, after `const token = bearerToken(req.headers.authorization)`
// and after the existing clinics lookup fails:
const viaRelayToken = clinicForRelayToken(db, token, relayId);
if (!viaRelayToken) return res.status(401).json(GENERIC_FAILURE_BODY);
```

Mount the new router in `control-plane/server/app.js` next to the existing relay mount:

```js
import { relayTokenRouter, RELAY_TOKEN_MOUNT } from './routes/relay-token.js';
app.use(RELAY_TOKEN_MOUNT, relayTokenRouter(db));
```

- [ ] **Step 6: Run tests**

Run: `node --test control-plane/server/routes/relay-token.route.test.js control-plane/server/routes/relay.route.test.js`
Expected: PASS, both files, `fail 0`

- [ ] **Step 7: Commit**

```bash
git add control-plane/server/db/migrations/006_relay_tokens.sql control-plane/server/routes/relay-token.js control-plane/server/routes/relay-token.route.test.js control-plane/server/routes/relay.js control-plane/server/app.js
git commit -m "feat(cp): relay-scoped tokens so a non-enrolled branch can use the relay"
```

---

### Task 5: The branch key carries letter and relay token

**Files:**
- Modify: `server/services/branch-sync/pairing.js` (`encodeKey`, `parseKey`)
- Modify: `server/services/branch-sync/pairing.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to server/services/branch-sync/pairing.test.js
test('EMB2 keys carry the branch letter and the relay token', () => {
  const key = encodeKey({
    group_id: 'g1', secret: 's1', main_url: 'http://10.0.0.5:8000',
    group_key: 'k'.repeat(43), letter: 'C', relay_token: 'rt-abc',
  });
  assert.match(key, /^EMB2-/);
  const parsed = parseKey(key);
  assert.equal(parsed.letter, 'C');
  assert.equal(parsed.relay_token, 'rt-abc');
});

test('an EMB1 key from an older release still parses, with no letter', () => {
  // Clinics paired before this release hold EMB1 keys. Refusing them would
  // silently un-pair every existing branch on upgrade.
  const legacy = encodeLegacyV1({ group_id: 'g1', secret: 's1', main_url: 'http://10.0.0.5:8000' });
  const parsed = parseKey(legacy);
  assert.equal(parsed.group_id, 'g1');
  assert.equal(parsed.letter, null, 'no letter in a v1 key - the caller must allocate one');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/services/branch-sync/pairing.test.js`
Expected: FAIL — `parsed.letter` is `undefined`

- [ ] **Step 3: Implement — add the fields, keep v1 parsing**

In `pairing.js`, extend `encodeKey` to emit an `EMB2-` prefix carrying `letter` and `relay_token` alongside the existing fields, and extend `parseKey` to accept **both** prefixes, returning `letter: null` and `relay_token: null` for a v1 key. Keep the v1 encoder available to tests as `encodeLegacyV1` so the back-compatibility test has something to build with.

```js
// pairing.js — comment to carry with the change
// KEY FORMAT v2. EMB1 keys are still accepted on purpose: every clinic paired
// before this release holds one, and refusing them would un-pair every existing
// branch the moment the update installed. A v1 key yields letter: null, and the
// caller allocates a letter then — the branch is no less identified, it simply
// learns its letter at activation instead of from the key.
```

- [ ] **Step 4: Run tests**

Run: `node --test server/services/branch-sync/pairing.test.js server/services/branch-sync/sync-e2e.test.js server/services/branch-sync/relay-e2e.test.js`
Expected: PASS, `fail 0` — the existing pairing and both end-to-end suites must be untouched by this

- [ ] **Step 5: Commit**

```bash
git add server/services/branch-sync/pairing.js server/services/branch-sync/pairing.test.js
git commit -m "feat(branches): branch key carries letter and relay token; EMB1 still parses"
```

---

### Task 6: The branch list shows name and permanent key

**Files:**
- Modify: `public/js/admin/views/branch-sync.js`
- Modify: `public/js/admin/branch-sync-logic.js`
- Modify: `public/js/admin/__tests__/branch-sync-logic.test.mjs`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: Write the failing test**

```js
// append to public/js/admin/__tests__/branch-sync-logic.test.mjs
test('the branch list gives every branch a name and a key that is always readable', () => {
  const rows = branchRows({ branches: [
    { name: 'Главный', letter: 'A', key: null, is_self: true },
    { name: 'Чиланзар', letter: 'B', key: 'EMB2-xxxx' },
  ] });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].key, 'EMB2-xxxx');
  assert.equal(rows[0].key, null, 'the main branch has no key to join itself');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test public/js/admin/__tests__/branch-sync-logic.test.mjs`
Expected: FAIL — `branchRows is not defined`

- [ ] **Step 3: Implement `branchRows` and render it**

Render each branch as *name · letter · key*, with the key selectable text and a copy button — **never** hidden behind a "show once" reveal. Add every new string to `i18n-strings.js` and read it through `tr()`, never `t()`.

Re-issuing a key must warn **before** acting, in these words:

> Перевыпуск ключа отключит все филиалы, подключённые старым ключом. Их придётся подключить заново.

- [ ] **Step 4: Run tests**

Run: `node --test public/js/admin/__tests__/branch-sync-logic.test.mjs`
Expected: PASS

- [ ] **Step 5: Look at it**

Run `npm start`, open `http://localhost:8000/admin.html#branch-sync`. Confirm: every branch shows a name and a readable key; the main branch shows no key; re-issue warns first. Stop the server with `Ctrl+C` or `stop-easymed.bat`.

- [ ] **Step 6: Bump the cache tag and commit**

```bash
git add public/js/admin/views/branch-sync.js public/js/admin/branch-sync-logic.js public/js/admin/__tests__/branch-sync-logic.test.mjs public/js/admin/i18n-strings.js
git commit -m "feat(branches): branch list shows name and a permanently readable key"
```

---

### Task 7: Whole-suite gate

- [ ] **Step 1: Run everything**

Run: `npm test`
Expected: `fail 0`. Anything else stops the stage — do not push a red suite.

- [ ] **Step 2: Confirm the three invariants by hand**

```bash
# a legacy MRN still round-trips
node --test server/db/migrations/080.test.js
# Route A and Route B both still work end to end
node --test server/services/branch-sync/sync-e2e.test.js server/services/branch-sync/relay-e2e.test.js
# the vendor still cannot read a relayed payload
node --test control-plane/server/routes/relay.route.test.js
```

- [ ] **Step 3: Push (pushing is NOT releasing)**

```bash
git push origin main
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| One licence per clinic; secondary joins by branch key | 3, 5 |
| Branch key permanent and listed on screen | 6 |
| Re-issuing a key warns before un-pairing | 6 |
| Branch letter allocated by the main branch, never reused | 2 |
| Letter format must not assume one character | 1, 2 |
| MRN gains the branch letter | 1, 3 |
| ~70,000 existing MRNs are not renumbered | 1 |
| Row ids stay local, remapped on arrival | *Stage 2 — no clinical data moves here* |
| Secondary branch needs a relay credential | 4, 5 |
| No clinical data moves in this stage | held: nothing here syncs patients |

**Deliberately out of scope**, and why: field-level conflict resolution, the append-only money model, and patient matching all belong to later stages. Building them now would mean writing merge rules before a single branch key has been exchanged in a real clinic.

**One thing that looks like scope creep but is not:** lettered MRNs (Task 1) move no clinical data, yet they must land in this stage. A patient created at a secondary branch *before* the letter exists would be numbered as if it were the main branch, and that number is already printed by the time Stage 2 arrives to fix it.

---

## Added during execution: the `already_numbered` dead end, and its way out

Task 3 refuses to adopt a branch letter when this install has already MINTED
patient numbers under its own letter. That refusal is correct — those numbers are
printed on cards, migration 080 forbids renumbering them, and leaving them as
`A-…` while the real branch A goes on minting its own `A-…` for different people
is exactly the collision the letter exists to prevent.

But as shipped the refusal is **terminal**. A building that ran the system
standalone for a week and then activates as branch C is stuck between "cannot
renumber" and "fresh install, discard the week". That is not an acceptable answer
to give an owner, so Task 6 must carry the way out.

**A consented one-time renumber at adoption is safe here, and only here.** The
letter has just been issued to this install and the ledger guarantees single
issue, so moving numbers OUT of a namespace this install never owned and INTO one
it now owns exclusively cannot collide with anything, fleet-wide. Two facts
verified during Task 3 make it cheap rather than sprawling: **no table stores a
copy of `mrn`** — every consumer reads it through a join — so it is one UPDATE,
not a fan-out; and Stage 1 syncs no patients, so no other install has yet seen
the numbers being changed.

What it requires, and why it is work rather than a one-liner:

- a column for the superseded number (`patients.mrn_previous`), included in
  patient search, so someone presenting last week's card is still found;
- the UPDATE inside the SAME transaction as the adoption;
- consent that names the count — «52 номера пациентов изменятся с A- на C-;
  эти карты нужно перепечатать» — because the cost is real and local, and the
  owner is the one who pays it.

`reason: 'already_numbered'` is the hook for that screen.

> **RESOLVED DIFFERENTLY, 2026-08-29, after this was written.** The line that
> stood here said the activation flow must not ship without the renumber. That
> was wrong on scope: a renumber REWRITES patient numbers, which is clinical
> data mutation, and Stage 1's whole boundary is that no clinical data moves.
> Building it here would have broken the one promise that makes this stage
> reviewable.
>
> What shipped instead is an honest refusal. `rpc/branch-sync.js` answers
> `already_numbered` with Russian that tells the owner exactly what happened,
> offers the one remedy that IS available today (a clean reinstall, if this is
> a new branch PC), and sends them to support for the case where the patients
> are real — rather than promising a button that does not exist. The renumber
> belongs to Stage 2, alongside the patient sync it exists to serve.
