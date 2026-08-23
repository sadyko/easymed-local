import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import {
  listBackups, createBackup, runDailyBackup, scheduleDailyBackups,
  pruneBackupsByKind, requestRestore, requestFactoryReset, processPendingAction,
} from './backup.js';

// SYSTEM_SETTINGS_V1 — everything here runs against a throwaway temp dir,
// mirroring db/backup.test.js: this suite must never look at the real data/
// folder, where a dev server may be holding easymed.db open right now.
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sysbk-'));
  const dbPath = path.join(dir, 'easymed.db');
  const db = openDb(dbPath);
  migrate(db);
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('a','x','A','admin')").run();
  return { dir, dbPath, db };
}

const backupsDir = (dir) => path.join(dir, 'backups');
const marker = (dir) => path.join(dir, 'pending-action.json');
const userCount = (file) => openDb(file).prepare('SELECT COUNT(*) n FROM users').get().n;

// --- createBackup -----------------------------------------------------------

test('createBackup writes a usable database named by its kind', async () => {
  const { dir, db } = workspace();
  const entry = await createBackup(db, dir, 'manual');
  assert.match(entry.name, /^manual-\d{8}-\d{6}\.db$/);
  assert.equal(entry.kind, 'manual');
  assert.ok(entry.size > 0);
  assert.equal(userCount(path.join(backupsDir(dir), entry.name)), 1,
    'the copy opens and holds the rows — same WAL-safety contract as backupBeforeMigrate');
});

test('two backups in the same second do not collide', async () => {
  const { dir, db } = workspace();
  const now = new Date();
  const [a, b] = await Promise.all([
    createBackup(db, dir, 'manual', now),
    createBackup(db, dir, 'manual', now),
  ]);
  assert.notEqual(a.name, b.name, 'a double-clicked «Создать копию» must not overwrite its own first copy');
  assert.equal(userCount(path.join(backupsDir(dir), a.name)), 1);
  assert.equal(userCount(path.join(backupsDir(dir), b.name)), 1);
});

test('createBackup refuses an unknown kind', async () => {
  const { dir, db } = workspace();
  await assert.rejects(() => createBackup(db, dir, 'weird'), /kind/);
  await assert.rejects(() => createBackup(db, dir, '../../evil'), /kind/,
    'the kind lands in a filename, so it must never be caller-shaped text');
});

// --- listBackups ------------------------------------------------------------

test('listBackups reports name, kind, size and age, newest first', async () => {
  const { dir, db } = workspace();
  const a = await createBackup(db, dir, 'manual');
  fs.utimesSync(path.join(backupsDir(dir), a.name), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const b = await createBackup(db, dir, 'safety', new Date(Date.now() + 1000));
  const list = listBackups(dir);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, b.name, 'newest first');
  assert.equal(list[0].kind, 'safety');
  assert.equal(list[1].kind, 'manual');
  assert.ok(list[1].size > 0 && list[1].mtimeMs > 0);
});

test('listBackups ignores non-backups: bad names, sidecars, directories, unknown prefixes', async () => {
  const { dir, db } = workspace();
  await createBackup(db, dir, 'manual');
  const bd = backupsDir(dir);
  fs.writeFileSync(path.join(bd, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(bd, 'daily-20260801-120000.db-wal'), 'x');
  // replaced-* is a raw move-aside whose -wal sits NEXT to it, not inside it —
  // offering it for restore would silently lose that WAL's writes, so it is
  // kept on disk but never listed (the safety- copy of the same moment is the
  // restorable one).
  fs.writeFileSync(path.join(bd, 'replaced-20260801-120000.db'), 'x');
  fs.mkdirSync(path.join(bd, 'dir.db'));
  fs.writeFileSync(path.join(bd, 'pre-2.4.0.db'), 'x');
  const list = listBackups(dir);
  assert.deepEqual(list.map((e) => e.kind).sort(), ['manual', 'pre']);
});

test('listBackups on a data dir with no backups folder is empty, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sysbk-empty-'));
  assert.deepEqual(listBackups(dir), []);
});

