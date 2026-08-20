# Supervised Install (Plan 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Easy-Med runs as a Windows service from a versioned directory, with its data outside the application folder, so a future release can be installed by swapping which version the service points at — and rolled back the same way.

**Architecture:** Three changes, none of them clever. The data directory becomes configurable via `EASYMED_DATA_DIR`. The application is installed under `C:\EasyMed\versions\<version>\` with a `current` junction pointing at the live one. A Windows service runs `C:\EasyMed\current\server\index.js`. Updating then means: unpack the new version beside the old, repoint `current`, restart. Rolling back means repointing it back.

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3. Windows service via `sc.exe` and a small wrapper — **no new npm dependency**. PowerShell for the installer script.

**Spec:** `docs/specs/2026-08-20-control-plane-design.md` §7.

---

## Why this plan exists at all

Updates cannot be built without it. A running Node process on Windows holds its own files open; it cannot overwrite `server/index.js` and restart into the new copy. Every remote-update design that ignores this ends the same way — a half-replaced install that will not start, on a clinic PC, with no engineer in the building.

`SETUP.md` has said "autostart comes in a later phase" since the project began. This is that phase, and it is now on the critical path.

## What must remain true afterwards

1. **`npm start` still works from a checkout**, unchanged, for development. Nothing here may make the dev loop worse.
2. **The database survives an update.** That is the whole point of moving `data/` out of the versioned tree.
3. **A failed update leaves a working clinic.** Not a working *new* version — a working one.
4. **No new runtime dependency.** This project has three and ships offline.

---

## Context for the implementer — read first

- **`npm test`** baseline **1259 passing, 0 failing**. Known flake: roughly one full run in three shows 2-3 `fetch failed / bad port` errors in tests that bind ephemeral ports. Environmental, never assertion failures — re-run before believing one, and never judge off a single run.
- **Never `git add -A` or `git add .`**
- **Never create a git worktree of this repo** — `node_modules/` and `data/` are gitignored, so a worktree has neither, and an earlier agent's worktree cleanup emptied the real `node_modules` mid-session.
- **If `node_modules` is empty**, do NOT `npm install` (it compiles better-sqlite3 from source and fails here). Restore with `cp -r ../easymed.old/node_modules ./node_modules`.
- **Do not kill processes you did not start.** A live instance runs on port 8000. Use a spare port.
- **Comment style:** comments record *why a line exists* — usually the failure that forced it. No git history before 2026-08-20, so comments are the only record.
- `data/` currently holds a **development** licence (`clinic_id: dev-local`, all modules, ten years) and the real 70k-patient database. Do not delete, move, or overwrite either.

### Verified facts — do not re-derive

| Fact | Location |
|---|---|
| `const DATA_DIR = path.join(ROOT, 'data');` — the only place the data path is decided at boot | `server/index.js:13` |
| `createApp(db, { dataDir })` already accepts the directory and defaults to `path.join(ROOT, 'data')` | `server/app.js` |
| `setDataDir(dataDir)` publishes it for RPC handlers, which get no `req` | `server/services/control/config.js` |
| Storage path is derived from `dataDir` already | `server/app.js` |
| Migrations run at boot, in `server/index.js`, before `listen()` | `server/index.js` |
| `openDb()` sets WAL, so the DB is three files: `.db`, `.db-wal`, `.db-shm` | `server/db/connection.js` |
| The Telegram poller starts at boot and reads a key from the data dir | `server/services/telegram/index.js` |

---

## File structure

```
server/
  index.js                    MODIFY  — EASYMED_DATA_DIR, backup-before-migrate
  index.datadir.test.js       CREATE  — proves the env var is honoured
  db/backup.js                CREATE  — copy the database before migrations run
  db/backup.test.js           CREATE
install/
  install-service.ps1         CREATE  — lay out C:\EasyMed, register the service
  uninstall-service.ps1       CREATE
  switch-version.ps1          CREATE  — repoint `current`, restart, verify, roll back
  README.md                   CREATE  — what an installer does at a clinic, in plain terms
SETUP.md                      MODIFY  — replace the "later phase" note
```

---

### Task 1: The data directory becomes configurable

**Files:**
- Modify: `server/index.js`
- Test: `server/index.datadir.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/index.datadir.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataDir } from './index.js';

test('with no environment variable, the data directory is <root>/data', () => {
  const root = '/srv/easymed';
  assert.equal(resolveDataDir({}, root), path.join(root, 'data'));
});

