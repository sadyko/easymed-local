import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { hashPassword } from '../auth.js';
import { setDataDir } from '../control/config.js';
import { createBackup, listBackups } from '../backup.js';
import { backupList, backupCreate, backupRestore, factoryReset, diskUsage, __setExitForTests } from './backup.js';
import { getRpc } from './index.js';
import { isAlwaysAllowedRpc } from '../control/gate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';   // TEST_TMPDIR_V1 — папка уберётся сама
import { __setDiskSpaceForTests, noteGuard, readGuard, diskUsageReport, copyNeedBytes, GB } from '../disk-guard.js';   // DISK_GUARD_V1

// DISK_GUARD_V1 — диск машины разработчика не данные теста.
const ROOMY = () => ({ free: 500 * GB, total: 1000 * GB });
__setDiskSpaceForTests(ROOMY);
test.after(() => __setDiskSpaceForTests(null));

// SYSTEM_SETTINGS_V1 — what belongs HERE is the RPC adapter: the admin gate,
// the password re-check, the confirm word, and the exit-75 seam. The backup
// mechanics themselves live in services/backup.js and have their own suite.

// Hashed once for the whole file — bcrypt costs ~60ms per hash and every
// test's fresh() would otherwise pay it again for the identical string.
const PASSWORD = 'correct-horse-9';
const HASH = hashPassword(PASSWORD);

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'admin',?,'Admin','admin')").run(HASH);
  const dir = tmpDir('em-bkrpc-');
  setDataDir(dir);
  return { db, dir };
}

const ADMIN = { id: 1, role: 'admin' };
const marker = (dir) => path.join(dir, 'pending-action.json');

// The stub is installed for the ENTIRE file, before any handler ever runs: a
// test that let the real process.exit(75) fire would kill the test process —
// a failed design, not a failed test. Delay 0 so tests only wait one tick.
let exitCalls = [];
__setExitForTests((code) => exitCalls.push(code), 0);
const exitFired = () => new Promise((r) => setTimeout(r, 25));

test('all four RPCs are registered and stay reachable while licence-locked', () => {
  for (const name of ['backup_list', 'backup_create', 'backup_restore', 'factory_reset']) {
    assert.ok(getRpc(name), `${name} must be in the registry`);
    assert.equal(isAlwaysAllowedRpc(name), true,
      `${name} must survive a lapse — a locked clinic saving (or erasing) its data is the point`);
  }
});

test('backup_list refuses a non-admin before touching the disk', () => {
  const { db } = fresh();
  assert.throws(() => backupList(db, {}, { id: 2, role: 'doctor' }), (e) => {
    assert.match(e.message, /администратор/i);
    assert.equal(e.status, 403);
    return true;
  });
});

test('an admin whose PRIMARY role is doctor still passes — the hasAnyRole rule', async () => {
  const { db } = fresh();
  const adminDoctor = { id: 1, role: 'doctor', extra_roles: ['admin'] };
  assert.ok(backupList(db, {}, adminDoctor).backups);
  assert.equal((await backupCreate(db, {}, adminDoctor)).ok, true);
});

test('backup_list returns the listing plus where it lives and how much room is left', async () => {
  const { db, dir } = fresh();
  await createBackup(db, dir, 'manual');
  await createBackup(db, dir, 'daily');
  const r = backupList(db, {}, ADMIN);
  assert.equal(r.data_dir, dir);
  assert.equal(r.backups.length, 2);
  assert.ok('free_bytes' in r, 'null when the platform cannot say, but always present');
});

test('backup_create takes a manual copy and returns its entry', async () => {
  const { db, dir } = fresh();
  const r = await backupCreate(db, {}, ADMIN);
  assert.equal(r.ok, true);
  assert.equal(r.backup.kind, 'manual');
  assert.ok(fs.existsSync(path.join(dir, 'backups', r.backup.name)));
});

test('backup_restore refuses a wrong password: nothing written, no restart', async () => {
  const { db, dir } = fresh();
  const snap = await createBackup(db, dir, 'manual');
  exitCalls = [];
  await assert.rejects(
    () => backupRestore(db, { name: snap.name, password: 'wrong' }, ADMIN),
    (e) => e.status === 403 && /пароль/i.test(e.message),
  );
  await exitFired();
  assert.ok(!fs.existsSync(marker(dir)), 'no restore intent lands without the caller re-proving who they are');
  assert.ok(!listBackups(dir).some((b) => b.kind === 'safety'), 'not even the safety copy — the request never started');
  assert.deepEqual(exitCalls, []);
});

