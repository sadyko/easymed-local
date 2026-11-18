// PATIENT_DUP_RULE_V3 — «Дубликаты» картотеки считает СЕРВЕР по всей картотеке:
// уверенные группы (правило V2 не меняется) и «Возможные дубликаты — проверьте»
// (тот же телефон и та же дата рождения; то же ФИО и та же дата рождения). Пары,
// отмеченные «Не дубликат», хранятся в patient_dup_dismissals (мигр. 290): кто и
// когда; отмечает только тот, кто может объединять карты (администратор); карты
// пациентов при этом не меняются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { patientDuplicatesScan, patientDupDismiss } from './patient-duplicates.js';
import { mergePatientsRpc } from './patient-merge.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'adm','x','Админ Админов','admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'reg','x','Регистратор','registrar')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (3,'sklad','x','Склад','inventory')").run();
  const pat = db.prepare('INSERT INTO patients (id, full_name, first_name, last_name, phone, date_of_birth, national_id) VALUES (?,?,?,?,?,?,?)');
  // Случай владельца: три карты на одном номере, две — с одной датой рождения.
  pat.run(101, 'TEST', 'TEST', '', '+998 97 765 43 21', '1990-05-05', '');
  pat.run(102, 'Sardor Alimov', 'Alimov', 'Sardor', '998977654321', '1991-04-23', '');
  pat.run(103, 'ТЕст 2 Тест 2', 'Тест 2', 'ТЕст 2', '+998977654321', '1991-04-23', '');
  // Уверенная пара: тот же телефон и то же имя.
  pat.run(201, 'Каримов Азиз', 'Азиз', 'Каримов', '+998 90 123 45 67', '1980-03-04', '');
  pat.run(202, 'Karimov Азиз', 'Азиз', 'Karimov', '901234567', '', '');
  // То же ФИО и та же дата при разных телефонах.
  pat.run(301, 'Эргашев Жахонгир', 'Жахонгир', 'Эргашев', '+998 97 700 11 22', '1990-04-01', '');
  pat.run(302, 'Эргашев Жахонгир', 'Жахонгир', 'Эргашев', '+998 97 700 33 44', '1990-04-01', '');
  return db;
}
const ADMIN = { id: 1, role: 'admin', full_name: 'Админ Админов' };
const REG = { id: 2, role: 'registrar', full_name: 'Регистратор' };
const SKLAD = { id: 3, role: 'inventory', full_name: 'Склад' };
const patientsSnap = (db) => db.prepare('SELECT * FROM patients ORDER BY id').all();

test('скан: уверенные группы и возможные — по всей картотеке; случай владельца виден', () => {
  const db = seed();
  const r = patientDuplicatesScan(db, {}, REG);
  assert.deepEqual(r.sure, [[201, 202]]);
  assert.deepEqual(r.possible, [
    { ids: [301, 302], reasons: ['name_dob'] },
    { ids: [102, 103], reasons: ['phone_dob'] },
  ]);
  assert.equal(r.scanned, 7);
  assert.equal(r.can_dismiss, false, 'регистратор видит, но «Не дубликат» не отмечает');
  assert.equal(patientDuplicatesScan(db, {}, ADMIN).can_dismiss, true);
});

test('скан смотрит ВСЮ картотеку — прежний экран читал только первые 1000 карт', () => {
  const db = seed();
  const pat = db.prepare('INSERT INTO patients (id, full_name, first_name, last_name, phone, date_of_birth) VALUES (?,?,?,?,?,?)');
  db.transaction(() => {
    for (let i = 1000; i < 2500; i++) pat.run(i, 'Пациент ' + i, 'Имя' + i, 'Пациент', '+998 90 ' + String(1000000 + i), '1970-01-01');
    pat.run(2600, 'Последний Дубль', 'Дубль', 'Последний', '+998 99 555 44 33', '2001-02-03');
    pat.run(2601, 'Последний Дубль', 'Дубль', 'Последний', '+998 99 555 44 33', '2001-02-03');
  })();
  const r = patientDuplicatesScan(db, {}, REG);
  assert.ok(r.sure.some((g) => g.includes(2600) && g.includes(2601)), 'дубль за пределами первой тысячи карт не найден');
  assert.ok(r.scanned > 1500);
});

test('скан: без раздела «Пациенты» — отказ; RPC зарегистрированы, скан — чтение, отметка — запись', () => {
  const db = seed();
  assert.throws(() => patientDuplicatesScan(db, {}, SKLAD), (e) => e.status === 403 && /Пациенты/.test(e.message));
  assert.equal(typeof getRpc('patient_duplicates_scan'), 'function');
  assert.equal(typeof getRpc('patient_dup_dismiss'), 'function');
  assert.equal(isReadOnlyRpc('patient_duplicates_scan'), true, 'клиника с просроченной лицензией видит дубликаты');
  assert.equal(isReadOnlyRpc('patient_dup_dismiss'), false, 'отметка — запись, при блокировке — 402');
});

