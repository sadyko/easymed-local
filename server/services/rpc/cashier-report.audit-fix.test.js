// REPORTS_AUDIT_FIX_V1 (2026-09-27) — касса и даты отчётов.
//
//   4  «Отчёт кассира» с фильтром по филиалу не теряет оплату счёта
//      госпитализации (у него филиала нет — это своё здание);
//   5  возврат в «Отчёте кассира» — строка «Возврат» со своим способом, а не
//      «Поступление»; число платежей смены возвратов не считает — они отдельно;
//   7  ошибки, которые видит человек, — по-русски; мусор вместо даты и «с»
//      позже «по» — отказ 400, а не молча пустой отчёт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { cashierReport } from './cashier-report.js';
import { shiftReport, cashShiftSummary } from './cashier.js';
import { callcenterReport } from './callcenter.js';
import { runReport, reportChoices, reportsOverview, doctorTierPositions } from './reports.js';
import { labUsageStats } from './lab-stats.js';

const ADMIN = { id: 1, role: 'admin' };
const RANGE = { from: '2026-09-01', to: '2026-09-30' };
const DAY = '2026-09-10T09:00:00Z';
const CYR = /[А-Яа-яЁё]/;

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (1,'a','x','Админ','admin')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (5,'k','x','Кассир','cashier')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (6,'k2','x','Кассир 2','cashier')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (10,'Пациент')").run();
  db.prepare("INSERT OR IGNORE INTO branches (id, name) VALUES (1,'Главный'),(2,'Второй')").run();
  return db;
}
function paidInvoice(db, { branch = 1, admission = null, amount = 100000, number }) {
  const inv = db.prepare(`INSERT INTO invoices (invoice_number, patient_id, branch_id, admission_id, total_amount, paid_amount, status, created_at)
                          VALUES (?,10,?,?,?,?,'paid',?)`).run(number, branch, admission, amount, amount, DAY).lastInsertRowid;
  db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?,'Услуга',1,?,?)").run(inv, amount, amount);
  return inv;
}
const pay = (db, inv, amount, method = 'cash', shift = null) =>
  db.prepare('INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at, shift_id) VALUES (?,?,?,5,?,?)').run(inv, amount, method, DAY, shift);

// ─── 4 ───────────────────────────────────────────────────────────────────────

test('4: касса с фильтром по филиалу видит оплату счёта госпитализации (филиала у него нет)', () => {
  const db = seed();
  db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (1,10,'discharged')").run();
  const own = db.prepare('SELECT COALESCE(bi.branch_id, (SELECT id FROM branches WHERE letter = bi.letter)) AS id FROM branch_identity bi WHERE id = 1').get().id;
  pay(db, paidInvoice(db, { branch: null, admission: 1, amount: 300000, number: 'INV-ADM' }), 300000);
  pay(db, paidInvoice(db, { branch: 2, amount: 50000, number: 'INV-2' }), 50000);
  const other = own === 2 ? 1 : 2;
  const r = cashierReport(db, { ...RANGE, branch_ids: [own] }, ADMIN);
  assert.equal(r.kpi.income, own === 2 ? 350000 : 300000, 'оплата стационара выпала из кассы филиала');
  assert.equal(cashierReport(db, { ...RANGE, branch_ids: [other] }, ADMIN).kpi.income, other === 2 ? 50000 : 0);
});

// ─── 5 ───────────────────────────────────────────────────────────────────────

test('5: возврат в «Отчёте кассира» — строка «Возврат» со своим способом, а не «Поступление»', () => {
  const db = seed();
  const inv = paidInvoice(db, { amount: 300000, number: 'INV-1' });
  pay(db, inv, 300000, 'cash');
  pay(db, inv, -100000, 'card');
  const r = cashierReport(db, RANGE, ADMIN);
  assert.equal(r.kpi.income, 200000, 'итог прихода — за вычетом возврата, как прежде');
  assert.equal(r.kpi.refunds, 100000);
  const typeCol = r.columns.indexOf('Тип');
  const methodCol = r.columns.indexOf('Способ оплаты');
  const refund = r.rows.find((row) => row[r.columns.indexOf('Сумма')] === -100000);
  assert.equal(refund[typeCol], 'Возврат');
  assert.equal(refund[methodCol], 'Карта');
  const inc = r.rows.find((row) => row[r.columns.indexOf('Сумма')] === 300000);
  assert.equal(inc[typeCol], 'Поступление');
  // И в таблице «Поступления» экрана строка названа возвратом.
  const im = r.income.columns.indexOf('Способ оплаты');
  assert.ok(r.income.rows.some((row) => /Возврат/.test(row[im])), 'в таблице поступлений возврат не назван');
});

