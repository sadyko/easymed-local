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
import { backupList, backupCreate, backupRestore, factoryReset, __setExitForTests } from './backup.js';
import { getRpc } from './index.js';
import { isAlwaysAllowedRpc } from '../control/gate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';   // TEST_TMPDIR_V1 — папка уберётся сама
import { __setDiskSpaceForTests, GB } from '../disk-guard.js';   // DISK_GUARD_V1

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
