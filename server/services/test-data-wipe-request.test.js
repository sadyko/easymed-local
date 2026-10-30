// TEST_DATA_WIPE_V1 — просьба администратора и запуск: копия «Перед удалением
// тестовых данных» прежде намерения, отказ связанной клинике, намерение
// дожидается открытой базы после migrate, итог для экрана и журнала.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { tmpDir, closeOnExit, closeRegistered } from '../test-helpers/tmpdir.js';
import { __setDiskSpaceForTests, GB, copyNeedBytes, dbBytes, readGuard } from './disk-guard.js';
import { listBackups, processPendingAction, ensureCopySpace, MARKER_NAME } from './backup.js';
import { writePairing } from './branch-sync/pairing.js';
import {
  requestTestDataWipe, applyPendingTestDataWipe, wipeStatus, readWipeResult, RESULT_NAME,
  estimateWipeBytes, WIPE_NO_SPACE_TEMPLATE,
} from './test-data-wipe.js';

// Диск машины разработчика — не данные теста (на этом ПК ~5 ГБ свободно).
const ROOMY = () => ({ free: 500 * GB, total: 1000 * GB });
__setDiskSpaceForTests(ROOMY);
test.after(() => __setDiskSpaceForTests(null));
test.after(closeRegistered);

function clinic() {
  const dir = tmpDir('em-wipe-req-');
  const db = closeOnExit(openDb(path.join(dir, 'easymed.db')));
  migrate(db);
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Учебный', 1)").run().lastInsertRowid;
  db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?, 1, '2026-10-01T09:00:00Z')").run(pid);
  return { dir, db };
}
const marker = (dir) => path.join(dir, MARKER_NAME);
const readMarker = (dir) => JSON.parse(fs.readFileSync(marker(dir), 'utf8'));
const pair = (dir) => writePairing(dir, { role: 'main', group_id: 'g-test', secret: 's-test' });
const visits = (db) => db.prepare('SELECT COUNT(*) AS n FROM visits').get().n;

test('просьба: сначала копия «перед удалением тестовых данных», потом намерение', async () => {
  const { dir, db } = clinic();
  const r = await requestTestDataWipe(db, dir, { now: new Date(2026, 9, 30, 10, 0, 0), userId: 1 });
  assert.equal(r.ok, true);
  assert.match(r.backup, /^wipe-20261030-100000\.db$/);
  const copy = listBackups(dir).find((b) => b.name === r.backup);
  assert.equal(copy.kind, 'wipe');
  assert.equal(copy.restorable, true, 'это и есть путь назад');
  assert.deepEqual(readMarker(dir), { action: 'test_data_wipe', backup: r.backup, requested_at: new Date(2026, 9, 30, 10, 0, 0).toISOString(), requested_by: 1 });
  assert.equal(visits(db), 1, 'до перезапуска ничего не удалено');
});

test('связанная клиника: ни копии, ни намерения', async () => {
  const { dir, db } = clinic();
  pair(dir);
  assert.deepEqual(await requestTestDataWipe(db, dir), { ok: false, reason: 'paired' });
  assert.equal(listBackups(dir).length, 0);
  assert.equal(fs.existsSync(marker(dir)), false);
});

test('нет места на копию — отказ no_space, намерения нет', async () => {
  const { dir, db } = clinic();
  __setDiskSpaceForTests(() => ({ free: 10 * 1024 * 1024, total: 1000 * GB }));
  try {
    await assert.rejects(() => requestTestDataWipe(db, dir), (e) => e.code === 'no_space');
  } finally { __setDiskSpaceForTests(ROOMY); }
  assert.equal(fs.existsSync(marker(dir)), false, 'без пути назад удаления нет');
});

test('processPendingAction оставляет намерение лежать до открытой базы', async () => {
  const { dir, db } = clinic();
  await requestTestDataWipe(db, dir);
  assert.deepEqual(processPendingAction(dir), { action: null, deferred: 'test_data_wipe' });
  assert.equal(readMarker(dir).action, 'test_data_wipe');
  assert.equal(fs.existsSync(marker(dir) + '.bad'), false);
});

