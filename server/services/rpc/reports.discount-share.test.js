// DISCOUNT_V2 (решение владельца 2026-11-07, п. 5) — «СКИДКА УМЕНЬШАЕТ ДОЛЮ ВРАЧА».
//
// Числа владельца: услуга 100 000, скидка группы 10 %, доля врача 30 % (налог 0):
//   переключатель включён (как всегда) → врачу 27 000; выключен → 30 000 (клиника берёт
//   скидку на себя). Выручка, скидка и «после налога» отчёта — деньги счёта, не меняются.
// Та же доля — у выполненной строки без счёта и у скидки кассы с выключенным переключателем;
// смесь (группа уменьшает 10 000, касса не уменьшает 30 000) — врачу 27 000.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { performedPayLines } from './reports.js';

const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const pad = (n) => String(n).padStart(2, '0');
const D = new Date(); D.setHours(9, 0, 0, 0);
const DAY = `${D.getFullYear()}-${pad(D.getMonth() + 1)}-${pad(D.getDate())}`;

function seed({ reduces = 1 } = {}) {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active) VALUES (1,'adm','x','admin','Админ',0,1), (9,'cash','x','cashier','Кассир',0,1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active, service_rates) VALUES (20,'doc','x','doctor','Врач',1,1,?)")
    .run(JSON.stringify([{ service_id: 30, pct: 30 }]));
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (30, 'Консультация', 100000, 0)").run();
  const cat = Number(db.prepare("INSERT INTO patient_categories (name, discount_percent, active, reduces_doctor_share) VALUES ('VIP', 10, 1, ?)").run(reduces).lastInsertRowid);
  const pid = Number(db.prepare('INSERT INTO patients (full_name, category_id) VALUES (?, ?)').run('Пациент', cat).lastInsertRowid);
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, 'arrived')").run(pid, D.toISOString()).lastInsertRowid);
  const vs = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 30, 20, 1, 100000, 100000, 'added', 1)").run(vid).lastInsertRowid);
  return { db, vid, vs };
}
const perform = (db, vs) => db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(vs);
const lineOf = (db) => performedPayLines(db, { from: DAY, to: DAY }).find((l) => l.doctor_id === 20);
const round = (n) => Math.round(n * 100) / 100;

test('группа 10 %, переключатель включён (как всегда): врачу 27 000 от 90 000', () => {
  const { db, vid, vs } = seed({ reduces: 1 });
  const inv = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 0 }, admin).invoice;
  assert.equal(inv.total_amount, 90000);
  perform(db, vs);
  const l = lineOf(db);
  assert.equal(round(l.doctor_fee), 27000);
  assert.deepEqual([round(l.amount), round(l.discount), round(l.net)], [100000, 10000, 90000]);
});

test('группа 10 %, переключатель выключен: пациент платит 90 000, врачу 30 000 (от цены до скидки); деньги отчёта прежние', () => {
  const { db, vid, vs } = seed({ reduces: 0 });
  const inv = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 0 }, admin).invoice;
  assert.equal(inv.total_amount, 90000);
  assert.equal(inv.doctor_discount_share, 0);
  perform(db, vs);
  const l = lineOf(db);
  assert.equal(round(l.doctor_fee), 30000);
  assert.deepEqual([round(l.amount), round(l.discount), round(l.net)], [100000, 10000, 90000], 'выручка и скидка отчёта — деньги счёта');
});

test('выполненная строка БЕЗ счёта: группа с выключенным переключателем — 30 000, с включённым — 27 000', () => {
  const off = seed({ reduces: 0 });
  perform(off.db, off.vs);
  assert.equal(round(lineOf(off.db).doctor_fee), 30000);
  const on = seed({ reduces: 1 });
  perform(on.db, on.vs);
  assert.equal(round(lineOf(on.db).doctor_fee), 27000);
});

test('скидка кассы 30 000 «не уменьшает долю врача» поверх группы 10 % (уменьшает): врачу 27 000, пациент платит 60 000', () => {
  const { db, vid, vs } = seed({ reduces: 1 });
  const inv = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 0 }, admin).invoice;
  RPC.cashier_invoice_discount(db, { invoice_id: inv.id, mode: 'abs', value: 30000, reason: 'акция', reduces_doctor_share: false }, cashier);
  assert.equal(db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(inv.id).total_amount, 60000);
  perform(db, vs);
  assert.equal(round(lineOf(db).doctor_fee), 27000);
});

