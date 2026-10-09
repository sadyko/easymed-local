// CRM_CALENDAR_MIRROR_V1 (2026-09-27) — ЗАЯВКА И КАЛЕНДАРЬ — ОДНА ЗАПИСЬ.
//
// Владелец: «they mirror each other, also the calendar. and the services —
// which means if in the CRM we create a booking it will show in the calendar.»
//
// Всё через НАСТОЯЩИЕ двери — /api/db и /api/rpc под настоящими ролями, — а не
// через функции: строки записи пишут пять экранов, и правило, проверенное на
// функции, ничего не говорит о том, соблюдает ли его дверь.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const pad = (n) => String(n).padStart(2, '0');
function localDay(offset) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function at(dayIso, hh, mm = 0) {
  const [y, m, d] = dayIso.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}
const D = localDay(3);
const D2 = localDay(4);

async function start() {
  const db = openDb(':memory:');
  migrate(db);
  const user = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  user.run(1, 'boss', hashPassword('password1'), 'Админ', 'admin');
  user.run(2, 'reg', hashPassword('password1'), 'Регистратура', 'registrar');
  user.run(3, 'cc', hashPassword('password1'), 'Оператор', 'callcenter');
  user.run(10, 'doc', hashPassword('password1'), 'Иванов', 'doctor');
  user.run(11, 'doc2', hashPassword('password1'), 'Петров', 'doctor');
  db.prepare("INSERT INTO services (id, name, price, type, requires_doctor, duration_minutes) VALUES (30,'Консультация терапевта',100000,'consultation',1,30)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40,'Анализ крови',40000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'Аппендэктомия',900000,'other')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (77,'Пациент Тест','+998900000077')").run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  for (const who of ['boss', 'reg', 'cc', 'doc']) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: who, password: 'password1' }),
    });
    assert.equal(res.status, 200, 'вход ' + who);
    cookies[who] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const call = async (path, who, body) => {
    const res = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies[who] },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const rpc = (name, who, args) => call('/api/rpc/' + name, who, args);
  const dbq = (who, desc) => call('/api/db', who, desc);
  return { db, server, rpc, dbq, close: () => { server.close(); db.close(); } };
}

const vsOf = (db, visitId) => db.prepare('SELECT * FROM visit_services WHERE visit_id = ? ORDER BY service_id').all(visitId);
const linesOf = (db, requestId) => db.prepare('SELECT * FROM crm_request_services WHERE request_id = ? ORDER BY id').all(requestId);
const reqRow = (db, id) => db.prepare('SELECT * FROM crm_requests WHERE id = ?').get(id);

/** Заявка колл-центра с двумя услугами на день D, записанная из карточки CRM. */
async function crmBooking(t) {
  const { db, rpc, dbq } = t;
  const r = await dbq('cc', { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Пациент Тест', phone: '+998900000077', patient_id: 77, status: 'in_process', source: 'call' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const rid = r.json.data.id;
  const ins = await dbq('cc', { table: 'crm_request_services', op: 'insert', values: [
    { request_id: rid, service_id: 30, scheduled_date: D, doctor_id: 10, status: 'pending' },
    { request_id: rid, service_id: 40, scheduled_date: D, status: 'pending' },
  ] });
  assert.equal(ins.status, 200, JSON.stringify(ins.json));
  const b = await rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D, 10), doctor_id: 10,
    book: { doctor_id: 10, service_id: 30, start: at(D, 10), duration_minutes: 30 } });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(b.json.data.booked, true);
  return { rid, visitId: b.json.data.visit.id };
}

test('1. запись из CRM видна в календаре визитом С УСЛУГАМИ заявки', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    const rows = vsOf(t.db, visitId);
    assert.deepEqual(rows.map((x) => x.service_id), [30, 40], 'в записи нет услуг заявки');
    assert.ok(rows.every((x) => x.status === 'added' && x.invoice_item_id == null), 'строки записи — не «в смете»');
    assert.equal(rows.find((x) => x.service_id === 30).unit_price, 100000, 'цена не по правилу кассы');
    assert.equal(rows.find((x) => x.service_id === 30).doctor_id, 10);
    const lines = linesOf(t.db, rid);
    assert.ok(lines.every((l) => l.visit_id === visitId && l.visit_service_id), 'строки заявки не связаны со строками записи');
    assert.equal(reqRow(t.db, rid).status, 'scheduled');
    // Календарь (регистратура) читает эти строки обычной дверью.
    const cal = await t.dbq('reg', { table: 'visit_services', op: 'select', columns: 'id, service_id',
      filters: [{ col: 'visit_id', op: 'eq', val: visitId }] });
    assert.equal(cal.status, 200);
    assert.equal(cal.json.data.length, 2);
    // Повторная сверка ничего не удваивает.
    const again = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D, 10), doctor_id: 10,
      book: { doctor_id: 10, service_id: 30, start: at(D, 10), duration_minutes: 30 } });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(vsOf(t.db, visitId).length, 2, 'повторная запись удвоила услуги');
    assert.equal(linesOf(t.db, rid).length, 2, 'повторная запись удвоила строки заявки');
  } finally { t.close(); }
});

