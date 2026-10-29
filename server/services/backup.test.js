import { tmpDir, closeOnExit, closeRegistered } from '../test-helpers/tmpdir.js';   // TEST_TMPDIR_V1 — папка уберётся сама
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
import { __setDiskSpaceForTests, readGuard, dbBytes, copyNeedBytes, GB } from './disk-guard.js';   // DISK_GUARD_V1

// DISK_GUARD_V1 — диск машины разработчика не данные теста (на 2026-10-29 там
// 0,9 % свободно — меньше порога 10 %, и чистка по объёму стирала бы копии
// посреди чужих тестов). Весь файл видит просторный диск; тесты места
// подставляют свой ответ сами.
const ROOMY = () => ({ free: 500 * GB, total: 1000 * GB });
__setDiskSpaceForTests(ROOMY);
test.after(() => __setDiskSpaceForTests(null));

// SYSTEM_SETTINGS_V1 — everything here runs against a throwaway temp dir,
// mirroring db/backup.test.js: this suite must never look at the real data/
// folder, where a dev server may be holding easymed.db open right now.
// V3120_FIX — базы закрываются по окончании файла, чтобы папки удалялись.
test.after(closeRegistered);

function workspace() {
  const dir = tmpDir('em-sysbk-');
  const dbPath = path.join(dir, 'easymed.db');
  const db = closeOnExit(openDb(dbPath));   // V3120_FIX — открытая база не даёт Windows удалить папку
  migrate(db);
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('a','x','A','admin')").run();
  return { dir, dbPath, db };
}

const backupsDir = (dir) => path.join(dir, 'backups');
const marker = (dir) => path.join(dir, 'pending-action.json');
const userCount = (file) => {
  const db = openDb(file);
  try { return db.prepare('SELECT COUNT(*) n FROM users').get().n; } finally { db.close(); }
};

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
  const dir = tmpDir('em-sysbk-empty-');
  assert.deepEqual(listBackups(dir), []);
});

// --- pruneBackupsByKind -----------------------------------------------------

test('pruning is per kind: daily backups can never evict update-rollback points', () => {
  const dir = tmpDir('em-sysbk-prune-');
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
  const dir = tmpDir('em-sysbk-fail-');
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
  const dir = tmpDir('em-sysbk-reset2-');
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
  const dir = tmpDir('em-sysbk-unk-');
  fs.writeFileSync(marker(dir), JSON.stringify({ action: 'defrag' }));
  assert.equal(processPendingAction(dir).action, null);
  assert.ok(fs.existsSync(marker(dir) + '.bad'));
});

test('no marker at all is the common case and does nothing', () => {
  const dir = tmpDir('em-sysbk-none-');
  assert.equal(processPendingAction(dir).action, null);
});

// --- DISK_GUARD_V1: оборвавшаяся копия ---------------------------------------

