// DOCS_FEED_V1 — лента готовых документов.
//
// Что здесь важно проверить: в ленту попадает ровно то, по чему ЕСТЬ документ
// (пустая назначенная услуга — не документ), страницы не теряют и не дублируют
// строк, а счётчики по типам не схлопываются в ноль, когда включён фильтр по
// типу — иначе сотрудник решит, что других документов за период нет.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { documentsFeed } from './documents.js';

const ADMIN = { id: 1, role: 'admin' };
const NOBODY = { id: 9, role: 'cashier' };   // раздел «Документы» кассиру не выдан

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'a','x','Админ','admin')").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (1,'ОАК',30000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (2,'УЗИ почек',90000,'imaging')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (3,'Приём терапевта',50000,'consultation')").run();
  db.prepare("INSERT INTO patients (id, full_name, mrn, phone) VALUES (1,'Каримова Сабина','P-26-70023','+998901112233')").run();
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (2,'Олимов Турсунбой','P-26-54170')").run();
  return db;
}

const day = (db, off) => db.prepare("SELECT date('now','localtime',?) d").get(off + ' days').d;

function visit(db, patient, d) {
  return db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,'scheduled') RETURNING id")
    .get(patient, d + 'T09:00:00Z').id;
}
function line(db, visitId, svc) {
  return db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,0,0,'completed') RETURNING id")
    .get(visitId, svc).id;
}
const addResult = (db, vsId, param) => db.prepare(
  "INSERT INTO lab_results (visit_service_id, parameter, value, flag) VALUES (?,?, '1', 'normal')").run(vsId, param);
const addDoc = (db, vsId, visitId, patient, type) => db.prepare(
  "INSERT INTO visit_documents (title, doc_type, visit_id, visit_service_id, patient_id) VALUES (?,?,?,?,?)")
  .run('Док', type, visitId, vsId, patient);

const feed = (db, args = {}, user = ADMIN) => documentsFeed(db, args, user);

test('раздел не выдан — ленту не отдаём', () => {
  const db = seed();
  assert.throws(() => feed(db, {}, NOBODY), /Документы/);
  db.close();
});

test('в ленту попадает только то, по чему есть документ', () => {
  const db = seed();
  const d = day(db, 0);
  const v = visit(db, 1, d);
  const withResult = line(db, v, 1);
  const withDoc = line(db, v, 3);
  line(db, v, 2);                       // назначено, но ничего нет — не документ
  addResult(db, withResult, 'HGB');
  addDoc(db, withDoc, v, 1, 'protocol');

  const r = feed(db, { from: d, to: d });
  assert.equal(r.total, 2, 'пустая назначенная услуга документом не считается');
  assert.deepEqual(r.rows.map((x) => x.visit_service_id).sort(), [withResult, withDoc].sort());
  db.close();
});

test('одна услуга — одна строка, сколько бы показателей в ней ни было', () => {
  const db = seed();
  const d = day(db, 0);
  const v = visit(db, 1, d);
  const vs = line(db, v, 1);
  for (const p of ['HGB', 'RBC', 'WBC', 'PLT']) addResult(db, vs, p);

  const r = feed(db, { from: d, to: d });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].result_count, 4, 'но число показателей видно в строке');
  db.close();
});

test('строка несёт пациента, услугу и тип', () => {
  const db = seed();
  const d = day(db, 0);
  const vs = line(db, visit(db, 1, d), 1);
  addResult(db, vs, 'HGB');

  const row = feed(db, { from: d, to: d }).rows[0];
  assert.equal(row.patient_name, 'Каримова Сабина');
  assert.equal(row.mrn, 'P-26-70023');
  assert.equal(row.service_name, 'ОАК');
  assert.equal(row.service_type, 'lab');
  db.close();
});

test('период отрезает чужие дни', () => {
  const db = seed();
  const today = day(db, 0), old = day(db, -30);
  addResult(db, line(db, visit(db, 1, today), 1), 'A');
  addResult(db, line(db, visit(db, 2, old), 1), 'B');

  assert.equal(feed(db, { from: today, to: today }).total, 1);
  assert.equal(feed(db, { from: old, to: old }).total, 1);
  assert.equal(feed(db, { from: old, to: today }).total, 2);
  assert.equal(feed(db, {}).total, 2, 'без периода — всё');
  db.close();
});