test('backup_restore refuses a caller whose account no longer exists', async () => {
  const { db, dir } = fresh();
  const snap = await createBackup(db, dir, 'manual');
  await assert.rejects(
    () => backupRestore(db, { name: snap.name, password: PASSWORD }, { id: 99, role: 'admin' }),
    /пароль/i,
  );
});

test('backup_restore refuses a name that is not a listed backup', async () => {
  const { db, dir } = fresh();
  await createBackup(db, dir, 'manual');
  exitCalls = [];
  await assert.rejects(
    () => backupRestore(db, { name: '../easymed.db', password: PASSWORD }, ADMIN),
    (e) => e.status === 400 && /копии/i.test(e.message),
  );
  await exitFired();
  assert.ok(!fs.existsSync(marker(dir)));
  assert.deepEqual(exitCalls, [], 'a refused restore must not restart the clinic');
});

test('backup_restore happy path: marker written, reply says restarting, then exit 75', async () => {
  const { db, dir } = fresh();
  const snap = await createBackup(db, dir, 'manual');
  exitCalls = [];
  const r = await backupRestore(db, { name: snap.name, password: PASSWORD }, ADMIN);
  assert.deepEqual(r, { ok: true, restarting: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(marker(dir), 'utf8')), { action: 'restore', backup: snap.name });
  await exitFired();
  assert.deepEqual(exitCalls, [75], 'exit code 75 is the launcher\'s restart convention');
});

test('factory_reset demands the exact confirm word, checked on the SERVER', async () => {
  const { db, dir } = fresh();
  exitCalls = [];
  for (const confirm of [undefined, '', 'удалить', 'DELETE', 'УДАЛИТЬ ']) {
    await assert.rejects(
      () => factoryReset(db, { password: PASSWORD, confirm, wipe_backups: false }, ADMIN),
      (e) => e.status === 400 && /УДАЛИТЬ/.test(e.message),
      `confirm=${JSON.stringify(confirm)} must be refused`,
    );
  }
  await exitFired();
  assert.ok(!fs.existsSync(marker(dir)));
  assert.deepEqual(exitCalls, []);
});

test('factory_reset refuses a wrong password even with the right confirm word', async () => {
  const { db, dir } = fresh();
  exitCalls = [];
  await assert.rejects(
    () => factoryReset(db, { password: 'wrong', confirm: 'УДАЛИТЬ', wipe_backups: true }, ADMIN),
    (e) => e.status === 403 && /пароль/i.test(e.message),
  );
  await exitFired();
  assert.ok(!fs.existsSync(marker(dir)));
  assert.deepEqual(exitCalls, []);
});

test('factory_reset happy path: final copy, marker with the wipe choice, exit 75', async () => {
  const { db, dir } = fresh();
  exitCalls = [];
  const r = await factoryReset(db, { password: PASSWORD, confirm: 'УДАЛИТЬ', wipe_backups: true }, ADMIN);
  assert.deepEqual(r, { ok: true, restarting: true });
  assert.ok(listBackups(dir).some((b) => b.kind === 'final'));
  assert.deepEqual(JSON.parse(fs.readFileSync(marker(dir), 'utf8')), { action: 'factory_reset', wipe_backups: true });
  await exitFired();
  assert.deepEqual(exitCalls, [75]);
});

test('factory_reset with wipe_backups omitted defaults to KEEPING the backups', async () => {
  const { db, dir } = fresh();
  await factoryReset(db, { password: PASSWORD, confirm: 'УДАЛИТЬ' }, ADMIN);
  assert.equal(JSON.parse(fs.readFileSync(marker(dir), 'utf8')).wipe_backups, false,
    'recovery-from-mistake beats clean-disk by default');
});

test('DISK_GUARD_V1: backup_create без места — 409 понятной фразой с шаблоном, не «Ошибка сервера»', async () => {
  const { db, dir } = fresh();
  __setDiskSpaceForTests(() => ({ free: GB / 2, total: 100 * GB }));
  try {
    await assert.rejects(() => backupCreate(db, {}, ADMIN), (e) => {
      assert.equal(e.status, 409, 'routes/rpc.js прячет всё, что ≥ 500, за «Ошибка сервера»');
      assert.equal(e.code, 'no_space');
      // :memory: — файла базы нет, копия 0 Б: нужно ровно 1 ГБ запаса.
      assert.equal(e.message, NO_SPACE_RU, 'русская фраза — для журнала и русского экрана');
      assert.equal(e.template, NO_SPACE_TEMPLATE);
      assert.deepStrictEqual(e.params, { need: 1, free: 0.5 }, 'числа — числами: десятичный знак ставит экран по своему языку');
      return true;
    });
  } finally {
    __setDiskSpaceForTests(ROOMY);
  }
  assert.deepEqual(listBackups(dir), []);
});