// НАСТОЯЩАЯ копия better-sqlite3, оборванная посередине. db.backup — единственное,
// чем createBackup трогает базу, поэтому подставлена обёртка над настоящим
// db.backup с обработчиком хода, который на первом шаге бросает SQLITE_FULL —
// так копия обрывается на полном диске. Имя занято заранее через 'wx', и
// better-sqlite3 такой файл за собой не удаляет (backup.cpp: unlink только для
// файла, которого до копии не было) — ровно та беда, которую лечит DISK_GUARD_V1.
function abortingMidCopy(db) {
  return {
    backup: (out) => db.backup(out, {
      progress() { throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' }); },
    }),
  };
}

test('DISK_GUARD_V1: оборвавшаяся копия удаляется вместе со всеми частями, в списке её нет', async () => {
  const { dir, db } = workspace();
  await assert.rejects(() => createBackup(abortingMidCopy(db), dir, 'manual'), { code: 'SQLITE_FULL' });
  assert.deepEqual(fs.readdirSync(backupsDir(dir)), [], 'ни обрывка .db, ни -journal, ни папки .files');
  assert.deepEqual(listBackups(dir), [], 'обрывок не выдаёт себя за годную копию');
});

test('DISK_GUARD_V1: оборвавшаяся ежедневная копия не закрывает день — следующий такт делает её снова', async () => {
  const { dir, db } = workspace();
  await assert.rejects(() => runDailyBackup(abortingMidCopy(db), dir, new Date('2026-08-23T08:05:00')), { code: 'SQLITE_FULL' });
  const again = await runDailyBackup(db, dir, new Date('2026-08-23T09:05:00'));
  assert.ok(again, 'день не был отмечен сделанным: обрывок 08:05 не считается копией дня');
  assert.equal(listBackups(dir).filter((b) => b.kind === 'daily').length, 1);
  assert.equal(userCount(path.join(backupsDir(dir), again.name)), 1, 'а новая — настоящая база');
});

test('DISK_GUARD_V1: обрывок с меткой .broken не в списке и не закрывает день', async () => {
  const { dir, db } = workspace();
  fs.mkdirSync(backupsDir(dir), { recursive: true });
  fs.writeFileSync(path.join(backupsDir(dir), 'daily-20260823-080500.db'), 'x');
  fs.writeFileSync(path.join(backupsDir(dir), 'daily-20260823-080500.db.broken'), 'partial');
  assert.deepEqual(listBackups(dir), []);
  assert.ok(await runDailyBackup(db, dir, new Date('2026-08-23T09:05:00')));
});

test('DISK_GUARD_V1: помеченный обрывок удаляется вместе с меткой и папкой файлов при следующем запуске', async () => {
  const { dir, db } = workspace();
  const b = backupsDir(dir);
  fs.mkdirSync(path.join(b, 'daily-20260822-080500.files'), { recursive: true });
  fs.writeFileSync(path.join(b, 'daily-20260822-080500.files', 'a'), 'x');
  fs.writeFileSync(path.join(b, 'daily-20260822-080500.db'), 'x');
  fs.writeFileSync(path.join(b, 'daily-20260822-080500.db-journal'), 'x');
  fs.writeFileSync(path.join(b, 'daily-20260822-080500.db.broken'), 'partial');
  await createBackup(db, dir, 'manual');
  assert.deepEqual(fs.readdirSync(b).filter((f) => f.startsWith('daily-')), []);
});

// --- DISK_GUARD_V1: место перед копией ---------------------------------------

test('DISK_GUARD_V1: места нет и уступать нечего — копия не делается, ничего не стёрто, причина записана', async () => {
  const { dir, db } = workspace();
  const keepMe = await createBackup(db, dir, 'manual');
  const tight = () => ({ free: GB / 2, total: 100 * GB });
  await assert.rejects(() => createBackup(db, dir, 'manual', new Date(), { diskSpaceImpl: tight }), (e) => {
    assert.equal(e.code, 'no_space');
    assert.match(e.message, /^Недостаточно места на диске: нужно \d+,\d ГБ, свободно 0,5 ГБ\. Копия не сделана\.$/);
    assert.equal(e.template, 'Недостаточно места на диске: нужно {need} ГБ, свободно {free} ГБ. Копия не сделана.');
    return true;
  });
  assert.deepEqual(listBackups(dir).map((b) => b.name), [keepMe.name], 'ручная копия на месте, новой нет');
  const g = readGuard(dir).copy_refused;
  assert.equal(g.kind, 'manual');
  assert.equal(g.free_bytes, GB / 2);
  assert.ok(g.need_bytes > GB, 'нужно — база × 1,2 + 1 ГБ');

  await createBackup(db, dir, 'manual');
  assert.equal(readGuard(dir).copy_refused, undefined, 'копия получилась — отказ больше не правда');
});

// Порядок уступок (п. 2): ежедневные → лишние «перед обновлением» (последняя
// остаётся) → страховочные. Ручные не трогаются никогда. Каждая копия — 100 КБ,
// а «свободно» на shortKb меньше нужного: уходит ровно столько, сколько нужно.
const SEEDED = ['pre-2.4.0.db', 'daily-20260801-030000.db', 'safety-20260802-110000.db',
  'daily-20260803-030000.db', 'pre-2.4.1.db', 'manual-20260804-100000.db'];
function seedForSpace(bd) {
  fs.mkdirSync(bd, { recursive: true });
  let t = Date.now() - 1e6;
  for (const name of SEEDED) {
    fs.writeFileSync(path.join(bd, name), Buffer.alloc(100 * 1024));
    fs.utimesSync(path.join(bd, name), new Date(t), new Date(t));
    t += 1000;
  }
}
for (const [shortKb, gone] of [
  [150, ['daily-20260801-030000.db', 'daily-20260803-030000.db']],
  [250, ['daily-20260801-030000.db', 'daily-20260803-030000.db', 'pre-2.4.0.db']],
  [350, ['daily-20260801-030000.db', 'daily-20260803-030000.db', 'pre-2.4.0.db', 'safety-20260802-110000.db']],
]) {
  test(`DISK_GUARD_V1: не хватает ${shortKb} КБ — уступают ${gone.join(', ')}`, async () => {
    const { dir, db } = workspace();
    const bd = backupsDir(dir);
    seedForSpace(bd);
    const need = copyNeedBytes(dbBytes(path.join(dir, 'easymed.db')));
    // total 5 ГБ: свободно ≈ 1 ГБ — больше 10 % диска, а копий — меньше 30 %,
    // так что чистка по объёму после копии ничего не добавит к уступкам.
    const made = await createBackup(db, dir, 'manual', new Date(), {
      diskSpaceImpl: () => ({ free: need - shortKb * 1024, total: 5 * GB }),
    });
    const left = fs.readdirSync(bd).filter((f) => f.endsWith('.db')).sort();
    assert.deepEqual(left, [...SEEDED.filter((n) => !gone.includes(n)), made.name].sort(),
      'последняя «перед обновлением» и ручные не трогаются');
  });
}

test('DISK_GUARD_V1: копия, которую восстанавливают, не уступает место страховочной', async () => {
  const { dir, db } = workspace();
  const bd = backupsDir(dir);
  fs.mkdirSync(bd, { recursive: true });
  const target = 'daily-20260801-030000.db';
  fs.writeFileSync(path.join(bd, target), Buffer.alloc(100 * 1024));
  const need = copyNeedBytes(dbBytes(path.join(dir, 'easymed.db')));
  __setDiskSpaceForTests(() => ({ free: need - 50 * 1024, total: 5 * GB }));
  try {
    await assert.rejects(() => requestRestore(db, dir, target), (e) => e.code === 'no_space');
  } finally {
    __setDiskSpaceForTests(ROOMY);
  }
  assert.ok(fs.existsSync(path.join(bd, target)), 'иначе восстанавливать было бы нечего');
  assert.ok(!fs.existsSync(marker(dir)), 'без страховочной копии намерение не пишется');
});

// --- DISK_GUARD_V1: предел по объёму и чистка сразу ---------------------------

function putSized(bd, name, kb, t) {
  fs.writeFileSync(path.join(bd, name), Buffer.alloc(kb * 1024));
  fs.utimesSync(path.join(bd, name), new Date(t), new Date(t));
}

test('DISK_GUARD_V1: копии больше 30 % диска — автоматические уходят от старых к новым, пока не уложатся', () => {
  const dir = tmpDir('em-sysbk-cap-');
  const bd = path.join(dir, 'backups');
  fs.mkdirSync(bd);
  let t = Date.now() - 1e6;
  for (const n of ['daily-20260801-030000.db', 'safety-20260802-110000.db', 'pre-2.4.0.db',
    'manual-20260803-100000.db', 'daily-20260804-030000.db']) { putSized(bd, n, 300, t); t += 1000; }
  // 1500 КБ копий на «диске» 4000 КБ — 37,5 %; предел 30 % — 1200 КБ.
  pruneBackupsByKind(bd, { diskSpaceImpl: () => ({ free: 2000 * 1024, total: 4000 * 1024 }) });
  assert.deepEqual(fs.readdirSync(bd).sort(),
    ['daily-20260804-030000.db', 'manual-20260803-100000.db', 'pre-2.4.0.db', 'safety-20260802-110000.db'],
    'ушла одна, самая старая автоматическая — и копии уложились в 30 %');
});

// Поправка 1 плана: предел по объёму не трогает самую новую копию каждого
// автоматического вида — поэтому здесь две ежедневные, и уходит старшая.
test('DISK_GUARD_V1: свободно меньше 10 % — уходят и лишние «перед обновлением», последняя остаётся', () => {
  const dir = tmpDir('em-sysbk-free-');
  const bd = path.join(dir, 'backups');
  fs.mkdirSync(bd);
  let t = Date.now() - 1e6;
  for (const n of ['pre-2.3.0.db', 'daily-20260801-030000.db', 'pre-2.4.0.db', 'daily-20260802-030000.db',
    'manual-20260803-100000.db']) {
    putSized(bd, n, 100, t); t += 1000;
  }
  // Диск 10000 КБ, свободно 800 КБ (8 %): нужно освободить 200 КБ.
  pruneBackupsByKind(bd, { diskSpaceImpl: () => ({ free: 800 * 1024, total: 10000 * 1024 }) });
  assert.deepEqual(fs.readdirSync(bd).sort(), ['daily-20260802-030000.db', 'manual-20260803-100000.db', 'pre-2.4.0.db'],
    'pre-2.4.0 — точка отката текущей версии, daily-0802 — самая новая ежедневная, ручная — не автоматическая');
});

// Поправка 1 плана: диск занят ДРУГИМИ файлами — свободно меньше 10 %, сколько
// копий ни удаляй. Чистка по объёму не опустошает копии: самая новая каждого
// автоматического вида остаётся, а в журнал программы уходит предупреждение.
test('DISK_GUARD_V1: диск занят другими файлами — самые новые ежедневная, «перед обновлением» и страховочная остаются, предупреждение о месте', async (t) => {
  const { dir, db } = workspace();
  const bd = backupsDir(dir);
  fs.mkdirSync(bd, { recursive: true });
  let ts = Date.now() - 1e6;
  for (const n of ['daily-20260801-030000.db', 'pre-2.3.0.db', 'safety-20260802-110000.db',
    'daily-20260803-030000.db', 'pre-2.4.0.db', 'safety-20260804-110000.db', 'manual-20260805-100000.db']) {
    putSized(bd, n, 100, ts); ts += 1000;
  }
  const warns = [];
  t.mock.method(console, 'warn', (...a) => { warns.push(a.join(' ')); });
  // Диск 100 ГБ, свободно 2 ГБ (2 %): на копию места хватает, а «меньше 10 %»
  // не исправить никакой чисткой копий.
  const made = await createBackup(db, dir, 'manual', new Date(), { diskSpaceImpl: () => ({ free: 2 * GB, total: 100 * GB }) });
  assert.deepEqual(fs.readdirSync(bd).filter((f) => f.endsWith('.db')).sort(),
    ['daily-20260803-030000.db', made.name, 'manual-20260805-100000.db', 'pre-2.4.0.db', 'safety-20260804-110000.db'].sort(),
    'ушли только старшие копии каждого автоматического вида');
  assert.ok(warns.some((w) => /Мало места на диске/.test(w)), `предупреждение о нехватке места: ${JSON.stringify(warns)}`);
});

test('DISK_GUARD_V1: ручные и финальные одни больше 30 % — не удаляются, на экране предупреждение', () => {
  const dir = tmpDir('em-sysbk-kept-');
  const bd = path.join(dir, 'backups');
  fs.mkdirSync(bd);
  const t = Date.now() - 1e6;
  putSized(bd, 'manual-20260801-100000.db', 200, t);
  putSized(bd, 'final-20260802-120000.db', 200, t + 1000);
  const disk = () => ({ free: 500 * 1024, total: 1000 * 1024 });
  pruneBackupsByKind(bd, { diskSpaceImpl: disk });
  assert.equal(fs.readdirSync(bd).length, 2, 'ручные и финальные сами не удаляются');
  const g = readGuard(dir).kept_over_cap;
  assert.equal(g.bytes, 400 * 1024);
  assert.equal(g.cap_bytes, Math.floor(0.3 * 1000 * 1024));

  fs.rmSync(path.join(bd, 'final-20260802-120000.db'));
  pruneBackupsByKind(bd, { diskSpaceImpl: disk });
  assert.equal(readGuard(dir).kept_over_cap, undefined, 'уложились — предупреждение снято');
});

test('DISK_GUARD_V1: «Создать копию сейчас» чистит старые копии сразу, а не ночью', async () => {
  const { dir, db } = workspace();
  const bd = backupsDir(dir);
  fs.mkdirSync(bd, { recursive: true });
  let t = Date.now() - 1e6;
  for (let i = 0; i < 10; i++) {
    putSized(bd, `manual-202608${String(i + 1).padStart(2, '0')}-100000.db`, 1, t);
    t += 1000;
  }
  const made = await createBackup(db, dir, 'manual');
  const manuals = listBackups(dir).filter((b) => b.kind === 'manual').map((b) => b.name);
  assert.equal(manuals.length, 10, 'KEEP_BY_KIND.manual — 10');
  assert.ok(manuals.includes(made.name));
  assert.ok(!manuals.includes('manual-20260801-100000.db'), 'самая старая ушла сразу');
});

// --- DISK_GUARD_V1: отказы по месту у ежедневной и финальной копии ------------

test('DISK_GUARD_V1: ежедневной копии не хватило места — ничего не стёрто зря, день не закрыт, причина «daily»', async () => {
  const { dir, db } = workspace();
  const bd = backupsDir(dir);
  fs.mkdirSync(bd, { recursive: true });
  const t0 = Date.now() - 1e6;
  putSized(bd, 'daily-20260822-030000.db', 100, t0);
  putSized(bd, 'manual-20260822-100000.db', 100, t0 + 1000);
  const need = copyNeedBytes(dbBytes(path.join(dir, 'easymed.db')));
  // Уступить может только ежедневная на 100 КБ, а не хватает 500 КБ: удалять
  // её бессмысленно — копия всё равно не поместится.
  const tight = () => ({ free: need - 500 * 1024, total: 5 * GB });
  await assert.rejects(() => runDailyBackup(db, dir, new Date('2026-08-23T08:05:00'), { diskSpaceImpl: tight }),
    (e) => e.code === 'no_space');
  assert.deepEqual(fs.readdirSync(bd).sort(), ['daily-20260822-030000.db', 'manual-20260822-100000.db'],
    'ни новой копии, ни зря удалённой старой');
  assert.ok(!fs.existsSync(marker(dir)), 'никаких отметок о действиях');
  const g = readGuard(dir).copy_refused;
  assert.equal(g.kind, 'daily');
  assert.equal(g.free_bytes, need - 500 * 1024);

  const again = await runDailyBackup(db, dir, new Date('2026-08-23T09:05:00'));
  assert.ok(again, 'день не закрыт: следующий такт, когда место есть, делает копию дня');
  assert.equal(readGuard(dir).copy_refused, undefined, 'копия получилась — отказ снят');
});

test('DISK_GUARD_V1: финальной копии не хватило места (копии оставить) — удаление данных не запрошено, причина «final»', async () => {
  const { dir, db } = workspace();
  __setDiskSpaceForTests(() => ({ free: GB / 2, total: 100 * GB }));
  try {
    await assert.rejects(() => requestFactoryReset(db, dir, { wipeBackups: false }), (e) => {
      assert.equal(e.code, 'no_space');
      assert.equal(e.template, 'Недостаточно места на диске: нужно {need} ГБ, свободно {free} ГБ. Копия не сделана.');
      return true;
    });
  } finally {
    __setDiskSpaceForTests(ROOMY);
  }
  assert.ok(!fs.existsSync(marker(dir)), 'без финальной копии намерение удалить всё не пишется');
  assert.deepEqual(listBackups(dir), []);
  assert.equal(readGuard(dir).copy_refused.kind, 'final');
});

test('DISK_GUARD_V1: в ошибке «нет места» числа — числами, русская фраза — для журнала', async () => {
  const { dir, db } = workspace();
  await assert.rejects(
    () => createBackup(db, dir, 'manual', new Date(), { diskSpaceImpl: () => ({ free: GB / 20, total: 100 * GB }) }),
    (e) => {
      // нужно: база × 1,2 + 1 ГБ — чуть больше 1 ГБ, вверх до десятой: 1,1;
      // свободно 0,05 ГБ — вниз: 0,0.
      assert.deepStrictEqual(e.params, { need: 1.1, free: 0 });
      assert.match(e.message, /нужно 1,1 ГБ, свободно 0,0 ГБ\. Копия не сделана\.$/);
      return true;
    },
  );
});

// --- DISK_GUARD_V1: чистка сразу после страховочной и финальной копии ---------

function seedKind(bd, kind, n, suffix) {
  fs.mkdirSync(bd, { recursive: true });
  let t = Date.now() - 1e6;
  const names = [];
  for (let i = 0; i < n; i++) {
    const name = `${kind}-202608${String(i + 1).padStart(2, '0')}-${suffix}.db`;
    putSized(bd, name, 1, t);
    names.push(name);
    t += 1000;
  }
  return names;
}

test('DISK_GUARD_V1: страховочная копия перед восстановлением сразу чистит лишние страховочные', async () => {
  const { dir, db } = workspace();
  const target = await createBackup(db, dir, 'manual');
  const seeded = seedKind(backupsDir(dir), 'safety', 5, '110000');
  assert.equal((await requestRestore(db, dir, target.name)).ok, true);
  const safeties = listBackups(dir).filter((b) => b.kind === 'safety').map((b) => b.name);
  assert.equal(safeties.length, 5, 'KEEP_BY_KIND.safety — 5');
  assert.ok(!safeties.includes(seeded[0]), 'самая старая ушла сразу, а не ночью');
});

test('DISK_GUARD_V1: восстанавливаемая страховочная копия не уходит при чистке после новой страховочной', async () => {
  const { dir, db } = workspace();
  const seeded = seedKind(backupsDir(dir), 'safety', 5, '110000');
  assert.equal((await requestRestore(db, dir, seeded[0])).ok, true);
  const safeties = listBackups(dir).filter((b) => b.kind === 'safety').map((b) => b.name);
  assert.ok(safeties.includes(seeded[0]), 'иначе после перезапуска восстанавливать было бы нечего');
  assert.equal(safeties.length, 6, 'лишняя по счёту осталась ради восстановления');
});

test('DISK_GUARD_V1: финальная копия перед удалением данных сразу чистит лишние финальные', async () => {
  const { dir, db } = workspace();
  const seeded = seedKind(backupsDir(dir), 'final', 5, '120000');
  await requestFactoryReset(db, dir);
  const finals = listBackups(dir).filter((b) => b.kind === 'final').map((b) => b.name);
  assert.equal(finals.length, 5, 'KEEP_BY_KIND.final — 5');
  assert.ok(!finals.includes(seeded[0]), 'самая старая ушла сразу');
});

// --- DISK_GUARD_V1 (ревью C2): удаление «вместе с копиями» на полном диске ----

test('DISK_GUARD_V1: удаление данных вместе со всеми копиями проходит и на полном диске — финальная копия всё равно ушла бы при запуске', async () => {
  const { dir, db } = workspace();
  __setDiskSpaceForTests(() => ({ free: GB / 2, total: 100 * GB }));
  let r;
  try {
    r = await requestFactoryReset(db, dir, { wipeBackups: true });
  } finally {
    __setDiskSpaceForTests(ROOMY);
  }
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(marker(dir), 'utf8')), { action: 'factory_reset', wipe_backups: true },
    'администратор может освободить диск этим путём');
  assert.ok(!listBackups(dir).some((b) => b.kind === 'final'), 'места на неё нет — и не надо');
  assert.equal(readGuard(dir).copy_refused, undefined, 'несделанная финальная копия здесь не отказ: копии удаляются по выбору');
});