test('фильтр по типу услуги', () => {
  const db = seed();
  const d = day(db, 0);
  const v = visit(db, 1, d);
  addResult(db, line(db, v, 1), 'A');            // lab
  addDoc(db, line(db, v, 2), v, 1, 'diag');      // imaging
  addDoc(db, line(db, v, 3), v, 1, 'protocol');  // consultation

  assert.equal(feed(db, { from: d, to: d, types: ['lab'] }).total, 1);
  assert.equal(feed(db, { from: d, to: d, types: ['lab', 'imaging'] }).total, 2);
  assert.equal(feed(db, { from: d, to: d }).total, 3, 'без фильтра — все типы');
  db.close();
});

test('счётчики по типам НЕ обнуляются выбранным типом', () => {
  const db = seed();
  const d = day(db, 0);
  const v = visit(db, 1, d);
  addResult(db, line(db, v, 1), 'A');
  addDoc(db, line(db, v, 2), v, 1, 'diag');

  const r = feed(db, { from: d, to: d, types: ['lab'] });
  const counts = Object.fromEntries(r.by_type.map((x) => [x.t, x.c]));
  assert.equal(r.total, 1, 'список сузился');
  assert.equal(counts.lab, 1);
  assert.equal(counts.imaging, 1, 'но соседний тип по-прежнему показывает, что он есть');
  db.close();
});

test('поиск по пациенту: имя, номер карты, телефон', () => {
  const db = seed();
  const d = day(db, 0);
  addResult(db, line(db, visit(db, 1, d), 1), 'A');
  addResult(db, line(db, visit(db, 2, d), 1), 'B');

  assert.equal(feed(db, { q: 'сабина' }).total, 1, 'регистр не важен');
  assert.equal(feed(db, { q: 'P-26-54170' }).total, 1, 'по номеру карты');
  assert.equal(feed(db, { q: '9011122' }).total, 1, 'по телефону');
  assert.equal(feed(db, { q: 'нет такого' }).total, 0);
  db.close();
});

test('поиск находит и по названию услуги', () => {
  const db = seed();
  const d = day(db, 0);
  const v = visit(db, 1, d);
  addResult(db, line(db, v, 1), 'A');            // ОАК
  addDoc(db, line(db, v, 2), v, 1, 'diag');      // УЗИ почек

  assert.equal(feed(db, { q: 'оак' }).total, 1, 'по названию услуги, в нижнем регистре');
  assert.equal(feed(db, { q: 'УЗИ' }).total, 1);
  db.close();
});

test('страницы не теряют и не дублируют строк', () => {
  const db = seed();
  const d = day(db, 0);
  const v = visit(db, 1, d);
  const made = [];
  for (let i = 0; i < 25; i++) { const vs = line(db, v, 1); addResult(db, vs, 'P' + i); made.push(vs); }

  const p1 = feed(db, { limit: 20, offset: 0 });
  assert.equal(p1.total, 25);
  assert.equal(p1.rows.length, 20);
  assert.equal(p1.has_more, true);
  assert.equal(p1.next_offset, 20);

  const p2 = feed(db, { limit: 20, offset: p1.next_offset });
  assert.equal(p2.rows.length, 5);
  assert.equal(p2.has_more, false, 'вторая страница последняя');

  const seen = p1.rows.concat(p2.rows).map((r) => r.visit_service_id);
  assert.equal(new Set(seen).size, 25, 'ни одной строки дважды');
  assert.deepEqual(seen.slice().sort((a, b) => a - b), made.slice().sort((a, b) => a - b), 'ни одной потерянной');
  db.close();
});

test('размер страницы ограничен сверху и снизу', () => {
  const db = seed();
  const v = visit(db, 1, day(db, 0));
  for (let i = 0; i < 5; i++) addResult(db, line(db, v, 1), 'P' + i);
  assert.equal(feed(db, { limit: 99999 }).rows.length, 5, 'больше, чем есть, не отдаст');
  assert.ok(feed(db, { limit: 0 }).rows.length >= 1, 'нулевая страница не бывает');
  assert.ok(feed(db, { limit: -5 }).rows.length >= 1);
  db.close();
});

test('мусорные даты игнорируются, а не роняют запрос', () => {
  const db = seed();
  addResult(db, line(db, visit(db, 1, day(db, 0)), 1), 'A');
  assert.equal(feed(db, { from: 'вчера', to: '' }).total, 1);
  db.close();
});