test('«Не дубликат»: только администратор (как объединение); регистратор и склад — отказ', () => {
  const db = seed();
  for (const who of [REG, SKLAD]) {
    assert.throws(() => patientDupDismiss(db, { ids: [102, 103] }, who), (e) => e.status === 403 && /администратор/.test(e.message));
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patient_dup_dismissals').get().n, 0);
  // Тот же гейт, что у объединения: admin в «Дополнительных ролях» тоже может.
  const extra = { id: 2, role: 'registrar', extra_roles: ['admin'], full_name: 'Регистратор' };
  assert.equal(patientDupDismiss(db, { ids: [102, 103] }, extra).dismissed, 1);
});

test('«Не дубликат»: пара запомнена (кто и когда), из возможных ушла, карты не изменились; повтор — без ошибки', () => {
  const db = seed();
  const before = patientsSnap(db);
  const out = patientDupDismiss(db, { ids: [103, 102], reasons: ['phone_dob'] }, ADMIN);
  assert.deepEqual(out, { dismissed: 1, pairs: 1 });
  const row = db.prepare('SELECT * FROM patient_dup_dismissals').get();
  assert.equal(row.patient_id_a, 102);
  assert.equal(row.patient_id_b, 103);
  assert.equal(row.dismissed_by, 1);
  assert.equal(row.dismissed_by_name, 'Админ Админов');
  assert.equal(row.reasons, 'phone_dob');
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(patientsSnap(db), before, 'отметка изменила карты пациентов');

  const r = patientDuplicatesScan(db, {}, REG);
  assert.deepEqual(r.possible.map((g) => g.ids), [[301, 302]], 'отмеченная пара всё ещё в «возможных»');
  assert.deepEqual(r.sure, [[201, 202]], 'уверенные группы отметка не трогает');

  assert.deepEqual(patientDupDismiss(db, { ids: [102, 103] }, ADMIN), { dismissed: 0, pairs: 1 }, 'повторное нажатие — не ошибка');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patient_dup_dismissals').get().n, 1);
});

test('«Не дубликат» на группу: запоминаются все пары группы, кроме уже уверенных', () => {
  const db = seed();
  db.prepare("INSERT INTO patients (id, full_name, first_name, last_name, phone, date_of_birth) VALUES (203, 'Каримов Aziz', 'Aziz', 'Каримов', '+998901234567', '1980-03-04')").run();
  const out = patientDupDismiss(db, { ids: [201, 202, 203] }, ADMIN);
  assert.deepEqual(out, { dismissed: 2, pairs: 2 }, '201–202 — уверенный дубликат, «не дубликатом» его не записать');
  const pairs = db.prepare('SELECT patient_id_a a, patient_id_b b FROM patient_dup_dismissals ORDER BY a, b').all();
  assert.deepEqual(pairs, [{ a: 201, b: 203 }, { a: 202, b: 203 }]);
});

test('«Не дубликат»: неверный выбор — отказ словами, ничего не записано', () => {
  const db = seed();
  const bad = [{}, { ids: [102] }, { ids: 'x' }, { ids: [102, 'abc'] }, { ids: [102, 102] }, { ids: [102, -1] },
    { ids: Array.from({ length: 51 }, (_, i) => i + 1) }];
  for (const args of bad) assert.throws(() => patientDupDismiss(db, args, ADMIN), (e) => e.status === 400, JSON.stringify(args));
  assert.throws(() => patientDupDismiss(db, { ids: [102, 999] }, ADMIN), (e) => e.status === 404 && /не найдена/.test(e.message));
  assert.throws(() => patientDupDismiss(db, { ids: [102, 103], reasons: ['drop table'] }, ADMIN), (e) => e.status === 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patient_dup_dismissals').get().n, 0);
});

test('объединение карт переносит отметки дубля на оставленную карту; пара «оставленная — дубль» снимается', () => {
  const db = seed();
  // 101 и 103 — «не дубликаты»; 102 и 103 — тоже. Потом 103 вливается в 102.
  patientDupDismiss(db, { ids: [101, 103] }, ADMIN);
  patientDupDismiss(db, { ids: [102, 103] }, ADMIN);
  mergePatientsRpc(db, { keep_id: 102, drop_id: 103 }, ADMIN);
  const pairs = db.prepare('SELECT patient_id_a a, patient_id_b b, dismissed_by_name n FROM patient_dup_dismissals ORDER BY a, b').all();
  assert.deepEqual(pairs, [{ a: 101, b: 102, n: 'Админ Админов' }], '«101 — не 103» осталось правдой для 102, кто отметил — тот же');
});

test('удалённая карта уносит свои отметки', () => {
  const db = seed();
  patientDupDismiss(db, { ids: [301, 302] }, ADMIN);
  db.prepare('DELETE FROM patients WHERE id = 302').run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patient_dup_dismissals').get().n, 0);
});