// --- DISK_GUARD_V1 (ревью C2): цель восстановления не удаляется ЧУЖОЙ копией ----

test('DISK_GUARD_V1: восстановление самой старой страховочной одновременно с другой страховочной копией — цель цела, намерение честное', async () => {
  const { dir, db } = workspace();
  const seeded = seedKind(backupsDir(dir), 'safety', 5, '110000');
  const [r] = await Promise.all([
    requestRestore(db, dir, seeded[0]),
    createBackup(db, dir, 'safety'),   // например, страховочная копия синхронизации филиалов (relay.js)
  ]);
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(backupsDir(dir), seeded[0])),
    'чужая чистка не удаляет копию, которую сейчас восстанавливают: иначе при запуске восстанавливать нечего');
  assert.equal(JSON.parse(fs.readFileSync(marker(dir), 'utf8')).backup, seeded[0]);
});

test('DISK_GUARD_V1: чужая копия, начатая раньше восстановления, своей чисткой не трогает его цель', async () => {
  const { dir, db } = workspace();
  const seeded = seedKind(backupsDir(dir), 'safety', 5, '110000');
  // Чужая копия встаёт в очередь первой и чистит, пока восстановление ждёт
  // своей страховочной копии: намерения ещё нет — цель бережёт только метка.
  const [, r] = await Promise.all([
    createBackup(db, dir, 'safety'),
    requestRestore(db, dir, seeded[0]),
  ]);
  assert.equal(r.ok, true, 'восстановление не сорвалось из-за чужой чистки');
  assert.ok(fs.existsSync(path.join(backupsDir(dir), seeded[0])));
});

