// DEPOSIT_REFUND_V1 — возврат депозита из кассы.
//
// Депозит — чужие деньги на хранении, и пациент вправе забрать их обратно.
// Правила те же, что у приёма, только наоборот:
//   • возвращает КАССА и только принятый (received) депозит;
//   • наличный возврат выходит из ящика строкой cash_movements (kind='out'),
//     иначе смена не сойдётся на пересчёте;
//   • вернуть можно не больше, чем осталось на балансе: часть депозита могла
//     уже уйти в оплату услуг, и эти деньги клиника пациенту не должна.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createDeposit, acceptDeposit, refundDeposit, depositBalance, listDeposits } from './deposits.js';
import { openCashShift, cashShiftSummary } from './cashier.js';

const REG  = { id: 7, role: 'registrar', full_name: 'Каримова' };
const CASH = { id: 9, role: 'cashier',  full_name: 'Юлдашева' };
const DOC  = { id: 3, role: 'doctor',   full_name: 'Др. Азиза' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (7,'r','x','Каримова','registrar')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (9,'c','x','Юлдашева','cashier')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (3,'d','x','Др. Азиза','doctor')").run();
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Dilshod Dilshod', 1)").run().lastInsertRowid;
  return { db, pid };
}
// Принятый депозит на 750 000 наличными — ровно как в живой базе (DEP-26-00003).
function accepted(db, pid, amount = 750000, method = 'cash') {
  const { deposit } = createDeposit(db, { patient_id: pid, amount }, REG);
  return acceptDeposit(db, { deposit_id: deposit.id, method }, CASH).deposit;
}

test('касса возвращает депозит целиком: статус refunded, баланс обнуляется', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 1000000 }, CASH);
  const dep = accepted(db, pid);
  assert.equal(depositBalance(db, { patient_id: pid }, CASH).balance, 750000);

  const out = refundDeposit(db, { deposit_id: dep.id }, CASH).deposit;
  assert.equal(out.status, 'refunded');
  assert.equal(out.refund_amount, 750000);
  assert.ok(out.closed_at, 'проставлено время возврата');
  assert.equal(depositBalance(db, { patient_id: pid }, CASH).balance, 0);
  db.close();
});

test('наличный возврат выходит из ящика смены', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 1000000 }, CASH);
  const dep = accepted(db, pid);
  const before = cashShiftSummary(db, {}, CASH).expected_drawer;
  refundDeposit(db, { deposit_id: dep.id }, CASH);
  const after = cashShiftSummary(db, {}, CASH).expected_drawer;
  assert.equal(before - after, 750000, 'деньги ушли из ящика');
  // DEPOSIT_REVENUE_V1 — возврат оформляется ОТРИЦАТЕЛЬНЫМ платежом по счёту
  // депозита, а не строкой «изъято»: так он сам вычитается и из ящика, и из
  // выручки, и из итога смены — одним механизмом вместо трёх.
  const back = db.prepare('SELECT * FROM payments WHERE amount < 0 ORDER BY id DESC LIMIT 1').get();
  assert.ok(back, 'возврат записан платежом');
  assert.equal(back.amount, -750000);
  assert.equal(back.method, 'cash', 'вернули тем же способом, каким приняли');
  assert.match(back.notes, /Возврат депозита DEP-/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cash_movements").get().n, 0, 'ящик двигают платежи, не движения');
  db.close();
});

test('возврат по карте ящик не трогает', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 1000000 }, CASH);
  const dep = accepted(db, pid, 750000, 'card');
  const before = cashShiftSummary(db, {}, CASH).expected_drawer;
  refundDeposit(db, { deposit_id: dep.id }, CASH);
  assert.equal(cashShiftSummary(db, {}, CASH).expected_drawer, before, 'наличных не убавилось');
  assert.equal(depositBalance(db, { patient_id: pid }, CASH).balance, 0, 'а баланс закрыт');
  db.close();
});

test('частичный возврат: остаток остаётся на балансе', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 1000000 }, CASH);
  const dep = accepted(db, pid);
  const out = refundDeposit(db, { deposit_id: dep.id, amount: 250000 }, CASH).deposit;
  assert.equal(out.refund_amount, 250000);
  assert.equal(depositBalance(db, { patient_id: pid }, CASH).balance, 500000, '750 000 − 250 000');
  db.close();
});

