# Easy-Med Licensing Core (Plan 1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clinic install that reads a cryptographically signed licence file, locks paid modules it has not bought, locks all writes when the licence expires, and can be unlocked over the telephone — all working with no network at all.

**Architecture:** A licence is a small JSON document signed with Ed25519. The public key is compiled into the app; the private key lives only with the vendor. The install verifies the signature, derives a lock state from `valid_until` versus a tamper-resistant clock, and enforces that state in the two places every write already passes through (`routes/db.js` and `routes/rpc.js`). The browser gets the same state from `/api/auth/me` and uses it to mark and route unlicensed modules. Nothing in this plan talks to a network — licences are issued by a CLI and delivered by hand, which is enough to license the first clinics.

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3, `node:crypto` (Ed25519 + HMAC — **no new dependencies**), `node:test`. Vanilla ES-module frontend, no build step.

**Spec:** `docs/specs/2026-08-20-control-plane-design.md`

---

## Context for the implementer — read this first

- **Everything is offline.** Never add a CDN import or a network call. This plan adds none.
- **`node --test` auto-discovers `*.test.js`.** Run the whole suite with `npm test`. The baseline
  is **1100 passing, 0 failing** — if your change makes that number go down, you broke something.
- **On Windows, invoke `node --test` with no path argument** (the directory-argument form is
  broken on Node 24/Windows). `npm test` already does this correctly.
- **Comment style matters here.** This codebase's comments explain *the bug that caused the line
  to exist*. The project has no git history before 2026-08-20, so comments are the only record.
  Match that style — explain why, not what.
- **Never `git add -A` or `git add .`** Add only the explicit paths listed in each commit step.
- **UI language is Russian.** Strings go through `public/js/admin/i18n-strings.js` (UZ/RU/EN).
- **No emojis in the UI, ever.** Icons come from `public/js/admin/icons.js`.

### Facts verified against the codebase (do not re-derive these)

| Fact | Location |
|---|---|
| Highest migration is `072_telegram_chat_files.sql` → **yours is `073`** | `server/db/migrations/` |
| Migrations apply in **filename sort order**, tracked by full filename | `server/db/migrate.js:23-38` |
| `compile()` returns `meta.op` = `select`/`insert`/`upsert`/`update`/`delete` | `server/db/query-compiler.js` |
| Every table write goes through one route handler | `server/routes/db.js:11` |
| Every RPC goes through one route handler; guards live *inside* handlers, not on the route | `server/routes/rpc.js:13` |
| Session → `req.user` on every request | `server/middleware/auth.js:26` (`attachUser`) |
| `GET /api/auth/me` is the boot payload, but `db-auth.js` keeps only its `user` key | `server/routes/auth.js:60`, `public/js/db-auth.js` |
| Client module gate | `public/js/admin/permissions.js:263` (`isModuleAllowed`) |
| Client route gate | `public/js/admin/permissions.js:305` (`isRouteAllowed`) |
| Sidebar filters on `isModuleAllowed(item.id)` | `public/js/admin.js:955` |
| Route dispatch checks `isRouteAllowed(viewName)` | `public/js/admin.js:772` |
| Data directory | `server/index.js:13` and `server/app.js:37` |
| Ed25519 signature is 64 bytes; `crypto.sign(null, …)` — the algorithm argument **must** be `null` | verified in this Node build |

### Two design constraints you must not "improve"

1. **The write gate fails closed.** Unknown RPCs are blocked while locked. When someone adds an
   RPC six months from now and forgets this file, the safe outcome is that it is blocked during a
   lapse — not that it silently becomes a hole.
2. **A licensing failure must never stop the app from booting.** A missing, corrupt or unreadable
   licence file means *unlicensed*, never *crash*. There is a test for this.

### Honest limitation, recorded on purpose

The phone-unlock secret lives on the clinic's own computer, because the clinic must be able to
verify an unlock code with no internet. Anyone who extracts that secret can mint their own unlock
codes. This is inherent to offline telephone activation — the alternative, a full Ed25519
signature, is 103 characters to read aloud. Rate-limiting makes casual abuse impractical;
a determined operator with file access wins, exactly as recorded in spec §12 risk 4. Do not
"fix" this with obfuscation.

---

## File structure

```
server/
  db/
    migrate.js                          MODIFY  — duplicate-prefix guard
    migrate.test.js                     MODIFY  — its test
    migrations/073_licensing.sql        CREATE  — control_state, module_requests
    migrations/073.test.js              CREATE
  services/control/
    config.js                           CREATE  — where the data directory lives
    canonical.js                        CREATE  — deterministic JSON for signing
    canonical.test.js                   CREATE
    licence.js                          CREATE  — verify a signed licence
    licence.test.js                     CREATE
    clock.js                            CREATE  — tamper-resistant "now"
    clock.test.js                       CREATE
    ladder.js                           CREATE  — pure lock-state machine
    ladder.test.js                      CREATE
    unlock.js                           CREATE  — phone challenge/response
    unlock.test.js                      CREATE
    state.js                            CREATE  — assembles the whole picture
    state.test.js                       CREATE
    gate.js                             CREATE  — the write/module gate
    gate.test.js                        CREATE
  routes/
    db.js                               MODIFY  — block writes when locked
    rpc.js                              MODIFY  — block mutating RPCs when locked
    auth.js                             UNTOUCHED — see Task 11 Step 5 for why
    licence-gate.test.js                CREATE  — end-to-end gate tests
  services/rpc/
    licence.js                          CREATE  — licence_status, module_request, licence_unlock
    licence.test.js                     CREATE
    index.js                            MODIFY  — register them
scripts/
  make-licence.mjs                      CREATE  — vendor CLI: keygen, enroll, sign
public/js/admin/
  licence.js                            CREATE  — client-side licence state
  licensed-modules.js                   CREATE  — nav id → licence key + sales copy
  permissions.js                        MODIFY  — add isModuleLicensed()
  i18n-strings.js                       MODIFY  — the new strings
  views/locked-module.js                CREATE  — the sales screen
  views/activation.js                   CREATE  — the lapsed-subscription screen
admin.js                                MODIFY  — lock markers + routing
```

**Why so many small files:** each one has a single responsibility and its own test. `ladder.js`
is a pure function of four inputs with no I/O, so its fourteen cases are trivial to test; if it
were folded into `state.js` they would need a database.

---

### Task 1: Guard against duplicate migration prefixes

The predecessor collided three migrations on `071_` and two on `058_`, which silently made their
relative order alphabetical rather than intentional. This plan adds migration 073 and later plans
add more, delivered remotely — so the guard comes first.

**Files:**
- Modify: `server/db/migrate.js`
- Test: `server/db/migrate.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/db/migrate.test.js`:

```js
test('refuses to run when two migrations share a number prefix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-mig-'));
  fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
  fs.writeFileSync(path.join(dir, '001_b.sql'), 'CREATE TABLE b (id INTEGER);');
  const db = new Database(':memory:');
  assert.throws(() => migrate(db, dir), /Duplicate migration number: 001/);
  // and nothing was applied
  const applied = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('a','b')").get();
  assert.equal(applied.n, 0);
});
```

Make sure the top of the file imports what this needs (`fs`, `os`, `path`, `Database`, `migrate`,
`test`, `assert`); add any that are missing.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/db/migrate.test.js`
Expected: FAIL — no error is thrown, both tables get created.

- [ ] **Step 3: Add the guard**

In `server/db/migrate.js`, inside `migrate()`, immediately after the existing filename-format loop
(the one that throws `Bad migration filename`), add:

```js
  // DUP_MIGRATION_GUARD_V1 — two files sharing a number prefix sort against each
  // other ALPHABETICALLY, not by intent. That is survivable while a human watches
  // one machine; it is not survivable once releases are delivered to clinics
  // remotely, which is where this project is going.
  //
  // The 058 and 071 groups below are grandfathered because they CANNOT be fixed.
  // schema_migrations records the FULL FILENAME, so renaming an applied migration
  // makes it look new and re-runs it — and 071_dedupe_lab_results.sql opens with
  // `DELETE FROM lab_results`, while 071_queue_local_day_backfill.sql and
  // 058_referral_source_person.sql both open with UPDATE. Renaming them to tidy up
  // the numbering would wipe real clinical data on every install that already has
  // them. They are applied, their order is settled, and they are left alone.
  //
  // Nothing may join this set. It is a record of damage already done, not a
  // mechanism for permitting more.
  const GRANDFATHERED_COLLISIONS = new Set(['058', '071']);

  const byNumber = new Map();
  for (const file of files) {
    const num = file.slice(0, file.indexOf('_'));
    if (GRANDFATHERED_COLLISIONS.has(num)) continue;
    if (byNumber.has(num)) {
      throw new Error(`Duplicate migration number: ${num} (${byNumber.get(num)} and ${file})`);
    }
    byNumber.set(num, file);
  }
```

- [ ] **Step 4: Pin the exemption with a second test, then run both**

The grandfather list is exactly the sort of thing a future reader tidies away. Append to
`server/db/migrate.test.js`:

```js
test('the real migrations directory still runs despite its historical collisions', () => {
  // 058 and 071 collide and are deliberately grandfathered — see the comment in
  // migrate.js. If this test fails, someone removed the exemption, and every
  // existing clinic would refuse to start.
  const db = new Database(':memory:');
  assert.doesNotThrow(() => migrate(db));
});
```

Run: `node --test server/db/migrate.test.js`
Expected: PASS, both tests.

- [ ] **Step 5: Run the whole suite — the existing migrations must still be legal**

Run: `npm test`
Expected: **1101 passing, 0 failing.**

If it reports `Duplicate migration number` for any number other than 058 or 071, someone has added
a colliding migration since this plan was written. **Renumber the new file — never an applied
one.** Renaming a migration that any install has already run makes it look new and re-runs it,
which for a `DELETE` or `UPDATE` migration destroys data.

- [ ] **Step 6: Commit**

```bash
git add server/db/migrate.js server/db/migrate.test.js
git commit -m "fix: refuse to migrate when two files share a number prefix"
```

---

### Task 2: Migration 073 — licensing tables

**Files:**
- Create: `server/db/migrations/073_licensing.sql`
- Test: `server/db/migrations/073.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/db/migrations/073.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { migrate } from '../migrate.js';

const fresh = () => { const db = new Database(':memory:'); migrate(db); return db; };

test('073 creates control_state as a key/value store', () => {
  const db = fresh();
  db.prepare("INSERT INTO control_state (key, value) VALUES ('clock_high_water', '2026-08-20T00:00:00Z')").run();
  const row = db.prepare("SELECT value FROM control_state WHERE key = 'clock_high_water'").get();
  assert.equal(row.value, '2026-08-20T00:00:00Z');
});

test('073 control_state keys are unique', () => {
  const db = fresh();
  db.prepare("INSERT INTO control_state (key, value) VALUES ('k', '1')").run();
  assert.throws(
    () => db.prepare("INSERT INTO control_state (key, value) VALUES ('k', '2')").run(),
    /UNIQUE|PRIMARY KEY/
  );
});

test('073 records module access requests with who and when', () => {
  const db = fresh();
  const uid = db.prepare("SELECT id FROM users LIMIT 1").get()?.id ?? null;
  db.prepare('INSERT INTO module_requests (module_key, requested_by) VALUES (?, ?)').run('marketing', uid);
  const row = db.prepare('SELECT * FROM module_requests').get();
  assert.equal(row.module_key, 'marketing');
  assert.ok(row.requested_at, 'requested_at defaults to now');
  assert.equal(row.sent_at, null, 'not yet reported to the vendor');
});

