import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { applyUpdate } from './updater.js';
import { readJsonFile } from './checkin.js';

// NODE_NATIVE_UPDATES_V1 — THE TEST THE OLD DESIGN COULD NOT HAVE.
//
// Its predecessor (apply-spawn.smoke.test.js, deleted with the scripts it
// covered) spawned the real apply-update.ps1 and skipped itself everywhere
// else, so CI — which runs on ubuntu — never executed the apply step at all.
// Four consecutive releases installed nothing on any clinic and every safety
// net missed it: the dev folder is a dev layout so the step is skipped there,
// every unit test injected a fake `spawn` and asserted ARGUMENTS, CI has no
// powershell.exe, and a silent failure reports nothing for the auto-halt to
// count.
//
// The apply is now ordinary Node, so this file runs everywhere — that
// portability is the whole point of the change, not a side effect of it. It
// builds a REAL versioned layout in a temp directory, runs the REAL apply
// against it, and asserts what actually matters: the junction moved, the old
// version survived, the database was snapshotted, and the outcome file can be
// read back by the app's OWN reader.
//
// Nothing here touches a real install: every path is under os.tmpdir(), and
// exitImpl is stubbed so the restart is observed rather than performed.

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/**
 * A real versioned install: <root>/versions/<old|new>/server/index.js, a
 * `current` link pointing at the old one, and a real SQLite database in
 * <root>/data with a row in it — the row is what proves the snapshot is a
 * usable database rather than an empty file.
 *
 * The link is created with the SAME call production uses ('junction' on
 * Windows, ignored elsewhere), so this fixture cannot be right while the
 * implementation is wrong.
 */
function install({ oldVersion = '0.1.3', newVersion = '0.1.4', link = true } = {}) {
  const root = tmpDir('em-apply-');
  for (const v of [oldVersion, newVersion]) {
    fs.mkdirSync(path.join(root, 'versions', v, 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'versions', v, 'server', 'index.js'), `// ${v}\n`);
  }
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const currentLink = path.join(root, 'current');
  const oldDir = path.join(root, 'versions', oldVersion);
  const newDir = path.join(root, 'versions', newVersion);
  if (link) {
    fs.symlinkSync(oldDir, currentLink, process.platform === 'win32' ? 'junction' : 'dir');
  }

  const dbPath = path.join(dataDir, 'easymed.db');
  const db = openDb(dbPath);
  migrate(db);
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('marker','x','Marker','admin')").run();

  return { root, dataDir, db, dbPath, currentLink, oldDir, newDir, oldVersion, newVersion };
}

function exitSpy() {
  const calls = [];
  return { impl: (code) => calls.push(code), calls };
}

// --- the happy path, for real ---------------------------------------------

test('a real apply: the junction moves, the database is snapshotted, and the outcome is readable', async () => {
  const inst = install();
  const exit = exitSpy();

  const result = await applyUpdate(inst.db, inst.dataDir, {
    root: inst.root,
    version: inst.newVersion,
    exitImpl: exit.impl,
  });

  assert.equal(result.ok, true, result.detail);
  assert.equal(result.from, '0.1.3');

  // 1. The switch actually happened — resolved through the link, not inferred
  //    from the fact that no error was thrown.
  assert.equal(path.resolve(fs.realpathSync(inst.currentLink)), path.resolve(inst.newDir));
  assert.equal(
    fs.readFileSync(path.join(inst.currentLink, 'server', 'index.js'), 'utf8').trim(),
    '// 0.1.4',
    'reading through `current` must now reach the NEW version',
  );

  // 2. The database snapshot exists AND is a usable database. A raw file copy
  //    of a WAL database can silently lose the most recent writes, which is
  //    why db/backup.js uses db.backup() — asserting the row is what tells the
  //    two apart (same assertion db/backup.test.js makes, for the same reason).
  const backups = fs.readdirSync(path.join(inst.dataDir, 'backups'));
  assert.deepEqual(backups, ['pre-0.1.4.db'], 'one snapshot, named for the version being installed');
  const restored = openDb(path.join(inst.dataDir, 'backups', 'pre-0.1.4.db'));
  assert.equal(restored.prepare("SELECT COUNT(*) n FROM users WHERE username='marker'").get().n, 1);

  // 3. The outcome file, through the app's OWN reader — not a bare
  //    JSON.parse. This is the contract checkin.js and the updates screen both
  //    depend on, and the one that silently broke for the whole life of the
  //    PowerShell apply.
  const resultPath = path.join(inst.dataDir, 'update-result.json');
  const outcome = readJsonFile(resultPath);
  assert.ok(outcome, 'the clinic must be able to read the outcome its own updater just wrote');
  assert.equal(outcome.version, '0.1.4');
  assert.equal(outcome.from, '0.1.3');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.db, 'current');
  assert.ok(!Number.isNaN(new Date(outcome.at).getTime()), 'at parses as a date');
  assert.ok(typeof outcome.detail === 'string' && outcome.detail.length > 0);

  // 4. The restart request — exit code 75 is what install/launcher/EasyMed.cs
  //    loops on. Without it the clinic keeps serving the old code from memory
  //    until somebody closes the window (three times on 2026-08-24).
  assert.deepEqual(exit.calls, [75]);
});