test('DISK_GUARD_V1: цель записанного намерения восстановить не уходит при чистке до перезапуска', async () => {
  const { dir, db } = workspace();
  const seeded = seedKind(backupsDir(dir), 'safety', 5, '110000');
  fs.writeFileSync(marker(dir), JSON.stringify({ action: 'restore', backup: seeded[0] }));
  await createBackup(db, dir, 'safety');
  assert.ok(fs.existsSync(path.join(backupsDir(dir), seeded[0])), 'pending-action.json называет её — она нужна при запуске');
});

test('DISK_GUARD_V1: цель пропала, пока делалась страховочная копия — восстановление не запрашивается', async () => {
  const { dir, db } = workspace();
  const target = await createBackup(db, dir, 'manual');
  // Копию удалили руками (Проводник) прямо во время страховочной копии.
  const vanishing = {
    backup: async (out) => {
      fs.rmSync(path.join(backupsDir(dir), target.name), { force: true });
      return db.backup(out);
    },
  };
  const r = await requestRestore(vanishing, dir, target.name);
  assert.equal(r.ok, false, 'отказ, а не намерение, которое при запуске молча пропустится');
  assert.ok(!fs.existsSync(marker(dir)));
});

// --- DISK_GUARD_V1 (ревью C2): копии по одной ----------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('DISK_GUARD_V1: две копии сразу делаются по очереди, а не вперемешку', async () => {
  const { dir, db } = workspace();
  const log = [];
  const slow = (tag) => ({
    backup: async (out) => { log.push(`начало ${tag}`); await sleep(30); await db.backup(out); log.push(`конец ${tag}`); },
  });
  await Promise.all([createBackup(slow('a'), dir, 'manual'), createBackup(slow('b'), dir, 'manual')]);
  assert.deepEqual(log, ['начало a', 'конец a', 'начало b', 'конец b']);
});

