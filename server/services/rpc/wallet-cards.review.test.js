// DEPOSIT_WALLET_V1 / CARD_BALANCE_V1 — ревью денег (2026-09-26).
//
// Каждый сценарий — дыра, найденная ревью: деньги выходили дважды, баланс
// можно было подделать с клиента, номинал карты правкой превращался в новые
// деньги, карта на услуги платила больше своих услуг, кэшбэк начислялся с
// денег, которые уже были посчитаны. Все — через настоящие RPC и SQLite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createDeposit, acceptDeposit, refundDeposit, depositBalance } from './deposits.js';
import { createInvoiceForVisit, recordPayment, recordPaymentSplit, refundPayment } from './billing.js';
import { openCashShift } from './cashier.js';
import { writableColumns } from '../../db/schema-registry.js';
import { compile } from '../../db/query-compiler.js';
import { getRpc } from './index.js';

const REG  = { id: 7, role: 'registrar', full_name: 'Каримова' };
const CASH = { id: 9, role: 'cashier', full_name: 'Юлдашева' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (7,'r','x','Каримова','registrar')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (9,'c','x','Юлдашева','cashier')").run();
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Dilshod', 1)").run().lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Кардиолог', 200000)").run().lastInsertRowid;
  const lab = db.prepare("INSERT INTO services (name, price) VALUES ('Анализ', 100000)").run().lastInsertRowid;
  openCashShift(db, { opening_float: 1000000 }, CASH);
  return { db, pid, svc, lab };
}
function billed(db, pid, lines) {
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const ids = lines.map(([sid, price]) => db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,?,?,'added')")
    .run(vid, sid, price, price).lastInsertRowid);
  return createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, REG).invoice;
}
const acceptedDeposit = (db, pid, amount = 100000) => {
  const { deposit } = createDeposit(db, { patient_id: pid, amount }, REG);
  return acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
};
const payOf = (db, invoiceId) => db.prepare('SELECT * FROM payments WHERE invoice_id = ? AND amount > 0 ORDER BY id').get(invoiceId);
const cashOut = (db) => db.prepare("SELECT COALESCE(SUM(-amount),0) s FROM payments WHERE amount < 0 AND method = 'cash'").get().s;

// ─── C1 — счёт депозита живёт только через «Принять/Вернуть депозит» ─────────
test('C1: платёж счёта депозита не возвращается через refund_payment — ни деньгами, ни на баланс', () => {
  const { db, pid } = seed();
  const acc = acceptedDeposit(db, pid);
  const p = payOf(db, acc.invoice.id);
  for (const to_balance of [false, true, undefined]) {
    assert.throws(() => refundPayment(db, { payment_id: p.id, to_balance }, CASH), /Вернуть депозит/);
  }
  // Единственный путь — refund_deposit, и он выдаёт ровно депозит, один раз.
  refundDeposit(db, { deposit_id: acc.deposit.id }, CASH);
  assert.throws(() => refundDeposit(db, { deposit_id: acc.deposit.id }, CASH));
  assert.equal(cashOut(db), 100000, 'из кассы вышло 100 000 за депозит в 100 000, а не 200 000');
  db.close();
});

test('C1: оплатить счёт депозита нельзя никаким способом (и частями тоже)', () => {
  const { db, pid } = seed();
  const acc = acceptedDeposit(db, pid);
  refundDeposit(db, { deposit_id: acc.deposit.id, amount: 40000 }, CASH);   // счёт стал «частично»
  for (const method of ['cash', 'card', 'wallet']) {
    assert.throws(() => recordPayment(db, { invoice_id: acc.invoice.id, amount: 1000, method }, CASH), /Вернуть депозит|счёт депозита/i, method);
  }
  assert.throws(() => recordPaymentSplit(db, { invoice_id: acc.invoice.id, tenders: [{ method: 'cash', amount: 1000 }] }, CASH), /счёт депозита/i);
  const card = db.prepare("INSERT INTO patient_discounts (name, kind, amount) VALUES ('К', 'gift_card', 50000)").run().lastInsertRowid;
  assert.throws(() => recordPayment(db, { invoice_id: acc.invoice.id, amount: 1000, method: 'gift_card', card_id: card }, CASH), /счёт депозита/i);
  db.close();
});

// ─── I1 — баланс не подделать ни с клиента, ни в обход сервера ──────────────
test('I1: реестр не даёт клиенту ни вставлять, ни править, ни удалять строки баланса', () => {
  for (const op of ['insert', 'update']) assert.deepEqual(writableColumns('patient_deposits', op), [], op);
  const admin = { id: 1, role: 'admin' };
  assert.throws(() => compile({ table: 'patient_deposits', op: 'insert', values: { patient_id: 1, amount: 1e6, status: 'received' } }, admin));
  assert.throws(() => compile({ table: 'patient_deposits', op: 'update', values: { status: 'received' }, filters: [{ col: 'id', op: 'eq', val: 1 }] }, admin));
  assert.throws(() => compile({ table: 'patient_deposits', op: 'delete', filters: [{ col: 'id', op: 'eq', val: 1 }] }, admin));
});