// --- pruneBackupsByKind -----------------------------------------------------

test('pruning is per kind: daily backups can never evict update-rollback points', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sysbk-prune-'));
  // Plain files with hand-set mtimes: pruning reads names and dates, never content.
  let t = Date.now() - 1e6;
  const put = (name) => {
    fs.writeFileSync(path.join(dir, name), 'x');
    fs.utimesSync(path.join(dir, name), new Date(t), new Date(t));
    t += 1000;
  };
  for (let i = 0; i < 16; i++) put(`daily-202608${String(i + 1).padStart(2, '0')}-030000.db`);
  for (let i = 0; i < 12; i++) put(`manual-202608${String(i + 1).padStart(2, '0')}-100000.db`);
  for (let i = 0; i < 7; i++) put(`safety-202608${String(i + 1).padStart(2, '0')}-110000.db`);
  for (let i = 0; i < 6; i++) put(`final-202608${String(i + 1).padStart(2, '0')}-120000.db`);
  for (let i = 0; i < 4; i++) put(`pre-2.4.${i}.db`);
  put('replaced-20260810-090000.db');

  pruneBackupsByKind(dir);

  const left = fs.readdirSync(dir);
  const count = (prefix) => left.filter((f) => f.startsWith(prefix)).length;
  assert.equal(count('daily-'), 14);
  assert.equal(count('manual-'), 10);
  assert.equal(count('safety-'), 5);
  assert.equal(count('final-'), 5);
  assert.equal(count('pre-'), 3);
  assert.equal(count('replaced-'), 1, 'moved-aside databases are never auto-deleted');
  assert.ok(left.includes('daily-20260816-030000.db'), 'the newest of each kind survives');
  assert.ok(!left.includes('daily-20260801-030000.db'), 'the oldest goes');
});

test('pruning a missing directory is a no-op, not a crash', () => {
  pruneBackupsByKind(path.join(os.tmpdir(), 'em-sysbk-no-such-dir'));
});

// --- daily schedule ---------------------------------------------------------

test('one daily backup per local day: the second tick of the day is a no-op', async () => {
  const { dir, db } = workspace();
  const morning = new Date('2026-08-23T08:05:00');
  assert.ok(await runDailyBackup(db, dir, morning), 'first tick creates');
  assert.equal(await runDailyBackup(db, dir, new Date('2026-08-23T17:05:00')), null, 'same day, nothing to do');
  assert.equal(listBackups(dir).filter((b) => b.kind === 'daily').length, 1);
  assert.ok(await runDailyBackup(db, dir, new Date('2026-08-24T08:05:00')), 'next day creates again');
  assert.equal(listBackups(dir).filter((b) => b.kind === 'daily').length, 2);
});

test('scheduleDailyBackups arms real timers and the first tick takes a backup', async () => {
  const { dir, db } = workspace();
  const handles = scheduleDailyBackups(db, dir, { initialDelayMs: 5, intervalMs: 60_000 });
  try {
    const until = Date.now() + 3000;
    while (Date.now() < until && listBackups(dir).length === 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(listBackups(dir)[0]?.kind, 'daily');
  } finally {
    clearTimeout(handles.initial);
    clearInterval(handles.interval);
  }
});

test('a failing tick is contained: the schedule never throws out of a timer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sysbk-fail-'));
  const broken = { backup: () => Promise.reject(new Error('boom')) };
  const handles = scheduleDailyBackups(broken, dir, { initialDelayMs: 5, intervalMs: 60_000 });
  await new Promise((r) => setTimeout(r, 60));
  clearTimeout(handles.initial);
  clearInterval(handles.interval);
  // Reaching this line IS the assertion: an uncaught rejection from the tick
  // would have failed the test process.
});

// --- requestRestore ---------------------------------------------------------