test('запуск: удаление по открытой базе, итог в файле и строкой для журнала, намерение снято', async () => {
  const { dir, db } = clinic();
  const { backup } = await requestTestDataWipe(db, dir);
  const out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY, now: () => new Date('2026-10-30T05:00:00Z') });
  assert.equal(out.action, 'test_data_wipe');
  assert.equal(out.ok, true);
  assert.match(out.line, /^Тестовые данные удалены: visits 1, /);
  assert.equal(visits(db), 0);
  assert.equal(fs.existsSync(marker(dir)), false);
  const res = readWipeResult(dir);
  assert.equal(res.ok, true);
  assert.equal(res.at, '2026-10-30T05:00:00.000Z');
  assert.equal(res.backup, backup);
  assert.equal(res.deleted.visits, 1);
  assert.equal(res.vacuum.done, true);
  assert.deepEqual(wipeStatus(dir), { paired: false, pending: false, last: res });
});

test('связали между просьбой и запуском — не удаляет, намерение в .bad, итог «связана»', async () => {
  const { dir, db } = clinic();
  await requestTestDataWipe(db, dir);
  pair(dir);
  const out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'paired');
  assert.equal(visits(db), 1);
  assert.ok(fs.existsSync(marker(dir) + '.bad'));
  assert.equal(readWipeResult(dir).reason, 'paired');
});