test('I1: база сама отказывает — строки зачисления/списания не правятся и не удаляются, сумма принятого депозита не меняется', () => {
  const { db, pid, svc } = seed();
  const acc = acceptedDeposit(db, pid);
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 50000, method: 'wallet' }, CASH);
  recordPayment(db, { invoice_id: a.id, amount: 150000, method: 'cash' }, CASH);
  refundPayment(db, { payment_id: payOf(db, a.id).id + 1, amount: 10000, to_balance: true }, CASH);
  const spend = db.prepare("SELECT id FROM patient_deposits WHERE kind = 'spend'").get().id;
  const credit = db.prepare("SELECT id FROM patient_deposits WHERE kind = 'credit'").get().id;
  for (const id of [spend, credit]) {
    assert.throws(() => db.prepare('UPDATE patient_deposits SET amount = 1 WHERE id = ?').run(id), /журнал\S* баланса/i);
    assert.throws(() => db.prepare("UPDATE patient_deposits SET status = 'cancelled' WHERE id = ?").run(id), /журнал\S* баланса/i);
    assert.throws(() => db.prepare('DELETE FROM patient_deposits WHERE id = ?').run(id), /журнал\S* баланса/i);
  }
  assert.throws(() => db.prepare('UPDATE patient_deposits SET amount = 9e6 WHERE id = ?').run(acc.deposit.id), /журнал\S* баланса/i);
  assert.throws(() => db.prepare("UPDATE patient_deposits SET kind = 'credit' WHERE id = ?").run(acc.deposit.id), /журнал\S* баланса/i);
  assert.throws(() => db.prepare('DELETE FROM patient_deposits WHERE id = ?').run(acc.deposit.id), /журнал\S* баланса/i);
  // Штатные пути работают как прежде: возврат депозита правит свою строку.
  refundDeposit(db, { deposit_id: acc.deposit.id, amount: 10000 }, CASH);
  assert.equal(depositBalance(db, { patient_id: pid }, CASH).balance, 100000 - 50000 + 10000 - 10000);
  db.close();
});

// ─── I2 — номинал карты не создаёт денег ────────────────────────────────────
test('I2: правка номинала — остаток = номинал − потраченное; ниже потраченного — отказ, новых денег нет', () => {
  const { db, pid, svc } = seed();
  const card = db.prepare("INSERT INTO patient_discounts (name, kind, amount) VALUES ('К', 'gift_card', 300000)").run().lastInsertRowid;
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'gift_card', card_id: card }, CASH);
  const rem = () => db.prepare('SELECT remaining FROM patient_discounts WHERE id = ?').get(card).remaining;
  assert.throws(() => db.prepare('UPDATE patient_discounts SET amount = 100000 WHERE id = ?').run(card), /потрачено/);
  assert.equal(rem(), 100000, 'отказ ничего не изменил');
  db.prepare('UPDATE patient_discounts SET amount = 200000 WHERE id = ?').run(card);
  assert.equal(rem(), 0);
  db.prepare('UPDATE patient_discounts SET amount = 300000 WHERE id = ?').run(card);
  assert.equal(rem(), 100000, 'вернули номинал — вернулся ровно прежний остаток, не больше');
  assert.throws(() => db.prepare("UPDATE patient_discounts SET kind = 'promo' WHERE id = ?").run(card), /вид/);
  assert.throws(() => db.prepare("UPDATE patient_discounts SET kind = 'certificate' WHERE id = ?").run(card), /вид/);
  assert.throws(() => db.prepare("INSERT INTO patient_discounts (name, kind, amount) VALUES ('Минус', 'certificate', -5)").run(), /номинал/i);
  db.close();
});

// ─── I3 — карта на услуги платит за них один раз ────────────────────────────
test('I3: карта на услуги: повторные оплаты и две части одной оплаты не превышают её услуг в счёте', () => {
  const { db, pid, svc, lab } = seed();
  const card = db.prepare("INSERT INTO patient_discounts (name, kind, amount, service_ids) VALUES ('Анализы', 'certificate', 500000, ?)").run(JSON.stringify([lab])).lastInsertRowid;
  const a = billed(db, pid, [[svc, 200000], [lab, 100000]]);
  recordPayment(db, { invoice_id: a.id, amount: 50000, method: 'gift_card', card_id: card }, CASH);
  recordPayment(db, { invoice_id: a.id, amount: 50000, method: 'gift_card', card_id: card }, CASH);
  assert.throws(() => recordPayment(db, { invoice_id: a.id, amount: 50000, method: 'gift_card', card_id: card }, CASH), /не больше 0/);
  const b = billed(db, pid, [[svc, 200000], [lab, 100000]]);
  assert.throws(() => recordPaymentSplit(db, { invoice_id: b.id, tenders: [
    { method: 'gift_card', amount: 60000, card_id: card }, { method: 'gift_card', amount: 60000, card_id: card }] }, CASH), /не больше 40000/);
  // Возврат оплаты картой снова открывает её услуги.
  refundPayment(db, { payment_id: payOf(db, a.id).id }, CASH);
  recordPayment(db, { invoice_id: a.id, amount: 50000, method: 'gift_card', card_id: card }, CASH);
  db.close();
});

// I4 (кэшбэк) — см. cashback.test.js: начисление перенесено в оплату (ре-ревью).

// ─── M2 — сумма частей «с баланса» проверяется заранее ──────────────────────
test('M2: две части «с баланса» больше баланса — отказ называет настоящий баланс', () => {
  const { db, pid, svc } = seed();
  acceptedDeposit(db, pid, 50000);
  const a = billed(db, pid, [[svc, 200000]]);
  assert.throws(() => recordPaymentSplit(db, { invoice_id: a.id, tenders: [
    { method: 'wallet', amount: 40000 }, { method: 'wallet', amount: 40000 }] }, CASH), /только 50000 — списать 80000/);
  db.close();
});
