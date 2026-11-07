// DISCOUNT_V2 (3.22.0, п. 5 списка S1) — СЧЁТ СО СКИДКОЙ 100 % ВИДЕН В КАССЕ.
//
// Счёт на 0 закрывается при выставлении, платежа у него нет, и «Приём оплат» (а с ним
// «История операций» и отчёт смены) его не показывал: FREE_SERVICE_V1 отсекал все счета
// на 0. Бесплатная услуга (сумма строк 0) по-прежнему не засоряет кассу; счёт, у которого
// всю сумму съела скидка, — виден, сумма 0. Деньги итогов не меняются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';

const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_active) VALUES (9,'cash','x','cashier','Кассир',1)").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (30, 'Консультация', 100000), (31, 'Бесплатный осмотр', 0)").run();
  return db;
}
function bill(db, sid, extra = {}) {
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid);
  const vid = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, new Date().toISOString()).lastInsertRowid);
  const price = db.prepare('SELECT price FROM services WHERE id = ?').get(sid).price;
  const vs = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, ?, 1, ?, ?, 'added')").run(vid, sid, price, price).lastInsertRowid);
  return RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 0, ...extra }, cashier).invoice;
}

test('скидка 100 % — в «Приёме оплат» (оплачен, сумма 0, скидка видна); бесплатная услуга — по-прежнему нет; итоги денег — прежние', () => {
  const db = seed();
  const shift = RPC.open_cash_shift(db, { opening_float: 0 }, cashier);
  void shift;
  const full = bill(db, 30, { discount_amount: 100000, discount_choice: 'manual' });
  assert.deepEqual([full.total_amount, full.discount_amount, full.status], [0, 100000, 'paid']);
  const free = bill(db, 31);
  const paid = bill(db, 30);
  RPC.record_payment(db, { invoice_id: paid.id, amount: 100000, method: 'cash' }, cashier);
  const { rows, counts } = RPC.cashier_invoices(db, {}, cashier);
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(full.id), 'счёт со скидкой 100 % не виден');
  assert.ok(!ids.includes(free.id), 'бесплатная услуга засоряет кассу');
  const row = rows.find((r) => r.id === full.id);
  assert.deepEqual([row.total_amount, row.discount_amount, row.discount_note], [0, 100000, 'Скидка вручную']);
  assert.equal(counts.paid.sum, 100000, 'сумма оплаченных — только деньги');
  const rep = RPC.shift_report(db, {}, cashier);
  assert.equal(rep.totals.total, 100000);
  assert.deepEqual(rep.full_discount, { n: 1, discount: 100000 });
});

test('скидка кассы 100 % — в отчёте смены кассира, давшего скидку; поиск счёта его находит', () => {
  const db = seed();
  RPC.open_cash_shift(db, { opening_float: 0 }, cashier);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_active) VALUES (7,'reg','x','registrar','Регистратор',1)").run();
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid);
  const vid = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, new Date().toISOString()).lastInsertRowid);
  const vs = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, 30, 1, 100000, 100000, 'added')").run(vid).lastInsertRowid);
  const inv = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 0 }, { id: 7, role: 'registrar' }).invoice;
  RPC.cashier_invoice_discount(db, { invoice_id: inv.id, mode: 'pct', value: 100, reason: 'благотворительность' }, cashier);
  assert.deepEqual(RPC.shift_report(db, {}, cashier).full_discount, { n: 1, discount: 100000 });
  const found = RPC.cashier_invoice_search(db, { invoice_id: inv.id }, cashier);
  assert.ok(JSON.stringify(found).includes(inv.invoice_number), 'поиск не находит счёт со скидкой 100 %: ' + JSON.stringify(found).slice(0, 300));
});

// DISCOUNT_V2 (ревью S1 L-1, проба G100) — счёт со скидкой 100 %, который выставила РЕГИСТРАТУРА
// (группа «Сотрудники» 100 %), закрыт без кассира — платежа нет, кассир его не трогал. В отчёт смены
// он не попадал: считались только счета, выставленные кассиром смены или закрытые его скидкой.
// Теперь — и счета без своего кассира (выставил не кассир со сменой, скидку кассы никто не давал),
// закрытые за время смены. Счёт другого кассира в чужую смену не уходит. Деньги смены — прежние.
test('ревью S1 L-1: группа 100 % — счёт регистратуры в отчёте смены; счёт другого кассира — только в его смене', () => {
  const db = seed();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_active) VALUES (7,'reg','x','registrar','Регистратор',1), (8,'cash2','x','cashier','Кассир 2',1)").run();
  const staff = Number(db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('Сотрудники', 100, 1)").run().lastInsertRowid);
  RPC.open_cash_shift(db, { opening_float: 0 }, cashier);
  const cashier2 = { id: 8, role: 'cashier', full_name: 'Кассир 2' };
  RPC.open_cash_shift(db, { opening_float: 0 }, cashier2);
  const staffBill = (actor) => {
    const pid = Number(db.prepare("INSERT INTO patients (full_name, category_id) VALUES ('Сотрудник', ?)").run(staff).lastInsertRowid);
    const vid = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, new Date().toISOString()).lastInsertRowid);
    const vs = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, 30, 1, 100000, 100000, 'added')").run(vid).lastInsertRowid);
    return RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 0 }, actor).invoice;
  };
  const reg = staffBill({ id: 7, role: 'registrar' });
  assert.deepEqual([reg.total_amount, reg.status], [0, 'paid']);
  assert.deepEqual(RPC.shift_report(db, {}, cashier).full_discount, { n: 1, discount: 100000 }, 'счёт регистратуры не в отчёте смены');
  // Счёт, выставленный вторым кассиром, — в его смене, а не в смене первого.
  staffBill(cashier2);
  assert.deepEqual(RPC.shift_report(db, {}, cashier).full_discount, { n: 1, discount: 100000 }, 'чужой счёт ушёл в смену первого кассира');
  assert.deepEqual(RPC.shift_report(db, {}, cashier2).full_discount, { n: 2, discount: 200000 });
  // Деньги смены — прежние: платежей нет.
  assert.equal(RPC.shift_report(db, {}, cashier).totals.total, 0);
});