test('сбой транзакции — база цела, намерение в .bad, итог «не удалось»; запуск продолжается', async () => {
  const { dir, db } = clinic();
  await requestTestDataWipe(db, dir);
  db.exec("CREATE TEMP TRIGGER boom BEFORE DELETE ON visits BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'failed');
  assert.equal(visits(db), 1);
  assert.ok(fs.existsSync(marker(dir) + '.bad'));
  assert.equal(readWipeResult(dir).ok, false);
});

test('сбой после записи итога: повторный запуск не затирает итог нулями и снимает намерение', async () => {
  const { dir, db } = clinic();
  await requestTestDataWipe(db, dir);
  const saved = readMarker(dir);
  applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  fs.writeFileSync(marker(dir), JSON.stringify(saved));   // как будто процесс упал до удаления намерения
  const out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  assert.equal(out.ok, true);
  assert.equal(readWipeResult(dir).deleted.visits, 1, 'итог первого удаления цел');
  assert.equal(fs.existsSync(marker(dir)), false);
});

test('нет намерения или оно чужое — запуск ничего не делает', () => {
  const { dir, db } = clinic();
  assert.deepEqual(applyPendingTestDataWipe(db, dir), { action: null });
  fs.writeFileSync(marker(dir), JSON.stringify({ action: 'restore', backup: 'manual-20261030-100000.db' }));
  assert.deepEqual(applyPendingTestDataWipe(db, dir), { action: null });
  assert.ok(fs.existsSync(marker(dir)), 'чужое намерение не трогается');
  assert.equal(visits(db), 1);
  assert.equal(fs.existsSync(path.join(dir, RESULT_NAME)), false);
});

// ── ревью C2/C3: место при просьбе, «нет места» при запуске, повтор после listen,
//    стадии CRM, намерение без пути назад ─────────────────────────────────────

const FULL = () => ({ free: 10 * 1024 * 1024, total: 1000 * GB });

// Копии нужно база × 1,2 + 1 ГБ (там же запас, который удаление при запуске
// требует сверх журнала), удалению — ещё оценка журнала (estimateWipeBytes).
// Ревью C4: проверяет охрана копии 3.18.1 (ensureCopySpace) — по СУММЕ, внутри
// очереди копий, со своими уступками старых автоматических копий.
const wipeNeed = (dir, db) => copyNeedBytes(dbBytes(path.join(dir, 'easymed.db'))) + estimateWipeBytes(db);

test('просьба: на копию места хватает, на копию и журнал удаления — нет, уступать нечего: отказ словами удаления ДО копии', async () => {
  const { dir, db } = clinic();
  const need = wipeNeed(dir, db);
  __setDiskSpaceForTests(() => ({ free: need - 1, total: 5 * GB }));
  try {
    await assert.rejects(() => requestTestDataWipe(db, dir), (e) => {
      assert.equal(e.code, 'no_space');
      assert.equal(e.template, WIPE_NO_SPACE_TEMPLATE, 'фраза удаления: «Тестовые данные не удалены»');
      assert.equal(e.need_bytes, need);
      assert.equal(e.free_bytes, need - 1);
      assert.deepEqual(Object.keys(e.params).sort(), ['free', 'need']);
      assert.match(e.message, /^Недостаточно места на диске: нужно \d+,\d ГБ, свободно \d+,\d ГБ\. Тестовые данные не удалены\.$/);
      return true;
    });
    assert.equal(listBackups(dir).length, 0, 'копия не начата');
    assert.equal(fs.existsSync(marker(dir)), false, 'намерения нет');
    assert.equal(readGuard(dir).copy_refused, undefined, 'это отказ удаления, а не «копия не сделана» на экране копий');
    __setDiskSpaceForTests(() => ({ free: need, total: 5 * GB }));
    const r = await requestTestDataWipe(db, dir);
    assert.equal(r.ok, true, 'ровно столько, сколько нужно, — хватает');
  } finally { __setDiskSpaceForTests(ROOMY); }
  assert.equal(visits(db), 1);
});

test('просьба: места мало, но есть старые ежедневные копии — уступает самая старая (как для любой копии), удаление запрошено', async () => {
  const { dir, db } = clinic();
  const bd = path.join(dir, 'backups');
  fs.mkdirSync(bd, { recursive: true });
  const t = Date.now() - 1e6;
  for (const [name, at] of [['daily-20261028-030000.db', t], ['daily-20261029-030000.db', t + 1000]]) {
    fs.writeFileSync(path.join(bd, name), Buffer.alloc(100 * 1024));
    fs.utimesSync(path.join(bd, name), new Date(at), new Date(at));
  }
  const need = wipeNeed(dir, db);
  __setDiskSpaceForTests(() => ({ free: need - 50 * 1024, total: 5 * GB }));
  let r;
  try { r = await requestTestDataWipe(db, dir); } finally { __setDiskSpaceForTests(ROOMY); }
  assert.equal(r.ok, true);
  const names = listBackups(dir).map((b) => b.name);
  assert.equal(names.includes('daily-20261028-030000.db'), false, 'самая старая ежедневная уступила место');
  assert.ok(names.includes('daily-20261029-030000.db'), 'уступает ровно столько, сколько нужно');
  assert.ok(names.includes(r.backup));
  assert.equal(readMarker(dir).backup, r.backup);
});

test('охрана копии: без добавки нужно столько же, сколько раньше; добавка — к той же сумме, отметка «копия не сделана» не пишется', () => {
  const { dir } = clinic();
  const copyNeed = copyNeedBytes(dbBytes(path.join(dir, 'easymed.db')));
  const disk = () => ({ free: copyNeed, total: 5 * GB });
  assert.deepEqual(ensureCopySpace(dir, { kind: 'manual', diskSpaceImpl: disk }), { freed: [] });
  assert.throws(() => ensureCopySpace(dir, { kind: 'wipe', diskSpaceImpl: disk, extraNeedBytes: 4096 }), (e) => {
    assert.equal(e.code, 'no_space');
    assert.equal(e.need_bytes, copyNeed + 4096);
    return true;
  });
  assert.equal(readGuard(dir).copy_refused, undefined);
  assert.throws(() => ensureCopySpace(dir, { kind: 'manual', diskSpaceImpl: () => ({ free: copyNeed - 1, total: 5 * GB }) }),
    (e) => e.code === 'no_space' && e.need_bytes === copyNeed);
  assert.equal(readGuard(dir).copy_refused.kind, 'manual', 'обычная копия пишет отметку, как раньше');
});

test('запуск: файл документа уходит, только если он есть в копии; загруженный после просьбы — остаётся', async () => {
  const { dir, db } = clinic();
  const pid = db.prepare('SELECT id FROM patients').get().id;
  const docs = path.join(dir, 'storage', 'clinic-docs', 'patients', String(pid), 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, '1-training.pdf'), 'учебный');
  await requestTestDataWipe(db, dir);
  fs.writeFileSync(path.join(docs, '2-after.pdf'), 'загружен между просьбой и перезапуском');
  const out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  assert.equal(out.ok, true);
  assert.equal(fs.existsSync(path.join(docs, '1-training.pdf')), false);
  assert.ok(fs.existsSync(path.join(docs, '2-after.pdf')), 'его нет в копии — без пути назад не удаляется');
  assert.deepEqual(readWipeResult(dir).files, { removed: 1, failed: 1 });
  assert.match(out.line, /files 1 \(не удалено 1\)/);
});