test('requestRestore takes a safety copy first, then writes the marker', async () => {
  const { dir, db } = workspace();
  const snap = await createBackup(db, dir, 'manual');
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('b','x','B','admin')").run();

  const r = await requestRestore(db, dir, snap.name);
  assert.equal(r.ok, true);

  const safety = listBackups(dir).find((b) => b.kind === 'safety');
  assert.ok(safety, 'the current state is captured BEFORE any restore intent lands on disk');
  assert.equal(userCount(path.join(backupsDir(dir), safety.name)), 2,
    'the safety copy holds the newer data the restore is about to discard');

  assert.deepEqual(JSON.parse(fs.readFileSync(marker(dir), 'utf8')), { action: 'restore', backup: snap.name });
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp-')), 'the marker write left no temp file behind');
});

test('requestRestore refuses a name that is not in the listing', async () => {
  const { dir, db } = workspace();
  await createBackup(db, dir, 'manual');
  for (const name of ['no-such.db', '../easymed.db', '..\\easymed.db', 'backups/x.db', '']) {
    const r = await requestRestore(db, dir, name);
    assert.equal(r.ok, false, `"${name}" must be refused`);
  }
  assert.ok(!fs.existsSync(marker(dir)), 'no marker for a refused restore');
  assert.ok(!listBackups(dir).some((b) => b.kind === 'safety'), 'no safety copy for a refused restore');
});

// --- requestFactoryReset ----------------------------------------------------

test('requestFactoryReset takes a final copy and records the wipe choice', async () => {
  const { dir, db } = workspace();
  const r = await requestFactoryReset(db, dir, { wipeBackups: true });
  assert.equal(r.ok, true);
  assert.ok(listBackups(dir).some((b) => b.kind === 'final'), 'fat fingers exist: even a deliberate wipe gets a last copy');
  assert.deepEqual(JSON.parse(fs.readFileSync(marker(dir), 'utf8')), { action: 'factory_reset', wipe_backups: true });
});

// --- processPendingAction: restore ------------------------------------------

async function restoreScenario() {
  const { dir, db } = workspace();                       // 1 user
  const snap = await createBackup(db, dir, 'manual');    // snapshot: 1 user
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('b','x','B','admin')").run(); // now 2
  await requestRestore(db, dir, snap.name);
  db.close();                                            // boot runs before openDb — no handle is held
  return { dir, snap };
}

test('a restore marker swaps the database in at boot and deletes the marker last', async () => {
  const { dir, snap } = await restoreScenario();
  const r = processPendingAction(dir);
  assert.equal(r.action, 'restore');
  assert.equal(r.backup, snap.name);
  assert.equal(userCount(path.join(dir, 'easymed.db')), 1, 'the old snapshot is now the live database');
  assert.ok(fs.readdirSync(backupsDir(dir)).some((f) => /^replaced-\d{8}-\d{6}\.db$/.test(f)),
    'the replaced database was moved aside, never deleted');
  assert.ok(!fs.existsSync(marker(dir)));
  assert.equal(processPendingAction(dir).action, null, 'a second boot finds nothing to do');
});

test('a restore moves the WAL sidecars aside with the database', async () => {
  const { dir } = await restoreScenario();
  // db.close() checkpointed the real sidecars away; plant stand-ins to prove
  // the move covers them — a stale -wal left beside the restored .db would be
  // replayed INTO it on the next open, corrupting the restore.
  fs.writeFileSync(path.join(dir, 'easymed.db-wal'), 'stale');
  fs.writeFileSync(path.join(dir, 'easymed.db-shm'), 'stale');
  processPendingAction(dir);
  assert.ok(!fs.existsSync(path.join(dir, 'easymed.db-wal')));
  assert.ok(!fs.existsSync(path.join(dir, 'easymed.db-shm')));
  const aside = fs.readdirSync(backupsDir(dir));
  assert.ok(aside.some((f) => f.endsWith('.db-wal')) && aside.some((f) => f.endsWith('.db-shm')));
});