test('нельзя вернуть больше, чем на балансе: часть уже потрачена на услуги', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 1000000 }, CASH);
  const dep = accepted(db, pid);
  // Пациент оплатил услуги с баланса — так это пишет мастер визита.
  db.prepare("INSERT INTO patient_deposits (patient_id, amount, status, notes) VALUES (?,?, 'spent', 'оплата услуг')")
    .run(pid, 600000);
  assert.equal(depositBalance(db, { patient_id: pid }, CASH).balance, 150000);

  assert.throws(() => refundDeposit(db, { deposit_id: dep.id, amount: 700000 }, CASH), /баланс|остат/i);
  assert.equal(depositBalance(db, { patient_id: pid }, CASH).balance, 150000, 'баланс не пострадал');

  const ok = refundDeposit(db, { deposit_id: dep.id, amount: 150000 }, CASH).deposit;
  assert.equal(ok.refund_amount, 150000);
  assert.equal(depositBalance(db, { patient_id: pid }, CASH).balance, 0);
  db.close();
});

test('дважды вернуть нельзя', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 1000000 }, CASH);
  const dep = accepted(db, pid);
  refundDeposit(db, { deposit_id: dep.id }, CASH);
  assert.throws(() => refundDeposit(db, { deposit_id: dep.id }, CASH), /refunded|возвращ/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE amount < 0').get().n, 1,
    'второго возврата не записано — деньги не ушли дважды');
  db.close();
});

test('не принятый депозит возвращать нечего', () => {
  const { db, pid } = seed();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 500000 }, REG);
  assert.throws(() => refundDeposit(db, { deposit_id: deposit.id }, CASH), /принят|received|pending/i);
  db.close();
});

test('роли: возвращает касса и админ, регистратура и врач — нет', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 1000000 }, CASH);
  const dep = accepted(db, pid);
  assert.throws(() => refundDeposit(db, { deposit_id: dep.id }, REG), /not allowed/);
  assert.throws(() => refundDeposit(db, { deposit_id: dep.id }, DOC), /not allowed/);
  db.close();
});

test('сумма возврата проверяется', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 1000000 }, CASH);
  const dep = accepted(db, pid);
  for (const bad of [0, -1, 'x', NaN]) {
    assert.throws(() => refundDeposit(db, { deposit_id: dep.id, amount: bad }, CASH), /amount|сумм/i, String(bad));
  }
  db.close();
});

test('касса видит и принятые депозиты, а не только ждущие', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 1000000 }, CASH);
  accepted(db, pid);
  createDeposit(db, { patient_id: pid, amount: 100000 }, REG);   // ещё один, ждёт

  const pending = listDeposits(db, {}, CASH).rows;
  assert.equal(pending.length, 1, 'по умолчанию — очередь на приём');

  const all = listDeposits(db, { status: 'all' }, CASH).rows;
  assert.equal(all.length, 2, 'принятый никуда не пропадает');
  assert.ok(all.some((d) => d.status === 'received'), 'и виден со статусом received');
  db.close();
});

// DEPOSIT_REVENUE_V1 — депозиты, принятые ДО перехода на счета, тоже надо уметь
// вернуть. У них нет invoice_id, а деньги вошли в ящик строкой cash_movements:
// возврат обязан выйти тем же путём, иначе касса не сойдётся на пересчёте.
test('старый депозит без счёта возвращается через ящик', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 1000000 }, CASH);
  const dep = accepted(db, pid);
  // Приводим строку к «доперёходному» виду: счёта нет, деньги лежат движением.
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(dep.invoice_id);
  db.prepare('DELETE FROM payments WHERE invoice_id = ?').run(inv.id);
  db.prepare('UPDATE patient_deposits SET invoice_id = NULL WHERE id = ?').run(dep.id);
  db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(inv.id);
  db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id);
  const shift = db.prepare("SELECT id FROM cash_shifts WHERE status='open' LIMIT 1").get();
  db.prepare("INSERT INTO cash_movements (shift_id, kind, amount, article, created_by) VALUES (?,'in',?,?,?)")
    .run(shift.id, 750000, 'Депозит ' + dep.deposit_number, CASH.id);

  const before = cashShiftSummary(db, {}, CASH).expected_drawer;
  refundDeposit(db, { deposit_id: dep.id }, CASH);
  const after = cashShiftSummary(db, {}, CASH).expected_drawer;
  assert.equal(before - after, 750000, 'деньги ушли из ящика и по старым депозитам');
  assert.equal(depositBalance(db, { patient_id: pid }, CASH).balance, 0);
  db.close();
});
