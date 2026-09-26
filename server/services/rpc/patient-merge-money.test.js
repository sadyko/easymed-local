// PATIENT_MERGE_MONEY_V1 — объединение дублей переносит деньги пациента.
//
// Объединение карт живёт в браузере (data.js mergePatients) и переносит
// patient_id таблица за таблицей через /api/db. Баланс пациента (patient_deposits)
// клиенту больше не пишется (ревью I1, мигр. 160) — значит депозиты, зачисления
// и списания дубля оставались бы на удалённой карте, а удаление карты падало
// бы на внешнем ключе. Перенос делает сервер: patient_merge_money.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createDeposit, acceptDeposit, depositBalance } from './deposits.js';
import { createInvoiceForVisit, recordPayment, refundPayment } from './billing.js';
import { openCashShift } from './cashier.js';
import { patientMergeMoney } from './patient-merge-money.js';
import { getRpc } from './index.js';

const ADMIN = { id: 1, role: 'admin', full_name: 'Админ' };
const REG   = { id: 7, role: 'registrar', full_name: 'Каримова' };
const CASH  = { id: 9, role: 'cashier', full_name: 'Юлдашева' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (1,'a','x','Админ','admin')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (7,'r','x','Каримова','registrar')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (9,'c','x','Юлдашева','cashier')").run();
  const keep = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Иванов Иван', 1)").run().lastInsertRowid;
  const drop = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Иванов Иван (дубль)', 1)").run().lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Кардиолог', 200000)").run().lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, CASH);
  return { db, keep, drop, svc };
}
function deposit(db, pid, amount) {
  const { deposit: d } = createDeposit(db, { patient_id: pid, amount }, REG);
  return acceptDeposit(db, { deposit_id: d.id, method: 'cash' }, CASH);
}
const bal = (db, pid) => depositBalance(db, { patient_id: pid }, CASH).balance;

test('баланс после объединения = сумма обоих; депозиты, зачисления и списания дубля — у оставленной карты', () => {
  const { db, keep, drop, svc } = seed();
  deposit(db, keep, 100000);
  const dep = deposit(db, drop, 300000);
  // У дубля есть и оплата с баланса, и возврат на баланс.
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(drop).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,200000,200000,'added')").run(vid, svc).lastInsertRowid;
  const inv = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, REG).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: 50000, method: 'wallet' }, CASH);
  recordPayment(db, { invoice_id: inv.id, amount: 150000, method: 'cash' }, CASH);
  const cashPay = db.prepare("SELECT id FROM payments WHERE invoice_id = ? AND method = 'cash'").get(inv.id).id;
  refundPayment(db, { payment_id: cashPay, amount: 20000, to_balance: true }, CASH);
  assert.equal(bal(db, keep), 100000);
  assert.equal(bal(db, drop), 300000 - 50000 + 20000);

  const out = patientMergeMoney(db, { keep_id: keep, drop_id: drop }, ADMIN);
  assert.equal(out.moved_deposits, 3, 'депозит, списание и зачисление дубля');
  assert.equal(out.moved_invoices, 1, 'счёт его депозита');
  assert.equal(bal(db, keep), 100000 + 270000, 'сумма обоих');
  assert.equal(bal(db, drop), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patient_deposits WHERE patient_id = ?').get(drop).n, 0);
  // Счёт депозита (без визита) едет вместе со своим депозитом.
  assert.equal(db.prepare('SELECT patient_id FROM invoices WHERE id = ?').get(dep.invoice.id).patient_id, keep);
  // Счёт визита остаётся при визите: его переносит само объединение вместе с визитом.
  assert.equal(db.prepare('SELECT patient_id FROM invoices WHERE id = ?').get(inv.id).patient_id, drop);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM merge_money_moves').get().n, 0, 'разрешение на перенос не остаётся висеть');
  db.close();
});

test('журнал баланса по-прежнему заморожен: без объединения patient_id и остальное не меняется', () => {
  const { db, keep, drop } = seed();
  deposit(db, drop, 100000);
  const d = db.prepare('SELECT id FROM patient_deposits WHERE patient_id = ?').get(drop).id;
  assert.throws(() => db.prepare('UPDATE patient_deposits SET patient_id = ? WHERE id = ?').run(keep, d), /журнал\S* баланса/);
  // Даже во время переноса разрешён ровно перенос drop → keep, а не сумма.
  db.prepare('INSERT INTO merge_money_moves (drop_id, keep_id) VALUES (?, ?)').run(drop, keep);
  assert.throws(() => db.prepare('UPDATE patient_deposits SET amount = 1 WHERE id = ?').run(d), /журнал\S* баланса/);
  const other = db.prepare("INSERT INTO patients (full_name) VALUES ('Третий')").run().lastInsertRowid;
  assert.throws(() => db.prepare('UPDATE patient_deposits SET patient_id = ? WHERE id = ?').run(other, d), /журнал\S* баланса/);
  db.close();
});

test('права и проверки: только админ (как удаление карт при объединении); та же карта и несуществующая — отказ', () => {
  const { db, keep, drop } = seed();
  assert.throws(() => patientMergeMoney(db, { keep_id: keep, drop_id: drop }, CASH), (e) => e.status === 403);
  assert.throws(() => patientMergeMoney(db, { keep_id: keep, drop_id: drop }, REG), (e) => e.status === 403);
  assert.throws(() => patientMergeMoney(db, { keep_id: keep, drop_id: keep }, ADMIN), (e) => e.status === 400);
  assert.throws(() => patientMergeMoney(db, { keep_id: keep, drop_id: 999 }, ADMIN), (e) => e.status === 400);
  assert.deepEqual(patientMergeMoney(db, { keep_id: keep, drop_id: drop }, ADMIN), { moved_deposits: 0, moved_invoices: 0 });
  assert.equal(typeof getRpc('patient_merge_money'), 'function');
  db.close();
});