test('the outcome file is written WITHOUT a BOM — the bug that made auto-halt impossible', async () => {
  const inst = install();
  await applyUpdate(inst.db, inst.dataDir, { root: inst.root, version: inst.newVersion, exitImpl: () => {} });

  const raw = fs.readFileSync(path.join(inst.dataDir, 'update-result.json'));
  assert.notDeepEqual([raw[0], raw[1], raw[2]], [0xEF, 0xBB, 0xBF], 'PowerShell wrote EF BB BF here; Node must not');
  // The stricter claim: a plain JSON.parse — what every reader would have
  // written if the BOM had never existed — succeeds on it.
  assert.equal(JSON.parse(raw.toString('utf8')).ok, true);
});

test('removing `current` removes the LINK, never the version it points at', async () => {
  // THE ASSERTION THAT MUST NEVER STOP PASSING. If fs.rmSync ever followed the
  // junction into its target, an update would delete the clinic's running
  // application instead of a shortcut to it — and the previous version, which
  // is the entire rollback story (recover.cmd points `current` back at it),
  // would be gone with it.
  const inst = install();
  await applyUpdate(inst.db, inst.dataDir, { root: inst.root, version: inst.newVersion, exitImpl: () => {} });

  assert.ok(fs.existsSync(path.join(inst.oldDir, 'server', 'index.js')),
    'the PREVIOUS version must still be on disk after the switch — rollback depends on it');
  assert.equal(fs.readFileSync(path.join(inst.oldDir, 'server', 'index.js'), 'utf8').trim(), '// 0.1.3');
});

test('no `current` link at all (a copy-pasted package): one is created', async () => {
  // Junctions do not survive being copy-pasted between machines, so a fresh
  // clinic package genuinely arrives without one — the launcher normally
  // rebuilds it, but an update must not fail just because it ran first.
  const inst = install({ link: false });
  const exit = exitSpy();
  const result = await applyUpdate(inst.db, inst.dataDir, {
    root: inst.root, version: inst.newVersion, exitImpl: exit.impl,
  });

  assert.equal(result.ok, true, result.detail);
  assert.equal(result.from, null, 'there was nothing to come FROM');
  assert.equal(path.resolve(fs.realpathSync(inst.currentLink)), path.resolve(inst.newDir));
  assert.deepEqual(exit.calls, [75]);
});

// --- the failures: the clinic keeps running the OLD version -----------------

test('a failed repoint leaves the OLD version current and records ok:false', async () => {
  const inst = install();
  const exit = exitSpy();

  // Fails only for the NEW target, so the recovery path (put the old link
  // back) runs for real — which is exactly the behaviour under test.
  const result = await applyUpdate(inst.db, inst.dataDir, {
    root: inst.root,
    version: inst.newVersion,
    exitImpl: exit.impl,
    symlinkSync: (target, link, type) => {
      if (path.resolve(target) === path.resolve(inst.newDir)) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return fs.symlinkSync(target, link, type);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(path.resolve(fs.realpathSync(inst.currentLink)), path.resolve(inst.oldDir),
    'the clinic must be left running the version it was already running');

  const outcome = readJsonFile(path.join(inst.dataDir, 'update-result.json'));
  assert.ok(outcome, 'a failure the vendor cannot read is a failure the auto-halt cannot count');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.version, '0.1.4');
  assert.equal(outcome.from, '0.1.3');
  assert.equal(outcome.db, 'untouched', 'nothing that fails here may claim it touched the database');
  assert.match(outcome.detail, /EPERM/);
  assert.match(outcome.detail, /put back/);
  assert.deepEqual(exit.calls, [], 'a failed apply must never ask the launcher to restart');
});

test('a repoint that fails BOTH ways still reports, and says how to recover', async () => {
  // The genuine worst case: the old link is gone and neither link can be
  // made. It must still be a reported failure with an instruction, never a
  // silent one — the state that hid four broken releases.
  const inst = install();
  const result = await applyUpdate(inst.db, inst.dataDir, {
    root: inst.root,
    version: inst.newVersion,
    exitImpl: () => { throw new Error('the launcher must not be asked to restart here'); },
    symlinkSync: () => { throw new Error('EPERM: operation not permitted'); },
  });

  assert.equal(result.ok, false);
  const outcome = readJsonFile(path.join(inst.dataDir, 'update-result.json'));
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /recover\.cmd|launcher rebuilds/);
});

test('an incomplete staged version is refused before anything is switched', async () => {
  const inst = install();
  fs.rmSync(path.join(inst.newDir, 'server', 'index.js'));
  const exit = exitSpy();

  const result = await applyUpdate(inst.db, inst.dataDir, {
    root: inst.root, version: inst.newVersion, exitImpl: exit.impl,
  });

  assert.equal(result.ok, false);
  assert.equal(path.resolve(fs.realpathSync(inst.currentLink)), path.resolve(inst.oldDir));
  assert.equal(fs.existsSync(path.join(inst.dataDir, 'backups')), false,
    'refused at the precondition — not even a snapshot was taken');
  const outcome = readJsonFile(path.join(inst.dataDir, 'update-result.json'));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.db, 'untouched');
  assert.deepEqual(exit.calls, []);
});

