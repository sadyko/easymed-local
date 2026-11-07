// REPORTS_TAX_PAY_V1 (владелец, 2026-11-07) — во всех окнах отчётов: сумма без
// НДС / НДС / сумма с НДС, способ оплаты (смешанная оплата делится по
// способам) и фильтры, применённые ДО выгрузки в Excel.
//
// НДС — правило владельца 2026-09-29 (SUPPLIERS_VAT_V1): налог внутри цены,
// сумма после скидки × ставка / 100. 112 000 при 12 % → НДС 13 440, без НДС
// 98 560 (тот же пример, что reports.suppliers-vat.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const FROM = '2026-11-01';
const TO = '2026-11-30';
const AT = '2026-11-05T06:00:00Z';   // 11:00 по Ташкенту
const run = (db, kind, extra = {}, user = ADMIN) => getRpc('run_report')(db, { kind, from: FROM, to: TO, ...extra }, user);
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const sum = (r, col) => {
  const i = r.columns.indexOf(col);
  assert.ok(i > -1, 'нет колонки «' + col + '»');
  return Math.round(r.rows.reduce((n, row) => n + (Number(row[i]) || 0), 0) * 100) / 100;
};

// Клиника: два врача, два кассира, группа пациентов VIP.
//   INV-1 — анализ (лаборатория, без НДС) 100 000, пациент VIP, врач Лабов:
//           60 000 наличными (кассир А) + 40 000 картой (кассир Б);
//   INV-2 — консультация (12 %) 112 000, врач Терапевтов: перевод 112 000 (кассир А);
//   INV-3 — анализ 50 000, не оплачен.
export function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rate_default) VALUES
    (1,'adm','x','admin','Админ',0,0),
    (2,'lab','x','doctor','Лабов',1,10),
    (3,'ter','x','doctor','Терапевтов',1,20),
    (5,'ca','x','cashier','Кассир А',0,0),
    (6,'cb','x','cashier','Кассир Б',0,0)`).run();
  const vip = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 0, 1)").run().lastInsertRowid;
  db.prepare('INSERT INTO patients (id, mrn, full_name, category_id) VALUES (1, ?, ?, ?)').run('A-1', 'Азизов А.', vip);
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (2, 'B-2', 'Бобров Б.')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type, is_lab) VALUES (1, 'Анализ крови', 100000, 0, 'lab', 1)").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (2, 'Консультация', 112000, 12, 'consultation')").run();
  const visit = (pid, doc) => db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (?, ?, ?, 'arrived')").run(pid, doc, AT).lastInsertRowid;
  const inv = (no, vid, pid, total, paid, status) => db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(no, vid, pid, total, total, paid, status, AT).lastInsertRowid;
  const line = (invId, vid, sid, doc, price) => {
    const ii = db.prepare('INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, ?, ?, 1, ?, ?)')
      .run(invId, sid, sid === 1 ? 'Анализ крови' : 'Консультация', price, price).lastInsertRowid;
    db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id) VALUES (?, ?, ?, 1, ?, ?, 'completed', ?)")
      .run(vid, sid, doc, price, price, ii);
  };
  const payment = (invId, amount, method, cashier) => db.prepare('INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at) VALUES (?, ?, ?, ?, ?)')
    .run(invId, amount, method, cashier, AT);
  const v1 = visit(1, 2); const i1 = inv('INV-1', v1, 1, 100000, 100000, 'paid'); line(i1, v1, 1, 2, 100000);
  payment(i1, 60000, 'cash', 5); payment(i1, 40000, 'card', 6);
  const v2 = visit(2, 3); const i2 = inv('INV-2', v2, 2, 112000, 112000, 'paid'); line(i2, v2, 2, 3, 112000);
  payment(i2, 112000, 'transfer', 5);
  const v3 = visit(2, 2); const i3 = inv('INV-3', v3, 2, 50000, 0, 'unpaid'); line(i3, v3, 1, 2, 50000);
  return { db, vip };
}

test('НДС: «Общая выручка» — без НДС / НДС / с НДС; 112 000 при 12 % → 98 560 + 13 440', () => {
  const { db } = seed();
  const r = run(db, 'total_revenue');
  const rows = objects(r);
  const cons = rows.find((o) => o['№ счёта'] === 'INV-2');
  assert.equal(cons['Сумма с НДС'], 112000);
  assert.equal(cons['НДС'], 13440);
  assert.equal(cons['Сумма без НДС'], 98560);
  // Анализ без ставки — НДС 0, обе суммы равны.
  for (const o of rows.filter((x) => x['№ счёта'] !== 'INV-2')) {
    assert.equal(o['НДС'], 0);
    assert.equal(o['Сумма без НДС'], o['Сумма с НДС']);
  }
  // «Итого» складывает все три; без НДС + НДС = с НДС.
  for (const c of ['Сумма без НДС', 'НДС', 'Сумма с НДС']) assert.ok(r.summable_columns.includes(c), c);
  assert.equal(sum(r, 'Сумма с НДС'), 262000);
  assert.equal(sum(r, 'НДС'), 13440);
  assert.equal(sum(r, 'Сумма без НДС') + sum(r, 'НДС'), sum(r, 'Сумма с НДС'));
  // Прежние колонки на месте и сходятся с новыми.
  assert.equal(sum(r, 'После скидки'), sum(r, 'Сумма с НДС'));
  assert.equal(sum(r, 'Налог'), sum(r, 'НДС'));
  db.close();
});

test('НДС: «Счета», «По услугам», «Рентабельность», «Рефералы», врачи и стационар — те же три колонки', () => {
  const { db } = seed();
  const inv = objects(run(db, 'invoices_full'));
  const i2 = inv.filter((o) => o['№ счёта'] === 'INV-2');
  assert.equal(i2.reduce((n, o) => n + o['НДС'], 0), 13440);
  assert.equal(i2.reduce((n, o) => n + o['Сумма с НДС'], 0), 112000);
  assert.equal(i2.reduce((n, o) => n + o['Сумма без НДС'], 0), 98560);
  const bs = objects(run(db, 'by_services'));
  const c = bs.find((o) => o['Услуга'] === 'Консультация');
  assert.deepEqual([c['Сумма без НДС'], c['НДС'], c['Сумма с НДС']], [98560, 13440, 112000]);
  for (const kind of ['doctor_salaries', 'by_doctors', 'doctor_services', 'doctor_lines', 'by_specialty', 'referrals', 'referrals_detail', 'surgery_profit', 'inpatient_share']) {
    const r = run(db, kind);
    for (const col of ['Сумма без НДС', 'НДС', 'Сумма с НДС']) assert.ok(r.columns.includes(col), kind + ': нет «' + col + '»');
  }
  const sal = run(db, 'doctor_salaries');
  assert.equal(sum(sal, 'НДС'), 13440);
  assert.equal(sum(sal, 'Сумма с НДС'), 262000);
  const dl = run(db, 'doctor_lines');
  assert.equal(sum(dl, 'НДС'), 13440);
  assert.equal(sum(dl, 'Сумма без НДС'), 248560);
  db.close();
});

test('НДС: «Отчёт кассира» — НДС платежа в доле НДС его счёта; отчёт владельца — плитки без НДС и НДС', () => {
  const { db } = seed();
  const cr = getRpc('cashier_report')(db, { from: FROM, to: TO }, ADMIN);
  const income = cr.income.rows.map((row) => Object.fromEntries(cr.income.columns.map((c, i) => [c, row[i]])));
  const tr = income.find((o) => o['Счёт'] === 'INV-2');
  assert.deepEqual([tr['Сумма без НДС'], tr['НДС'], tr['Сумма с НДС']], [98560, 13440, 112000]);
  assert.ok(cr.columns.includes('НДС'));
  const own = getRpc('owner_report')(db, { from: FROM, to: TO }, ADMIN);
  assert.equal(own.kpis.revenue, 262000);
  assert.equal(own.kpis.vat, 13440);
  assert.equal(own.kpis.revenue_net, 248560);
  db.close();
});