test('2. колл-центр записывает из календаря С УСЛУГАМИ — строки визита и новая заявка', async () => {
  const t = await start();
  try {
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 11), duration_minutes: 30 });
    assert.equal(b.status, 200, JSON.stringify(b.json));
    const visitId = b.json.data.visit.id;
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: visitId, lines: [{ service_id: 30, doctor_id: 10 }, { service_id: 40 }] });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    assert.equal(add.json.data.added.length, 2);
    assert.deepEqual(vsOf(t.db, visitId).map((x) => x.service_id), [30, 40]);
    const req = t.db.prepare('SELECT * FROM crm_requests WHERE patient_id = 77').all();
    assert.equal(req.length, 1, 'у записи колл-центра не появилась заявка');
    assert.equal(req[0].status, 'scheduled');
    assert.equal(req[0].assigned_to, 3, 'заявку ведёт не тот, кто записал');
    assert.equal(req[0].scheduled_date, D);
    const lines = linesOf(t.db, req[0].id);
    assert.deepEqual(lines.map((l) => [l.service_id, l.visit_id, l.status]), [[30, visitId, 'pending'], [40, visitId, 'pending']]);
    const links = await t.rpc('crm_visit_links', 'reg', { visit_ids: [visitId] });
    assert.equal(links.json.data[0].request_id, req[0].id, 'календарь не знает, что запись из заявки');
    // Повтор той же услуги — не вторая строка.
    const dup = await t.rpc('booking_lines_add', 'cc', { visit_id: visitId, lines: [{ service_id: 40 }] });
    assert.deepEqual(dup.json.data.skipped, [40]);
    assert.equal(vsOf(t.db, visitId).length, 2);
  } finally { t.close(); }
});

// Разбор ревью (I3): регистратура привязывает запись только к заявке, которая
// уже ждёт ЭТОТ день.
test('2б. запись из календаря привязывается к открытой заявке на ЭТОТ день, новой не заводит', async () => {
  const t = await start();
  try {
    const r = await t.dbq('cc', { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
      values: { full_name: 'Пациент Тест', phone: '+998900000077', patient_id: 77, status: 'in_process', source: 'call', scheduled_date: D } });
    const rid = r.json.data.id;
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 12), duration_minutes: 30 });
    assert.equal(b.status, 200, JSON.stringify(b.json));
    const visitId = b.json.data.visit.id;
    // Регистратура вставляет строку визита своей дверью (/api/db) — заявка её видит.
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: visitId, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 100000, total: 100000, status: 'added' } });
    assert.equal(ins.status, 200, JSON.stringify(ins.json));
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 1, 'регистратура завела лишнюю заявку');
    assert.equal(reqRow(t.db, rid).status, 'scheduled');
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.visit_id]), [[30, visitId]]);
  } finally { t.close(); }
});

test('2в. регистратура без открытой заявки новую заявку не заводит', async () => {
  const t = await start();
  try {
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 12), duration_minutes: 30 });
    assert.equal(b.status, 200);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 0);
  } finally { t.close(); }
});

test('3. перенос в календаре → заявка видит новый день и нового врача', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    const mv = await t.rpc('calendar_book', 'reg', { visit_id: visitId, doctor_id: 11, start: at(D2, 14) });
    assert.equal(mv.status, 200, JSON.stringify(mv.json));
    const lines = linesOf(t.db, rid);
    assert.ok(lines.every((l) => l.scheduled_date === D2), 'строки заявки остались на старом дне');
    assert.equal(lines.find((l) => l.service_id === 30).doctor_id, 11, 'врач строки не последовал за записью');
    assert.equal(lines.find((l) => l.service_id === 40).doctor_id, null, 'строке «на дату» выдумали врача');
    assert.equal(reqRow(t.db, rid).scheduled_date, D2, 'дата заявки не последовала за записью');
    assert.equal(vsOf(t.db, visitId).find((x) => x.service_id === 30).doctor_id, 11);
  } finally { t.close(); }
});

