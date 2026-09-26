// DEPOSIT_WALLET_V1 — баланс пациента: возврат «на баланс» и оплата «с баланса».
//
// Владелец: «cashier cancels the payment and can actually refund or push to the
// deposit so on the next service it can be paid — e.g. when a doctor made an
// error: the neurologist says after payment and review it's not his patient».
//
// Все проверки — через настоящие RPC и SQLite после миграций: деньги, ящик,
// итог смены, приход дня и отчёты считаются теми же функциями, что у кассы.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createDeposit, acceptDeposit, refundDeposit, depositBalance, listDeposits } from './deposits.js';
import { createInvoiceForVisit, recordPayment, recordPaymentSplit, refundPayment } from './billing.js';
import { openCashShift, cashShiftSummary, voidInvoice } from './cashier.js';
import { dashboardSummary } from './dashboard.js';
import { cashierReport } from './cashier-report.js';
import { runReport, ownerReport } from './reports.js';
import { RPC } from './index.js';

const ADMIN = { id: 1, role: 'admin', full_name: 'Админ' };
const REG   = { id: 7, role: 'registrar', full_name: 'Каримова' };
const CASH  = { id: 9, role: 'cashier', full_name: 'Юлдашева' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (1,'a','x','Админ','admin')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (7,'r','x','Каримова','registrar')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (9,'c','x','Юлдашева','cashier')").run();
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Dilshod', 1)").run().lastInsertRowid;
  const neuro = db.prepare("INSERT INTO services (name, price) VALUES ('Невролог', 300000)").run().lastInsertRowid;
  const cardio = db.prepare("INSERT INTO services (name, price) VALUES ('Кардиолог', 200000)").run().lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, CASH);
  return { db, pid, neuro, cardio };
}

// Визит с одной услугой и счёт по нему.
function billed(db, pid, serviceId, price) {
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,?,?,'added')")
    .run(vid, serviceId, price, price).lastInsertRowid;
  return createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, REG).invoice;
}
const payOf = (db, invoiceId) => db.prepare('SELECT * FROM payments WHERE invoice_id = ? AND amount > 0 ORDER BY id DESC').get(invoiceId);
const inv = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
const today = (db) => db.prepare("SELECT date('now','localtime') d").get().d;
const balance = (db, pid) => depositBalance(db, { patient_id: pid }, CASH).balance;

test('невролог «не мой пациент»: возврат на баланс — наличные из кассы не уходят, счёт снова должен', () => {
  const { db, pid, neuro } = seed();
  const i1 = billed(db, pid, neuro, 300000);
  recordPayment(db, { invoice_id: i1.id, amount: 300000, method: 'cash' }, CASH);
  const drawerBefore = cashShiftSummary(db, {}, CASH).expected_drawer;
  const totalBefore = cashShiftSummary(db, {}, CASH).totals.total;
  const collectedBefore = dashboardSummary(db, {}, CASH).collected_today;

  const out = refundPayment(db, { payment_id: payOf(db, i1.id).id, to_balance: true, reason: 'Невролог: не его пациент' }, CASH);
  assert.equal(out.to_balance, true);
  assert.equal(out.invoice.paid_amount, 0);
  assert.equal(out.invoice.status, 'unpaid', 'счёт снова должен — его отменяют или оплачивают');

  const s = cashShiftSummary(db, {}, CASH);
  assert.equal(s.expected_drawer, drawerBefore, 'из ящика наличные не вышли');
  assert.equal(s.totals.total, totalBefore, 'итог смены тот же');
  assert.equal(s.totals.cash, 300000, 'наличные смены не уменьшились');
  assert.equal(dashboardSummary(db, {}, CASH).collected_today, collectedBefore, 'приход дня тот же: деньги в клинике');
  assert.equal(balance(db, pid), 300000, 'деньги на балансе пациента');

  const back = db.prepare('SELECT * FROM payments WHERE amount < 0').get();
  assert.equal(back.method, 'wallet');
  assert.equal(back.amount, -300000);
  const credit = db.prepare("SELECT * FROM patient_deposits WHERE kind = 'credit'").get();
  assert.equal(credit.status, 'received');
  assert.equal(credit.amount, 300000);
  assert.equal(credit.invoice_id, i1.id, 'видно, из какого счёта пришли деньги');
  assert.equal(credit.payment_id, payOf(db, i1.id).id, 'и какой платёж вернули');
  assert.equal(credit.reason, 'Невролог: не его пациент');
  db.close();
});