test('5: смена — число платежей без возвратов, возвраты отдельно', () => {
  const db = seed();
  const summary = cashShiftSummary(db, {}, { id: 5, role: 'cashier' });
  const shift = summary.shift.id;
  const inv = paidInvoice(db, { amount: 300000, number: 'INV-1' });
  pay(db, inv, 200000, 'cash', shift);
  pay(db, inv, 100000, 'card', shift);
  pay(db, inv, -50000, 'cash', shift);
  const r = shiftReport(db, {}, { id: 5, role: 'cashier' });
  assert.equal(r.totals.count, 2, 'возврат посчитан платежом');
  assert.equal(r.totals.refund_count, 1);
  assert.equal(r.totals.refunds, 50000);
  assert.equal(r.totals.total, 250000);
});

// ─── 7 ───────────────────────────────────────────────────────────────────────

test('7: ошибки отчётов по-русски; мусорная дата и «с» позже «по» — 400', () => {
  const db = seed();
  const bad = [
    () => runReport(db, { kind: 'total_revenue', from: 'вчера', to: '2026-09-30' }, ADMIN),
    () => runReport(db, { kind: 'total_revenue', from: '2026-09-30', to: '2026-09-01' }, ADMIN),
    () => runReport(db, { kind: 'bogus', ...RANGE }, ADMIN),
    () => runReport(db, { kind: 'referrals', referrer: 'x', ...RANGE }, ADMIN),
    () => runReport(db, { kind: 'by_services', paid: 'x', ...RANGE }, ADMIN),
    () => runReport(db, { kind: 'by_services', group: 'x', ...RANGE }, ADMIN),
    () => runReport(db, { kind: 'stock_consumption', by: 'x', ...RANGE }, ADMIN),
    () => runReport(db, { kind: 'doctor_lines', doctor_id: 'x', ...RANGE }, ADMIN),
    () => reportChoices(db, { kind: 'bogus', arg: 'doctor_id' }, ADMIN),
    () => reportChoices(db, { kind: 'doctor_lines', arg: 'bogus' }, ADMIN),
    () => reportsOverview(db, { from: '2026-09-30', to: '2026-09-01' }, ADMIN),
    () => doctorTierPositions(db, { doctor_id: 1, from: '2026-09', to: '2026-08' }, ADMIN),
    () => doctorTierPositions(db, { doctor_id: 1, month: '2026-13' }, ADMIN),
    () => cashierReport(db, { from: 'abc', to: '2026-09-30' }, ADMIN),
    () => cashierReport(db, { from: '2026-09-30', to: '2026-09-01' }, ADMIN),
    () => callcenterReport(db, { from: 'abc', to: '2026-09-30' }, ADMIN),
    () => callcenterReport(db, { from: '2026-09-30', to: '2026-09-01' }, ADMIN),
    () => labUsageStats(db, { period: 'bogus' }, ADMIN),
  ];
  bad.forEach((fn, i) => {
    assert.throws(fn, (e) => {
      assert.equal(e.status, 400, 'вызов #' + i + ': не 400 — ' + e.message);
      assert.match(e.message, CYR, 'вызов #' + i + ': сообщение не по-русски — ' + e.message);
      return true;
    });
  });
});

test('7: отказы смены по-русски (чужая смена, не та роль)', () => {
  const db = seed();
  const shift = cashShiftSummary(db, {}, { id: 5, role: 'cashier' }).shift.id;
  assert.throws(() => shiftReport(db, { shift_id: shift }, { id: 6, role: 'cashier' }),
    (e) => e.status === 403 && CYR.test(e.message));
  assert.throws(() => shiftReport(db, {}, { id: 7, role: 'lab' }),
    (e) => e.status === 403 && CYR.test(e.message));
  assert.throws(() => shiftReport(db, { shift_id: 99999 }, ADMIN),
    (e) => e.status === 400 && CYR.test(e.message));
});