test('4. перенос в CRM → календарь: строки визита едут, а не удваиваются; тот же день — перенос времени', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    const before = vsOf(t.db, visitId).map((x) => x.id).sort();
    // Тот же день, другое время: запись с услугами «в смете» — всё ещё запись.
    const same = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D, 15), doctor_id: 10,
      book: { doctor_id: 10, service_id: 30, start: at(D, 15), duration_minutes: 30 } });
    assert.equal(same.status, 200, JSON.stringify(same.json));
    assert.equal(same.json.data.booked, true, 'перенос времени отказан как «визит дня занят»');
    assert.equal(same.json.data.moved, true);
    // Другой день: карточка снимает строки со старой записи (как saveLines) и записывает новый день.
    for (const l of linesOf(t.db, rid)) {
      const up = await t.dbq('cc', { table: 'crm_request_services', op: 'update',
        values: { scheduled_date: D2, doctor_id: l.doctor_id, visit_id: null }, filters: [{ col: 'id', op: 'eq', val: l.id }] });
      assert.equal(up.status, 200, JSON.stringify(up.json));
    }
    const b = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D2, 10), doctor_id: 10,
      book: { doctor_id: 10, service_id: 30, start: at(D2, 10), duration_minutes: 30 } });
    assert.equal(b.status, 200, JSON.stringify(b.json));
    const v2 = b.json.data.visit.id;
    assert.notEqual(v2, visitId);
    assert.deepEqual(vsOf(t.db, v2).map((x) => x.id).sort(), before, 'строки визита завелись заново вместо переезда');
    assert.equal(vsOf(t.db, visitId).length, 0, 'на старой записи остались услуги');
    assert.ok(linesOf(t.db, rid).every((l) => l.visit_id === v2));
  } finally { t.close(); }
});

test('5. отмена в календаре → заявка возвращается в работу', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    const c = await t.rpc('calendar_book', 'reg', { visit_id: visitId, start: at(D, 10), status: 'cancelled' });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.ok(linesOf(t.db, rid).every((l) => l.visit_id == null && l.status === 'pending'));
    assert.equal(reqRow(t.db, rid).status, 'in_process');
  } finally { t.close(); }
});

test('6. отказ в CRM → запись в календаре отменена', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    const up = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { status: 'stopped' }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    assert.equal(t.db.prepare('SELECT status FROM visits WHERE id = ?').get(visitId).status, 'cancelled', 'запись осталась в календаре');
    assert.equal(reqRow(t.db, rid).status, 'stopped');
  } finally { t.close(); }
});

test('7. услуги, добавленные и снятые в календаре до прихода, отражаются в заявке', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    // Регистратура снимает анализ своей дверью.
    const lab = vsOf(t.db, visitId).find((x) => x.service_id === 40);
    const del = await t.dbq('reg', { table: 'visit_services', op: 'delete', filters: [{ col: 'id', op: 'eq', val: lab.id }] });
    assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.equal(linesOf(t.db, rid).find((l) => l.service_id === 40).status, 'cancelled', 'снятая в календаре услуга ждёт в заявке');
    // Колл-центр возвращает её из календаря.
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: visitId, lines: [{ service_id: 40 }] });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    const pending = linesOf(t.db, rid).filter((l) => l.status === 'pending');
    assert.deepEqual(pending.map((l) => l.service_id).sort(), [30, 40]);
    // …и снимает её своей дверью.
    const rm = await t.rpc('booking_line_remove', 'cc', { visit_service_id: add.json.data.added[0].id });
    assert.equal(rm.status, 200, JSON.stringify(rm.json));
    assert.deepEqual(linesOf(t.db, rid).filter((l) => l.status === 'pending').map((l) => l.service_id), [30]);
  } finally { t.close(); }
});

test('8. правка строк в CRM до прихода отражается в записи; последняя снятая — запись отменена', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    const lab = linesOf(t.db, rid).find((l) => l.service_id === 40);
    const c1 = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { status: 'cancelled' }, filters: [{ col: 'id', op: 'eq', val: lab.id }] });
    assert.equal(c1.status, 200, JSON.stringify(c1.json));
    assert.deepEqual(vsOf(t.db, visitId).map((x) => x.service_id), [30], 'снятая в заявке услуга осталась в записи');
    assert.equal(t.db.prepare('SELECT status FROM visits WHERE id = ?').get(visitId).status, 'scheduled');
    // Врача строки сменили в карточке — строка визита следует.
    const con = linesOf(t.db, rid).find((l) => l.service_id === 30);
    const d = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { doctor_id: 11 }, filters: [{ col: 'id', op: 'eq', val: con.id }] });
    assert.equal(d.status, 200);
    assert.equal(vsOf(t.db, visitId)[0].doctor_id, 11);
    const c2 = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { status: 'cancelled' }, filters: [{ col: 'id', op: 'eq', val: con.id }] });
    assert.equal(c2.status, 200);
    assert.equal(vsOf(t.db, visitId).length, 0);
    assert.equal(t.db.prepare('SELECT status FROM visits WHERE id = ?').get(visitId).status, 'cancelled', 'пустая запись осталась держать время врача');
  } finally { t.close(); }
});