test('073 keeps only one open request per module', () => {
  const db = fresh();
  db.prepare('INSERT INTO module_requests (module_key) VALUES (?)').run('crm');
  assert.throws(
    () => db.prepare('INSERT INTO module_requests (module_key) VALUES (?)').run('crm'),
    /UNIQUE/,
    'a second unsent request for the same module must be refused'
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/db/migrations/073.test.js`
Expected: FAIL — `no such table: control_state`.

- [ ] **Step 3: Write the migration**

Create `server/db/migrations/073_licensing.sql`:

```sql
-- LICENCE_CORE_V1 — local side of the vendor control plane.
--
-- The licence itself is NOT stored here. It lives in data/licence.dat as a
-- signed document, because a row in this database is exactly what an operator
-- would edit to grant themselves a module. What lives here is only the state
-- that has no security value on its own.

CREATE TABLE IF NOT EXISTS control_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- «Подключить модуль» from the locked-module screen. Rows wait here until a
-- check-in carries them to the vendor (Plan 1b); until then this table IS the
-- outbox, so nothing is lost while a clinic is offline.
CREATE TABLE IF NOT EXISTS module_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  module_key    TEXT NOT NULL,
  requested_by  INTEGER REFERENCES users(id),
  requested_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  sent_at       TEXT
);

-- One pending request per module: a reception desk clicking the button four
-- times must not become four leads in the vendor's inbox. Partial index, so a
-- module can be requested again once the previous request has been delivered.
CREATE UNIQUE INDEX IF NOT EXISTS module_requests_open_uniq
  ON module_requests (module_key) WHERE sent_at IS NULL;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test server/db/migrations/073.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test` — Expected: 1104+ passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add server/db/migrations/073_licensing.sql server/db/migrations/073.test.js
git commit -m "feat: licensing tables — control state and module requests"
```

---

### Task 3: Deterministic serialisation

A signature covers bytes. If two machines serialise the same licence differently, verification
fails for no visible reason. This function is the contract between the vendor's signer and the
clinic's verifier.

**Files:**
- Create: `server/services/control/canonical.js`
- Test: `server/services/control/canonical.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/control/canonical.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { canonical } from './canonical.js';

test('key order in the source object does not change the bytes', () => {
  const a = canonical({ b: 2, a: 1 });
  const b = canonical({ a: 1, b: 2 });
  assert.equal(a, b);
  assert.equal(a, '{"a":1,"b":2}');
});

test('nested objects are sorted too', () => {
  assert.equal(canonical({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
});

test('array order is preserved — it is data, not key order', () => {
  assert.equal(canonical({ modules: ['telegram', 'crm'] }), '{"modules":["telegram","crm"]}');
});

test('undefined properties are dropped, null is kept', () => {
  assert.equal(canonical({ a: undefined, b: null }), '{"b":null}');
});

test('non-ASCII survives a round trip', () => {
  const s = canonical({ name: 'Нурафшон Мед' });
  assert.equal(JSON.parse(s).name, 'Нурафшон Мед');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/services/control/canonical.test.js`
Expected: FAIL — cannot find module `./canonical.js`.

- [ ] **Step 3: Implement it**

Create `server/services/control/canonical.js`:

```js
// LICENCE_CORE_V1 — the exact bytes a licence signature covers.
//
// A signature is over bytes, not over an object. If the vendor's signer and the
// clinic's verifier disagree about key order by even one character, every licence
// fails to verify and the error says nothing useful. So serialisation is pinned
// here, in one file, used by both sides, with its own tests.
//
// JSON.stringify's array-replacer form was rejected: it filters keys recursively
// in ways that are easy to get subtly wrong. This is explicit instead.

export function canonical(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);   // order is meaningful — leave it
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;   // JSON.stringify would drop it anyway; be explicit
    out[key] = sortDeep(value[key]);
  }
  return out;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test server/services/control/canonical.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/services/control/canonical.js server/services/control/canonical.test.js
git commit -m "feat: deterministic JSON serialisation for licence signing"
```

---

### Task 4: Verify a signed licence

**Files:**
- Create: `server/services/control/licence.js`
- Test: `server/services/control/licence.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/control/licence.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonical } from './canonical.js';
import { verifyLicence } from './licence.js';

// A throwaway key pair per run: no private key is ever committed to this repo.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const PAYLOAD = {
  clinic_id:   'c-000047',
  clinic_name: 'Нурафшон Мед',
  modules:     ['crm', 'telegram'],
  valid_until: '2026-09-03T00:00:00Z',
  issued_at:   '2026-08-20T03:14:00Z',
  nonce:       'abc123',
};

const issue = (payload = PAYLOAD) => JSON.stringify({
  payload,
  sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64'),
});

test('a correctly signed licence verifies', () => {
  const r = verifyLicence(issue(), { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.licence.modules, ['crm', 'telegram']);
  assert.equal(r.licence.valid_until, '2026-09-03T00:00:00Z');
});

test('adding a module to the file invalidates it', () => {
  const raw = JSON.parse(issue());
  raw.payload.modules.push('marketing');           // exactly what an operator would try
  const r = verifyLicence(JSON.stringify(raw), { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('extending the expiry date in the file invalidates it', () => {
  const raw = JSON.parse(issue());
  raw.payload.valid_until = '2099-01-01T00:00:00Z';
  const r = verifyLicence(JSON.stringify(raw), { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test("another clinic's valid licence is refused", () => {
  const r = verifyLicence(issue(), { publicKey, clinicId: 'c-000099' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_clinic');
});

test('a licence signed by a different key is refused', () => {
  const other = generateKeyPairSync('ed25519');
  const forged = JSON.stringify({
    payload: PAYLOAD,
    sig: sign(null, Buffer.from(canonical(PAYLOAD), 'utf8'), other.privateKey).toString('base64'),
  });
  const r = verifyLicence(forged, { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

// The app must never crash on a bad file — an unreadable licence is "unlicensed",
// never a stack trace on a clinic's screen.
for (const [label, raw] of [
  ['empty string',      ''],
  ['not json',          'hello'],
  ['json but no sig',   '{"payload":{"clinic_id":"c-000047"}}'],
  ['json but no payload','{"sig":"AAAA"}'],
  ['sig not base64',    '{"payload":{"clinic_id":"c-000047"},"sig":"!!!!"}'],
  ['null',              null],
]) {
  test(`malformed licence (${label}) is refused without throwing`, () => {
    const r = verifyLicence(raw, { publicKey, clinicId: 'c-000047' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'malformed');
  });
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/services/control/licence.test.js`
Expected: FAIL — cannot find module `./licence.js`.

- [ ] **Step 3: Implement it**

Create `server/services/control/licence.js`:

```js
import { createPublicKey, verify } from 'node:crypto';
import { canonical } from './canonical.js';

// LICENCE_CORE_V1 — the vendor's Ed25519 public key, compiled into the app.
//
// Ed25519 is used because node:crypto has it built in: this project has exactly
// three runtime dependencies and licensing was not going to be the fourth.
//
// REPLACE THIS at first release with the real public key printed by
// `node scripts/make-licence.mjs keygen`. The matching private key must never
// exist anywhere except the control plane. The placeholder below is a real,
// valid key whose private half was discarded, so an un-replaced build fails
// closed: no licence can ever verify against it.
const VENDOR_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=
-----END PUBLIC KEY-----`;

let _defaultKey = null;
function defaultKey() {
  if (!_defaultKey) _defaultKey = createPublicKey(VENDOR_PUBLIC_KEY_PEM);
  return _defaultKey;
}

/**
 * Verify a licence document.
 *
 * @param {string|null} raw       contents of data/licence.dat
 * @param {object}      opts
 * @param {KeyObject}  [opts.publicKey]  override for tests
 * @param {string}      opts.clinicId    who this install claims to be
 * @returns {{ok: true, licence: object} | {ok: false, reason: string}}
 *
 * NEVER throws. A clinic must not be unable to open its own patient list because
 * a licence file got truncated by a bad shutdown.
 */
export function verifyLicence(raw, { publicKey = null, clinicId } = {}) {
  let doc;
  try {
    doc = JSON.parse(String(raw ?? ''));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'malformed' };

  const { payload, sig } = doc;
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'malformed' };
  if (typeof sig !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) {
    return { ok: false, reason: 'malformed' };
  }

  let good = false;
  try {
    good = verify(
      null,                                              // Ed25519 takes no digest algorithm
      Buffer.from(canonical(payload), 'utf8'),
      publicKey || defaultKey(),
      Buffer.from(sig, 'base64'),
    );
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!good) return { ok: false, reason: 'bad_signature' };

  // Checked AFTER the signature so a forged file can never choose its own answer.
  if (payload.clinic_id !== clinicId) return { ok: false, reason: 'wrong_clinic' };

  return { ok: true, licence: payload };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test server/services/control/licence.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server/services/control/licence.js server/services/control/licence.test.js
git commit -m "feat: verify Ed25519-signed licences, failing closed on any damage"
```

---

### Task 5: A clock that cannot be wound back

**Files:**
- Create: `server/services/control/clock.js`
- Test: `server/services/control/clock.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/control/clock.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { migrate } from '../../db/migrate.js';
import { effectiveNow, clockAnomaly } from './clock.js';

const fresh = () => { const db = new Database(':memory:'); migrate(db); return db; };

test('normal time passing is reported as-is', () => {
  const db = fresh();
  assert.equal(effectiveNow(db, new Date('2026-08-20T10:00:00Z')).toISOString(), '2026-08-20T10:00:00.000Z');
  assert.equal(effectiveNow(db, new Date('2026-08-21T10:00:00Z')).toISOString(), '2026-08-21T10:00:00.000Z');
  assert.equal(clockAnomaly(db), false);
});

test('winding the clock back does not turn time back', () => {
  const db = fresh();
  effectiveNow(db, new Date('2026-09-01T00:00:00Z'));
  const back = effectiveNow(db, new Date('2026-08-01T00:00:00Z'));   // the licence-dodging move
  assert.equal(back.toISOString(), '2026-09-01T00:00:00.000Z', 'the high-water mark wins');
  assert.equal(clockAnomaly(db), true, 'and it is recorded for the vendor');
});

test('the high-water mark survives a restart', () => {
  const db = fresh();
  effectiveNow(db, new Date('2026-09-01T00:00:00Z'));
  // A new module instance reading the same database is exactly what a restart is.
  assert.equal(
    effectiveNow(db, new Date('2026-08-01T00:00:00Z')).toISOString(),
    '2026-09-01T00:00:00.000Z'
  );
});

test('small backward drift is tolerated without crying tamper', () => {
  const db = fresh();
  effectiveNow(db, new Date('2026-09-01T00:00:00Z'));
  effectiveNow(db, new Date('2026-09-01T00:00:00Z'));         // NTP nudges of a few seconds
  const drift = effectiveNow(db, new Date('2026-08-31T23:59:30Z'));
  assert.equal(drift.toISOString(), '2026-09-01T00:00:00.000Z', 'still never goes backwards');
  assert.equal(clockAnomaly(db), false, '30 seconds is NTP, not fraud');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/services/control/clock.test.js`
Expected: FAIL — cannot find module `./clock.js`.

- [ ] **Step 3: Implement it**

Create `server/services/control/clock.js`:

```js
// LICENCE_CORE_V1 — time that only moves forwards.
//
// A licence that expires on a date is trivially defeated by setting the PC clock
// back a month, and a clinic PC's clock is not protected in any way. So the
// install remembers the latest moment it has ever observed and refuses to believe
// anything earlier.
//
// Tolerance exists because clocks legitimately step backwards: NTP corrects
// drift, and Windows resyncs after sleep. A few minutes is housekeeping. A month
// is somebody trying it on, and the vendor should hear about it.

const KEY_HIGH_WATER = 'clock_high_water';
const KEY_ANOMALY    = 'clock_anomaly';
const TOLERANCE_MS   = 5 * 60 * 1000;

function get(db, key) {
  return db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null;
}

function put(db, key, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}

/**
 * The current time, floored at the highest moment ever seen.
 * @param {Database} db
 * @param {Date} [systemNow] injectable for tests
 * @returns {Date}
 */
export function effectiveNow(db, systemNow = new Date()) {
  const seen = get(db, KEY_HIGH_WATER);
  const high = seen ? new Date(seen) : null;

  if (high && systemNow.getTime() < high.getTime()) {
    if (high.getTime() - systemNow.getTime() > TOLERANCE_MS) put(db, KEY_ANOMALY, '1');
    return high;
  }

  put(db, KEY_HIGH_WATER, systemNow.toISOString());
  return systemNow;
}

/** Has this install ever seen its clock jump meaningfully backwards? */
export function clockAnomaly(db) {
  return get(db, KEY_ANOMALY) === '1';
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test server/services/control/clock.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/services/control/clock.js server/services/control/clock.test.js
git commit -m "feat: monotonic clock so winding the PC back cannot extend a licence"
```

---

### Task 6: The lock ladder

A pure function with no database and no I/O — which is why it can afford to be exhaustively
tested.

**Files:**
- Create: `server/services/control/ladder.js`
- Test: `server/services/control/ladder.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/control/ladder.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { ladderState } from './ladder.js';

// A licence issued on the 20th is valid for 14 days, to the 3rd of September.
const VALID_UNTIL = '2026-09-03T00:00:00Z';
const at = (iso, subscription = 'active') =>
  ladderState({ validUntil: VALID_UNTIL, now: new Date(iso), subscription });

test('plenty of time left shows nothing at all', () => {
  const s = at('2026-08-21T09:00:00Z');
  assert.equal(s.state, 'ok');
  assert.equal(s.daysLeft, 13);
  assert.equal(s.locked, false);
});

test('a week out, a quiet notice appears', () => {
  assert.equal(at('2026-08-27T09:00:00Z').state, 'notice');   // 7 days left
});

test('three days out it escalates to a warning', () => {
  assert.equal(at('2026-08-31T09:00:00Z').state, 'warn');     // 3 days left
});

test('the boundary between notice and warning is exactly three days', () => {
  assert.equal(at('2026-08-30T09:00:00Z').state, 'notice');   // 4 days
  assert.equal(at('2026-08-31T09:00:00Z').state, 'warn');     // 3 days
});

test('on the expiry moment it locks', () => {
  const s = at('2026-09-03T00:00:00Z');
  assert.equal(s.state, 'locked');
  assert.equal(s.locked, true);
  assert.equal(s.daysLeft, 0);
});

test('long past expiry it stays locked and never reports negative days', () => {
  const s = at('2027-01-01T00:00:00Z');
  assert.equal(s.state, 'locked');
  assert.equal(s.daysLeft, 0);
});

// The distinction that protects a paying customer from being insulted.
test('a paid clinic that cannot reach the server is told it is offline', () => {
  assert.equal(at('2026-08-31T09:00:00Z', 'active').reason, 'offline');
});

test('a clinic that stopped paying is told about the subscription', () => {
  assert.equal(at('2026-08-31T09:00:00Z', 'unpaid').reason, 'unpaid');
});

test('no licence at all is locked, not crashed', () => {
  const s = ladderState({ validUntil: null, now: new Date('2026-08-21T00:00:00Z'), subscription: 'active' });
  assert.equal(s.state, 'locked');
  assert.equal(s.reason, 'unlicensed');
});

test('an unparseable date is treated as no licence', () => {
  const s = ladderState({ validUntil: 'not-a-date', now: new Date('2026-08-21T00:00:00Z'), subscription: 'active' });
  assert.equal(s.state, 'locked');
  assert.equal(s.reason, 'unlicensed');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/services/control/ladder.test.js`
Expected: FAIL — cannot find module `./ladder.js`.

- [ ] **Step 3: Implement it**

Create `server/services/control/ladder.js`:

```js
// LICENCE_CORE_V1 — how many days are left, and what the clinic should be told.
//
// Pure: no database, no clock, no files. Everything it needs is an argument, so
// every rung of the ladder is a one-line test instead of a fixture.
//
// The `reason` field exists for one reason, and it matters more than the rest of
// this file: a clinic that has paid, whose router died, must NEVER be shown a
// message about money. Same countdown, completely different words.

const DAY_MS = 24 * 60 * 60 * 1000;

const NOTICE_FROM = 7;   // days left when the quiet grey banner starts
const WARN_FROM   = 3;   // days left when it becomes a daily warning

/**
 * @param {object}  args
 * @param {string|null} args.validUntil    ISO date from the signed licence
 * @param {Date}        args.now           already passed through effectiveNow()
 * @param {string}      args.subscription  'active' | 'unpaid' — last known from the vendor
 * @returns {{state:'ok'|'notice'|'warn'|'locked', locked:boolean, daysLeft:number, reason:string}}
 */
export function ladderState({ validUntil, now, subscription = 'active' }) {
  const until = validUntil ? new Date(validUntil) : null;

  if (!until || Number.isNaN(until.getTime())) {
    return { state: 'locked', locked: true, daysLeft: 0, reason: 'unlicensed' };
  }

  const msLeft = until.getTime() - now.getTime();
  const daysLeft = Math.max(0, Math.ceil(msLeft / DAY_MS));
  const reason = subscription === 'unpaid' ? 'unpaid' : 'offline';

  if (msLeft <= 0)          return { state: 'locked', locked: true,  daysLeft: 0,        reason };
  if (daysLeft <= WARN_FROM)   return { state: 'warn',   locked: false, daysLeft, reason };
  if (daysLeft <= NOTICE_FROM) return { state: 'notice', locked: false, daysLeft, reason };
  return { state: 'ok', locked: false, daysLeft, reason };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test server/services/control/ladder.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/services/control/ladder.js server/services/control/ladder.test.js
git commit -m "feat: lock ladder — an offline clinic is never accused of not paying"
```

---

### Task 7: Phone unlock

**Files:**
- Create: `server/services/control/unlock.js`
- Test: `server/services/control/unlock.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/control/unlock.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { migrate } from '../../db/migrate.js';
import { currentChallenge, expectedResponse, redeem, extensionUntil } from './unlock.js';

const SECRET = 'unlock-secret-for-clinic-47';
const CLINIC = 'c-000047';
const NOW = new Date('2026-09-04T09:00:00Z');
const fresh = () => { const db = new Database(':memory:'); migrate(db); return db; };

test('the challenge is short enough to read down a telephone', () => {
  const c = currentChallenge(fresh());
  assert.match(c, /^[A-Z0-9]{6}$/);
});

test('the challenge is stable until it is used', () => {
  const db = fresh();
  assert.equal(currentChallenge(db), currentChallenge(db));
});

test('the vendor code unlocks and grants another 14 days', () => {
  const db = fresh();
  const challenge = currentChallenge(db);
  const code = expectedResponse({ clinicId: CLINIC, challenge, secret: SECRET });

  const r = redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(extensionUntil(db), '2026-09-18T09:00:00.000Z');
});

test('the response is formatted for reading aloud', () => {
  const code = expectedResponse({ clinicId: CLINIC, challenge: 'ABC123', secret: SECRET });
  assert.match(code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
});

test('a wrong code changes nothing', () => {
  const db = fresh();
  currentChallenge(db);
  const r = redeem(db, { code: 'AAAAA-BBBBB', clinicId: CLINIC, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_code');
  assert.equal(extensionUntil(db), null);
});

test('a code cannot be used twice', () => {
  const db = fresh();
  const challenge = currentChallenge(db);
  const code = expectedResponse({ clinicId: CLINIC, challenge, secret: SECRET });
  assert.equal(redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW }).ok, true);

  const again = redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW });
  assert.equal(again.ok, false, 'the challenge rotated, so the old code is dead');
});

test("another clinic's code does not work here", () => {
  const db = fresh();
  const challenge = currentChallenge(db);
  const code = expectedResponse({ clinicId: 'c-000099', challenge, secret: SECRET });
  assert.equal(redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW }).ok, false);
});

test('guessing is rate limited', () => {
  const db = fresh();
  currentChallenge(db);
  for (let i = 0; i < 5; i++) {
    assert.equal(redeem(db, { code: 'ZZZZZ-ZZZZZ', clinicId: CLINIC, secret: SECRET, now: NOW }).reason, 'bad_code');
  }
  const blocked = redeem(db, { code: 'ZZZZZ-ZZZZZ', clinicId: CLINIC, secret: SECRET, now: NOW });
  assert.equal(blocked.reason, 'too_many_attempts');
});

test('a correct code still works right up to the attempt limit', () => {
  const db = fresh();
  const challenge = currentChallenge(db);
  const code = expectedResponse({ clinicId: CLINIC, challenge, secret: SECRET });
  for (let i = 0; i < 4; i++) redeem(db, { code: 'ZZZZZ-ZZZZZ', clinicId: CLINIC, secret: SECRET, now: NOW });
  assert.equal(redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW }).ok, true);
});

test('codes are accepted in lower case and with stray spaces', () => {
  const db = fresh();
  const challenge = currentChallenge(db);
  const code = expectedResponse({ clinicId: CLINIC, challenge, secret: SECRET });
  const sloppy = ' ' + code.toLowerCase() + ' ';
  assert.equal(redeem(db, { code: sloppy, clinicId: CLINIC, secret: SECRET, now: NOW }).ok, true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/services/control/unlock.test.js`
Expected: FAIL — cannot find module `./unlock.js`.

- [ ] **Step 3: Implement it**

Create `server/services/control/unlock.js`:

```js
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// LICENCE_CORE_V1 — unlocking a clinic over the telephone.
//
// A locked clinic usually has no internet — that is often WHY it locked. So the
// recovery path must work with nothing but a voice call: the clinic reads six
// characters out, the vendor types them into the panel and reads ten back.
//
// HMAC, not the Ed25519 licence signature, because an Ed25519 signature is 103
// characters when encoded and nobody is reading that down a phone line. HMAC
// means the clinic holds the secret and could in principle mint its own codes —
// see spec §12 risk 4. That is inherent: verifying offline requires the material
// to verify with. The attempt limiter below stops casual guessing; someone who
// digs the secret out of their own disk was always going to win, and would have
// patched the check out instead.
//
// Ambiguous characters (I, O, 0, 1) are excluded because these codes are read
// aloud by people, over a phone, in a busy clinic.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const KEY_CHALLENGE = 'unlock_challenge';
const KEY_ATTEMPTS  = 'unlock_attempts';
const KEY_EXTENSION = 'offline_extension_until';

const MAX_ATTEMPTS   = 5;
const EXTENSION_DAYS = 14;

function get(db, key) {
  return db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null;
}

function put(db, key, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}

function randomCode(len) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** The six characters shown on the lock screen. Stable until a code is redeemed. */
export function currentChallenge(db) {
  let c = get(db, KEY_CHALLENGE);
  if (!c) { c = randomCode(6); put(db, KEY_CHALLENGE, c); }
  return c;
}

/**
 * The code the vendor reads back. Computed identically on both sides — the panel
 * runs this exact function.
 */
export function expectedResponse({ clinicId, challenge, secret }) {
  const mac = createHmac('sha256', String(secret)).update(`${clinicId}:${challenge}`).digest();
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHABET[mac[i] % ALPHABET.length];
  return out.slice(0, 5) + '-' + out.slice(5);
}

/** How long an accepted unlock has bought this install, or null. */
export function extensionUntil(db) {
  return get(db, KEY_EXTENSION);
}

/**
 * Try an unlock code.
 * @returns {{ok:true, until:string} | {ok:false, reason:'bad_code'|'too_many_attempts'}}
 */
export function redeem(db, { code, clinicId, secret, now = new Date() }) {
  const attempts = Number(get(db, KEY_ATTEMPTS) || 0);
  if (attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  const challenge = currentChallenge(db);
  const expected = expectedResponse({ clinicId, challenge, secret });

  // Typed by a human off a phone call: case and spacing are not the point.
  const given = String(code || '').trim().toUpperCase().replace(/\s+/g, '');

  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const same = a.length === b.length && timingSafeEqual(a, b);

  if (!same) {
    put(db, KEY_ATTEMPTS, attempts + 1);
    return { ok: false, reason: 'bad_code' };
  }

  const until = new Date(now.getTime() + EXTENSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  put(db, KEY_EXTENSION, until);
  put(db, KEY_ATTEMPTS, 0);
  put(db, KEY_CHALLENGE, randomCode(6));   // rotate — a used code must never work twice
  return { ok: true, until };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test server/services/control/unlock.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/services/control/unlock.js server/services/control/unlock.test.js
git commit -m "feat: telephone unlock for a locked clinic with no internet"
```

---

### Task 8: Assemble the whole picture

**Files:**
- Create: `server/services/control/state.js`
- Test: `server/services/control/state.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/control/state.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { generateKeyPairSync, sign } from 'node:crypto';
import { migrate } from '../../db/migrate.js';
import { canonical } from './canonical.js';
import { controlState, __setPublicKeyForTests } from './state.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

function workspace({ licence, identity } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-ctl-'));
  if (identity !== null) {
    fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(identity ?? {
      clinic_id: 'c-000047', unlock_secret: 's3cret', subscription: 'active',
    }));
  }
  if (licence) fs.writeFileSync(path.join(dir, 'licence.dat'), licence);
  const db = new Database(':memory:'); migrate(db);
  return { dir, db };
}

const issue = (over = {}) => {
  const payload = {
    clinic_id: 'c-000047', clinic_name: 'Нурафшон Мед',
    modules: ['crm'], valid_until: '2026-09-03T00:00:00Z',
    issued_at: '2026-08-20T00:00:00Z', nonce: 'n1', ...over,
  };
  return JSON.stringify({ payload, sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64') });
};

__setPublicKeyForTests(publicKey);

test('a healthy licence reports the modules it grants', () => {
  const { dir, db } = workspace({ licence: issue() });
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.locked, false);
  assert.deepEqual(s.modules, ['crm']);
  assert.equal(s.clinicName, 'Нурафшон Мед');
  assert.equal(s.state, 'ok');
});

test('an expired licence locks', () => {
  const { dir, db } = workspace({ licence: issue() });
  const s = controlState(db, dir, new Date('2026-09-10T00:00:00Z'));
  assert.equal(s.locked, true);
  assert.deepEqual(s.modules, [], 'a locked clinic has no modules');
});

test('no licence file at all is locked, not broken', () => {
  const { dir, db } = workspace();
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.locked, true);
  assert.equal(s.reason, 'unlicensed');
});

test('a shredded licence file is locked, not a crash', () => {
  const { dir, db } = workspace({ licence: 'garbage' });
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.locked, true);
});

test('an unenrolled install is locked but says so distinctly', () => {
  const { dir, db } = workspace({ identity: null });
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.locked, true);
  assert.equal(s.reason, 'not_enrolled');
});

test('a phone unlock rescues an expired licence', () => {
  const { dir, db } = workspace({ licence: issue() });
  db.prepare("INSERT INTO control_state (key, value) VALUES ('offline_extension_until', '2026-09-20T00:00:00Z')").run();
  const s = controlState(db, dir, new Date('2026-09-10T00:00:00Z'));
  assert.equal(s.locked, false, 'the extension outlives the licence date');
  assert.deepEqual(s.modules, ['crm'], 'and the modules come back');
});

test('an extension in the past does not rescue anything', () => {
  const { dir, db } = workspace({ licence: issue() });
  db.prepare("INSERT INTO control_state (key, value) VALUES ('offline_extension_until', '2026-09-05T00:00:00Z')").run();
  assert.equal(controlState(db, dir, new Date('2026-09-10T00:00:00Z')).locked, true);
});

test('a module is only granted if the licence names it', () => {
  const { dir, db } = workspace({ licence: issue({ modules: ['crm', 'telegram'] }) });
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.has('crm'), true);
  assert.equal(s.has('telegram'), true);
  assert.equal(s.has('marketing'), false);
});

test('an unreadable data directory does not throw', () => {
  const db = new Database(':memory:'); migrate(db);
  const s = controlState(db, path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()), new Date());
  assert.equal(s.locked, true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/services/control/state.test.js`
Expected: FAIL — cannot find module `./state.js`.

- [ ] **Step 3: Implement it**

Create `server/services/control/state.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { verifyLicence } from './licence.js';
import { effectiveNow, clockAnomaly } from './clock.js';
import { ladderState } from './ladder.js';
import { extensionUntil } from './unlock.js';

// LICENCE_CORE_V1 — the single question the rest of the app asks: "what am I
// allowed to do right now?"
//
// Everything below is wrapped so that it CANNOT throw. This module is consulted
// on the hot path of every write and on every page load; a clinic must never be
// unable to register a patient because a file was half-written during a power
// cut. Anything unexpected means "locked", which is safe, visible, and
// recoverable by telephone.

let _testPublicKey = null;
/** Tests inject their own throwaway key. Never called in production. */
export function __setPublicKeyForTests(key) { _testPublicKey = key; }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * @param {Database} db
 * @param {string}   dataDir  where control.json and licence.dat live
 * @param {Date}     [systemNow]
 * @returns {{
 *   locked:boolean, state:string, reason:string, daysLeft:number,
 *   modules:string[], clinicId:string|null, clinicName:string|null,
 *   clockAnomaly:boolean, has:(key:string)=>boolean
 * }}
 */
export function controlState(db, dataDir, systemNow = new Date()) {
  const identity = readJson(path.join(dataDir, 'control.json'));

  if (!identity || !identity.clinic_id) {
    return shape({ state: 'locked', locked: true, daysLeft: 0, reason: 'not_enrolled' }, [], null, null, false);
  }

  const now = effectiveNow(db, systemNow);
  const anomaly = clockAnomaly(db);

  const result = verifyLicence(readText(path.join(dataDir, 'licence.dat')), {
    publicKey: _testPublicKey,
    clinicId: identity.clinic_id,
  });

  const licence = result.ok ? result.licence : null;

  // A telephone unlock cannot rewrite the signed licence, so it is recorded
  // separately and simply wins when it reaches further into the future.
  const ext = extensionUntil(db);
  const dates = [licence?.valid_until, ext].filter(Boolean).map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()));
  const until = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString() : null;

  const ladder = ladderState({ validUntil: until, now, subscription: identity.subscription || 'active' });

  // Modules are granted only while unlocked. A lapsed clinic has none, which is
  // what makes the whole app fall back to the activation screen.
  const modules = !ladder.locked && licence ? (Array.isArray(licence.modules) ? licence.modules : []) : [];

  return shape(ladder, modules, identity.clinic_id, licence?.clinic_name ?? null, anomaly);
}

function shape(ladder, modules, clinicId, clinicName, clockAnomalyFlag) {
  const set = new Set(modules);
  return {
    state:    ladder.state,
    locked:   ladder.locked,
    reason:   ladder.reason,
    daysLeft: ladder.daysLeft,
    modules,
    clinicId,
    clinicName,
    clockAnomaly: clockAnomalyFlag,
    has: (key) => set.has(key),
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test server/services/control/state.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/services/control/state.js server/services/control/state.test.js
git commit -m "feat: assemble licence, clock, ladder and unlock into one answer"
```

---

### Task 9: The vendor CLI

Without this you cannot issue a licence at all, so nothing after here is testable by hand.

**Files:**
- Create: `scripts/make-licence.mjs`

- [ ] **Step 1: Write it**

Create `scripts/make-licence.mjs`:

```js
#!/usr/bin/env node
// LICENCE_CORE_V1 — the vendor's licence tool. Runs on the VENDOR's machine, never
// at a clinic. Plan 1b replaces it with the panel; until then this is how clinics
// are licensed, and it stays afterwards as the break-glass path.
//
//   node scripts/make-licence.mjs keygen
//   node scripts/make-licence.mjs enroll  --clinic c-000047 --name "Нурафшон Мед"
//   node scripts/make-licence.mjs issue   --clinic c-000047 --name "Нурафшон Мед" \
//                                         --modules crm,telegram --days 14 --key vendor-private.pem
//   node scripts/make-licence.mjs unlock  --clinic c-000047 --challenge K7M2QP --secret <secret>

import fs from 'node:fs';
import { generateKeyPairSync, sign, randomBytes, createHmac } from 'node:crypto';
import { canonical } from '../server/services/control/canonical.js';

const args = Object.create(null);
for (let i = 3; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const need = (k) => { if (!args[k]) { console.error(`Missing --${k}`); process.exit(1); } return args[k]; };

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

switch (process.argv[2]) {
  case 'keygen': {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    fs.writeFileSync('vendor-private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }));
    console.log('Wrote vendor-private.pem — KEEP THIS OFF EVERY CLINIC MACHINE. Back it up offline.');
    console.log('If it leaks, anyone can license themselves. If it is lost, no clinic can be licensed again.\n');
    console.log('Paste this into VENDOR_PUBLIC_KEY_PEM in server/services/control/licence.js:\n');
    console.log(publicKey.export({ type: 'spki', format: 'pem' }).trim());
    break;
  }

  case 'enroll': {
    const identity = {
      clinic_id:     need('clinic'),
      clinic_name:   args.name || '',
      unlock_secret: randomBytes(32).toString('base64'),
      subscription:  'active',
    };
    const out = `control-${identity.clinic_id}.json`;
    fs.writeFileSync(out, JSON.stringify(identity, null, 2));
    console.log(`Wrote ${out} — copy it to the clinic's data/ directory as control.json`);
    console.log('Keep your own copy: the unlock_secret is what lets you unlock them by telephone.');
    break;
  }

  case 'issue': {
    const days = Number(args.days || 14);
    const payload = {
      clinic_id:   need('clinic'),
      clinic_name: args.name || '',
      modules:     String(args.modules || '').split(',').map((s) => s.trim()).filter(Boolean),
      valid_until: new Date(Date.now() + days * 86400000).toISOString(),
      issued_at:   new Date().toISOString(),
      nonce:       randomBytes(8).toString('hex'),
    };
    const privateKey = fs.readFileSync(args.key || 'vendor-private.pem', 'utf8');
    const doc = {
      payload,
      sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64'),
    };
    const out = `licence-${payload.clinic_id}.dat`;
    fs.writeFileSync(out, JSON.stringify(doc));
    console.log(`Wrote ${out} — copy to the clinic's data/ directory as licence.dat`);
    console.log(`Modules: ${payload.modules.join(', ') || '(none)'}   Valid until: ${payload.valid_until}`);
    break;
  }

  case 'unlock': {
    const mac = createHmac('sha256', need('secret')).update(`${need('clinic')}:${need('challenge')}`).digest();
    let code = '';
    for (let i = 0; i < 10; i++) code += ALPHABET[mac[i] % ALPHABET.length];
    console.log('Read this back to the clinic:  ' + code.slice(0, 5) + '-' + code.slice(5));
    break;
  }

  default:
    console.error('Usage: make-licence.mjs keygen|enroll|issue|unlock [--flags]');
    process.exit(1);
}
```

- [ ] **Step 2: Prove the whole loop works by hand**

```bash
node scripts/make-licence.mjs keygen
node scripts/make-licence.mjs enroll --clinic c-000047 --name "Test Clinic"
node scripts/make-licence.mjs issue --clinic c-000047 --name "Test Clinic" --modules crm,telegram --days 14
```

Expected: three files written. Open `licence-c-000047.dat` and confirm it contains a `payload`
with `modules: ["crm","telegram"]` and a `sig`.

- [ ] **Step 3: Install the real public key**

Copy the public key printed by `keygen` into `VENDOR_PUBLIC_KEY_PEM` in
`server/services/control/licence.js`, replacing the discarded placeholder.

- [ ] **Step 4: Make sure the private key can never be committed**

Append to `.gitignore`:

```gitignore
# --- Vendor licence signing material — must NEVER reach a clinic or a repo ---
vendor-private.pem
control-*.json
licence-*.dat
```

Verify: `git check-ignore -q vendor-private.pem && echo IGNORED` → prints `IGNORED`.

- [ ] **Step 5: Commit**

```bash
git add scripts/make-licence.mjs .gitignore server/services/control/licence.js
git commit -m "feat: vendor CLI to generate keys, enroll clinics and sign licences"
```

---

### Task 10: Block writes when locked

**Files:**
- Modify: `server/app.js`
- Modify: `server/routes/db.js`
- Modify: `server/routes/rpc.js`
- Create: `server/services/control/gate.js`
- Test: `server/routes/licence-gate.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/routes/licence-gate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { generateKeyPairSync, sign } from 'node:crypto';
import { migrate } from '../db/migrate.js';
import { bootstrapAdmin } from '../services/auth.js';
import { canonical } from '../services/control/canonical.js';
import { __setPublicKeyForTests } from '../services/control/state.js';
import { createApp } from '../app.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
__setPublicKeyForTests(publicKey);

function harness({ validUntil }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-gate-'));
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({
    clinic_id: 'c-1', unlock_secret: 's', subscription: 'active',
  }));
  const payload = {
    clinic_id: 'c-1', clinic_name: 'T', modules: ['crm'],
    valid_until: validUntil, issued_at: '2026-08-01T00:00:00Z', nonce: 'n',
  };
  fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify({
    payload, sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64'),
  }));

  const db = new Database(':memory:');
  migrate(db);
  const password = bootstrapAdmin(db);
  return { db, dir, password, app: createApp(db, { dataDir: dir }) };
}

async function login(server, password) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

test('a licensed clinic can still write', async (t) => {
  const { app, password } = harness({ validUntil: '2099-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ table: 'patients', op: 'insert', values: { full_name: 'Тест Тестов' } }),
  });
  assert.notEqual(res.status, 402);
});

test('a lapsed clinic cannot write, and is told why', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ table: 'patients', op: 'insert', values: { full_name: 'Тест Тестов' } }),
  });
  assert.equal(res.status, 402, 'Payment Required is the honest status here');
  const body = await res.json();
  assert.equal(body.error.code, 'licence_locked');
});

test('a lapsed clinic can still READ its own records', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ table: 'patients', op: 'select', columns: '*', filters: [] }),
  });
  assert.equal(res.status, 200, 'reading a patient card must never be blocked');
});