test('DISK_GUARD_V1: вторая из двух одновременных копий заново спрашивает место — запас в 1 ГБ не съедают обе', async () => {
  const { dir, db } = workspace();
  const need = copyNeedBytes(dbBytes(path.join(dir, 'easymed.db')));
  let free = need + GB / 2;   // хватает на одну: копия «съедает» 1 ГБ
  const disk = () => ({ free, total: 100 * GB });
  const log = [];
  const eating = (tag) => ({
    backup: async (out) => { log.push(`начало ${tag}`); await sleep(30); await db.backup(out); free -= GB; log.push(`конец ${tag}`); },
  });
  const [a, b] = await Promise.allSettled([
    createBackup(eating('a'), dir, 'manual', new Date(), { diskSpaceImpl: disk }),
    createBackup(eating('b'), dir, 'manual', new Date(), { diskSpaceImpl: disk }),
  ]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal(b.reason.code, 'no_space');
  assert.deepEqual(log, ['начало a', 'конец a'], 'вторая не начиналась: место кончилось на первой');
});

// --- DISK_GUARD_V1 (ревью C2): «свободно меньше 10 %» — только когда места и правда мало ----

test('DISK_GUARD_V1: диск 1 ТБ, свободно 60 ГБ (6 %) — история копий остаётся', () => {
  const dir = tmpDir('em-sysbk-big-');
  const bd = path.join(dir, 'backups');
  fs.mkdirSync(bd);
  let t = Date.now() - 1e6;
  const names = ['daily-20260801-030000.db', 'daily-20260802-030000.db', 'daily-20260803-030000.db',
    'pre-2.3.0.db', 'pre-2.4.0.db', 'safety-20260804-110000.db', 'safety-20260805-110000.db'];
  for (const n of names) { putSized(bd, n, 10, t); t += 1000; }
  pruneBackupsByKind(bd, { diskSpaceImpl: () => ({ free: 60 * GB, total: 1000 * GB }) });
  assert.deepEqual(fs.readdirSync(bd).sort(), [...names].sort(),
    '60 ГБ хватит на много копий: удалять историю ради «10 %» незачем');
});