// DOCS_FEED_ANSWERS_V1 — значения показателей едут прямо в строке.

test('строка несёт сами ответы: параметр, значение, единицу, флаг', () => {
  const db = seed();
  const d = day(db, 0);
  const vs = line(db, visit(db, 1, d), 1);
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, unit, flag) VALUES (?,?,?,?,?)")
    .run(vs, 'HGB', '142', 'г/л', 'normal');
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, unit, flag) VALUES (?,?,?,?,?)")
    .run(vs, 'WBC', '15.2', '10^9/л', 'high');

  const row = feed(db, { from: d, to: d }).rows[0];
  assert.equal(row.results.length, 2);
  assert.deepEqual(row.results[0], { parameter: 'HGB', value: '142', unit: 'г/л', flag: 'normal' });
  assert.deepEqual(row.results[1], { parameter: 'WBC', value: '15.2', unit: '10^9/л', flag: 'high' });
  db.close();
});

test('повторный ввод того же показателя заменяет ответ, а не удваивает строку', () => {
  const db = seed();
  const d = day(db, 0);
  const vs = line(db, visit(db, 1, d), 1);
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (?,?,?)").run(vs, 'HGB', '90');
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (?,?,?)").run(vs, 'HGB', '142');

  const row = feed(db, { from: d, to: d }).rows[0];
  assert.equal(row.results.length, 1, 'один показатель — один ответ');
  assert.equal(row.results[0].value, '142', 'побеждает последний ввод');
  db.close();
});

test('услуга с подписанным документом, но без результатов, несёт пустой results', () => {
  const db = seed();
  const d = day(db, 0);
  const v = visit(db, 1, d);
  const vs = line(db, v, 3);
  addDoc(db, vs, v, 1, 'protocol');
  assert.deepEqual(feed(db, { from: d, to: d }).rows[0].results, []);
  db.close();
});

test('новые документы идут первыми', () => {
  const db = seed();
  const old = day(db, -5), now = day(db, 0);
  addResult(db, line(db, visit(db, 1, old), 1), 'A');
  const newer = line(db, visit(db, 2, now), 1);
  addResult(db, newer, 'B');

  assert.equal(feed(db, {}).rows[0].visit_service_id, newer);
  db.close();
});

// ---------------------------------------------------------------------------
// LAB_ONE_CLINIC_V1 / BUILDING_REPORTS_V1 — лента документов подчиняется той же
// границе, что лабораторная очередь, и подписывает каждую строку зданием.
// Фильтра здесь не было вообще: лента показывала документы всех зданий по
// случайности и не знала настройки doc_settings.lab_scope.
// ---------------------------------------------------------------------------

function seedTwoBuildings() {
  const db = seed();
  db.prepare("INSERT INTO branches (name, letter, active) VALUES ('Чиланзар','B',0)").run();
  const v1 = visit(db, 1, day(db, 0));
  const own = line(db, v1, 1);
  addResult(db, own, 'HGB');
  const foreign = db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, sync_origin) VALUES (?,1,1,0,0,'completed','B') RETURNING id")
    .get(v1).id;
  addResult(db, foreign, 'WBC');
  return db;
}

test('лента: по умолчанию видны документы всей клиники, каждая строка подписана зданием', () => {
  const db = seedTwoBuildings();
  const r = feed(db, {});
  assert.equal(r.lab_scope, 'clinic');
  assert.equal(r.total, 2);
  const foreign = r.rows.find((x) => x.origin === 'B');
  assert.ok(foreign, 'документ соседнего здания в ленте есть');
  assert.equal(foreign.building, 'Чиланзар', 'строка названа зданием, включая строку перечня active = 0');
  const b = r.by_building.find((x) => x.key === 'B');
  assert.equal(b.rows, 1);
  db.close();
});

test('лента: при lab_scope=building остаются только свои документы', () => {
  const db = seedTwoBuildings();
  db.prepare("UPDATE doc_settings SET lab_scope = 'building' WHERE id = 1").run();
  const r = feed(db, {});
  assert.equal(r.lab_scope, 'building');
  assert.equal(r.total, 1, 'приехавший документ скрыт — как и в очереди');
  assert.ok(r.rows.every((x) => x.origin === ''), 'остались только свои строки');
  db.close();
});
