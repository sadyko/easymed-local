// DISCOUNT_RATES_V1 (3.22.0) — ДОЛЯ ВРАЧА ПРИ СКИДКЕ ПО УСЛУГАМ.
//
// Группа «Сотрудники»: по умолчанию 20 %, Консультации 100 %. Врачу 30 % (налог 0).
// Строки счёта несут свою скидку: консультация 100 000 → 0, УЗИ 200 000 → 160 000.
//   переключатель «Скидка уменьшает долю врача» включён — врачу 0 и 48 000;
//   выключен (клиника берёт скидку на себя) — 30 000 и 60 000.
// Выручка и скидка отчёта — деньги счёта по строкам (не средняя по счёту).
// То же у выполненной строки без счёта.
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
const round = (n) => Math.round(n * 100) / 100;

function seed({ reduces = 1 } = {}) {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active) VALUES (1,'adm','x','admin','Админ',0,1), (9,'cash','x','cashier','Кассир',0,1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active, service_rates) VALUES (20,'doc','x','doctor','Врач',1,1,?)")
    .run(JSON.stringify([{ service_id: 30, pct: 30 }, { service_id: 31, pct: 30 }, { service_id: 40, pct: 30 }]));
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (30, 'Консультация', 100000, 0, 'consultation'), (31, 'УЗИ', 200000, 0, 'imaging'), (40, 'ОАК', 40000, 0, 'lab')").run();
  const cat = Number(db.prepare("INSERT INTO patient_categories (name, discount_percent, active, reduces_doctor_share, discount_rates) VALUES ('Сотрудники', 20, 1, ?, ?)")
    .run(reduces, JSON.stringify({ g: { consultation: 100 } })).lastInsertRowid);
  const pid = Number(db.prepare('INSERT INTO patients (full_name, category_id) VALUES (?, ?)').run('Пациент', cat).lastInsertRowid);
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, 'arrived')").run(pid, D.toISOString()).lastInsertRowid);
  const line = (sid, price) => Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, 20, 1, ?, ?, 'added', 1)").run(vid, sid, price, price).lastInsertRowid);
  return { db, vid, consult: line(30, 100000), uzi: line(31, 200000) };
}
const perform = (db, ...ids) => { for (const id of ids) db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(id); };
const lineOf = (db, sid) => performedPayLines(db, { from: DAY, to: DAY }).find((l) => l.doctor_id === 20 && Number(l.service_id) === sid);

test('переключатель включён: врачу 0 за консультацию (100 %) и 48 000 за УЗИ (20 %); скидка — по строкам', () => {
  const { db, vid, consult, uzi } = seed({ reduces: 1 });
  const inv = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [consult, uzi], discount_amount: 0 }, admin).invoice;
  assert.equal(inv.total_amount, 160000);
  perform(db, consult, uzi);
  const c = lineOf(db, 30), u = lineOf(db, 31);
  assert.deepEqual([round(c.amount), round(c.discount), round(c.doctor_fee)], [100000, 100000, 0]);
  assert.deepEqual([round(u.amount), round(u.discount), round(u.doctor_fee)], [200000, 40000, 48000]);
});

test('переключатель выключен: пациент платит 160 000, врачу 30 000 и 60 000 (от цены до скидки); деньги отчёта — прежние', () => {
  const { db, vid, consult, uzi } = seed({ reduces: 0 });
  const inv = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [consult, uzi], discount_amount: 0 }, admin).invoice;
  assert.equal(inv.total_amount, 160000);
  assert.deepEqual(db.prepare('SELECT discount_doctor_share s FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(inv.id).map((r) => r.s), [0, 0]);
  perform(db, consult, uzi);
  const c = lineOf(db, 30), u = lineOf(db, 31);
  assert.deepEqual([round(c.discount), round(c.net), round(c.doctor_fee)], [100000, 0, 30000]);
  assert.deepEqual([round(u.discount), round(u.net), round(u.doctor_fee)], [40000, 160000, 60000]);
});

test('выполненные строки БЕЗ счёта — те же ставки и тот же переключатель', () => {
  const on = seed({ reduces: 1 });
  perform(on.db, on.consult, on.uzi);
  assert.deepEqual([round(lineOf(on.db, 30).discount), round(lineOf(on.db, 30).doctor_fee)], [100000, 0]);
  assert.deepEqual([round(lineOf(on.db, 31).discount), round(lineOf(on.db, 31).doctor_fee)], [40000, 48000]);
  const off = seed({ reduces: 0 });
  perform(off.db, off.consult, off.uzi);
  assert.equal(round(lineOf(off.db, 30).doctor_fee), 30000);
  assert.equal(round(lineOf(off.db, 31).doctor_fee), 60000);
});

test('скидка кассы «не уменьшает долю врача» поверх ставок (уменьшают): врачу за УЗИ 48 000, пациент платит 144 000', () => {
  const { db, vid, consult, uzi } = seed({ reduces: 1 });
  const inv = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [consult, uzi], discount_amount: 0 }, admin).invoice;
  RPC.cashier_invoice_discount(db, { invoice_id: inv.id, mode: 'pct', value: 10, reason: 'акция', reduces_doctor_share: false }, cashier);
  assert.equal(db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(inv.id).total_amount, 144000);
  perform(db, consult, uzi);
  assert.equal(round(lineOf(db, 31).doctor_fee), 48000);
  assert.equal(round(lineOf(db, 31).discount), 56000);
});

test('замена в ОПЛАЧЕННОМ счёте по ставкам: консультация (100 %) → ОАК (20 %) — к доплате 32 000, доля врача — от 32 000', () => {
  const { db, vid, consult, uzi } = seed({ reduces: 1 });
  RPC.open_cash_shift(db, { opening_float: 0 }, cashier);
  const inv = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [consult, uzi], discount_amount: 0 }, admin).invoice;
  RPC.record_payment(db, { invoice_id: inv.id, amount: 160000, method: 'cash' }, cashier);
  const r = RPC.cashier_line_swap_paid(db, { visit_service_id: consult, new_service_id: 40 }, admin);
  assert.equal(r.due, 32000);
  assert.equal(r.total_after, 192000);
  perform(db, consult, uzi);
  assert.deepEqual([round(lineOf(db, 40).discount), round(lineOf(db, 40).doctor_fee)], [8000, 9600]);
});
