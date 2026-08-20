// DEPOSIT_REVENUE_V1 — одни деньги считаются выручкой ОДИН раз.
//
// Депозит признаётся доходом в момент приёма: касса взяла 750 000 — это выручка
// дня. Когда пациент потом расплачивается этим балансом за услуги, платёж
// проводится способом «кошелёк». Новых денег в клинику при этом не приходит, и
// если бы «кошелёк» считался приходом, те же 750 000 попали бы в выручку второй
// раз, а смена потребовала бы объяснить сумму, которой в кассе не было.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createDeposit, acceptDeposit } from './deposits.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { openCashShift, cashShiftSummary } from './cashier.js';
import { dashboardSummary } from './dashboard.js';

const REG  = { id: 7, role: 'registrar', full_name: 'Каримова' };
const CASH = { id: 9, role: 'cashier',  full_name: 'Юлдашева' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (7,'r','x','Каримова','registrar')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (9,'c','x','Юлдашева','cashier')").run();
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Dilshod', 1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, price) VALUES ('Консультация', 300000)").run().lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,300000,300000,'added')").run(vid, sid).lastInsertRowid;
  return { db, pid, vid, vs };
}

test('приём депозита — выручка; трата баланса «кошельком» — уже нет', () => {
  const { db, pid, vid, vs } = seed();
  openCashShift(db, { opening_float: 0 }, CASH);

  // 1. Касса взяла 750 000 предоплаты.
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 750000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);

  const afterDeposit = dashboardSummary(db, {}, CASH).collected_today;
  assert.equal(afterDeposit, 750000, 'приход дня — ровно принятая предоплата');
  assert.equal(cashShiftSummary(db, {}, CASH).expected_drawer, 750000, 'и в ящике они же');

  // 2. Пациент оплачивает услугу с баланса — «кошельком».
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, REG);
  recordPayment(db, { invoice_id: invoice.id, amount: 300000, method: 'wallet' }, CASH);

  const afterSpend = dashboardSummary(db, {}, CASH).collected_today;
  assert.equal(afterSpend, 750000, 'выручка НЕ выросла: эти деньги уже посчитаны');
  assert.equal(cashShiftSummary(db, {}, CASH).expected_drawer, 750000, 'и в ящике ничего не прибавилось');

  // Счёт услуги при этом закрыт — пациент ничего не должен.
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id);
  assert.equal(inv.paid_amount, 300000);
  assert.equal(inv.status, 'paid');
  db.close();
});

test('«кошелёк» показан в смене отдельной строкой, но не в её итоге', () => {
  const { db, pid, vid, vs } = seed();
  openCashShift(db, { opening_float: 0 }, CASH);
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 750000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, REG);
  recordPayment(db, { invoice_id: invoice.id, amount: 300000, method: 'wallet' }, CASH);

  const t = cashShiftSummary(db, {}, CASH).totals;
  assert.equal(t.cash, 750000);
  assert.equal(t.wallet, 300000, 'кассир видит, сколько ушло с депозитов');
  assert.equal(t.total, 750000, 'но в итог смены это не входит');
  db.close();
});

test('обычная оплата наличными по-прежнему выручка', () => {
  const { db, vid, vs } = seed();
  openCashShift(db, { opening_float: 0 }, CASH);
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, REG);
  recordPayment(db, { invoice_id: invoice.id, amount: 300000, method: 'cash' }, CASH);
  assert.equal(dashboardSummary(db, {}, CASH).collected_today, 300000);
  assert.equal(cashShiftSummary(db, {}, CASH).totals.total, 300000);
  db.close();
});