test('следующая услуга оплачивается с баланса: баланс списан, выручка и ящик не выросли, отчёты не двоят', () => {
  const { db, pid, neuro, cardio } = seed();
  const i1 = billed(db, pid, neuro, 300000);
  recordPayment(db, { invoice_id: i1.id, amount: 300000, method: 'cash' }, CASH);
  refundPayment(db, { payment_id: payOf(db, i1.id).id, to_balance: true }, CASH);
  voidInvoice(db, { invoice_id: i1.id }, CASH);

  const i2 = billed(db, pid, cardio, 200000);
  const r = recordPayment(db, { invoice_id: i2.id, amount: 200000, method: 'wallet' }, CASH);
  assert.equal(r.invoice.status, 'paid');
  assert.equal(balance(db, pid), 100000, 'остаток на балансе');
  const spend = db.prepare("SELECT * FROM patient_deposits WHERE kind = 'spend'").get();
  assert.equal(spend.status, 'spent');
  assert.equal(spend.amount, 200000);
  assert.equal(spend.invoice_id, i2.id);
  assert.equal(spend.payment_id, payOf(db, i2.id).id);

  const s = cashShiftSummary(db, {}, CASH);
  assert.equal(s.expected_drawer, 300000, 'в ящике ровно то, что пациент принёс');
  assert.equal(s.totals.total, 300000);
  assert.equal(dashboardSummary(db, {}, CASH).collected_today, 300000);
  const cr = cashierReport(db, { from: today(db), to: today(db) }, ADMIN);
  assert.equal(cr.kpi.income, 300000, '«Отчёт кассира»: баланс — не новый приход');
  // Оказанное: счёт невролога отменён, счёт кардиолога — 200 000.
  const rev = runReport(db, { kind: 'total_revenue' }, ADMIN);
  const sum = rev.rows.reduce((n, row) => n + Number(row[10] || 0), 0);
  assert.equal(sum, 200000, 'выставленные услуги — только кардиолог');
  db.close();
});

test('списать больше баланса нельзя — ни платежа, ни строки журнала', () => {
  const { db, pid, cardio } = seed();
  const i2 = billed(db, pid, cardio, 200000);
  assert.throws(() => recordPayment(db, { invoice_id: i2.id, amount: 200000, method: 'wallet' }, CASH),
    (e) => e.status === 400 && /На балансе пациента только 0/.test(e.message));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patient_deposits WHERE kind='spend'").get().n, 0);
  assert.equal(inv(db, i2.id).paid_amount, 0);
  db.close();
});

test('два списания одного баланса: второе отказано, баланс не уходит в минус (и в одной оплате частями тоже)', () => {
  const { db, pid, neuro, cardio } = seed();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 250000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  const a = billed(db, pid, cardio, 200000);
  const b = billed(db, pid, cardio, 200000);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'wallet' }, CASH);
  assert.throws(() => recordPayment(db, { invoice_id: b.id, amount: 200000, method: 'wallet' }, ADMIN), /только 50000/);
  assert.equal(balance(db, pid), 50000);

  const c = billed(db, pid, neuro, 300000);
  assert.throws(() => recordPaymentSplit(db, { invoice_id: c.id, tenders: [
    { method: 'wallet', amount: 40000 }, { method: 'wallet', amount: 40000 }, { method: 'cash', amount: 100000 }] }, CASH),
  /только 10000/, 'вторая часть «с баланса» видит первую');
  assert.equal(inv(db, c.id).paid_amount, 0, 'оплата частями откатилась целиком');
  assert.equal(balance(db, pid), 50000);

  recordPaymentSplit(db, { invoice_id: c.id, tenders: [{ method: 'wallet', amount: 50000 }, { method: 'cash', amount: 250000 }] }, CASH);
  assert.equal(balance(db, pid), 0);
  assert.equal(inv(db, c.id).status, 'paid');
  db.close();
});