test('9. регистратура подставляет строки заявки в смету — строка зеркала уступает, дублей нет', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    const auto = vsOf(t.db, visitId).find((x) => x.service_id === 30);
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: visitId, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 90000, total: 90000, status: 'added' } });
    assert.equal(ins.status, 200, JSON.stringify(ins.json));
    const rows = vsOf(t.db, visitId).filter((x) => x.service_id === 30);
    assert.equal(rows.length, 1, 'в записи две строки одной услуги — двойной счёт');
    assert.equal(rows[0].id, ins.json.data.id, 'осталась строка зеркала, а не строка регистратуры');
    assert.notEqual(rows[0].id, auto.id);
    const lines = linesOf(t.db, rid).filter((l) => l.service_id === 30);
    assert.equal(lines.length, 1, 'появилась вторая строка заявки');
    assert.equal(lines[0].visit_service_id, ins.json.data.id);
  } finally { t.close(); }
});

test('10. после прихода и счёта правка из CRM отказывается, запись не трогается', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    const con = vsOf(t.db, visitId).find((x) => x.service_id === 30);
    // Счёт выставлен: строка визита уже в счёте.
    t.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, total_amount, status) VALUES (900,'INV-900',?,77,100000,'unpaid')").run(visitId);
    t.db.prepare('INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total) VALUES (901,900,30,?,1,100000,100000)').run('Консультация');
    t.db.prepare('UPDATE visit_services SET invoice_item_id = 901 WHERE id = ?').run(con.id);
    const line = linesOf(t.db, rid).find((l) => l.service_id === 30);
    const r1 = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { scheduled_date: D2 }, filters: [{ col: 'id', op: 'eq', val: line.id }] });
    assert.equal(r1.status, 409, 'правка выставленной услуги из заявки прошла');
    assert.match(r1.json.error.message, /уже в счёте или в работе/);
    // Сохранение карточки теми же значениями (комментарий) — проходит.
    const same = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { scheduled_date: D, doctor_id: 10 }, filters: [{ col: 'id', op: 'eq', val: line.id }] });
    assert.equal(same.status, 200, JSON.stringify(same.json));
    // Колл-центр не дописывает услуги к записи со счётом.
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: visitId, lines: [{ service_id: 40 }] });
    assert.equal(add.status, 400);
    // Пациент пришёл — строки закрыты, правка их из CRM отказывается.
    const arr = await t.rpc('calendar_book', 'reg', { visit_id: visitId, start: at(D, 10), status: 'arrived' });
    assert.equal(arr.status, 200, JSON.stringify(arr.json));
    t.db.prepare("UPDATE crm_request_services SET status = 'done' WHERE request_id = ?").run(rid);   // приход в будущем дне сторож не пропускает — ставим как после прихода
    const r2 = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { status: 'cancelled' }, filters: [{ col: 'request_id', op: 'eq', val: rid }] });
    assert.equal(r2.status, 409);
    assert.match(r2.json.error.message, /уже пришёл/);
    assert.equal(vsOf(t.db, visitId).length, 2, 'после прихода заявка сняла услугу записи');
  } finally { t.close(); }
});

test('11. колл-центр по-прежнему не пишет строки визита напрямую, не выставляет счёт, не платит и не записывает хирургию', async () => {
  const t = await start();
  try {
    const { visitId } = await crmBooking(t);
    const direct = await t.dbq('cc', { table: 'visit_services', op: 'insert', values: { visit_id: visitId, service_id: 40, quantity: 1, unit_price: 1, total: 1, status: 'added' } });
    assert.equal(direct.status, 403, 'колл-центру открыли visit_services в /api/db');
    const inv = await t.rpc('create_invoice_for_visit', 'cc', { visit_id: visitId });
    assert.equal(inv.status, 403, 'колл-центр выставил счёт');
    const pay = await t.rpc('record_payment', 'cc', { invoice_id: 1, amount: 1000, method: 'cash' });
    assert.equal(pay.status, 403, 'колл-центр принял оплату');
    const surg = await t.rpc('booking_lines_add', 'cc', { visit_id: visitId, lines: [{ service_id: 50 }] });
    assert.equal(surg.status, 400);
    assert.match(surg.json.error.message, /хирургия/);
    assert.equal(vsOf(t.db, visitId).some((x) => x.service_id === 50), false);
  } finally { t.close(); }
});