test('EASYMED_DATA_DIR wins when set', () => {
  assert.equal(resolveDataDir({ EASYMED_DATA_DIR: 'C:\\EasyMed\\data' }, '/srv/easymed'), 'C:\\EasyMed\\data');
});

test('an empty or whitespace value is ignored, not obeyed', () => {
  // A service registered with a blank environment entry must not put the clinic
  // database in the filesystem root.
  const root = '/srv/easymed';
  assert.equal(resolveDataDir({ EASYMED_DATA_DIR: '' }, root), path.join(root, 'data'));
  assert.equal(resolveDataDir({ EASYMED_DATA_DIR: '   ' }, root), path.join(root, 'data'));
});

test('a relative value resolves against the application root, not the cwd', () => {
  // A Windows service starts with cwd = C:\Windows\system32. A relative path
  // resolved against that would silently create a second, empty database there
  // and the clinic would open the app to an empty patient list.
  const root = path.join(os.tmpdir(), 'em-root');
  assert.equal(resolveDataDir({ EASYMED_DATA_DIR: 'mydata' }, root), path.join(root, 'mydata'));
});

test('the directory is created if it does not exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-dd-'));
  const target = path.join(root, 'nested', 'data');
  resolveDataDir({ EASYMED_DATA_DIR: target }, root, { mkdir: true });
  assert.ok(fs.existsSync(target));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/index.datadir.test.js`
Expected: FAIL — `resolveDataDir` is not exported.

- [ ] **Step 3: Implement**

`server/index.js` currently decides the path at line 13 and immediately uses it. Extract that decision into an exported, testable function and call it. Replace:

```js
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
```

with:

```js
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// SUPERVISED_INSTALL_V1 — where the clinic's data lives.
//
// It must be settable from outside because the application directory becomes
// versioned: C:\EasyMed\versions\2.4.0\ is replaced wholesale by an update, and
// anything inside it is thrown away with the old version. The database, the
// licence and uploaded files have to sit somewhere an update never touches.
//
// A relative value resolves against ROOT rather than the working directory. A
// Windows service starts with cwd = C:\Windows\system32; resolving there would
// quietly create a second, empty database and the clinic would open the app to an
// empty patient list, with their real records still on disk but unreferenced.
export function resolveDataDir(env = process.env, root = ROOT, { mkdir = false } = {}) {
  const raw = String(env.EASYMED_DATA_DIR || '').trim();
  const dir = raw ? path.resolve(root, raw) : path.join(root, 'data');
  if (mkdir) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const DATA_DIR = resolveDataDir(process.env, ROOT, { mkdir: true });
```

Then make every later use of the data path in this file read `DATA_DIR` rather than recomputing it, and pass it to `createApp`:

```js
const server = createApp(db, { dataDir: DATA_DIR }).listen(PORT, '0.0.0.0', () => {
```

Read the whole file and check each existing use — the Telegram bot and the session pruner may also need it.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test server/index.datadir.test.js` — Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the dev loop is unchanged and the override works**

```bash
npm start
```
Expected: starts as before, serving the existing 70k-patient database. Stop it.

```bash
EASYMED_DATA_DIR=/tmp/em-alt npm start
```
Expected: starts, creates `/tmp/em-alt`, and reports **FIRST RUN — admin account created** with a generated password, because that directory has an empty database. Confirm `/tmp/em-alt/easymed.db` exists and the real `data/easymed.db` is untouched (`ls -la data/`). Stop it and delete `/tmp/em-alt`.

- [ ] **Step 6: Run the whole suite**

Run: `npm test` — Expected: **1264 passing, 0 failing.**

- [ ] **Step 7: Commit**

```bash
git add server/index.js server/index.datadir.test.js
git commit -m "feat: the data directory is settable, so an update cannot delete it"
```

---

### Task 2: Back up the database before migrations run

**Files:**
- Create: `server/db/backup.js`
- Test: `server/db/backup.test.js`
- Modify: `server/index.js`

An update installs a new version and boots it; migrations then run against the clinic's live database. If one fails halfway, or succeeds and the new version then crashes, rolling back the *code* is not enough — the database has already moved on. This is the rollback.

- [ ] **Step 1: Write the failing test**

Create `server/db/backup.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';
import { backupBeforeMigrate, pruneBackups } from './backup.js';

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-bk-'));
  const dbPath = path.join(dir, 'easymed.db');
  const db = openDb(dbPath);
  migrate(db);
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('a','x','A','admin')").run();
  return { dir, dbPath, db };
}

test('a backup is taken and is a usable database', () => {
  const { dir, dbPath, db } = workspace();
  const out = backupBeforeMigrate(db, dbPath, '2.4.0');
  assert.ok(fs.existsSync(out), 'the file exists');

  const restored = openDb(out);
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM users').get().n, 1,
    'the copy opens and holds the same rows — a raw file copy of a WAL database can lose the last writes');
});

test('the backup name records the version being installed', () => {
  const { dbPath, db } = workspace();
  assert.match(path.basename(backupBeforeMigrate(db, dbPath, '2.4.0')), /2\.4\.0/);
});

test('taking a backup twice does not overwrite the first', () => {
  const { dbPath, db } = workspace();
  const a = backupBeforeMigrate(db, dbPath, '2.4.0');
  const b = backupBeforeMigrate(db, dbPath, '2.4.0');
  assert.notEqual(a, b, 'a retried update must not destroy the pre-update state');
});

test('old backups are pruned but the newest are kept', () => {
  const { dir, dbPath, db } = workspace();
  const made = [];
  for (let i = 0; i < 7; i++) made.push(backupBeforeMigrate(db, dbPath, '2.4.' + i));
  pruneBackups(path.join(dir, 'backups'), 3);
  const left = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(left.length, 3, 'a clinic disk is not infinite');
  assert.ok(left.includes(path.basename(made[6])), 'the newest survives');
  assert.ok(!left.includes(path.basename(made[0])), 'the oldest is gone');
});

test('a failure to back up is reported, not swallowed', () => {
  const { db } = workspace();
  assert.throws(() => backupBeforeMigrate(db, '/definitely/not/here/easymed.db', '2.4.0'));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test server/db/backup.test.js` — Expected: FAIL, cannot find `./backup.js`.

- [ ] **Step 3: Implement**

Create `server/db/backup.js`:

```js
import fs from 'node:fs';
import path from 'node:path';

// SUPERVISED_INSTALL_V1 — the rollback for an update.
//
// Reverting code is trivial; reverting a migration is not. So the design never
// tries: it restores the database from a copy taken immediately before the
// migrations ran. That copy IS the rollback story, and everything else about
// remote updates depends on it existing.
//
// better-sqlite3's own .backup() is used rather than fs.copyFileSync. The
// database runs in WAL mode, so the .db file on disk is NOT the whole database —
// recent writes live in the -wal sidecar. A plain file copy silently loses them,
// and the loss only shows up when the backup is restored, which is the worst
// possible moment to discover it.

/**
 * @param {Database} db      the open connection
 * @param {string} dbPath    where that database lives on disk
 * @param {string} version   the version about to be installed, for the filename
 * @returns {string} the path written
 */
export function backupBeforeMigrate(db, dbPath, version) {
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });

  // A retried update must not destroy the state the first attempt captured, so
  // the name carries a counter rather than being overwritten.
  const base = `pre-${version}`;
  let n = 0;
  let out = path.join(dir, `${base}.db`);
  while (fs.existsSync(out)) out = path.join(dir, `${base}.${++n}.db`);

  db.backup(out);   // synchronous in better-sqlite3; checkpoints the WAL for us
  return out;
}

/** Keep the newest `keep` backups. A clinic PC does not have infinite disk. */
export function pruneBackups(dir, keep = 3) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')); } catch { return; }
  const byAge = files
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of byAge.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* a locked file is not worth failing a boot over */ }
  }
}
```

**Check `db.backup()` is synchronous in the installed better-sqlite3 version** before relying on it. If it returns a promise in this version, await it and make `backupBeforeMigrate` async — and say so in your report, because the caller in `index.js` runs before `listen()`.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test server/db/backup.test.js` — Expected: PASS, 5 tests.

- [ ] **Step 5: Call it at boot, but only when there is something to do**

In `server/index.js`, immediately **before** `migrate(db);`:

```js
// SUPERVISED_INSTALL_V1 — back up before touching the schema, and only then.
//
// Guarded on there being unapplied migrations so an ordinary restart does not
// copy a 36 MB database every time the clinic reboots its PC. The version string
// comes from package.json so a restored file says what it was rescued from.
try {
  if (pendingMigrations(db).length) {
    const out = backupBeforeMigrate(db, path.join(DATA_DIR, 'easymed.db'), APP_VERSION);
    console.log(`  Database backed up before update: ${out}`);
    pruneBackups(path.join(DATA_DIR, 'backups'), 3);
  }
} catch (e) {
  // A clinic must not be unable to start because a backup could not be written —
  // but it must be loud, because the next migration is now unprotected.
  console.error('[backup] FAILED — migrations will run WITHOUT a rollback point:', e.message);
}
migrate(db);
```

You will need `pendingMigrations(db)` — add it to `server/db/migrate.js` as a small exported helper that returns the list of `.sql` files not yet recorded in `schema_migrations`, reusing the existing directory read and the duplicate-prefix guard. Give it its own test in `server/db/migrate.test.js`: none pending on a migrated database, all pending on an empty one.

`APP_VERSION` comes from `package.json` — read it once at boot with `createRequire` or `fs.readFileSync`, and default to `'0.0.0'` if unreadable.

- [ ] **Step 6: Prove it end to end**

```bash
cp -r data /tmp/em-bktest && EASYMED_DATA_DIR=/tmp/em-bktest node server/index.js
```
First boot: no unapplied migrations, so **no backup is taken** — confirm `/tmp/em-bktest/backups` does not exist. Stop it.

Now force one: `node -e "const D=require('better-sqlite3');new D('/tmp/em-bktest/easymed.db').prepare(\"DELETE FROM schema_migrations WHERE name='073_licensing.sql'\").run()"`, restart, and confirm a backup **is** written and the migration re-applies. Then delete `/tmp/em-bktest`.

- [ ] **Step 7: Suite and commit**

Run: `npm test` — Expected: **1271 passing, 0 failing.**

```bash
git add server/db/backup.js server/db/backup.test.js server/db/migrate.js server/db/migrate.test.js server/index.js
git commit -m "feat: back up the database before migrations, so an update can be undone"
```

---

### Task 3: The versioned layout and the Windows service

**Files:**
- Create: `install/install-service.ps1`, `install/uninstall-service.ps1`, `install/README.md`

This task is scripts and manual verification; there is no unit test that can prove a Windows service registered correctly. Be correspondingly careful, and report exactly what you ran and saw.

The target layout:

```
C:\EasyMed\
  current              junction  -> versions\2.4.0
  versions\2.3.1\      the previous version, kept for rollback
  versions\2.4.0\      server\, public\, node_modules\, package.json
  data\                easymed.db, licence.dat, control.json, storage\, backups\
  logs\                service stdout/stderr
```

- [ ] **Step 1: Write `install/install-service.ps1`**

It must:
1. Take `-Source <path>` (a checkout or unpacked bundle) and `-Version <string>`, defaulting the version to the `version` field in the source's `package.json`.
2. Create `C:\EasyMed\{versions,data,logs}` if absent. **Never touch `data\` if it already exists** — reinstalling must not disturb a clinic's records.
3. Copy the source to `C:\EasyMed\versions\<version>\`, **excluding `data/` and `.git/`**, including `node_modules/` (the clinic has no internet).
4. Create or repoint the `current` junction with `New-Item -ItemType Junction`.
5. Register a service named `EasyMed` that runs `node.exe C:\EasyMed\current\server\index.js` with `EASYMED_DATA_DIR=C:\EasyMed\data`, set to start automatically, and to restart on failure (`sc.exe failure EasyMed reset= 86400 actions= restart/5000/restart/5000/restart/60000`).
6. Refuse to run without administrator rights, with a plain-language message — a clinic manager will run this.
7. Print, at the end, the URL to open and the first-run admin password if one was generated.

**Node has no built-in service wrapper.** Do not add a dependency. Use `sc.exe create` with a `binPath` that invokes `node.exe` directly. Node processes started this way do not handle service control messages, so **stopping will be a kill** — that is acceptable here because SQLite in WAL mode is crash-safe and the app holds no unflushed state, but say so in the script's comments and in `install/README.md` so nobody assumes a graceful shutdown they are not getting.

Set `-Environment` on the service via `sc.exe` is not possible directly; set it in the registry under `HKLM\SYSTEM\CurrentControlSet\Services\EasyMed\Environment` (a `REG_MULTI_SZ` value), or write a one-line `.cmd` shim in `C:\EasyMed\` that sets the variable and execs node, and point the service at that. **Pick one, and explain in a comment why you rejected the other.**

- [ ] **Step 2: Write `install/uninstall-service.ps1`**

Stops and deletes the service. **Must not delete `C:\EasyMed\data`** — and must say so on screen, so an operator removing the app does not believe the records went with it. Print where the data still is.

- [ ] **Step 3: Write `install/README.md`**

Written for a non-programmer installing at a clinic: what to copy, what to run, what it will ask, how to check it worked, how to back up (`C:\EasyMed\data`), and how to uninstall. Say plainly that all clinic records live in `C:\EasyMed\data` and that folder is the thing to copy for a backup.

- [ ] **Step 4: Verify on this machine**

Run the installer against the current checkout into a **scratch root**, not `C:\EasyMed` — parameterise the destination or temporarily override it, so this machine's real setup is untouched. Confirm:

1. The layout is created and `current` is a junction pointing at the version folder (`Get-Item C:\...\current | Select-Object LinkType, Target`).
2. `data\` was created but **not** populated from the source, and re-running the installer leaves an existing `data\` alone. Prove it by putting a sentinel file in `data\` and re-running.
3. The service registers, starts, and the app answers on its port.
4. Stopping and starting the service works.
5. Uninstall removes the service and leaves `data\` intact, sentinel file present.

Then remove the scratch root and confirm the real port-8000 instance is still running and untouched.

- [ ] **Step 5: Commit**

```bash
git add install/install-service.ps1 install/uninstall-service.ps1 install/README.md
git commit -m "feat: install Easy-Med as a Windows service from a versioned directory"
```

---

### Task 4: Switching versions, and switching back

**Files:**
- Create: `install/switch-version.ps1`

This is the mechanism a remote update will drive. Building it now, separately, means the update client in Plan 4 is a downloader plus a call to this — and it can be tested by hand today.

- [ ] **Step 1: Write it**

`switch-version.ps1 -Version <target>` must:

1. Refuse if `C:\EasyMed\versions\<target>` does not exist.
2. Record the version `current` points at now, so it can go back.
3. Stop the service.
4. Repoint `current` at the target.
5. Start the service.
6. **Health-check**: poll `http://localhost:<port>/api/health` for up to 60 seconds.
7. On failure — service will not start, or health never answers — **repoint `current` back, restart, and report the rollback**. Exit non-zero.
8. Print what it did either way.

Note in comments that this rolls back **code only**. Restoring the database is a separate, deliberate act using the backup from Task 2, because a migration that succeeded may have been correct — automatically reverting data on a health-check failure could destroy a morning's work. Plan 4 decides when to escalate; this script must not do it silently.

- [ ] **Step 2: Verify both directions by hand**

In the scratch root: install version A, install version B, switch to B, confirm the app serves B. Then deliberately break B (rename its `server/index.js`), switch to B again, and confirm the script **rolls back to A by itself** and reports it. Confirm the app is serving A and healthy afterwards.

- [ ] **Step 3: Commit**

```bash
git add install/switch-version.ps1
git commit -m "feat: switch versions with an automatic roll-back on a failed health check"
```

---

### Task 5: Tell the truth in SETUP.md

**Files:**
- Modify: `SETUP.md`

- [ ] **Step 1: Rewrite the daily-use section**

`SETUP.md` currently says autostart and automatic backups come "in a later phase". Both now exist. Replace those notes with:

- how to install at a clinic (point at `install/README.md`),
- that the app starts with Windows and needs no console window,
- that **all clinic data is `C:\EasyMed\data`** and that folder is the backup,
- that pre-update database backups appear in `C:\EasyMed\data\backups\`,
- that `npm start` remains the development path from a checkout.

Keep the existing tone: it is written for a clinic manager, not an engineer.

- [ ] **Step 2: Commit**

```bash
git add SETUP.md
git commit -m "docs: SETUP.md said autostart was a later phase; it is now this one"
```

---

## Definition of done

- [ ] `npm test` passes; the suite has grown by roughly 12 tests
- [ ] `npm start` from a checkout behaves exactly as before
- [ ] `EASYMED_DATA_DIR` relocates the database, licence and uploads together
- [ ] A relative `EASYMED_DATA_DIR` resolves against the app root, never `C:\Windows\system32`
- [ ] A backup is taken **only** when migrations are pending, and it opens as a valid database
- [ ] The installer never disturbs an existing `data\`
- [ ] The service starts with Windows and survives a reboot
- [ ] `switch-version.ps1` rolls back by itself when the new version fails its health check
- [ ] Uninstalling leaves the clinic's records in place and says where they are

## Deliberately out of scope

| Not here | Where |
|---|---|
| Downloading or verifying release bundles | Plan 4 |
| Deciding *when* to update, and asking permission | Plan 4 |
| Rollout rings and automatic halt | Plan 4 |
| Restoring a database backup automatically | Plan 4 — this plan only creates them |
| Anything about subscriptions or the panel | Plan 1b |