// :memory: — файла базы нет, копия 0 Б: нужно ровно 1 ГБ запаса.
const NO_SPACE_RU = 'Недостаточно места на диске: нужно 1,0 ГБ, свободно 0,5 ГБ. Копия не сделана.';
const NO_SPACE_TEMPLATE = 'Недостаточно места на диске: нужно {need} ГБ, свободно {free} ГБ. Копия не сделана.';
const isNoSpace409 = (e) => {
  assert.equal(e.status, 409, 'не «Ошибка сервера»: routes/rpc.js прячет всё, что ≥ 500');
  assert.equal(e.code, 'no_space');
  assert.equal(e.message, NO_SPACE_RU);
  assert.equal(e.template, NO_SPACE_TEMPLATE);
  assert.deepStrictEqual(e.params, { need: 1, free: 0.5 });
  return true;
};

test('DISK_GUARD_V1: backup_restore без места на страховочную копию — 409 с шаблоном, восстановление не запрошено, перезапуска нет', async () => {
  const { db, dir } = fresh();
  const snap = await createBackup(db, dir, 'manual');
  exitCalls = [];
  __setDiskSpaceForTests(() => ({ free: GB / 2, total: 100 * GB }));
  try {
    await assert.rejects(() => backupRestore(db, { name: snap.name, password: PASSWORD }, ADMIN), isNoSpace409);
  } finally {
    __setDiskSpaceForTests(ROOMY);
  }
  await exitFired();
  assert.ok(!fs.existsSync(marker(dir)));
  assert.ok(!listBackups(dir).some((b) => b.kind === 'safety'));
  assert.deepEqual(exitCalls, []);
});

test('DISK_GUARD_V1: factory_reset (копии оставить) без места на финальную копию — 409 с шаблоном, удаление не запрошено, перезапуска нет', async () => {
  const { db, dir } = fresh();
  exitCalls = [];
  __setDiskSpaceForTests(() => ({ free: GB / 2, total: 100 * GB }));
  try {
    await assert.rejects(() => factoryReset(db, { password: PASSWORD, confirm: 'УДАЛИТЬ', wipe_backups: false }, ADMIN), isNoSpace409);
  } finally {
    __setDiskSpaceForTests(ROOMY);
  }
  await exitFired();
  assert.ok(!fs.existsSync(marker(dir)));
  assert.ok(!listBackups(dir).some((b) => b.kind === 'final'));
  assert.deepEqual(exitCalls, []);
});

test('DISK_GUARD_V1: factory_reset вместе с копиями на полном диске — проходит: так администратор и освобождает место', async () => {
  const { db, dir } = fresh();
  exitCalls = [];
  __setDiskSpaceForTests(() => ({ free: GB / 2, total: 100 * GB }));
  let r;
  try {
    r = await factoryReset(db, { password: PASSWORD, confirm: 'УДАЛИТЬ', wipe_backups: true }, ADMIN);
  } finally {
    __setDiskSpaceForTests(ROOMY);
  }
  assert.deepEqual(r, { ok: true, restarting: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(marker(dir), 'utf8')), { action: 'factory_reset', wipe_backups: true });
  await exitFired();
  assert.deepEqual(exitCalls, [75]);
});

// --- DISK_GUARD_V1: «Место на диске» -------------------------------------------

test('DISK_GUARD_V1: disk_usage зарегистрирован и проходит сквозь блокировку, как его соседи', () => {
  assert.ok(getRpc('disk_usage'));
  assert.equal(isAlwaysAllowedRpc('disk_usage'), true, 'клиника с просроченной лицензией тоже должна видеть, что диск кончается');
});