test('итог и строка журнала называют, кто и когда просил удалить (без данных пациентов)', async () => {
  const { dir, db } = clinic();
  const asked = new Date(2026, 9, 30, 10, 0, 0);
  await requestTestDataWipe(db, dir, { now: asked, userId: 7 });
  const out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  const res = readWipeResult(dir);
  assert.equal(res.requested_by, 7);
  assert.equal(res.requested_at, asked.toISOString());
  assert.ok(out.line.endsWith(`; просил пользователь 7, ${asked.toISOString()}`), out.line);
  // Отказ — тоже.
  const other = clinic();
  await requestTestDataWipe(other.db, other.dir, { now: asked, userId: 7 });
  pair(other.dir);
  const refused = applyPendingTestDataWipe(other.db, other.dir, { diskSpaceImpl: ROOMY });
  assert.equal(readWipeResult(other.dir).requested_by, 7);
  assert.match(refused.line, /; просил пользователь 7, /);
});

test('запуск: места на журнал удаления нет — итог no_space с шаблоном и числами для экрана, база цела, намерение в .bad', async () => {
  const { dir, db } = clinic();
  const { backup } = await requestTestDataWipe(db, dir);
  const out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: FULL, now: () => new Date('2026-10-30T05:00:00Z') });
  assert.equal(out.action, 'test_data_wipe');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no_space', 'не «не удалось»: причина — место, и её надо назвать');
  assert.match(out.line, /^Недостаточно места на диске: нужно \d+,\d ГБ, свободно 0,0 ГБ\. Тестовые данные не удалены\.; просил пользователь \?, \d{4}-/);
  assert.equal(visits(db), 1, 'база цела');
  assert.equal(fs.existsSync(marker(dir)), false);
  assert.ok(fs.existsSync(marker(dir) + '.bad'));
  const res = readWipeResult(dir);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_space');
  assert.equal(res.at, '2026-10-30T05:00:00.000Z');
  assert.equal(res.backup, backup);
  assert.equal(res.template, WIPE_NO_SPACE_TEMPLATE, 'экран переведёт фразу целиком по шаблону');
  assert.equal(res.params.free, 0);
  assert.ok(res.params.need >= 1, 'нужно не меньше запаса 1 ГБ');
  assert.equal(typeof res.need_bytes, 'number');
  assert.equal(res.free_bytes, 10 * 1024 * 1024);
  assert.deepEqual(wipeStatus(dir), { paired: false, pending: false, last: res });
});

// Клиника после удаления работает по-настоящему: новый визит и документ,
// загруженный в карту пациента.
function realWork(db, dir) {
  const pid = db.prepare('SELECT id FROM patients').get().id;
  db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?, 1, '2026-10-31T09:00:00Z')").run(pid);
  const doc = path.join(dir, 'storage', 'clinic-docs', 'patients', String(pid), 'docs', '9-real-scan.pdf');
  fs.mkdirSync(path.dirname(doc), { recursive: true });
  fs.writeFileSync(doc, 'настоящий документ');
  return doc;
}

test('намерение не убралось и пережило listen: следующий запуск не удаляет ни новых визитов, ни документов, загруженных после', async () => {
  const { dir, db } = clinic();
  await requestTestDataWipe(db, dir);
  const saved = readMarker(dir);
  assert.equal(applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY }).ok, true);
  const doc = realWork(db, dir);
  fs.writeFileSync(marker(dir), JSON.stringify(saved));
  const out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  assert.equal(out.ok, true);
  assert.equal(visits(db), 1, 'настоящий визит на месте');
  assert.ok(fs.existsSync(doc), 'документ, загруженный после удаления, на месте');
  assert.equal(fs.existsSync(marker(dir)), false);
});

