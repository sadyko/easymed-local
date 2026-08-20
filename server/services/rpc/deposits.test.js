// DEPOSIT_V1 — регистратура заводит депозит, касса принимает.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createDeposit, acceptDeposit, cancelDeposit, listDeposits, depositBalance } from './deposits.js';
import { openCashShift, cashShiftSummary } from './cashier.js';

const REG = { id: 7, role: 'registrar', full_name: 'Каримова Шахзода' };
const CASH = { id: 9, role: 'cashier', full_name: 'Юлдашева Д.' };
const DOC = { id: 3, role: 'doctor', full_name: 'Др. Азиза' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (7,'r','x','Каримова Шахзода','registrar')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'c','x','Юлдашева Д.','cashier')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (3,'d','x','Др. Азиза','doctor')").run();
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Пациент', 1)").run().lastInsertRowid;
  return { db, pid };
}

test('регистратура заводит депозит: pending, свой номер DEP-…', () => {
  const { db, pid } = seed();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 500000, method: 'cash' }, REG);
  assert.equal(deposit.status, 'pending');
  assert.equal(deposit.amount, 500000);
  assert.match(deposit.deposit_number, /^DEP-\d{2}-\d{5}$/);
  assert.equal(deposit.created_by, REG.id);
  assert.equal(deposit.created_by_name, 'Каримова Шахзода');
});

test('номера идут подряд и не переиспользуются', () => {
  const { db, pid } = seed();
  const a = createDeposit(db, { patient_id: pid, amount: 1000 }, REG).deposit;
  const b = createDeposit(db, { patient_id: pid, amount: 2000 }, REG).deposit;
  const seq = (n) => Number(n.slice(-5));
  assert.equal(seq(b.deposit_number), seq(a.deposit_number) + 1);
  db.prepare('DELETE FROM patient_deposits WHERE id = ?').run(b.id);
  const c = createDeposit(db, { patient_id: pid, amount: 3000 }, REG).deposit;
  assert.equal(seq(c.deposit_number), seq(b.deposit_number) + 1, 'удаление не возвращает номер в оборот');
});

test('до приёма кассой баланс не растёт', () => {
  const { db, pid } = seed();
  createDeposit(db, { patient_id: pid, amount: 500000 }, REG);
  assert.equal(depositBalance(db, { patient_id: pid }, REG).balance, 0, 'денег ещё не взяли');
});

test('касса принимает: received, кто и когда, баланс появился', () => {
  const { db, pid } = seed();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 500000 }, REG);
  openCashShift(db, { opening_float: 0 }, CASH);
  const out = acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH).deposit;
  assert.equal(out.status, 'received');
  assert.equal(out.received_by, CASH.id);
  assert.equal(out.received_by_name, 'Юлдашева Д.');
  assert.ok(out.received_at, 'проставлено время приёма');
  assert.equal(depositBalance(db, { patient_id: pid }, CASH).balance, 500000);
});

test('наличный депозит попадает в ящик смены', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 100000 }, CASH);
  const before = cashShiftSummary(db, {}, CASH).expected_drawer;
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 500000, method: 'cash' }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  const after = cashShiftSummary(db, {}, CASH).expected_drawer;
  assert.equal(after - before, 500000, 'смена обязана объяснить наличные в ящике');
});

test('карта в наличный ящик не попадает', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 100000 }, CASH);
  const before = cashShiftSummary(db, {}, CASH).expected_drawer;
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 500000, method: 'card' }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'card' }, CASH);
  assert.equal(cashShiftSummary(db, {}, CASH).expected_drawer, before, 'наличных не прибавилось');
  assert.equal(depositBalance(db, { patient_id: pid }, CASH).balance, 500000, 'а баланс есть');
});

// DEPOSIT_REVENUE_V1 — правило ПЕРЕВЁРНУТО сознательно.
//
// Раньше здесь утверждалось обратное: приём депозита не создавал ни счёта, ни
// платежа, а выручкой предоплата становилась позже — когда баланс уходил в
// оплату услуг. Клиника решила считать доход в момент, когда деньги ВЗЯЛИ,
// поэтому приём теперь выписывает настоящий счёт и платёж. Двойного счёта не
// возникает: трата баланса проводится способом «кошелёк», а он исключён из
// выручки и из итога смены (shared/payment-methods.js).
test('принятый депозит становится выручкой: ровно один счёт и один платёж', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 0 }, CASH);
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 500000 }, REG);
  const out = acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 1);

  const inv = db.prepare('SELECT * FROM invoices').get();
  assert.equal(inv.invoice_number, deposit.deposit_number, 'номер счёта = номер депозита');
  assert.equal(inv.total_amount, 500000);
  assert.equal(inv.paid_amount, 500000);
  assert.equal(inv.status, 'paid');
  assert.equal(inv.visit_id, null, 'депозит не привязан к визиту — это не оплата услуг');
  assert.equal(out.deposit.invoice_id, inv.id, 'связь депозита со счётом сохранена');

  const pay = db.prepare('SELECT * FROM payments').get();
  assert.equal(pay.amount, 500000);
  assert.equal(pay.method, 'cash');
  assert.ok(pay.shift_id, 'платёж попал в смену — иначе его не будет в X-отчёте');

  // Строку «внесено» в ящик больше не пишем: платёж уже учтён в остатке кассы,
  // а две записи положили бы одни деньги в ящик дважды.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cash_movements').get().n, 0);
});