test('DISK_GUARD_V1: disk_usage — только администратору; что сколько занимает и отметки об отказах', async () => {
  const { db, dir } = fresh();
  await assert.rejects(() => diskUsage(db, {}, { id: 2, role: 'doctor' }), (e) => e.status === 403);
  fs.mkdirSync(path.join(dir, 'storage', 'clinic-docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'storage', 'clinic-docs', 'scan.pdf'), Buffer.alloc(3000));
  fs.writeFileSync(path.join(dir, 'easymed.db'), Buffer.alloc(5000));
  const made = await createBackup(db, dir, 'manual');
  noteGuard(dir, { copy_refused: { at: '2026-10-29T03:05:00.000Z', kind: 'daily', need_bytes: 2 * GB, free_bytes: GB } });

  const r = await diskUsage(db, {}, ADMIN);
  assert.equal(r.free_bytes, 500 * GB);
  assert.equal(r.total_bytes, 1000 * GB);
  assert.equal(r.low, false);
  assert.equal(r.db_bytes, 5000);
  assert.equal(r.storage_bytes, 3000);
  assert.equal(r.backups_bytes, made.size, 'снимок файлов — жёсткие ссылки, места он не занимает и не считается');
  assert.equal(r.versions_bytes, null, 'из исходников папки versions/ нет');
  assert.deepEqual(r.partial, [], 'всё сосчитано полностью');
  assert.equal(r.copy_refused, null, 'места на копию уже хватает — старый отказ не показывается');
  assert.equal(readGuard(dir).copy_refused.kind, 'daily', 'а в disk-guard.json он остаётся — для журнала');
  assert.equal(r.update_refused, null);
  assert.equal(r.kept_over_cap, null);

  const q = await diskUsage(db, { quick: true }, ADMIN);
  assert.equal('storage_bytes' in q, false, 'колокол спрашивает каждую минуту — без обхода папок');
  assert.equal('backups_bytes' in q, false);
  assert.equal(q.copy_refused, null);
});

// Колокол звонит «Мало места», только когда свободно меньше max(5 ГБ, место на
// следующую копию) (public/js/admin/system-logic.js diskNotices): сколько
// нужно на копию, знает сервер — и говорит это и в быстром ответе.
test('DISK_GUARD_V1: быстрый ответ — с местом на следующую копию (база с журналом × 1,2 + 1 ГБ)', async () => {
  const { db, dir } = fresh();
  fs.writeFileSync(path.join(dir, 'easymed.db'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(dir, 'easymed.db-wal'), Buffer.alloc(1000));
  assert.equal((await diskUsage(db, { quick: true }, ADMIN)).copy_need_bytes, copyNeedBytes(6000));
  assert.equal((await diskUsage(db, {}, ADMIN)).copy_need_bytes, copyNeedBytes(6000));
});

// Ежедневная копия делается раз в день: освободили место днём — следующей
// копии не будет до завтра, и красное «Копия не сделана» висело бы весь день.
// Пока места на копию не хватает (база × 1,2 + 1 ГБ) — отказ виден.
test('DISK_GUARD_V1: отказ в копии виден, пока места на копию не хватает; хватает — не показывается', async () => {
  const { db, dir } = fresh();
  fs.writeFileSync(path.join(dir, 'easymed.db'), Buffer.alloc(5000));
  const refusal = { at: '2026-10-29T03:05:00.000Z', kind: 'daily', need_bytes: 2 * GB, free_bytes: GB };
  noteGuard(dir, { copy_refused: refusal });
  try {
    __setDiskSpaceForTests(() => ({ free: GB / 2, total: 100 * GB }));   // нужно ~1 ГБ
    assert.deepEqual((await diskUsage(db, { quick: true }, ADMIN)).copy_refused, refusal);
    assert.deepEqual((await diskUsage(db, {}, ADMIN)).copy_refused, refusal);
    __setDiskSpaceForTests(() => ({ free: 2 * GB, total: 100 * GB }));
    assert.equal((await diskUsage(db, { quick: true }, ADMIN)).copy_refused, null, 'место освободили — красного больше нет');
    __setDiskSpaceForTests(() => null);
    assert.deepEqual((await diskUsage(db, { quick: true }, ADMIN)).copy_refused, refusal, 'платформа не сказала — отказ не прячем');
  } finally {
    __setDiskSpaceForTests(ROOMY);
  }
  assert.deepEqual(readGuard(dir).copy_refused, refusal);
});

test('DISK_GUARD_V1: размер базы — вместе с журналом -wal', async () => {
  const { db, dir } = fresh();
  fs.writeFileSync(path.join(dir, 'easymed.db'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(dir, 'easymed.db-wal'), Buffer.alloc(700));
  assert.equal((await diskUsage(db, {}, ADMIN)).db_bytes, 5700);
});

test('DISK_GUARD_V1: обход не идёт по ссылкам (junction, symlink) — чужая папка не считается', async () => {
  const dir = tmpDir('em-diskusage-link-');
  const outside = tmpDir('em-diskusage-outside-');
  fs.writeFileSync(path.join(outside, 'big.bin'), Buffer.alloc(9000));
  fs.mkdirSync(path.join(dir, 'storage'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'storage', 'a.pdf'), Buffer.alloc(100));
  fs.symlinkSync(outside, path.join(dir, 'storage', 'j'), 'junction');
  try {
    fs.symlinkSync(path.join(outside, 'big.bin'), path.join(dir, 'storage', 'f.bin'), 'file');
  } catch (e) {
    if (e.code !== 'EPERM') throw e;   // без прав на symlink файла — проверяем только junction
  }
  assert.equal((await diskUsageReport(dir, { cacheMs: 0 })).storage_bytes, 100);
});

test('DISK_GUARD_V1: «мало места» — свободно меньше 10 % диска или меньше 5 ГБ', async () => {
  const { db } = fresh();
  try {
    for (const [free, total, low] of [
      [4 * GB, 1000 * GB, true], [50 * GB, 1000 * GB, true], [101 * GB, 1000 * GB, false],
      [6 * GB, 50 * GB, false], [4 * GB, 50 * GB, true],
      [4 * GB, 30 * GB, true],   // 13 % свободно, но меньше 5 ГБ — правило «меньше 5 ГБ» само по себе
    ]) {
      __setDiskSpaceForTests(() => ({ free, total }));
      assert.equal((await diskUsage(db, { quick: true }, ADMIN)).low, low, `${free / GB} ГБ из ${total / GB}`);
    }
  } finally {
    __setDiskSpaceForTests(ROOMY);
  }
});

test('DISK_GUARD_V1: платформа не сказала, сколько свободно, — числа null, «мало места» не выдумывается', async () => {
  const { db } = fresh();
  __setDiskSpaceForTests(() => null);
  try {
    const q = await diskUsage(db, { quick: true }, ADMIN);
    assert.equal(q.free_bytes, null);
    assert.equal(q.total_bytes, null);
    assert.equal(q.low, false);
  } finally {
    __setDiskSpaceForTests(ROOMY);
  }
});

// Снимок файлов .files — жёсткие ссылки на те же файлы storage: места они не
// занимают. Но файл снимка, у которого ссылка одна (storage удалили «Удалить
// все данные» без копий или ссылку сделать не удалось и файл скопирован), —
// настоящее место, и оно — в папке копий.
test('DISK_GUARD_V1: «Резервные копии» — вся папка копий: отложенные с журналом, обрывки и единственные копии файлов считаются, жёсткие ссылки — нет', async () => {
  const { db, dir } = fresh();
  const b = path.join(dir, 'backups');
  const snap = path.join(b, 'replaced-20261001-090000.files', 'x');
  fs.mkdirSync(snap, { recursive: true });
  fs.mkdirSync(path.join(dir, 'storage', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'storage', 'x', 'scan.pdf'), Buffer.alloc(9000));
  fs.linkSync(path.join(dir, 'storage', 'x', 'scan.pdf'), path.join(snap, 'scan.pdf'));   // nlink 2
  fs.writeFileSync(path.join(snap, 'gone.pdf'), Buffer.alloc(600));                        // nlink 1
  fs.writeFileSync(path.join(b, 'replaced-20261001-090000.db'), Buffer.alloc(700));
  fs.writeFileSync(path.join(b, 'replaced-20261001-090000.db-wal'), Buffer.alloc(300));
  fs.writeFileSync(path.join(b, 'daily-20261002-030000.db'), Buffer.alloc(40));   // обрывок
  fs.writeFileSync(path.join(b, 'daily-20261002-030000.db.broken'), 'partial');
  const r = await diskUsage(db, {}, ADMIN);
  assert.equal(r.backups_bytes, 700 + 300 + 40 + 'partial'.length + 600);
  assert.equal(r.storage_bytes, 9000, 'файл со ссылкой — один раз, в хранилище');
});

// «Удалить все данные» без удаления копий: storage пуст, а финальная и
// ежедневная копии ссылаются на одни и те же файлы — у файла две ссылки, и обе
// в копиях. Место он занимает, и считается один раз — в папке копий.
test('DISK_GUARD_V1: файл, общий для двух снимков .files без оригинала в storage, — в копиях, один раз', async () => {
  const { db, dir } = fresh();
  const b = path.join(dir, 'backups');
  const s1 = path.join(b, 'final-20261001-090000.files', 'x');
  const s2 = path.join(b, 'daily-20261002-030000.files', 'x');
  fs.mkdirSync(s1, { recursive: true });
  fs.mkdirSync(s2, { recursive: true });
  fs.writeFileSync(path.join(s1, 'scan.pdf'), Buffer.alloc(800));
  fs.linkSync(path.join(s1, 'scan.pdf'), path.join(s2, 'scan.pdf'));   // nlink 2, оригинала нет
  const r = await diskUsage(db, {}, ADMIN);
  assert.equal(r.backups_bytes, 800);
  assert.equal(r.storage_bytes, 0);
});

// Отказ обновления «нет места» (control/updater.js) правдив, только пока клиника
// ждёт ЭТУ версию: предложение одобрено и версия ещё не запущена. Устаревший —
// не показывается и снимается (clearStaleUpdateRefusal — то же правило, что у
// обновления).
function putState(db, key, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value));
}

test('DISK_GUARD_V1: отказ обновления виден, пока клиника ждёт эту версию; устаревший не показывается', async () => {
  const { db, dir } = fresh();
  const refusal = { at: '2026-10-29T03:05:00.000Z', version: '99.0.0', need_bytes: null, free_bytes: null };

  noteGuard(dir, { update_refused: refusal });
  assert.equal((await diskUsage(db, { quick: true }, ADMIN)).update_refused, null, 'предложения нет — отказ устарел');
  assert.equal(readGuard(dir).update_refused, undefined, 'и снят в файле: при связи с Easy-Med он тоже больше не уходит');

  putState(db, 'update_offer', { version: '99.0.0', url: '/x.tar.gz', sha256: 'a', manifest: {} });
  putState(db, 'update_consent', { version: '99.0.0', hour: 3 });
  noteGuard(dir, { update_refused: refusal });
  assert.deepEqual((await diskUsage(db, { quick: true }, ADMIN)).update_refused, refusal, 'одобрено и ждёт — отказ правдив');
  assert.deepEqual((await diskUsage(db, {}, ADMIN)).update_refused, refusal);
});

test('DISK_GUARD_V1: обход папок ограничен — сверх предела число «не меньше» и отмечено в partial', async () => {
  const dir = tmpDir('em-diskusage-cap-');
  fs.mkdirSync(path.join(dir, 'storage', 'a'), { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, 'storage', 'a', `f${i}.pdf`), Buffer.alloc(100));
  const capped = await diskUsageReport(dir, { maxEntries: 3, cacheMs: 0 });
  assert.deepEqual(capped.partial, ['storage_bytes']);
  assert.ok(capped.storage_bytes < 500, 'остановился на пределе');
  const full = await diskUsageReport(dir, { cacheMs: 0 });
  assert.deepEqual(full.partial, []);
  assert.equal(full.storage_bytes, 500);
});

test('DISK_GUARD_V1: размеры папок держатся минуту — частые открытия «Данных клиники» не обходят хранилище заново', async () => {
  const dir = tmpDir('em-diskusage-cache-');
  fs.mkdirSync(path.join(dir, 'storage'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'storage', 'a.pdf'), Buffer.alloc(100));
  let t = 1_000_000;
  const now = () => t;
  assert.equal((await diskUsageReport(dir, { now })).storage_bytes, 100);
  fs.writeFileSync(path.join(dir, 'storage', 'b.pdf'), Buffer.alloc(50));
  t += 30_000;
  assert.equal((await diskUsageReport(dir, { now })).storage_bytes, 100, 'через 30 с — тот же подсчёт');
  t += 31_000;
  assert.equal((await diskUsageReport(dir, { now })).storage_bytes, 150, 'через минуту — заново');
});

test('DISK_GUARD_V1: минута считается от конца обхода — долгий обход не запускает второй рядом', async () => {
  const dir = tmpDir('em-diskusage-cache-end-');
  fs.mkdirSync(path.join(dir, 'storage'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'storage', 'a.pdf'), Buffer.alloc(100));
  let t = 0;
  const now = () => t;
  const first = diskUsageReport(dir, { now });   // обход начался на 0-й секунде…
  t = 100_000;                                     // …и закончился на 100-й
  assert.equal((await first).storage_bytes, 100);
  fs.writeFileSync(path.join(dir, 'storage', 'b.pdf'), Buffer.alloc(50));
  t = 130_000;
  assert.equal((await diskUsageReport(dir, { now })).storage_bytes, 100, '30 с после конца обхода — тот же подсчёт');
  t = 161_000;
  assert.equal((await diskUsageReport(dir, { now })).storage_bytes, 150);
});