test('итог тоже не записался (диск, права): отметка в базе всё равно не даёт удалить настоящее второй раз', async () => {
  const { dir, db } = clinic();
  await requestTestDataWipe(db, dir);
  const saved = readMarker(dir);
  assert.equal(applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY }).ok, true);
  fs.rmSync(path.join(dir, RESULT_NAME));
  const doc = realWork(db, dir);
  fs.writeFileSync(marker(dir), JSON.stringify(saved));
  const out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  assert.equal(out.ok, true);
  assert.doesNotMatch(out.line, /visits 0/, 'не итог нулями');
  assert.equal(visits(db), 1);
  assert.ok(fs.existsSync(doc));
  assert.equal(fs.existsSync(marker(dir)), false);
});

test('неудачное удаление, намерение не отложилось: следующий запуск не пробует снова на настоящих данных', async () => {
  const { dir, db } = clinic();
  await requestTestDataWipe(db, dir);
  const saved = readMarker(dir);
  db.exec("CREATE TEMP TRIGGER boom BEFORE DELETE ON visits BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.equal(applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY }).reason, 'failed');
  db.exec('DROP TRIGGER boom');
  const doc = realWork(db, dir);
  fs.rmSync(marker(dir) + '.bad');
  fs.writeFileSync(marker(dir), JSON.stringify(saved));
  const out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'failed');
  assert.equal(visits(db), 2, 'учебный и настоящий визиты на месте: администратор просит заново, с новой копией');
  assert.ok(fs.existsSync(doc));
  assert.ok(fs.existsSync(marker(dir) + '.bad'));
});

test('запуск: стадии карточек CRM те же, что до удаления; итог называет карточки без учебной записи (поправка 8)', async () => {
  const { dir, db } = clinic();
  const visit = db.prepare('SELECT id FROM visits').get().id;
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Приём', 100000)").run().lastInsertRowid;
  const booked = db.prepare("INSERT INTO crm_requests (full_name, phone, status) VALUES ('Учебная карточка', '+998900000001', 'scheduled')").run().lastInsertRowid;
  const came = db.prepare("INSERT INTO crm_requests (full_name, phone, status) VALUES ('Учебная вторая', '+998900000002', 'came')").run().lastInsertRowid;
  db.prepare("INSERT INTO crm_requests (full_name, phone, status) VALUES ('Без записи', '+998900000003', 'in_process')").run();
  db.prepare('INSERT INTO crm_booking_links (visit_id, request_id, created_request) VALUES (?, ?, 1)').run(visit, booked);
  db.prepare("INSERT INTO crm_booking_undo (visit_id, request_id, prev_status, set_status) VALUES (?, ?, 'recall', 'scheduled')").run(visit, booked);
  db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id) VALUES (?, ?, '2026-10-01', 'done', ?)").run(came, svc, visit);
  const cards = () => db.prepare('SELECT * FROM crm_requests ORDER BY id').all();
  const lines = () => db.prepare('SELECT id, request_id, service_id, scheduled_date, status FROM crm_request_services ORDER BY id').all();
  const cardsBefore = cards();
  const linesBefore = lines();
  await requestTestDataWipe(db, dir);
  const out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  assert.equal(out.ok, true);
  assert.equal(visits(db), 0);
  assert.deepEqual(cards(), cardsBefore, '«Записан» остаётся «Записан», «Пришёл» — «Пришёл»: след записи не проигран');
  assert.deepEqual(lines(), linesBefore, '«done» не вернулся в «pending»');
  assert.equal(readWipeResult(dir).crm_cards_unbooked, 2);
  assert.match(out.line, /карточек CRM без учебной записи: 2 \(стадии не менялись\)/);
});

test('намерение без копии «перед удалением» — пути назад нет: не удаляет, намерение в .bad', async () => {
  const { dir, db } = clinic();
  fs.writeFileSync(marker(dir), JSON.stringify({ action: 'test_data_wipe' }));
  let out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'failed');
  assert.equal(visits(db), 1);
  assert.ok(fs.existsSync(marker(dir) + '.bad'));

  // Копию удалили мимо программы между просьбой и запуском.
  fs.rmSync(marker(dir) + '.bad');
  const { backup } = await requestTestDataWipe(db, dir);
  fs.rmSync(path.join(dir, 'backups', backup));
  out = applyPendingTestDataWipe(db, dir, { diskSpaceImpl: ROOMY });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'failed');
  assert.equal(visits(db), 1);
  assert.equal(fs.existsSync(marker(dir)), false);
  assert.equal(readWipeResult(dir).backup, backup);
});
