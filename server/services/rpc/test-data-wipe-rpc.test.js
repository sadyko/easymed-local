// TEST_DATA_WIPE_V1 — вызовы карточки «Удалить тестовые данные»: только
// администратор, слово УДАЛИТЬ и пароль проверяет сервер, связанной клинике —
// отказ с объяснением ДО копии, копия прежде намерения, потом перезапуск (75).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { hashPassword } from '../auth.js';
import { setDataDir } from '../control/config.js';
import { listBackups } from '../backup.js';
import { writePairing } from '../branch-sync/pairing.js';
import {
  testDataWipe, testDataWipeStatus, PAIRED_REFUSAL, PENDING_SAME_REFUSAL, PENDING_OTHER_REFUSAL, __setExitForTests,
} from './backup.js';
import { getRpc } from './index.js';
import { isAlwaysAllowedRpc, isReadRpc } from '../control/gate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { __setDiskSpaceForTests, GB } from '../disk-guard.js';

const ROOMY = () => ({ free: 500 * GB, total: 1000 * GB });
__setDiskSpaceForTests(ROOMY);
test.after(() => __setDiskSpaceForTests(null));

const PASSWORD = 'correct-horse-9';
const HASH = hashPassword(PASSWORD);
const ADMIN = { id: 1, role: 'admin' };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'admin',?,'Admin','admin')").run(HASH);
  const dir = tmpDir('em-wiperpc-');
  setDataDir(dir);
  return { db, dir };
}
const marker = (dir) => path.join(dir, 'pending-action.json');
let exitCalls = [];
__setExitForTests((code) => exitCalls.push(code), 0);
const exitFired = () => new Promise((r) => setTimeout(r, 25));

test('оба вызова есть и проходят сквозь блокировку лицензии; состояние — чтение, удаление — запись', () => {
  for (const name of ['test_data_wipe', 'test_data_wipe_status']) {
    assert.ok(getRpc(name), name);
    assert.equal(isAlwaysAllowedRpc(name), true, name);
  }
  assert.equal(isReadRpc('test_data_wipe_status'), true);
  assert.equal(isReadRpc('test_data_wipe'), false);
});

test('не администратор — 403 до любой работы с диском', async () => {
  const { db, dir } = fresh();
  await assert.rejects(() => testDataWipe(db, { confirm: 'УДАЛИТЬ', password: PASSWORD }, { id: 2, role: 'cashier' }), (e) => e.status === 403);
  assert.throws(() => testDataWipeStatus(db, {}, { id: 2, role: 'cashier' }), (e) => e.status === 403);
  assert.equal(listBackups(dir).length, 0);
});

test('неточное слово — 400; неверный пароль — 403: ни копии, ни намерения, ни перезапуска', async () => {
  const { db, dir } = fresh();
  exitCalls = [];
  await assert.rejects(() => testDataWipe(db, { confirm: 'удалить', password: PASSWORD }, ADMIN), (e) => e.status === 400 && /УДАЛИТЬ/.test(e.message));
  await assert.rejects(() => testDataWipe(db, { confirm: 'УДАЛИТЬ', password: 'wrong' }, ADMIN), (e) => e.status === 403 && /пароль/i.test(e.message));
  await exitFired();
  assert.equal(listBackups(dir).length, 0);
  assert.equal(fs.existsSync(marker(dir)), false);
  assert.deepEqual(exitCalls, []);
});

test('клиника связана с другими зданиями — 409 с объяснением, ни копии, ни намерения', async () => {
  const { db, dir } = fresh();
  writePairing(dir, { role: 'secondary', group_id: 'g', secret: 's', main_url: 'http://192.168.1.10:8000' });
  exitCalls = [];
  await assert.rejects(() => testDataWipe(db, { confirm: 'УДАЛИТЬ', password: PASSWORD }, ADMIN), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'paired');
    assert.equal(e.message, PAIRED_REFUSAL);
    assert.match(e.message, /другое здание/);
    return true;
  });
  await exitFired();
  assert.equal(listBackups(dir).length, 0);
  assert.equal(fs.existsSync(marker(dir)), false);
  assert.deepEqual(exitCalls, []);
  assert.equal(testDataWipeStatus(db, {}, ADMIN).paired, true, 'карточка заранее знает, что кнопка не сработает');
});