test('a `current` that is a REAL directory is refused, not deleted', async () => {
  // switch-version.ps1's Get-CurrentVersionInfo refused this case for a
  // reason: a botched manual install (or a copy-paste that flattened the
  // junction) leaves a real folder there, and "remove it then link" would
  // delete a directory that might BE the running application.
  const inst = install({ link: false });
  fs.mkdirSync(path.join(inst.currentLink, 'server'), { recursive: true });
  fs.writeFileSync(path.join(inst.currentLink, 'server', 'index.js'), '// a real folder, not a link\n');
  const exit = exitSpy();

  const result = await applyUpdate(inst.db, inst.dataDir, {
    root: inst.root, version: inst.newVersion, exitImpl: exit.impl,
  });

  assert.equal(result.ok, false);
  assert.ok(fs.existsSync(path.join(inst.currentLink, 'server', 'index.js')), 'the real directory must be left alone');
  assert.equal(fs.lstatSync(inst.currentLink).isSymbolicLink(), false);
  const outcome = readJsonFile(path.join(inst.dataDir, 'update-result.json'));
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /real directory/);
  assert.deepEqual(exit.calls, []);
});

test('a database snapshot that cannot be taken CANCELS the update', async () => {
  // An update is always deferrable; losing the only rollback point is not.
  // The new version's migrations run at its next boot, so switching without a
  // snapshot means a migration could hurt data with nothing to restore from.
  const inst = install();
  const exit = exitSpy();

  const result = await applyUpdate(inst.db, inst.dataDir, {
    root: inst.root,
    version: inst.newVersion,
    exitImpl: exit.impl,
    backupImpl: async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); },
  });

  assert.equal(result.ok, false);
  assert.equal(path.resolve(fs.realpathSync(inst.currentLink)), path.resolve(inst.oldDir),
    'no snapshot means no switch');
  const outcome = readJsonFile(path.join(inst.dataDir, 'update-result.json'));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.db, 'untouched');
  assert.match(outcome.detail, /ENOSPC/);
  assert.deepEqual(exit.calls, []);
});

test('applying the version already current does nothing, and never asks for a restart', async () => {
  // The backstop against an exit-75 loop: the launcher relaunches on 75, so a
  // "successful" apply that never moved anything would restart forever.
  const inst = install();
  const exit = exitSpy();

  const result = await applyUpdate(inst.db, inst.dataDir, {
    root: inst.root, version: inst.oldVersion, exitImpl: exit.impl,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(exit.calls, []);
  assert.equal(fs.existsSync(path.join(inst.dataDir, 'update-result.json')), false,
    'neither an install nor a failure — the vendor must not be told either');
});

test('the backstop: even a throw nothing predicted produces a readable outcome', async () => {
  // applyUpdate's outer try/catch. Reached here by omitting `root` entirely,
  // which throws inside path.join before any guarded step runs — the class of
  // failure no DI seam can stand in for. It must still be REPORTED: "no
  // outcome" is precisely the state that let four broken releases look healthy
  // to the vendor's auto-halt for a month.
  const inst = install();
  const exit = exitSpy();
  const result = await applyUpdate(inst.db, inst.dataDir, { version: '0.1.4', exitImpl: exit.impl });

  assert.equal(result.ok, false);
  const outcome = readJsonFile(path.join(inst.dataDir, 'update-result.json'));
  assert.ok(outcome, 'an unreadable failure is an uncounted failure');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.version, '0.1.4');
  assert.equal(outcome.db, 'unknown');
  assert.deepEqual(exit.calls, [], 'and nothing may ask for a restart on the way out');
});