// Кнопку «Пришёл» в клинике не нажимает никто: у заплатившего пациента визит
// так и стоит 'scheduled'. Зеркало обязано понять приход по доказательству
// (оплата, работа), а не только по статусу — иначе по ходу приёма оно
// переписывало бы заявку.
test('12. оплата без отметки «Пришёл» — приход: услуги, добавленные на приёме, заявку не трогают', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    t.db.prepare("INSERT INTO services (id, name, price, type) VALUES (60,'УЗИ',150000,'imaging')").run();
    t.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, total_amount, paid_amount, status) VALUES (910,'INV-910',?,77,140000,140000,'paid')").run(visitId);
    assert.equal(t.db.prepare('SELECT status FROM visits WHERE id = ?').get(visitId).status, 'scheduled');
    const before = linesOf(t.db, rid).length;
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: visitId, service_id: 60, quantity: 1, unit_price: 150000, total: 150000, status: 'added' } });
    assert.equal(ins.status, 200, JSON.stringify(ins.json));
    assert.equal(linesOf(t.db, rid).length, before, 'услуга, добавленная на приёме, уехала в заявку колл-центра');
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: visitId, lines: [{ service_id: 60 }] });
    assert.equal(add.status, 400, 'колл-центр дописал услугу к оплаченному приёму');
  } finally { t.close(); }
});

// ═══ CRM_CALENDAR_MIRROR_V1 (часть 2) — КОНСУЛЬТАЦИИ ПО ВИДАМ ПРИЁМА ═══════
//
// Строка консультации — service_id NULL + consultation_type_id; её цену считает
// сервер по ценам врача (BILLING_AUDIT_FIX_V1 B7), а не браузер. Колл-центр
// пишет и её, и она зеркалится в заявку строкой того же вида приёма.
test('13. колл-центр записывает консультацию по виду приёма — цена сервера, строка заявки того же вида', async () => {
  const t = await start();
  try {
    t.db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active) VALUES (5,'Первичный','Первичный приём',80000,1)").run();
    t.db.prepare("INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available) VALUES (10, 5, 120000, 1)").run();
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, start: at(D, 11), duration_minutes: 30 });
    assert.equal(b.status, 200, JSON.stringify(b.json));
    const visitId = b.json.data.visit.id;
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: visitId, lines: [{ consultation_type_id: 5, doctor_id: 10, unit_price: 1 }] });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    const vs = t.db.prepare('SELECT * FROM visit_services WHERE visit_id = ?').all(visitId);
    assert.equal(vs.length, 1);
    assert.equal(vs[0].service_id, null);
    assert.equal(vs[0].consultation_type_id, 5);
    assert.equal(vs[0].unit_price, 120000, 'цена консультации не по цене врача');
    const req = t.db.prepare('SELECT id FROM crm_requests WHERE patient_id = 77').get();
    const lines = linesOf(t.db, req.id);
    assert.deepEqual(lines.map((l) => [l.service_id, l.consultation_type_id, l.visit_service_id, l.doctor_id]), [[null, 5, vs[0].id, 10]]);
    // Повтор того же вида — не вторая строка.
    const dup = await t.rpc('booking_lines_add', 'cc', { visit_id: visitId, lines: [{ consultation_type_id: 5, doctor_id: 10 }] });
    assert.equal(dup.json.data.added.length, 0);
    // Снятие в заявке снимает и в записи.
    const c = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { status: 'cancelled' }, filters: [{ col: 'id', op: 'eq', val: lines[0].id }] });
    assert.equal(c.status, 200);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(visitId).n, 0);
  } finally { t.close(); }
});