test('дважды принять нельзя', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 0 }, CASH);
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 1000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  assert.throws(() => acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH), /already received/);
  // DEPOSIT_REVENUE_V1 — деньги учитываются платежом, поэтому и проверяем его:
  // второго счёта и второго платежа быть не должно.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 1, 'второго платежа нет');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 1, 'и второго счёта тоже');
});

test('отменить можно только не принятый', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 0 }, CASH);
  const a = createDeposit(db, { patient_id: pid, amount: 1000 }, REG).deposit;
  assert.equal(cancelDeposit(db, { deposit_id: a.id }, REG).deposit.status, 'cancelled');
  const b = createDeposit(db, { patient_id: pid, amount: 1000 }, REG).deposit;
  acceptDeposit(db, { deposit_id: b.id, method: 'cash' }, CASH);
  assert.throws(() => cancelDeposit(db, { deposit_id: b.id }, CASH), /only for pending/);
});

test('роли: врач не заводит и не принимает; регистратор не принимает', () => {
  const { db, pid } = seed();
  assert.throws(() => createDeposit(db, { patient_id: pid, amount: 1000 }, DOC), /not allowed/);
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 1000 }, REG);
  assert.throws(() => acceptDeposit(db, { deposit_id: deposit.id }, REG), /not allowed/);
  assert.throws(() => acceptDeposit(db, { deposit_id: deposit.id }, DOC), /not allowed/);
});

test('валидация суммы, способа и пациента', () => {
  const { db, pid } = seed();
  for (const bad of [0, -100, 'x', null, NaN]) {
    assert.throws(() => createDeposit(db, { patient_id: pid, amount: bad }, REG), /amount/);
  }
  assert.throws(() => createDeposit(db, { patient_id: 999999, amount: 100 }, REG), /patient not found/);
});

test('список для кассы показывает ждущих приёма', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 0 }, CASH);
  const a = createDeposit(db, { patient_id: pid, amount: 1000 }, REG).deposit;
  createDeposit(db, { patient_id: pid, amount: 2000 }, REG);
  acceptDeposit(db, { deposit_id: a.id, method: 'cash' }, CASH);
  const pending = listDeposits(db, {}, CASH).rows;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].amount, 2000);
  assert.equal(pending[0].patient_name, 'Пациент');
  assert.equal(listDeposits(db, { status: 'all' }, CASH).rows.length, 2);
});

// ---------------------------------------------------------------------------
// DEPOSIT_METHOD_BY_CASHIER_V1 — способ оплаты выбирает КАССА, не регистратура.
// ---------------------------------------------------------------------------
// Регистратура денег не берёт: она объявляет сумму и отправляет пациента в
// кассу. Чем он в итоге заплатит, знает только тот, кто принял деньги, —
// пациент передумывает у окошка. Поэтому в форме регистратуры выбора способа
// больше нет, а у неоплаченного депозита способа НЕТ ВООБЩЕ (NULL), а не
// «Наличные» по умолчанию: список кассы иначе обещал бы наличные, которых
// никто не обещал.
test('регистратура не задаёт способ — до приёма его нет', () => {
  const { db, pid } = seed();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 5000 }, REG);
  assert.equal(deposit.method, null, 'способ появляется только при приёме кассой');
  assert.equal(deposit.status, 'pending');
});

// Старый клиент (или чужой вызов) не должен протащить способ мимо кассы.
test('способ, присланный при создании, игнорируется', () => {
  const { db, pid } = seed();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 5000, method: 'card' }, REG);
  assert.equal(deposit.method, null);
});

test('касса принимает выбранным способом', () => {
  for (const m of ['cash', 'card', 'acquiring']) {
    const { db, pid } = seed();
    openCashShift(db, { opening_float: 0 }, CASH);
    const d = createDeposit(db, { patient_id: pid, amount: 3000 }, REG).deposit;
    const got = acceptDeposit(db, { deposit_id: d.id, method: m }, CASH).deposit;
    assert.equal(got.method, m, m);
    assert.equal(got.status, 'received');
    db.close();
  }
});

// Три способа — ровно те, что берёт касса. «Перевод» убран: депозит вносят у
// окошка, а не переводом, и лишняя строка в списке кассира — это выбор,
// который потом придётся объяснять в сверке.
test('способов ровно три: наличные, карта, эквайринг', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 0 }, CASH);
  const d = createDeposit(db, { patient_id: pid, amount: 3000 }, REG).deposit;
  assert.throws(() => acceptDeposit(db, { deposit_id: d.id, method: 'transfer' }, CASH), /unknown method/);
  assert.throws(() => acceptDeposit(db, { deposit_id: d.id, method: 'bitcoin' }, CASH), /unknown method/);
});

// Без способа принять нельзя: иначе «Принять» одним щелчком снова записал бы
// наличные, и ящик разошёлся бы с тем, что кассир действительно взял.
test('принять без способа нельзя', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 0 }, CASH);
  const d = createDeposit(db, { patient_id: pid, amount: 3000 }, REG).deposit;
  assert.throws(() => acceptDeposit(db, { deposit_id: d.id }, CASH), /способ|method/i);
});

// Наличные меняют ящик, безнал — нет. Это уже проверено выше для старого
// поведения; здесь то же самое, но способ приходит от кассира.
test('карта, выбранная кассиром, в ящик не попадает', () => {
  const { db, pid } = seed();
  openCashShift(db, { opening_float: 0 }, CASH);
  const d = createDeposit(db, { patient_id: pid, amount: 7000 }, REG).deposit;
  acceptDeposit(db, { deposit_id: d.id, method: 'card' }, CASH);
  assert.equal(cashShiftSummary(db, {}, CASH).totals.cash, 0);
});