test('удача: копия, намерение, ответ restarting, выход 75; состояние — «ждёт запуска»', async () => {
  const { db, dir } = fresh();
  exitCalls = [];
  const r = await testDataWipe(db, { confirm: ' УДАЛИТЬ '.trim(), password: PASSWORD }, ADMIN);
  assert.equal(r.ok, true);
  assert.equal(r.restarting, true);
  assert.ok(listBackups(dir).some((b) => b.name === r.backup && b.kind === 'wipe'));
  assert.equal(JSON.parse(fs.readFileSync(marker(dir), 'utf8')).action, 'test_data_wipe');
  await exitFired();
  assert.deepEqual(exitCalls, [75]);
  assert.deepEqual(testDataWipeStatus(db, {}, ADMIN), { paired: false, pending: true, last: null });
});

test('нет места на копию — 409 no_space с числами, намерения нет, перезапуска нет', async () => {
  const { db, dir } = fresh();
  __setDiskSpaceForTests(() => ({ free: 10 * 1024 * 1024, total: 1000 * GB }));
  exitCalls = [];
  try {
    await assert.rejects(() => testDataWipe(db, { confirm: 'УДАЛИТЬ', password: PASSWORD }, ADMIN), (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.code, 'no_space');
      assert.ok(e.template && e.params);
      return true;
    });
  } finally { __setDiskSpaceForTests(ROOMY); }
  await exitFired();
  assert.equal(fs.existsSync(marker(dir)), false);
  assert.deepEqual(exitCalls, []);
});

// Ревью C5 (M1): второй раз, пока перезапуска ждёт удаление (или другое
// действие), — 409 словами, ни копии, ни перезапуска; фразы — в словаре.
test('перезапуска уже ждёт действие — 409 pending словами, без новой копии и без перезапуска', async () => {
  const { db, dir } = fresh();
  exitCalls = [];
  await testDataWipe(db, { confirm: 'УДАЛИТЬ', password: PASSWORD }, ADMIN);
  await exitFired();
  exitCalls = [];
  const copies = listBackups(dir).length;
  await assert.rejects(() => testDataWipe(db, { confirm: 'УДАЛИТЬ', password: PASSWORD }, ADMIN), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'pending');
    assert.equal(e.message, PENDING_SAME_REFUSAL);
    return true;
  });
  fs.writeFileSync(marker(dir), JSON.stringify({ action: 'restore', backup: 'manual-20261030-100000.db' }));
  await assert.rejects(() => testDataWipe(db, { confirm: 'УДАЛИТЬ', password: PASSWORD }, ADMIN),
    (e) => e.status === 409 && e.code === 'pending' && e.message === PENDING_OTHER_REFUSAL);
  await exitFired();
  assert.equal(listBackups(dir).length, copies);
  assert.equal(JSON.parse(fs.readFileSync(marker(dir), 'utf8')).action, 'restore');
  assert.deepEqual(exitCalls, []);
  const { STRINGS } = await import('../../../public/js/admin/i18n-strings.js');
  for (const k of [PENDING_SAME_REFUSAL, PENDING_OTHER_REFUSAL]) {
    const s = STRINGS[k];
    assert.ok(s && s.ru === k, 'статья словаря: ' + k);
    for (const l of ['uz', 'en']) assert.doesNotMatch(s[l], /[Ѐ-ӿ]/, l);
  }
});

// Поправка 9(г): после «Отвязать» удалять тестовые данные нужно ДО новой связи —
// иначе загрузка с того здания может вернуть учебные строки. Отказ говорит это
// словами, и у фразы есть статья словаря (экран переводит её целиком).
test('отказ связанной клинике называет выход: «Отвязать», удалить до новой связи; uz/en — без кириллицы', async () => {
  assert.match(PAIRED_REFUSAL, /«Отвязать»/);
  assert.match(PAIRED_REFUSAL, /до того, как связывать клинику снова/);
  const { STRINGS } = await import('../../../public/js/admin/i18n-strings.js');
  const e = STRINGS[PAIRED_REFUSAL];
  assert.ok(e, 'статья словаря для отказа');
  for (const l of ['uz', 'en']) {
    assert.ok(e[l], l);
    assert.doesNotMatch(e[l], /[Ѐ-ӿ]/, l);
  }
  assert.equal(e.ru, PAIRED_REFUSAL);
});