test('14. консультация из заявки CRM становится строкой записи; неизвестный вид приёма — отказ', async () => {
  const t = await start();
  try {
    t.db.prepare("INSERT INTO consultation_types (id, name, price, active) VALUES (5,'Первичный',80000,1)").run();
    const r = await t.dbq('cc', { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
      values: { full_name: 'Пациент Тест', phone: '+998900000077', patient_id: 77, status: 'in_process', source: 'call' } });
    const rid = r.json.data.id;
    const ins = await t.dbq('cc', { table: 'crm_request_services', op: 'insert', values: { request_id: rid, consultation_type_id: 5, scheduled_date: D, doctor_id: 10, status: 'pending' } });
    assert.equal(ins.status, 200, JSON.stringify(ins.json));
    const b = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D, 10), doctor_id: 10,
      book: { doctor_id: 10, start: at(D, 10), duration_minutes: 30 } });
    assert.equal(b.status, 200, JSON.stringify(b.json));
    const vs = t.db.prepare('SELECT * FROM visit_services WHERE visit_id = ?').all(b.json.data.visit.id);
    assert.deepEqual(vs.map((x) => [x.service_id, x.consultation_type_id, x.unit_price]), [[null, 5, 80000]]);
    const bad = await t.rpc('booking_lines_add', 'cc', { visit_id: b.json.data.visit.id, lines: [{ consultation_type_id: 999 }] });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.message, /Вид приёма/);
  } finally { t.close(); }
});

// ═══ РАЗБОР РЕВЬЮ (2026-09-27) ═══════════════════════════════════════════════
const daysAgoIso = (n) => new Date(Date.now() - n * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const vsRows = (db, visitId, sid) => db.prepare('SELECT * FROM visit_services WHERE visit_id = ? AND service_id = ?').all(visitId, sid);

test('R-C1. дверь строк заявки не ставит в запись хирургию и снятую с продажи услугу', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    t.db.prepare("INSERT INTO services (id, name, price, type, active) VALUES (41,'Старое УЗИ',50000,'imaging',0)").run();
    for (const sid of [50, 41]) {
      const r = await t.dbq('cc', { table: 'crm_request_services', op: 'insert', values: { request_id: rid, service_id: sid, scheduled_date: D, status: 'pending', visit_id: visitId } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(vsRows(t.db, visitId, sid).length, 0, 'зеркало поставило в амбулаторную запись услугу ' + sid);
    }
    // Замена услуги строки на хирургию — тоже нет.
    const lab = linesOf(t.db, rid).find((l) => l.service_id === 40);
    const up = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { service_id: 50 }, filters: [{ col: 'id', op: 'eq', val: lab.id }] });
    assert.equal(up.status, 200);
    assert.equal(vsRows(t.db, visitId, 50).length, 0, 'замена строки заявки поставила хирургию');
  } finally { t.close(); }
});

test('R-I1. та же услуга у ДРУГОГО врача — вторая строка, а не замена записанной', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    const booked = vsRows(t.db, visitId, 30)[0];
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: visitId, service_id: 30, doctor_id: 11, quantity: 1, unit_price: 100000, total: 100000, status: 'added' } });
    assert.equal(ins.status, 200);
    const rows = vsRows(t.db, visitId, 30);
    assert.equal(rows.length, 2, 'строка к Иванову удалена строкой к Петрову');
    assert.ok(rows.some((x) => x.id === booked.id && x.doctor_id === 10));
    const lines = linesOf(t.db, rid).filter((l) => l.service_id === 30 && l.status === 'pending');
    assert.equal(lines.find((l) => l.doctor_id === 10).visit_service_id, booked.id, 'строка заявки к Иванову перепривязана к чужому врачу');
    assert.ok(lines.some((l) => l.doctor_id === 11), 'приём у Петрова не появился в заявке');
  } finally { t.close(); }
});

test('R-I2. выданный талон очереди — строка не свободна и приход доказан', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    const lab = vsRows(t.db, visitId, 40)[0];
    t.db.prepare('INSERT INTO service_queue_tickets (visit_service_id, visit_id, service_id, number) VALUES (?, ?, 40, 7)').run(lab.id, visitId);
    const line = linesOf(t.db, rid).find((l) => l.service_id === 40);
    await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { status: 'cancelled' }, filters: [{ col: 'id', op: 'eq', val: line.id }] });
    assert.equal(vsRows(t.db, visitId, 40).length, 1, 'строка с талоном удалена');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM service_queue_tickets WHERE visit_service_id = ?').get(lab.id).n, 1, 'выданный талон стёрт');
    const rm = await t.rpc('booking_line_remove', 'cc', { visit_service_id: lab.id });
    assert.equal(rm.status, 400);
  } finally { t.close(); }
});

