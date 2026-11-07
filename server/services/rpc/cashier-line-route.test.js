// CASHIER_LINE_EDIT_V1 (владелец, 2026-11-07) — «ИСПРАВИТЬ УСЛУГИ» У КАССЫ: АНАЛИЗУ ВРАЧ НЕ НУЖЕН.
//
// Владелец: «даже если меняю на анализ, требует врача». Двери кассы на настоящей базе:
//   • замена в неоплаченном счёте (cashier_line_change_service) — консультация ЛОРа → анализ: ЛОР
//     оставался на строке анализа (его доля, его цена); теперь выбор врача идёт в той же двери
//     (doctor_id / no_doctor), и анализ уходит без врача;
//   • добавление (cashier_line_add) и замена в оплаченном (cashier_line_swap_quote / _paid) — анализ
//     с галочкой «Услугу оказывает специалист» отказывал «нужен врач»: анализ — окно забора, врача
//     ему касса не ставит;
//   • cashier_line_performers говорит экрану, нужен ли исполнитель (needs_performer) и куда идёт
//     услуга (route): анализ («Лаборатория» или «Консультации» из лабораторного отделения) и
//     процедура — нет; услуга кабинета — да.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';

const admin = { id: 1, role: 'admin', full_name: 'Админ', extra_roles: [] };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active, service_rates) VALUES
    (1,'adm','x','admin','Админ',0,1,'[]'),
    (20,'lor','x','doctor','Врач ЛОР',1,1,'[{"service_id":1,"percentage":30},{"service_id":7,"percentage":30}]')`).run();
  db.prepare("INSERT INTO departments (id, name, kind) VALUES (95, 'Лаборатория (тест)', 'laboratory')").run();
  db.prepare(`INSERT INTO services (id, name, price, type, requires_doctor, department_id) VALUES
    (1, 'Приём ЛОР', 100000, 'consultation', 1, NULL),
    (2, 'CRP', 35000, 'lab', 0, NULL),
    (3, 'CA 15-3', 80000, 'consultation', 0, 95),
    (4, 'Перевязка', 30000, 'procedure', 0, NULL),
    (6, 'ОАК', 40000, 'lab', 1, NULL),
    (7, 'УЗИ', 120000, 'imaging', 0, NULL)`).run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3, 'Пациент')").run();
  return db;
}
function visitLine(db, sid, doc) {
  const vid = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (3, ?)').run(new Date().toISOString()).lastInsertRowid);
  const price = db.prepare('SELECT price FROM services WHERE id = ?').get(sid).price;
  const vs = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?, ?, ?, 1, ?, ?, 'added')")
    .run(vid, sid, doc, price, price).lastInsertRowid);
  const inv = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 0 }, admin).invoice;
  return { vid, vs, inv };
}
const line = (db, id) => db.prepare('SELECT service_id, doctor_id, unit_price FROM visit_services WHERE id = ?').get(id);

test('cashier_line_performers: анализ и процедура — исполнитель не нужен; услуга кабинета и «специалист» — нужен', () => {
  const db = seed();
  const { vid } = visitLine(db, 1, 20);
  const ask = (sid) => { const r = RPC.cashier_line_performers(db, { service_id: sid, visit_id: vid }, admin); return [r.route, r.needs_performer]; };
  assert.deepEqual(ask(2), ['lab', false], 'анализ');
  assert.deepEqual(ask(3), ['lab', false], '«Консультации» из лабораторного отделения');
  assert.deepEqual(ask(6), ['lab', false], 'анализ с галочкой «специалист» — всё равно окно забора');
  assert.deepEqual(ask(4), ['procedure', false], 'процедура');
  assert.deepEqual(ask(7), ['cabinet', true], 'УЗИ — кабинет врача');
  assert.deepEqual(ask(1), ['cabinet', true], 'приём');
});

test('неоплаченный счёт: приём ЛОРа → анализ без врача одной дверью; врач другой услуги — той же дверью', () => {
  const db = seed();
  const a = visitLine(db, 1, 20);
  const r = RPC.cashier_line_change_service(db, { visit_service_id: a.vs, new_service_id: 2, no_doctor: true }, admin);
  assert.equal(r.changed, true);
  assert.deepEqual(line(db, a.vs), { service_id: 2, doctor_id: null, unit_price: 35000 });
  // Без врача и без no_doctor — как прежде: врач строки остаётся (другие двери не меняются).
  const b = visitLine(db, 1, 20);
  RPC.cashier_line_change_service(db, { visit_service_id: b.vs, new_service_id: 4 }, admin);
  assert.equal(line(db, b.vs).doctor_id, 20);
  // Замена на УЗИ с выбранным врачом — одна дверь, цена этого врача.
  const c = visitLine(db, 4, null);
  RPC.cashier_line_change_service(db, { visit_service_id: c.vs, new_service_id: 7, doctor_id: 20 }, admin);
  assert.deepEqual(line(db, c.vs), { service_id: 7, doctor_id: 20, unit_price: 120000 });
  // «Без врача» услуге, которой врач нужен, — отказ словами.
  const d = visitLine(db, 4, null);
  assert.throws(() => RPC.cashier_line_change_service(db, { visit_service_id: d.vs, new_service_id: 1, no_doctor: true }, admin), /нужен врач/);
  assert.throws(() => RPC.cashier_line_change_service(db, { visit_service_id: d.vs, new_service_id: 2, doctor_id: 'x' }, admin), /Исполнитель указан неверно/);
});

test('добавление: анализ с галочкой «специалист» — без врача; приём — по-прежнему с врачом', () => {
  const db = seed();
  const a = visitLine(db, 1, 20);
  const r = RPC.cashier_line_add(db, { invoice_id: a.inv.id, service_id: 6 }, admin);
  assert.ok(r.invoice, 'анализ не добавлен');
  assert.throws(() => RPC.cashier_line_add(db, { invoice_id: a.inv.id, service_id: 1 }, admin), /нужен врач/);
});

test('оплаченный счёт: приём ЛОРа → анализ «специалист» без врача — расчёт разницы, а не «нужен врач»', () => {
  const db = seed();
  const a = visitLine(db, 1, 20);
  RPC.open_cash_shift(db, { opening_float: 0 }, admin);
  RPC.record_payment(db, { invoice_id: a.inv.id, amount: 100000, method: 'cash' }, admin);
  const q = RPC.cashier_line_swap_quote(db, { visit_service_id: a.vs, new_service_id: 6, no_doctor: true }, admin);
  assert.equal(q.refunded, 60000);
  assert.match(q.line_after, /ОАК/);
  assert.doesNotMatch(q.line_after, /ЛОР/, 'ЛОР остался на анализе');
});