test('a crash between restore and marker delete is safe: the re-run restores again', async () => {
  const { dir, snap } = await restoreScenario();
  processPendingAction(dir);
  // Simulate the crash window: the action completed but the marker survived.
  fs.writeFileSync(marker(dir), JSON.stringify({ action: 'restore', backup: snap.name }));
  const r = processPendingAction(dir);
  assert.equal(r.action, 'restore');
  assert.equal(userCount(path.join(dir, 'easymed.db')), 1, 'restoring twice lands in the same state');
  assert.ok(!fs.existsSync(marker(dir)));
});

test('a restore marker naming a missing or traversal backup is quarantined, database untouched', async () => {
  const { dir, db } = workspace();
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('b','x','B','admin')").run();
  db.close();
  for (const backup of ['gone.db', '../easymed.db', 42, null]) {
    fs.writeFileSync(marker(dir), JSON.stringify({ action: 'restore', backup }));
    const r = processPendingAction(dir);
    assert.equal(r.action, null);
    assert.ok(fs.existsSync(marker(dir) + '.bad'), 'the marker is set aside for inspection, not deleted');
    fs.rmSync(marker(dir) + '.bad');
  }
  assert.equal(userCount(path.join(dir, 'easymed.db')), 2, 'the live database was never moved');
});

// --- processPendingAction: factory reset ------------------------------------

async function resetScenario(wipeBackups) {
  const { dir, db } = workspace();
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ clinic_id: 'c-1' }));
  fs.writeFileSync(path.join(dir, 'licence.dat'), 'licence');
  fs.mkdirSync(path.join(dir, 'storage', 'documents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'storage', 'documents', 'scan.pdf'), 'pdf');
  await requestFactoryReset(db, dir, { wipeBackups });
  db.close();
  return dir;
}

test('a factory reset wipes the clinic back to a virgin install', async () => {
  const dir = await resetScenario(false);
  const r = processPendingAction(dir);
  assert.equal(r.action, 'factory_reset');
  for (const f of ['easymed.db', 'easymed.db-wal', 'easymed.db-shm', 'control.json', 'licence.dat']) {
    assert.ok(!fs.existsSync(path.join(dir, f)), `${f} must be gone`);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'storage')), 'uploaded patient documents are clinic data too');
  assert.ok(fs.readdirSync(backupsDir(dir)).some((f) => f.startsWith('final-')),
    'backups survive by default — recovery-from-mistake beats clean-disk');
  assert.ok(!fs.existsSync(marker(dir)));
});

test('wipe_backups takes the backups tree too — the clean-disk path', async () => {
  const dir = await resetScenario(true);
  processPendingAction(dir);
  assert.ok(!fs.existsSync(backupsDir(dir)));
});

test('a factory reset re-run after a crash is safe on an already-empty dir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sysbk-reset2-'));
  fs.writeFileSync(marker(dir), JSON.stringify({ action: 'factory_reset', wipe_backups: true }));
  const r = processPendingAction(dir);
  assert.equal(r.action, 'factory_reset');
  assert.ok(!fs.existsSync(marker(dir)));
});

// --- processPendingAction: hostile/corrupt markers --------------------------

test('a malformed marker is renamed .bad and boot continues', () => {
  const { dir, db } = workspace();
  db.close();
  fs.writeFileSync(marker(dir), 'not json {{{');
  const r = processPendingAction(dir);
  assert.equal(r.action, null);
  assert.ok(fs.existsSync(marker(dir) + '.bad'), 'kept for inspection — a corrupt marker must never brick or wipe a clinic');
  assert.ok(!fs.existsSync(marker(dir)));
  assert.ok(fs.existsSync(path.join(dir, 'easymed.db')), 'nothing was deleted');
});

test('an unknown action is quarantined the same way', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sysbk-unk-'));
  fs.writeFileSync(marker(dir), JSON.stringify({ action: 'defrag' }));
  assert.equal(processPendingAction(dir).action, null);
  assert.ok(fs.existsSync(marker(dir) + '.bad'));
});

test('no marker at all is the common case and does nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sysbk-none-'));
  assert.equal(processPendingAction(dir).action, null);
});