test('возврат платежа «с баланса» по умолчанию — на баланс; наличными — только явным выбором', () => {
  const { db, pid, cardio } = seed();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 200000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  const a = billed(db, pid, cardio, 200000);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'wallet' }, CASH);
  const drawer = cashShiftSummary(db, {}, CASH).expected_drawer;

  const r1 = refundPayment(db, { payment_id: payOf(db, a.id).id, amount: 50000 }, CASH);
  assert.equal(r1.to_balance, true, 'по умолчанию на баланс');
  assert.equal(balance(db, pid), 50000);
  assert.equal(cashShiftSummary(db, {}, CASH).expected_drawer, drawer, 'ящик не тронут');

  const r2 = refundPayment(db, { payment_id: payOf(db, a.id).id, amount: 30000, to_balance: false }, CASH);
  assert.equal(r2.to_balance, false);
  assert.equal(balance(db, pid), 50000, 'выданное наличными на баланс не легло');
  assert.equal(cashShiftSummary(db, {}, CASH).expected_drawer, drawer - 30000, 'и вышло из ящика');
  const back = db.prepare('SELECT method FROM payments WHERE amount = -30000').get();
  assert.equal(back.method, 'cash');
  db.close();
});

test('отмена счёта, оплаченного с баланса: сначала возврат (на баланс), потом отмена — баланс целиком вернулся', () => {
  const { db, pid, cardio } = seed();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 200000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'card' }, CASH);
  const a = billed(db, pid, cardio, 200000);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'wallet' }, CASH);
  assert.throws(() => voidInvoice(db, { invoice_id: a.id }, CASH), /сначала оформите возврат/);
  refundPayment(db, { payment_id: payOf(db, a.id).id }, CASH);
  voidInvoice(db, { invoice_id: a.id }, CASH);
  assert.equal(inv(db, a.id).status, 'void');
  assert.equal(balance(db, pid), 200000);
  db.close();
});

test('счёт депозита: оплатить его балансом и вернуть его платёж «на баланс» нельзя; строку баланса не выдать кнопкой депозита', () => {
  const { db, pid, neuro } = seed();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 100000 }, REG);
  const acc = acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  assert.throws(() => refundPayment(db, { payment_id: payOf(db, acc.invoice.id).id, to_balance: true }, CASH), /Вернуть депозит/);

  const i1 = billed(db, pid, neuro, 300000);
  recordPayment(db, { invoice_id: i1.id, amount: 300000, method: 'cash' }, CASH);
  refundPayment(db, { payment_id: payOf(db, i1.id).id, to_balance: true }, CASH);
  const credit = db.prepare("SELECT * FROM patient_deposits WHERE kind='credit'").get();
  assert.throws(() => refundDeposit(db, { deposit_id: credit.id }, CASH), /не депозит/);

  const list = listDeposits(db, { status: 'all' }, CASH).rows;
  assert.deepEqual(list.map((r) => r.kind), ['deposit'], 'в списке депозитов кассы — только депозиты');
  const b = depositBalance(db, { patient_id: pid }, CASH);
  assert.equal(b.balance, 400000);
  assert.deepEqual(b.rows.map((r) => r.kind), ['credit', 'deposit'], 'журнал объясняет цифру');
  db.close();
});

test('депозит + оплата им услуги: в отчёте владельца услуга одна, приход — один раз', () => {
  const { db, pid, cardio } = seed();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 500000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  const a = billed(db, pid, cardio, 200000);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'wallet' }, CASH);
  assert.equal(ownerReport(db, {}, ADMIN).kpis.revenue, 200000, 'выставлено услуг — 200 000, депозит не услуга');
  assert.equal(dashboardSummary(db, {}, CASH).collected_today, 500000, 'приход — принятый депозит');
  assert.equal(cashierReport(db, { from: today(db), to: today(db) }, ADMIN).kpi.income, 500000);
  db.close();
});

test('права: оплата с баланса и возврат на баланс — только касса и админ', () => {
  const { db, pid, neuro } = seed();
  const i1 = billed(db, pid, neuro, 300000);
  assert.throws(() => recordPayment(db, { invoice_id: i1.id, amount: 1, method: 'wallet' }, REG), (e) => e.status === 403);
  recordPayment(db, { invoice_id: i1.id, amount: 300000, method: 'cash' }, CASH);
  assert.throws(() => refundPayment(db, { payment_id: payOf(db, i1.id).id, to_balance: true }, REG), (e) => e.status === 403);
  assert.equal(typeof RPC.deposit_balance, 'function');
  db.close();
});