test('a lapsed clinic cannot call a mutating RPC', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rpc/record_payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ invoice_id: 1, amount: 100 }),
  });
  assert.equal(res.status, 402);
});

test('a lapsed clinic can still call a read-only RPC', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rpc/dashboard_summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({}),
  });
  assert.notEqual(res.status, 402);
});

test('an unknown RPC is blocked while locked — the gate fails CLOSED', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rpc/some_future_rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 402, 'an RPC nobody remembered to classify must not become a hole');
});

test('login still works when locked — otherwise nobody can pay', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  assert.ok(cookie.includes('emsid'), 'a locked clinic must still be able to log in');
});

test('the app boots and serves with no licence file at all', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-nolic-'));
  const db = new Database(':memory:'); migrate(db); bootstrapAdmin(db);
  const server = await listen(createApp(db, { dataDir: dir }));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.equal(res.status, 200, 'a missing licence must never stop the server starting');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/routes/licence-gate.test.js`
Expected: FAIL — `createApp` does not accept options; writes are not blocked.

- [ ] **Step 3: Write the data-directory config**

The RPC registry calls every handler as `(db, args, user)` — there is no fourth argument and no
`req`, so an RPC cannot be told where the data directory is. One module holds it instead, set once
at boot.

Create `server/services/control/config.js`:

```js
import path from 'node:path';

// LICENCE_CORE_V1 — where control.json and licence.dat live.
//
// This exists because of a signature mismatch that is easy to miss: RPC handlers
// are invoked as (db, args, user) by services/rpc/index.js. They never see `req`,
// so req.control and any per-request data directory are unreachable from inside
// an RPC. Rather than widen that signature across ninety handlers, the path is
// resolved once when the app is created and read from here.
//
// Plan 3 makes this read EASYMED_DATA_DIR. Until then the default matches the
// behaviour every existing test expects.

let _dataDir = null;

export function setDataDir(dir) { _dataDir = dir; }

export function getDataDir() {
  return _dataDir || path.join(process.cwd(), 'data');
}
```

- [ ] **Step 4: Write the gate**

Create `server/services/control/gate.js`:

```js
import { controlState } from './state.js';

// LICENCE_CORE_V1 — the enforcement point.
//
// Enforced on the SERVER, in the two places every write already funnels through.
// Hiding buttons in the browser would be decoration: the API is reachable with
// curl from any PC on the clinic's network.
//
// 402 Payment Required is used deliberately. It is the one status whose meaning
// is exactly this, and it keeps a licence lapse distinguishable from 401 (log in
// again) and 403 (your role may not) — three different problems with three
// different fixes, which the UI must not confuse.

// RPCs that only read. Everything absent from this set is treated as a write.
//
// FAILS CLOSED ON PURPOSE. When someone adds an RPC next year and never reads
// this file, the failure mode is "it stops working during a lapse" — noticed
// immediately, fixed in one line. The alternative default would silently leave a
// hole open for as long as nobody looked.
const READ_ONLY_RPCS = new Set([
  'dashboard_summary', 'reports_overview', 'run_report', 'owner_report',
  'cashier_invoices', 'cash_shift_summary', 'shift_report', 'cashier_report',
  'callcenter_report', 'queue_board', 'documents_feed', 'accommodation_state',
  'deposit_balance', 'list_deposits', 'service_delete_check', 'get_clinic_by_slug',
  'telegram_settings_get', 'telegram_links_list', 'telegram_deliveries_list',
  'telegram_stats', 'telegram_broadcast_status', 'telegram_broadcast_history',
  'telegram_chats_list', 'telegram_chat_messages', 'telegram_chat_unread',
]);

// The way back in. These must work while locked or a clinic that wants to pay
// has no route to doing so — the reason login itself stays open.
const ALWAYS_ALLOWED_RPCS = new Set([
  'licence_status', 'licence_unlock', 'module_request',
]);

export function isReadOnlyRpc(name) { return READ_ONLY_RPCS.has(name); }
export function isAlwaysAllowedRpc(name) { return ALWAYS_ALLOWED_RPCS.has(name); }

/** Cached per request by attachControl() below — controlState touches the disk. */
export function attachControl(db, dataDir) {
  return (req, res, next) => {
    try { req.control = controlState(db, dataDir); }
    catch (e) {
      // Unreachable by design (controlState never throws), but if it ever did,
      // a licensing bug must not take the clinic down with it.
      console.warn('[licence] state unavailable:', e.message);
      req.control = { locked: false, modules: [], has: () => true, state: 'ok', reason: 'error', daysLeft: 0 };
    }
    next();
  };
}

export function lockedResponse(res) {
  return res.status(402).json({
    error: { code: 'licence_locked', message: 'Подписка не активна. Обратитесь к менеджеру Easy-Med.' },
  });
}
```

- [ ] **Step 5: Wire it into the app**

In `server/app.js`, change the signature and add the middleware. Replace:

```js
export function createApp(db) {
```

with:

```js
export function createApp(db, { dataDir = path.join(ROOT, 'data') } = {}) {
```

Add the imports at the top, beside the other middleware imports:

```js
import { attachControl } from './services/control/gate.js';   // LICENCE_CORE_V1
import { setDataDir } from './services/control/config.js';   // LICENCE_CORE_V1
```

As the **first statement inside** `createApp`, before `const app = express();`:

```js
  // LICENCE_CORE_V1 — publish the path for RPC handlers, which get no `req`.
  setDataDir(dataDir);
```

Immediately **after** the existing `app.use(attachUser(db));` line, add:

```js
  // LICENCE_CORE_V1 — resolved once per request, after the user is known and
  // before any route can write.
  app.use(attachControl(db, dataDir));
```

And change the storage route to use the configurable directory. Replace:

```js
  app.use('/api/storage', requireAuth, storageRoutes(path.join(ROOT, 'data', 'storage')));
```

with:

```js
  app.use('/api/storage', requireAuth, storageRoutes(path.join(dataDir, 'storage')));
```

- [ ] **Step 6: Gate `/api/db`**

In `server/routes/db.js`, add the import at the top:

```js
import { lockedResponse } from '../services/control/gate.js';   // LICENCE_CORE_V1
```

Then inside `r.post('/', (req, res) => {`, immediately **after** the `compile()` try/catch block
that produces `compiled` (so we know the operation) and **before** `try { const { sql, params, meta } = compiled;`, add:

```js
    // LICENCE_CORE_V1 — a lapsed clinic reads its own records freely and changes
    // nothing. Placed after compile() so we know the operation, and before
    // execution so nothing has touched the database yet.
    if (req.control?.locked && compiled.meta.op !== 'select') return lockedResponse(res);
```

- [ ] **Step 7: Gate `/api/rpc`**

In `server/routes/rpc.js`, add the import:

```js
import { isReadOnlyRpc, isAlwaysAllowedRpc, lockedResponse } from '../services/control/gate.js';   // LICENCE_CORE_V1
```

Inside the handler, immediately **after** the `if (!handler)` check, add:

```js
    // LICENCE_CORE_V1 — default deny. See the comment on READ_ONLY_RPCS: an RPC
    // added later and never classified must fail shut, not open.
    if (req.control?.locked
        && !isAlwaysAllowedRpc(req.params.name)
        && !isReadOnlyRpc(req.params.name)) {
      return lockedResponse(res);
    }
```

- [ ] **Step 8: Run the gate tests**

Run: `node --test server/routes/licence-gate.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 9: Run the whole suite — `createApp` changed, so everything is at risk**

Run: `npm test`
Expected: **all passing.** `createApp(db)` still works because `dataDir` has a default; if any
existing test fails, it is because it asserted on a data path — fix the test, not the default.

- [ ] **Step 10: Commit**

```bash
git add server/services/control/gate.js server/services/control/config.js \
        server/routes/licence-gate.test.js \
        server/app.js server/routes/db.js server/routes/rpc.js
git commit -m "feat: block writes server-side when the licence has lapsed"
```

---

### Task 11: Tell the browser

**Files:**
- Create: `server/services/rpc/licence.js`
- Modify: `server/services/rpc/index.js`
- Test: `server/services/rpc/licence.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/rpc/licence.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { migrate } from '../../db/migrate.js';
import { moduleRequest } from './licence.js';

const fresh = () => { const db = new Database(':memory:'); migrate(db); return db; };
const USER = { id: 1, role: 'admin' };

test('requesting a module records a lead for the vendor', () => {
  const db = fresh();
  const r = moduleRequest(db, { module_key: 'marketing' }, USER);
  assert.equal(r.ok, true);
  const row = db.prepare('SELECT * FROM module_requests').get();
  assert.equal(row.module_key, 'marketing');
  assert.equal(row.requested_by, 1);
});

test('clicking the button twice does not create two leads', () => {
  const db = fresh();
  moduleRequest(db, { module_key: 'marketing' }, USER);
  const second = moduleRequest(db, { module_key: 'marketing' }, USER);
  assert.equal(second.ok, true, 'the button must not show an error to the clinic');
  assert.equal(second.already, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM module_requests').get().n, 1);
});

test('the request date comes back so the button can show it', () => {
  const db = fresh();
  moduleRequest(db, { module_key: 'crm' }, USER);
  const again = moduleRequest(db, { module_key: 'crm' }, USER);
  assert.ok(again.requested_at, 'so the UI can say "Заявка отправлена <date>"');
});

test('an unknown module key is refused', () => {
  const db = fresh();
  assert.throws(() => moduleRequest(db, { module_key: 'not-a-module' }, USER), /module/i);
});

test('a missing module key is refused', () => {
  const db = fresh();
  assert.throws(() => moduleRequest(db, {}, USER), /module/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/services/rpc/licence.test.js`
Expected: FAIL — cannot find module `./licence.js`.

- [ ] **Step 3: Implement the RPCs**

Create `server/services/rpc/licence.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { controlState } from '../control/state.js';
import { currentChallenge, redeem } from '../control/unlock.js';
import { getDataDir } from '../control/config.js';

// LICENCE_CORE_V1 — the three RPCs that must work while locked.

class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// The keys a licence may grant. Kept here rather than derived from the licence so
// that a typo in a request is caught, and so the panel and the app agree on
// vocabulary. Extend deliberately, in step with the vendor panel.
export const SELLABLE_MODULES = new Set(['crm', 'telegram', 'marketing']);

/** Everything the lock screen and the banners need. Never blocked. */
export function licenceStatus(db, args, user) {
  const s = controlState(db, getDataDir());
  return {
    state: s.state,
    locked: s.locked,
    reason: s.reason,
    days_left: s.daysLeft,
    modules: s.modules,
    clinic_name: s.clinicName,
    clock_anomaly: s.clockAnomaly,
    // Shown on the lock screen for the telephone call. Harmless to expose: it is
    // useless without the vendor's copy of the unlock secret.
    challenge: s.locked ? currentChallenge(db) : null,
  };
}

/** Redeem a code read out by the vendor over the telephone. */
export function licenceUnlock(db, args, user) {
  if (!user || user.role !== 'admin') throw new RpcError('Только администратор может активировать.', 403);

  let identity = null;
  try { identity = JSON.parse(fs.readFileSync(path.join(getDataDir(), 'control.json'), 'utf8')); } catch {}
  if (!identity?.clinic_id) throw new RpcError('Эта установка не привязана к клинике.', 400);

  const r = redeem(db, {
    code: args.code,
    clinicId: identity.clinic_id,
    secret: identity.unlock_secret,
  });

  if (!r.ok) {
    throw new RpcError(
      r.reason === 'too_many_attempts'
        ? 'Слишком много попыток. Попробуйте позже.'
        : 'Код неверный. Проверьте и введите ещё раз.',
      400,
    );
  }
  return { ok: true, until: r.until };
}

/** «Подключить модуль» from the locked-module screen. */
export function moduleRequest(db, args, user) {
  const key = String(args.module_key || '');
  if (!SELLABLE_MODULES.has(key)) throw new RpcError('Неизвестный модуль: ' + key, 400);

  const open = db.prepare('SELECT * FROM module_requests WHERE module_key = ? AND sent_at IS NULL').get(key);
  if (open) return { ok: true, already: true, requested_at: open.requested_at };

  db.prepare('INSERT INTO module_requests (module_key, requested_by) VALUES (?, ?)')
    .run(key, user?.id ?? null);
  const row = db.prepare('SELECT * FROM module_requests WHERE module_key = ? AND sent_at IS NULL').get(key);
  return { ok: true, already: false, requested_at: row.requested_at };
}
```

- [ ] **Step 4: Register them**

In `server/services/rpc/index.js`, add the import beside the others:

```js
import { licenceStatus, licenceUnlock, moduleRequest } from './licence.js';   // LICENCE_CORE_V1
```

And add to the `RPC` object:

```js
  // LICENCE_CORE_V1 — the three that stay reachable while locked (see
  // control/gate.js ALWAYS_ALLOWED_RPCS). Without them a clinic that wants to
  // pay would have no way to say so.
  licence_status:  (db, args, user) => licenceStatus(db, args, user),
  licence_unlock:  (db, args, user) => licenceUnlock(db, args, user),
  module_request:  (db, args, user) => moduleRequest(db, args, user),
```

- [ ] **Step 5: Understand why the licence does NOT ride on `/api/auth/me`**

No code change in this step. It exists so that nobody "improves" this later and silently breaks
enforcement.

The obvious design is to add a `licence` block to the `/api/auth/me` response. **It does not
work.** The browser never sees that response: `public/js/db-auth.js` funnels `/me` through the
Supabase-compat shim, whose `getUser()` returns `{ data: { user: json.user } }` and **discards
every other top-level property**. A `licence` key added to `/me` would vanish without an error,
and the symptom would be an application where nothing is ever locked — an enforcement failure that
looks exactly like everything working.

The browser therefore calls the `licence_status` RPC at boot instead (Task 14, Step 2). It is
already listed in `ALWAYS_ALLOWED_RPCS`, so it answers even while locked, and a local round trip
costs under a millisecond.

`server/routes/auth.js` is **not modified by this plan.**

- [ ] **Step 6: Run the tests**

Run: `node --test server/services/rpc/licence.test.js`
Expected: PASS, 5 tests.

Run: `npm test`
Expected: all passing.

- [ ] **Step 7: Commit**

```bash
git add server/services/rpc/licence.js server/services/rpc/licence.test.js \
        server/services/rpc/index.js
git commit -m "feat: licence status, telephone unlock and module requests over RPC"
```

---

### Task 12: The module map and client state

**Files:**
- Create: `public/js/admin/licensed-modules.js`
- Create: `public/js/admin/licence.js`
- Test: `public/js/admin/licence.test.js`

- [ ] **Step 1: Write the failing test**

Create `public/js/admin/licence.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { setLicence, isLicensed, licenceState, licenceKeyFor } from './licence.js';

test('a module the licence names is unlocked', () => {
  setLicence({ locked: false, modules: ['crm'], state: 'ok', days_left: 13 });
  assert.equal(isLicensed('crm'), true);
});

test('a module the licence omits is locked', () => {
  setLicence({ locked: false, modules: ['crm'], state: 'ok', days_left: 13 });
  assert.equal(isLicensed('marketing'), false);
});

test('modules nobody sells are always open', () => {
  setLicence({ locked: false, modules: [], state: 'ok', days_left: 13 });
  assert.equal(isLicensed('patients'), true, 'the clinical core is never for sale');
  assert.equal(isLicensed('cashier-shifts'), true);
});

test('a lapsed subscription locks even the free modules', () => {
  setLicence({ locked: true, modules: [], state: 'locked', days_left: 0 });
  assert.equal(isLicensed('patients'), false);
});

test('before the server answers, nothing is treated as sold', () => {
  setLicence(null);
  assert.equal(isLicensed('patients'), true, 'never flash a lock at a paying clinic on boot');
  assert.equal(isLicensed('marketing'), false, 'but never flash a paid module open either');
});

test('nav ids map to licence keys', () => {
  assert.equal(licenceKeyFor('telegram-chat'), 'telegram');
  assert.equal(licenceKeyFor('crm'), 'crm');
  assert.equal(licenceKeyFor('patients'), null);
});

test('the ladder state is readable for the banner', () => {
  setLicence({ locked: false, modules: [], state: 'warn', days_left: 2, reason: 'offline' });
  assert.equal(licenceState().state, 'warn');
  assert.equal(licenceState().days_left, 2);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test public/js/admin/licence.test.js`
Expected: FAIL — cannot find module `./licence.js`.

- [ ] **Step 3: Write the module map**

Create `public/js/admin/licensed-modules.js`:

```js
// LICENCE_CORE_V1 — which parts of the app are sold separately, and what to say
// about them when they are not bought.
//
// Keys are nav ids / route names from admin.js; `key` is the licence vocabulary
// used in the signed licence and in the vendor panel. Anything NOT listed here is
// part of the clinical core and is never for sale — a clinic must always be able
// to register a patient and take money.
//
// The copy is deliberately benefit-led, not feature-led. This screen is the best
// sales surface in the product: somebody is asking for the module at the exact
// moment they want it.

export const LICENSED_MODULES = {
    crm: {
        key: 'crm',
        title: 'Все звонки и заявки — в одном списке',
        blurb: 'Call-центр собирает обращения пациентов, ведёт их до записи и показывает, кто перезвонил, а кто нет.',
    },
    'telegram-chat': {
        key: 'telegram',
        title: 'Пациент забирает анализы сам, в Telegram',
        blurb: 'Бот узнаёт пациента по номеру телефона и отправляет готовые результаты. Регистратура перестаёт распечатывать и обзванивать.',
    },
    marketing: {
        key: 'marketing',
        title: 'Видно, откуда приходят пациенты',
        blurb: 'Считает источники обращений и повторные визиты, чтобы вы платили за рекламу, которая действительно приводит людей.',
    },
};

/** Every nav id that is gated. Used by the sidebar to decide where to draw a lock. */
export const LICENSED_NAV_IDS = new Set(Object.keys(LICENSED_MODULES));
```

- [ ] **Step 4: Write the client state**

Create `public/js/admin/licence.js`:

```js
import { LICENSED_MODULES } from './licensed-modules.js';

// LICENCE_CORE_V1 — the browser's copy of what the server decided.
//
// Never the source of truth: every write is gated again on the server. This
// exists so the interface can be honest BEFORE the user clicks — a lock marker
// on the sidebar instead of a 402 after filling in a form.

let _licence = null;

/** Called once at boot from the /api/auth/me payload. */
export function setLicence(licence) { _licence = licence || null; }

export function licenceState() {
    return _licence || { state: 'ok', locked: false, reason: 'unknown', days_left: 0, modules: [] };
}

/** Nav id → licence key, or null when the module is part of the free core. */
export function licenceKeyFor(navId) {
    return LICENSED_MODULES[navId]?.key ?? null;
}

/**
 * May this nav id be opened?
 *
 * Two independent reasons it may not, and they must not be conflated: the
 * subscription has lapsed (everything shuts), or this particular module was never
 * bought (only it shuts). See spec §4.
 */
export function isLicensed(navId) {
    const key = licenceKeyFor(navId);

    // Before /me answers we know nothing. Treat the free core as open — flashing a
    // lock at a paying clinic every time it loads would be its own bug — but treat
    // paid modules as closed, so an unbought module never flickers open.
    if (!_licence) return key === null;

    if (_licence.locked) return false;
    if (key === null) return true;
    return Array.isArray(_licence.modules) && _licence.modules.includes(key);
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `node --test public/js/admin/licence.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add public/js/admin/licence.js public/js/admin/licensed-modules.js public/js/admin/licence.test.js
git commit -m "feat: client-side licence state and the sellable-module map"
```

---

### Task 13: The locked-module sales screen

**Files:**
- Create: `public/js/admin/views/locked-module.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: Add the strings**

In `public/js/admin/i18n-strings.js`, add these entries to the exported object (match the
existing formatting exactly — one entry per line, `{"en":…,"ru":…,"uz":…}`):

```js
  "Модуль не подключён": {"en":"Not included in your plan","ru":"Модуль не подключён","uz":"Modul ulanmagan"},
  "Подключить модуль": {"en":"Enable this module","ru":"Подключить модуль","uz":"Modulni ulash"},
  "Заявка уйдёт вашему менеджеру Easy-Med. Обычно отвечаем в тот же рабочий день.": {"en":"Sent to your Easy-Med manager. We usually reply the same working day.","ru":"Заявка уйдёт вашему менеджеру Easy-Med. Обычно отвечаем в тот же рабочий день.","uz":"Ariza Easy-Med menejeringizga yuboriladi. Odatda o'sha ish kunida javob beramiz."},
  "Заявка отправлена": {"en":"Request sent","ru":"Заявка отправлена","uz":"Ariza yuborildi"},
  "Ваш менеджер свяжется с вами.": {"en":"Your manager will be in touch.","ru":"Ваш менеджер свяжется с вами.","uz":"Menejeringiz siz bilan bog'lanadi."},
  "Не удалось отправить заявку. Попробуйте ещё раз.": {"en":"Could not send the request. Try again.","ru":"Не удалось отправить заявку. Попробуйте ещё раз.","uz":"Ariza yuborilmadi. Qayta urinib ko'ring."},
```

- [ ] **Step 2: Write the view**

Create `public/js/admin/views/locked-module.js`:

```js
import { h } from '../ui.js';
import { t } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { LICENSED_MODULES } from '../licensed-modules.js';

// LICENCE_CORE_V1 — what a clinic sees when it opens a module it has not bought.
//
// This is NOT an error screen, and building it as one would waste the most
// valuable moment the product gets: somebody is actively trying to use the
// feature. So it leads with the outcome, explains in one sentence, and makes
// asking cost a single click.
//
// No emojis, per the house rule — the lock mark is a real icon.

export async function renderLockedModule(root, navId) {
    const mod = LICENSED_MODULES[navId];
    root.replaceChildren();

    // A module gated but not described is a bug in licensed-modules.js. Say so
    // plainly rather than rendering an empty page nobody can diagnose.
    if (!mod) {
        root.appendChild(h('div', { class: 'card' }, h('p', null, t('Модуль не подключён'))));
        return;
    }

    const foot = h('p', { class: 'lm-foot' },
        t('Заявка уйдёт вашему менеджеру Easy-Med. Обычно отвечаем в тот же рабочий день.'));

    const cta = h('button', {
        type: 'button',
        class: 'btn btn-primary lm-cta',
        onclick: async () => {
            cta.disabled = true;
            try {
                const { data, error } = await supabase.rpc('module_request', { module_key: mod.key });
                if (error) throw error;
                const when = data?.requested_at ? String(data.requested_at).slice(0, 10) : '';
                cta.textContent = t('Заявка отправлена') + (when ? ' ' + when : '');
                foot.textContent = t('Ваш менеджер свяжется с вами.');
            } catch (e) {
                // Re-enable: an offline clinic must be able to try again later.
                cta.disabled = false;
                foot.textContent = t('Не удалось отправить заявку. Попробуйте ещё раз.');
            }
        },
    }, t('Подключить модуль'));

    root.appendChild(h('div', { class: 'card locked-module' },
        h('div', { class: 'lm-label' }, t('Модуль не подключён')),
        h('h1', { class: 'lm-title' }, mod.title),
        h('p', { class: 'lm-blurb' }, mod.blurb),
        cta,
        foot,
    ));
}
```

- [ ] **Step 3: Add the styling**

Append to `public/css/admin-views.css`:

```css
/* LICENCE_CORE_V1 — the locked-module screen. Deliberately calm and roomy: it is
   a small sales page, not a warning. */
.locked-module { max-width: 560px; margin: 48px auto; text-align: left; padding: 32px; }
.locked-module .lm-label { font-size: 12px; letter-spacing: .04em; text-transform: uppercase;
    color: var(--muted, #7a8a89); margin-bottom: 14px; }
.locked-module .lm-title { font-size: 26px; line-height: 1.25; margin: 0 0 14px; font-weight: 700; }
.locked-module .lm-blurb { font-size: 15px; line-height: 1.6; color: var(--text-2, #475756); margin: 0 0 28px; }
.locked-module .lm-cta { height: 46px; padding: 0 26px; font-size: 15px; font-weight: 600; }
.locked-module .lm-cta[disabled] { opacity: .75; cursor: default; }
.locked-module .lm-foot { font-size: 13px; color: var(--muted, #7a8a89); margin: 16px 0 0; line-height: 1.5; }
```

- [ ] **Step 4: Check it renders**

Run: `npm start`, log in, and confirm the app still loads normally. The screen is not routed yet —
Task 14 does that. This step is only to prove nothing broke.

- [ ] **Step 5: Commit**

```bash
git add public/js/admin/views/locked-module.js public/js/admin/i18n-strings.js public/css/admin-views.css
git commit -m "feat: locked-module screen — a sales page, not an error"
```

---

### Task 14: Mark and route locked modules

**Files:**
- Modify: `public/js/admin.js`

- [ ] **Step 1: Import what you need**

At the top of `public/js/admin.js`, beside the other admin imports:

```js
import { setLicence, isLicensed, licenceState } from './admin/licence.js';   // LICENCE_CORE_V1
import { renderLockedModule } from './admin/views/locked-module.js';   // LICENCE_CORE_V1
```

- [ ] **Step 2: Load the licence at boot**

In `public/js/admin.js`, inside `boot()` (line ~2247), find these two lines:

```js
    const userRow = await rehydrateUserFromSession();
    if (!userRow) { showLogin(); return; }
```

Immediately **after** them, add:

```js
    // LICENCE_CORE_V1 — fetched before onAuthed() paints the shell, so the sidebar
    // is never drawn with a module open and then corrected a frame later.
    //
    // An RPC rather than a field on /api/auth/me: db-auth.js's getUser() returns
    // only { data: { user } } and drops every other property of that response, so
    // a licence block added there would vanish silently. See Task 11 Step 5.
    try {
        const { data: lic } = await supabase.rpc('licence_status', {});
        setLicence(lic || null);
    } catch (e) {
        // A licence check that cannot run must never stop someone logging in.
        // null means "clinical core open, paid modules closed" — see licence.js.
        console.warn('[licence]', e && e.message);
        setLicence(null);
    }
```

- [ ] **Step 3: Draw the lock marker in the sidebar**

In `renderSidebar()`, find the block that appends each nav button (line ~968). Replace it
**entirely** — this is the existing code plus two additions:

```js
        // LICENCE_CORE_V1 — an unbought module stays VISIBLE and gets a lock mark.
        // Hiding it would hide what the clinic could buy, and nobody asks for a
        // feature they have never seen. Note this is deliberately NOT folded into
        // isModuleAllowed() above: that gate hides, this one marks.
        const unlicensed = !isLicensed(item.id);
        currentNav.appendChild(h('button', {
            class: 'nav-item' + (active ? ' active' : '') + (unlicensed ? ' nav-locked' : ''),
            title: t('sidebar.nav.' + item.id, item.label),   // SIDEBAR_RAIL_V1 — readable when collapsed
            onclick: () => navigate(item.id),
        },
            h('span', { class: 'nav-icon' }, Icon(item.icon, { size: 18 })),
            h('span', null, t('sidebar.nav.' + item.id, item.label)),
            badgeText && h('span', {
                class: 'nav-badge' + (item.badgeKind === 'alert' && navCounts[item.id] > 0 ? ' alert' : ''),
            }, badgeText),
            unlicensed && h('span', { class: 'nav-lock-icon' }, Icon('Lock', { size: 14 })),
        ));
```

`icons.js` has no `Lock` glyph. Add one to the icon map in `public/js/admin/icons.js`, in the same
style as its neighbours — a real icon, never an emoji:

```js
    Lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
```

- [ ] **Step 4: Route an unlicensed module to the sales screen**

In `navigate()`, find the guard at line ~772: `if (!isRouteAllowed(viewName)) {`. Immediately
**before** it, add:

```js
    // LICENCE_CORE_V1 — checked BEFORE the role gate. A clinic that has not bought
    // a module should be offered it, not told their role is wrong: those are two
    // different problems with two different fixes.
    if (!isLicensed(viewName)) {
        await renderLockedModule(contentRoot, viewName);
        return;
    }
```

Use the same variable the surrounding code uses for the content container in place of
`contentRoot`.

- [ ] **Step 5: Style the marker**

Append to `public/css/admin.css`:

```css
/* LICENCE_CORE_V1 — an unbought module: visible, reachable, plainly marked. */
.sidebar .nav-locked { opacity: .62; }
.sidebar .nav-lock-icon { margin-left: auto; opacity: .8; flex: 0 0 auto; }
```

- [ ] **Step 6: Verify by hand — this is the acceptance test for the whole feature**

```bash
node scripts/make-licence.mjs enroll --clinic c-test --name "Тест"
node scripts/make-licence.mjs issue --clinic c-test --name "Тест" --modules crm --days 14
cp control-c-test.json data/control.json
cp licence-c-test.dat  data/licence.dat
npm start
```

Log in as admin and confirm all four:

1. **CRM opens normally** — it is in the licence.
2. **«Чат с пациентами» shows a lock icon** and clicking it opens the sales screen, not an error.
3. **Clicking «Подключить модуль»** changes the button to «Заявка отправлена». Confirm the row
   landed: `node -e "const D=require('better-sqlite3');console.log(new D('data/easymed.db').prepare('SELECT * FROM module_requests').all())"`
4. **Clicking it a second time creates no second row.**

- [ ] **Step 7: Run the whole suite**

Run: `npm test` — Expected: all passing.

- [ ] **Step 8: Commit**

```bash
git add public/js/admin.js public/js/admin/icons.js public/css/admin.css
git commit -m "feat: mark unbought modules in the sidebar and route them to the offer"
```

---

### Task 15: The banner and the activation screen

**Files:**
- Create: `public/js/admin/views/activation.js`
- Modify: `public/js/admin.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: Add the strings**

Add to `public/js/admin/i18n-strings.js`:

```js
  "Подписка не активна": {"en":"Subscription inactive","ru":"Подписка не активна","uz":"Obuna faol emas"},
  "Нет связи с Easy-Med": {"en":"No connection to Easy-Med","ru":"Нет связи с Easy-Med","uz":"Easy-Med bilan aloqa yo'q"},
  "Позвоните менеджеру Easy-Med и назовите этот код:": {"en":"Call your Easy-Med manager and read them this code:","ru":"Позвоните менеджеру Easy-Med и назовите этот код:","uz":"Easy-Med menejeriga qo'ng'iroq qiling va bu kodni ayting:"},
  "Введите код разблокировки": {"en":"Enter the unlock code","ru":"Введите код разблокировки","uz":"Qulfni ochish kodini kiriting"},
  "Активировать": {"en":"Activate","ru":"Активировать","uz":"Faollashtirish"},
  "Система разблокирована.": {"en":"System unlocked.","ru":"Система разблокирована.","uz":"Tizim qulfdan chiqarildi."},
  "Данные клиники на месте. Пока подписка не активна, можно только просматривать записи.": {"en":"Your clinic's data is intact. While the subscription is inactive you can view records but not change them.","ru":"Данные клиники на месте. Пока подписка не активна, можно только просматривать записи.","uz":"Klinika ma'lumotlari joyida. Obuna faol bo'lmaguncha yozuvlarni faqat ko'rish mumkin."},
```

- [ ] **Step 2: Write the activation screen**

Create `public/js/admin/views/activation.js`:

```js
import { h } from '../ui.js';
import { t } from '../i18n.js';
import { supabase } from '../../supabase.js';

// LICENCE_CORE_V1 — the screen a lapsed clinic lands on.
//
// It exists because login deliberately stays open when the subscription lapses:
// if an admin could not reach this screen, a clinic that WANTED to pay would have
// no way to say so, and the only route back would be an engineer's visit.
//
// The reassurance line is not decoration. A clinic seeing its system lock is
// frightened about its records; saying plainly that the data is intact prevents
// the panicked phone call and the reputational damage that follows it.

export async function renderActivation(root, licence) {
    root.replaceChildren();

    const unpaid = licence?.reason === 'unpaid';
    let status = null;
    try {
        const { data } = await supabase.rpc('licence_status', {});
        status = data;
    } catch (e) { /* offline is the normal case here — fall through with no challenge */ }

    const input = h('input', {
        type: 'text', class: 'input act-code', autocomplete: 'off',
        placeholder: 'XXXXX-XXXXX', 'aria-label': t('Введите код разблокировки'),
    });

    const msg = h('p', { class: 'act-msg' });

    const btn = h('button', {
        type: 'button', class: 'btn btn-primary',
        onclick: async () => {
            btn.disabled = true;
            msg.textContent = '';
            try {
                const { error } = await supabase.rpc('licence_unlock', { code: input.value });
                if (error) throw error;
                msg.textContent = t('Система разблокирована.');
                setTimeout(() => window.location.reload(), 900);
            } catch (e) {
                btn.disabled = false;
                msg.textContent = (e && e.message) || '';
            }
        },
    }, t('Активировать'));

    root.appendChild(h('div', { class: 'card activation' },
        h('h1', { class: 'act-title' }, unpaid ? t('Подписка не активна') : t('Нет связи с Easy-Med')),
        h('p', { class: 'act-sub' },
            t('Данные клиники на месте. Пока подписка не активна, можно только просматривать записи.')),
        status?.challenge
            ? h('div', { class: 'act-challenge' },
                h('p', null, t('Позвоните менеджеру Easy-Med и назовите этот код:')),
                h('div', { class: 'act-challenge-code' }, status.challenge))
            : null,
        h('div', { class: 'act-form' }, input, btn),
        msg,
    ));
}
```

- [ ] **Step 3: Route to it, and add the countdown banner**

In `public/js/admin.js`, add the import:

```js
import { renderActivation } from './admin/views/activation.js';   // LICENCE_CORE_V1
```

In `navigate()`, **before** the unlicensed-module check added in Task 14 Step 4, add:

```js
    // LICENCE_CORE_V1 — a lapsed subscription outranks everything: it blocks every
    // module, not just the unbought ones. Two separate conditions on purpose, see
    // spec §4 — "module not bought" and "subscription lapsed" are different
    // problems with different screens and different ways out.
    const _lic = licenceState();
    if (_lic.locked && viewName !== 'activation') {
        await renderActivation(document.getElementById('view-root'), _lic);
        return;
    }
```

Now the banner. It mounts the same way `verify-banner.js` does — above `.app`, not inside the
tab strip, so it cannot be pushed off-screen by a crowded toolbar. Add this function near the
bottom of `admin.js`:

```js
// LICENCE_CORE_V1 — the warning ramp. A lock must never arrive as a surprise.
//
// The two messages matter more than the mechanism: a clinic whose ROUTER died and
// a clinic that stopped paying are on mechanically identical countdowns, and
// telling the first one about money is how you lose a paying customer.
function renderLicenceBanner() {
    document.getElementById('em-licence-banner')?.remove();
    const l = licenceState();
    if (l.state !== 'notice' && l.state !== 'warn') return;

    const text = l.reason === 'unpaid'
        ? `Подписка заканчивается через ${l.days_left} дн. Свяжитесь с менеджером Easy-Med.`
        : `Нет связи с Easy-Med ${l.days_left} дн. Проверьте интернет — иначе система заблокируется.`;

    const banner = h('div', { id: 'em-licence-banner', class: 'licence-banner licence-' + l.state }, text);
    const root = document.querySelector('.app') || document.body.firstChild;
    document.body.insertBefore(banner, root);
}
```

Call it from `onAuthed()`, immediately after the shell is started:

```js
    renderLicenceBanner();   // LICENCE_CORE_V1
```

- [ ] **Step 4: Style both**

Append to `public/css/admin-views.css`:

```css
/* LICENCE_CORE_V1 */
.activation { max-width: 520px; margin: 56px auto; padding: 34px; text-align: center; }
.activation .act-title { font-size: 24px; margin: 0 0 12px; font-weight: 700; }
.activation .act-sub { color: var(--text-2, #475756); line-height: 1.6; margin: 0 0 26px; }
.activation .act-challenge { background: var(--surface-2, #f2f7f6); border-radius: 12px; padding: 18px; margin-bottom: 24px; }
.activation .act-challenge p { margin: 0 0 10px; font-size: 14px; color: var(--text-2, #475756); }
.activation .act-challenge-code { font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 30px; letter-spacing: .22em; font-weight: 700; }
.activation .act-form { display: flex; gap: 10px; justify-content: center; }
.activation .act-code { width: 190px; text-align: center; font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 17px; letter-spacing: .12em; text-transform: uppercase; }
.activation .act-msg { margin: 16px 0 0; min-height: 20px; font-size: 14px; }

.licence-banner { padding: 7px 14px; border-radius: 9px; font-size: 13px; font-weight: 500; }
.licence-notice { background: #f2f7f6; color: #475756; }
.licence-warn   { background: #fde68a; color: #7c5a00; }
```

- [ ] **Step 5: Verify by hand — the full lapse and recovery**

```bash
node scripts/make-licence.mjs issue --clinic c-test --name "Тест" --modules crm --days -1
cp licence-c-test.dat data/licence.dat
npm start
```

Confirm all five:

1. **Login still works.** (If it does not, you have broken the most important rule in this plan.)
2. The activation screen appears with a six-character code.
3. **Opening a patient card still shows the record** — reads are not blocked.
4. **Saving anything fails** with «Подписка не активна».
5. Take the code, and on the vendor side run:
   ```bash
   node scripts/make-licence.mjs unlock --clinic c-test --challenge <CODE> --secret <unlock_secret from data/control.json>
   ```
   Type the returned code into the activation screen. **The system unlocks and writes work again.**

- [ ] **Step 6: Run the whole suite**

Run: `npm test` — Expected: all passing.

- [ ] **Step 7: Commit**

```bash
git add public/js/admin/views/activation.js public/js/admin.js \
        public/js/admin/i18n-strings.js public/css/admin-views.css
git commit -m "feat: activation screen and the countdown banner before a lock"
```

---

### Task 16: Final verification

- [ ] **Step 1: Full suite, from clean**

Run: `npm test`
Expected: **every test passing**, and the total is at least 1100 + the ~70 added here. Record the
exact number in the commit message.

- [ ] **Step 2: Prove a broken licence cannot stop the clinic working**

```bash
echo "corrupted" > data/licence.dat
npm start
```

Expected: the server **starts**, `/api/health` answers, login works, and the activation screen
appears. It must not crash. Then:

```bash
rm data/licence.dat
npm start
```

Expected: identical behaviour — locked, not broken.

- [ ] **Step 3: Prove the clock defence works**

With a valid 14-day licence installed, set the Windows clock forward 30 days, start the app and
confirm it locks. Set the clock back to today, restart, and confirm **it stays locked** — the
high-water mark must not be undone. Then set the clock correctly and issue a fresh licence to
recover.

- [ ] **Step 4: Restore your development licence**

```bash
node scripts/make-licence.mjs issue --clinic c-test --name "Тест" --modules crm,telegram,marketing --days 3650
cp licence-c-test.dat data/licence.dat
```

- [ ] **Step 5: Update the project notes**

In `CLAUDE.md`, replace the "Next work" line under **Current status** with:

```markdown
Licensing core (Plan 1a) is **done**: signed Ed25519 licences, the 14-day lock ladder,
server-side write gating, the locked-module offer screen and telephone unlock. Licences are
issued by hand with `node scripts/make-licence.mjs`. Next: Plan 1b — the control-plane service
at settings.easymed.uz and the daily check-in that replaces hand-delivered licence files.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: licensing core complete — record state and the hand-issue workflow"
```

---

## Definition of done

- [ ] `npm test` passes with no failures, having gained roughly 70 tests
- [ ] A clinic with a valid licence works exactly as it did before this plan
- [ ] An unbought module is **visible, marked, and offers itself** rather than erroring
- [ ] Requesting a module twice produces one lead, not two
- [ ] A lapsed clinic can log in and read, cannot write, and cannot export
- [ ] An admin can always reach the activation screen
- [ ] A telephone unlock restores service with no internet
- [ ] Editing `modules` or `valid_until` in `licence.dat` locks the app rather than unlocking it
- [ ] Winding the PC clock backwards does not extend a licence
- [ ] A missing, empty or corrupt licence file locks the app but never stops it starting
- [ ] Licensing never modifies clinical data — it writes only to `control_state` and
      `module_requests` (spec §9 invariant 5)
- [ ] `vendor-private.pem` is gitignored and has never been committed

## Deliberately out of scope

Belongs to later plans; do not build it here.

| Not in this plan | Where it goes |
|---|---|
| Any network call, check-in or `settings.easymed.uz` | Plan 1b |
| The vendor panel UI | Plan 1b |
| Automatic enrollment (codes are hand-delivered here) | Plan 1b |
| Statistics collection | Plan 2 |
| `EASYMED_DATA_DIR`, Windows service, versioned layout | Plan 3 |
| Release bundles and remote updates | Plan 4 |

**One limitation to state plainly rather than pretend away:** export blocking is enforced in the
browser only. Exports are built client-side from ordinary `select` queries, which a locked clinic
is still allowed to make, so a determined user could pull the same data through the API. This
matches spec §12 risk 1, which already records that the lock applies commercial pressure without
truly retaining data — `data/easymed.db` is an ordinary file on the clinic's own computer.