// CRM_UNIFY_V1 — ОДНО ПРАВИЛО ДЛЯ ВСЕХ ДВЕРЕЙ. Раньше ensure_visit двигал любую открытую
// заявку пациента без строк, а calendar_book — только «ждущую этот день». Теперь
// оба — по правилу ensure_visit (crm/visit-link.js, шаг C): открытая карточка
// пациента без строк любой давности — это его карточка.
test('R-I3 (CRM_UNIFY_V1): давняя открытая карточка без строк едет в «Записан» при любой записи; второй колл-центр не заводит', async () => {
  const t = await start();
  try {
    const old = t.db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, created_at, updated_at) VALUES ('Пациент Тест','+998900000077','in_process',77,?,?)")
      .run(daysAgoIso(60), daysAgoIso(60)).lastInsertRowid;
    const r1 = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.equal(reqRow(t.db, old).status, 'scheduled', 'запись регистратуры не нашла открытую карточку пациента — ensure_visit нашёл бы');
    const link = t.db.prepare('SELECT * FROM crm_booking_links WHERE visit_id = ?').get(r1.json.data.visit.id);
    assert.ok(link && link.request_id === old);
    assert.equal(link.source, 'match');
    const r3 = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 11, start: at(D2, 12), duration_minutes: 30 });
    assert.equal(r3.status, 200, JSON.stringify(r3.json));
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 1, 'колл-центр завёл вторую карточку пациенту с открытой');
  } finally { t.close(); }
});

test('R-I3. заявка на ЭТОТ день цепляется и к записи регистратуры; отказ по заявке её запись не отменяет', async () => {
  const t = await start();
  try {
    const rid = t.db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date, created_at) VALUES ('Пациент Тест','+998900000077','in_process',77,?,?)").run(D, daysAgoIso(60)).lastInsertRowid;
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
    const visitId = b.json.data.visit.id;
    const link = t.db.prepare('SELECT * FROM crm_booking_links WHERE visit_id = ?').get(visitId);
    assert.ok(link, 'заявка на этот день не привязалась к записи регистратуры');
    assert.equal(link.request_id, rid);
    await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: visitId, service_id: 40, quantity: 1, unit_price: 40000, total: 40000, status: 'added' } });
    assert.equal(linesOf(t.db, rid).length, 1);
    const up = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { status: 'stopped' }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(up.status, 200);
    assert.equal(t.db.prepare('SELECT status FROM visits WHERE id = ?').get(visitId).status, 'scheduled', 'отказ в CRM отменил запись регистратуры');
  } finally { t.close(); }
});

test('R-I4. выданный товар — работа: колл-центр не дописывает, приход доказан', async () => {
  const t = await start();
  try {
    const { visitId } = await crmBooking(t);
    t.db.prepare("INSERT INTO services (id, name, price, type) VALUES (60,'УЗИ',150000,'imaging')").run();
    t.db.prepare("INSERT INTO products (id, name) VALUES (5, 'Бинт')").run();
    t.db.prepare("INSERT INTO visit_services (visit_id, clinic_item_id, quantity, status) VALUES (?, 5, 1, 'added')").run(visitId);
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: visitId, lines: [{ service_id: 60 }] });
    assert.equal(add.status, 400, 'колл-центр дописал услугу к записи с выданным товаром');
  } finally { t.close(); }
});

test('R-I5. при выставленном (неоплаченном) счёте дверь заявки строки визита не ставит и не снимает', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    t.db.prepare("INSERT INTO services (id, name, price, type) VALUES (60,'УЗИ',150000,'imaging')").run();
    t.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, total_amount, status) VALUES (920,'INV-920',?,77,100000,'unpaid')").run(visitId);
    const lab = linesOf(t.db, rid).find((l) => l.service_id === 40);
    await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { status: 'cancelled' }, filters: [{ col: 'id', op: 'eq', val: lab.id }] });
    assert.equal(vsRows(t.db, visitId, 40).length, 1, 'при счёте дверь заявки сняла строку визита');
    await t.dbq('cc', { table: 'crm_request_services', op: 'insert', values: { request_id: rid, service_id: 60, scheduled_date: D, status: 'pending', visit_id: visitId } });
    assert.equal(vsRows(t.db, visitId, 60).length, 0, 'при счёте дверь заявки поставила строку визита');
  } finally { t.close(); }
});