test('скидка кассы 30 000, переключатель включён: врачу 30 % от 60 000 = 18 000 (как прежде у ручной скидки)', () => {
  const { db, vid, vs } = seed({ reduces: 1 });
  const inv = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 0 }, admin).invoice;
  RPC.cashier_invoice_discount(db, { invoice_id: inv.id, mode: 'abs', value: 30000, reason: 'акция' }, cashier);
  perform(db, vs);
  assert.equal(round(lineOf(db).doctor_fee), 18000);
});

test('«Общая выручка» (строки счёта, ITEM_FEE_SQL): доля врача по переключателю — 30 000; скидка — деньги счёта', () => {
  const { db, vid, vs } = seed({ reduces: 0 });
  RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 0 }, admin);
  perform(db, vs);
  const r = RPC.run_report(db, { kind: 'total_revenue', from: DAY, to: DAY }, admin);
  const col = (row, name) => row[r.columns.indexOf(name)];
  const row = r.rows.find((x) => col(x, 'Услуга') === 'Консультация');
  assert.ok(row, 'строки нет: ' + JSON.stringify(r.rows).slice(0, 300));
  assert.equal(col(row, 'Скидка'), 10000);
  assert.equal(col(row, 'Доля врача'), 30000);
});

test('«Общая выручка»: переключатель включён — как прежде, 27 000', () => {
  const { db, vid, vs } = seed({ reduces: 1 });
  RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 0 }, admin);
  perform(db, vs);
  const r = RPC.run_report(db, { kind: 'total_revenue', from: DAY, to: DAY }, admin);
  const col = (row, name) => row[r.columns.indexOf(name)];
  assert.equal(col(r.rows.find((x) => col(x, 'Услуга') === 'Консультация'), 'Доля врача'), 27000);
});

// DISCOUNT_CHANGE_PAID_V1 (3.23.0) — «Изменить скидку» после оплаты: доля врача — по тем же
// формулам отчётов. VIP 10 % оплачен (90 000); касса подняла скидку до 40 % с выключенным
// «Скидка уменьшает долю врача»: добавленные 30 000 берёт клиника (доля скидки для врача
// 10 000 из 40 000 = 0,25) — врачу прежние 27 000, пациенту вернули 30 000; с включённым
// переключателем — 30 % от 60 000 = 18 000. «Общая выручка» говорит то же.
test('DISCOUNT_CHANGE_PAID_V1: скидку подняли после оплаты — переключатель выключен: врачу 27 000; включён: 18 000', () => {
  for (const [reduces, fee] of [[false, 27000], [undefined, 18000]]) {
    const { db, vid, vs } = seed({ reduces: 1 });
    const inv = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 0 }, admin).invoice;
    RPC.record_payment(db, { invoice_id: inv.id, amount: 90000, method: 'cash' }, cashier);
    const r = RPC.cashier_invoice_discount_change(db, { invoice_id: inv.id, mode: 'pct', value: 40, reason: 'жалоба',
      ...(reduces === undefined ? {} : { reduces_doctor_share: reduces }) }, cashier);
    assert.deepEqual([r.refunded, r.total_after], [30000, 60000]);
    assert.equal(r.share_after, reduces === false ? 0.25 : 1);
    perform(db, vs);
    const l = lineOf(db);
    assert.equal(round(l.doctor_fee), fee, 'переключатель: ' + reduces);
    assert.deepEqual([round(l.amount), round(l.discount), round(l.net)], [100000, 40000, 60000], 'деньги отчёта — деньги счёта');
    const rep = RPC.run_report(db, { kind: 'total_revenue', from: DAY, to: DAY }, admin);
    const col = (row, name) => row[rep.columns.indexOf(name)];
    const row = rep.rows.find((x) => col(x, 'Услуга') === 'Консультация');
    assert.equal(col(row, 'Скидка'), 40000);
    assert.equal(col(row, 'Доля врача'), fee);
  }
});