test('R-M1. смена услуги строки — в обе стороны', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    t.db.prepare("INSERT INTO services (id, name, price, type) VALUES (60,'УЗИ',150000,'imaging')").run();
    t.db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (61,'Глюкоза',20000,'lab',1)").run();
    const lab = linesOf(t.db, rid).find((l) => l.service_id === 40);
    const up = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { service_id: 60 }, filters: [{ col: 'id', op: 'eq', val: lab.id }] });
    assert.equal(up.status, 200);
    assert.equal(vsRows(t.db, visitId, 40).length, 0, 'прежняя услуга осталась в записи');
    assert.equal(vsRows(t.db, visitId, 60).length, 1, 'новой услуги нет в записи');
    // Обратно: замена в карте пациента.
    const vs60 = vsRows(t.db, visitId, 60)[0];
    const ch = await t.rpc('change_unpaid_service', 'boss', { visit_service_id: vs60.id, new_service_id: 61 });
    assert.equal(ch.status, 200, JSON.stringify(ch.json));
    const line = linesOf(t.db, rid).find((l) => l.id === lab.id);
    assert.equal(line.service_id, 61, 'заявка не узнала о замене услуги в записи');
    assert.equal(vsRows(t.db, visitId, 61).length, 1);
  } finally { t.close(); }
});

test('R-M2. booking_lines_add: врач — только врач, время — время, пациент — этой записи', async () => {
  const t = await start();
  try {
    const { visitId } = await crmBooking(t);
    const notDoc = await t.rpc('booking_lines_add', 'cc', { visit_id: visitId, lines: [{ service_id: 30, doctor_id: 3 }] });
    assert.equal(notDoc.status, 400); assert.match(notDoc.json.error.message, /врач/i);
    const badTime = await t.rpc('booking_lines_add', 'cc', { visit_id: visitId, lines: [{ service_id: 40, scheduled_at: 'завтра' }] });
    assert.equal(badTime.status, 400);
    const other = await t.rpc('booking_lines_add', 'cc', { visit_id: visitId, patient_id: 78, lines: [{ service_id: 40 }] });
    assert.equal(other.status, 400); assert.match(other.json.error.message, /пациент/i);
  } finally { t.close(); }
});

test('R-M5. смена врача не переписывает цену строки, поставленной регистратурой', async () => {
  const t = await start();
  try {
    const { visitId } = await crmBooking(t);
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: visitId, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 55555, total: 55555, status: 'added' } });
    assert.equal(ins.status, 200);
    const mv = await t.rpc('calendar_book', 'reg', { visit_id: visitId, doctor_id: 11, start: at(D, 10) });
    assert.equal(mv.status, 200);
    const row = t.db.prepare('SELECT * FROM visit_services WHERE id = ?').get(ins.json.data.id);
    assert.equal(row.doctor_id, 11);
    assert.equal(row.unit_price, 55555, 'зеркало переписало цену регистратуры');
  } finally { t.close(); }
});

test('R-M6. первый счёт убирает строку зеркала, оставшуюся рядом со строкой регистратуры', async () => {
  const t = await start();
  try {
    const { rid, visitId } = await crmBooking(t);
    const auto = vsRows(t.db, visitId, 30)[0];
    // Строка регистратуры, поставленная мимо двери (зеркало её не видело).
    const regId = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 30, 10, 1, 100000, 100000, 'added', 2)").run(visitId).lastInsertRowid);
    const inv = await t.rpc('create_invoice_for_visit', 'boss', { visit_id: visitId, visit_service_ids: [regId] });
    assert.equal(inv.status, 200, JSON.stringify(inv.json));
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id = ?').get(auto.id).n, 0, 'строка зеркала осталась вторым счётом');
    assert.equal(linesOf(t.db, rid).find((l) => l.service_id === 30).visit_service_id, regId);
  } finally { t.close(); }
});

test('R-M7. убранная пустая запись колл-центра уносит и заведённую ею заявку', async () => {
  const t = await start();
  try {
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, start: at(D, 11), duration_minutes: 30 });
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 1);
    const d = await t.rpc('discard_empty_visit', 'cc', { visit_id: b.json.data.visit.id });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 0, 'осталась заявка «Записан» без записи');
  } finally { t.close(); }
});

test('R-M8. отчёт колл-центра называет консультации по виду приёма и кладёт их в «Консультации»', async () => {
  const t = await start();
  try {
    t.db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active) VALUES (5,'Первичный','Первичный приём',80000,1)").run();
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, start: at(D, 11), duration_minutes: 30 });
    await t.rpc('booking_lines_add', 'cc', { visit_id: b.json.data.visit.id, lines: [{ consultation_type_id: 5, doctor_id: 10 }] });
    const rep = await t.rpc('callcenter_report', 'boss', {});
    assert.equal(rep.status, 200, JSON.stringify(rep.json));
    assert.ok(rep.json.data.topServices.some((x) => x.name === 'Первичный приём'), JSON.stringify(rep.json.data.topServices));
    assert.ok(!rep.json.data.byServiceType.some((x) => x.name === 'Без группы'), JSON.stringify(rep.json.data.byServiceType));
  } finally { t.close(); }
});
