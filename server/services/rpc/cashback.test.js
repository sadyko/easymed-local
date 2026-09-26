// CASHBACK_SERVER_V2 (ре-ревью денег, 2026-09-26) — кэшбэк начисляет ОПЛАТА.
//
// Первый серверный вариант был отдельной дверью credit_cashback, которую звал
// экран: её можно было звать повторно после отката, и касса (оплата частями,
// окно кассы) её не звала вовсе. Теперь кэшбэк начисляется внутри
// record_payment / record_payment_split в ту же транзакцию, в момент, когда
// счёт становится оплаченным, — не больше одного раза за всю жизнь счёта.
// Плюс остальное из ре-ревью: процент правила 0..100, строки журнала баланса
// вставляет только сервер, карты на одни услуги делят один потолок, отмена
// счёта после полного возврата на баланс — в той же транзакции, фото без «%».

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createDeposit, acceptDeposit, depositBalance } from './deposits.js';
import { createInvoiceForVisit, recordPayment, recordPaymentSplit, refundPayment } from './billing.js';
import { openCashShift } from './cashier.js';
import { updateMyDoctorProfile } from './doctor-profile.js';
import { getRpc } from './index.js';

const REG  = { id: 7, role: 'registrar', full_name: 'Каримова' };
const CASH = { id: 9, role: 'cashier', full_name: 'Юлдашева' };

function seed({ percent = 5 } = {}) {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (7,'r','x','Каримова','registrar')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (9,'c','x','Юлдашева','cashier')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role,is_doctor) VALUES (2,'d','x','Врач','doctor',1)").run();
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Dilshod', 1)").run().lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Кардиолог', 200000)").run().lastInsertRowid;
  const lab = db.prepare("INSERT INTO services (name, price) VALUES ('Анализ', 100000)").run().lastInsertRowid;
  if (percent) db.prepare("INSERT INTO cashback_rules (name, percent, active) VALUES ('Кэшбэк', ?, 1)").run(percent);
  openCashShift(db, { opening_float: 1000000 }, CASH);
  return { db, pid, svc, lab };
}
function billed(db, pid, lines) {
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const ids = lines.map(([sid, price]) => db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,?,?,'added')")
    .run(vid, sid, price, price).lastInsertRowid);
  return createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, REG).invoice;
}
const bal = (db, pid) => depositBalance(db, { patient_id: pid }, CASH).balance;
const cashbackRows = (db) => db.prepare("SELECT * FROM patient_deposits WHERE kind = 'cashback' ORDER BY id").all();
const pay = (db, invoiceId, method) => db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND method = ? AND amount > 0 ORDER BY id').get(invoiceId, method).id;

test('кэшбэк начисляет сама оплата, когда счёт стал оплаченным — любая касса, частями тоже; двери credit_cashback нет', () => {
  const { db, pid, svc } = seed();
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 100000, method: 'cash' }, CASH);
  assert.equal(cashbackRows(db).length, 0, 'счёт ещё не оплачен');
  recordPayment(db, { invoice_id: a.id, amount: 100000, method: 'card' }, CASH);
  assert.equal(bal(db, pid), 10000, '5 % с 200 000');
  const b = billed(db, pid, [[svc, 200000]]);
  recordPaymentSplit(db, { invoice_id: b.id, tenders: [{ method: 'cash', amount: 50000 }, { method: 'acquiring', amount: 150000 }] }, CASH);
  assert.equal(cashbackRows(db).length, 2);
  assert.equal(cashbackRows(db)[1].amount, 10000);
  assert.equal(cashbackRows(db)[1].invoice_id, b.id);
  assert.ok(!getRpc('credit_cashback'), 'повторно звать нечего');
  db.close();
});

test('база — только новые деньги: баланс и карта кэшбэка не дают', () => {
  const { db, pid, svc } = seed();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 100000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  const card = db.prepare("INSERT INTO patient_discounts (name, kind, amount) VALUES ('К', 'gift_card', 50000)").run().lastInsertRowid;
  const a = billed(db, pid, [[svc, 200000]]);
  recordPaymentSplit(db, { invoice_id: a.id, tenders: [
    { method: 'wallet', amount: 100000 }, { method: 'gift_card', amount: 50000, card_id: card }, { method: 'cash', amount: 50000 }] }, CASH);
  assert.equal(cashbackRows(db)[0].amount, 2500);
  db.close();
});

test('один раз за жизнь счёта: полный возврат откатывает кэшбэк, повторная оплата его уже не даёт (не накрутить)', () => {
  const { db, pid, svc } = seed();
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'cash' }, CASH);
  assert.equal(bal(db, pid), 10000);
  refundPayment(db, { payment_id: pay(db, a.id, 'cash') }, CASH);
  assert.equal(bal(db, pid), 0, 'откат');
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'cash' }, CASH);
  assert.equal(cashbackRows(db).length, 1, 'второго кэшбэка нет');
  assert.equal(bal(db, pid), 0);
  db.close();
});

test('откат пропорционален возврату', () => {
  const { db, pid, svc } = seed({ percent: 10 });
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'cash' }, CASH);
  assert.equal(bal(db, pid), 20000);
  refundPayment(db, { payment_id: pay(db, a.id, 'cash'), amount: 50000 }, CASH);
  assert.equal(bal(db, pid), 15000, 'вернули четверть — откатили четверть');
  // Пациент потратил остаток кэшбэка; следующий возврат снимает сколько есть.
  const b = billed(db, pid, [[svc, 200000]]);
  recordPaymentSplit(db, { invoice_id: b.id, tenders: [{ method: 'wallet', amount: 15000 }, { method: 'cash', amount: 185000 }] }, CASH);
  const afterB = bal(db, pid);   // кэшбэк за b: 10 % с 185 000
  assert.equal(afterB, 18500);
  refundPayment(db, { payment_id: pay(db, a.id, 'cash'), amount: 150000 }, CASH);
  const cbA = cashbackRows(db)[0];
  assert.equal(cbA.status, 'refunded');
  assert.equal(cbA.refund_amount, 20000, 'весь кэшбэк за a снят (баланса хватило)');
  assert.equal(bal(db, pid), 18500 - 15000);
  db.close();
});

test('процент правила кэшбэка — от 0 до 100; больше — отказ базы', () => {
  const { db } = seed({ percent: 0 });
  assert.throws(() => db.prepare("INSERT INTO cashback_rules (name, percent, active) VALUES ('x', 150, 1)").run(), /от 0 до 100/);
  assert.throws(() => db.prepare("INSERT INTO cashback_rules (name, percent, active) VALUES ('x', -1, 1)").run(), /от 0 до 100/);
  const id = db.prepare("INSERT INTO cashback_rules (name, percent, active) VALUES ('ok', 100, 1)").run().lastInsertRowid;
  assert.throws(() => db.prepare('UPDATE cashback_rules SET percent = 101 WHERE id = ?').run(id), /от 0 до 100/);
  db.close();
});

test('строки баланса с деньгами вставляет только сервер; refund_amount в пределах суммы; «принят» — только кассой', () => {
  const { db, pid } = seed();
  for (const [kind, status] of [['credit', 'received'], ['spend', 'spent'], ['cashback', 'received'], ['deposit', 'received']]) {
    assert.throws(() => db.prepare('INSERT INTO patient_deposits (patient_id, amount, status, kind) VALUES (?, 1000, ?, ?)').run(pid, status, kind), /только сервер/, kind);
  }
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 100000 }, REG);
  assert.throws(() => db.prepare("UPDATE patient_deposits SET status = 'received' WHERE id = ?").run(deposit.id), /только сервер/);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  assert.throws(() => db.prepare("UPDATE patient_deposits SET status = 'refunded', refund_amount = 200000 WHERE id = ?").run(deposit.id), /refund_amount|возвращено/i);
  assert.throws(() => db.prepare("UPDATE patient_deposits SET status = 'refunded', refund_amount = -5 WHERE id = ?").run(deposit.id), /refund_amount|возвращено/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_write_token').get().n, 0, 'разрешение сервера не остаётся висеть');
  db.close();
});

test('две карты на одни и те же услуги делят один потолок в счёте', () => {
  const { db, pid, svc, lab } = seed({ percent: 0 });
  const c1 = db.prepare("INSERT INTO patient_discounts (name, kind, amount, service_ids) VALUES ('А1', 'certificate', 500000, ?)").run(JSON.stringify([lab])).lastInsertRowid;
  const c2 = db.prepare("INSERT INTO patient_discounts (name, kind, amount, service_ids) VALUES ('А2', 'certificate', 500000, ?)").run(JSON.stringify([lab])).lastInsertRowid;
  const a = billed(db, pid, [[svc, 200000], [lab, 100000]]);
  recordPayment(db, { invoice_id: a.id, amount: 100000, method: 'gift_card', card_id: c1 }, CASH);
  assert.throws(() => recordPayment(db, { invoice_id: a.id, amount: 1000, method: 'gift_card', card_id: c2 }, CASH), /не больше 0/);
  db.close();
});

test('возврат на баланс с void_when_zero: счёт отменён той же транзакцией; пациент в койке — не отменён, кассиру сказано', () => {
  const { db, pid, svc } = seed({ percent: 0 });
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'cash' }, CASH);
  const r = refundPayment(db, { payment_id: pay(db, a.id, 'cash'), to_balance: true, void_when_zero: true, keep_services: false }, CASH);
  assert.equal(r.invoice.status, 'void');
  assert.equal(r.voided, true);
  assert.equal(bal(db, pid), 200000);

  // Счёт стационара, пациент ещё в койке.
  const adm = db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'admitted')").run(pid).lastInsertRowid;
  const inv = db.prepare("INSERT INTO invoices (invoice_number, patient_id, admission_id, subtotal, discount_amount, total_amount, paid_amount, status) VALUES ('INV-A-26-09999', ?, ?, 100000, 0, 100000, 0, 'unpaid')").run(pid, adm).lastInsertRowid;
  recordPayment(db, { invoice_id: inv, amount: 100000, method: 'cash' }, CASH);
  const r2 = refundPayment(db, { payment_id: pay(db, inv, 'cash'), to_balance: true, void_when_zero: true }, CASH);
  assert.equal(r2.voided, false);
  assert.match(r2.void_note, /в стационаре/);
  assert.notEqual(r2.invoice.status, 'void');
  assert.equal(bal(db, pid), 300000, 'возврат на баланс всё равно проведён');
  db.close();
});

test('фото врача: закодированный выход из папки («%2e%2e») — отказ', () => {
  const { db } = seed({ percent: 0 });
  for (const bad of ['/api/storage/doctor-photos/%2e%2e/patient-photos/1.jpg', '/api/storage/doctor-photos/a%2Fb.jpg']) {
    assert.throws(() => updateMyDoctorProfile(db, { p: { photo_url: bad } }, { id: 2, role: 'doctor' }), (e) => e.status === 400, bad);
  }
  db.close();
});

// ─── Третья проверка денег (2026-09-27) ─────────────────────────────────────
import { withLedgerToken, walletBalance } from '../domain/wallet.js';
import { refundDeposit } from './deposits.js';

test('I1: кэшбэк не начисляется задним числом через «вернуть 1, оплатить 1» — счёт оценивается один раз, когда впервые оплачен', () => {
  const { db, pid, svc } = seed({ percent: 0 });
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'cash' }, CASH);   // правила нет
  assert.ok(db.prepare('SELECT cashback_evaluated_at FROM invoices WHERE id = ?').get(a.id).cashback_evaluated_at, 'оценён при первой оплате');
  db.prepare("INSERT INTO cashback_rules (name, percent, active) VALUES ('5%', 5, 1)").run();
  refundPayment(db, { payment_id: pay(db, a.id, 'cash'), amount: 1 }, CASH);
  recordPayment(db, { invoice_id: a.id, amount: 1, method: 'cash' }, CASH);
  assert.equal(cashbackRows(db).length, 0, 'старый оплаченный счёт кэшбэк не получает');
  db.close();
});

test('I2: кэшбэк не выводится наличными — возврат оплаты с баланса деньгами ограничен настоящими деньгами на балансе', () => {
  const { db, pid, svc } = seed({ percent: 5 });
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'cash' }, CASH);   // кэшбэк 10 000
  const b = billed(db, pid, [[svc, 200000]]);
  recordPaymentSplit(db, { invoice_id: b.id, tenders: [{ method: 'wallet', amount: 10000 }, { method: 'cash', amount: 190000 }] }, CASH);
  const wpay = pay(db, b.id, 'wallet');
  assert.throws(() => refundPayment(db, { payment_id: wpay, to_balance: false }, CASH), /кэшбэк|только на баланс/i);
  refundPayment(db, { payment_id: wpay }, CASH);   // на баланс — можно
  // Настоящие деньги (депозит) выводятся, как прежде.
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 50000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  const c = billed(db, pid, [[svc, 200000]]);
  recordPaymentSplit(db, { invoice_id: c.id, tenders: [{ method: 'wallet', amount: 60000 }, { method: 'cash', amount: 140000 }] }, CASH);
  const w2 = pay(db, c.id, 'wallet');
  assert.throws(() => refundPayment(db, { payment_id: w2, to_balance: false }, CASH), /50000/, 'из 60 000 деньгами — только 50 000 депозита');
  refundPayment(db, { payment_id: w2, amount: 50000, to_balance: false }, CASH);
  db.close();
});

test('I3: откат кэшбэка всегда полный — долг баланса не прощается и закрывается будущими зачислениями', () => {
  const { db, pid, svc } = seed({ percent: 5 });
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'cash' }, CASH);   // кэшбэк 10 000
  db.prepare('UPDATE cashback_rules SET active = 0').run();   // дальше кэшбэка нет — считаем только A
  const b = billed(db, pid, [[svc, 200000]]);
  recordPaymentSplit(db, { invoice_id: b.id, tenders: [{ method: 'wallet', amount: 10000 }, { method: 'cash', amount: 190000 }] }, CASH);
  refundPayment(db, { payment_id: pay(db, a.id, 'cash') }, CASH);   // весь A назад
  assert.equal(cashbackRows(db)[0].refund_amount, 10000, 'откачен целиком, хоть на балансе и 0');
  assert.equal(bal(db, pid), 0, 'показан 0, а не минус');
  assert.ok(walletBalance(db, pid) === 0);
  // Новый депозит сначала гасит долг: из 5 000 выдать назад нечего, потратить — тоже.
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 5000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  assert.equal(bal(db, pid), 0);
  assert.throws(() => refundDeposit(db, { deposit_id: deposit.id }, CASH), /только 0/);
  const c = billed(db, pid, [[svc, 200000]]);
  assert.throws(() => recordPayment(db, { invoice_id: c.id, amount: 1, method: 'wallet' }, CASH), /только 0/);
  refundPayment(db, { payment_id: pay(db, b.id, 'wallet') }, CASH);   // B-часть с баланса — на баланс
  assert.equal(bal(db, pid), 5000, 'долг 10 000 закрыт; на балансе ровно депозит, а не 15 000');
  db.close();
});

test('M1: начисление округляется вниз, откат — вверх', () => {
  const { db, pid, svc } = seed({ percent: 3 });
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 199999, method: 'cash' }, CASH);
  recordPayment(db, { invoice_id: a.id, amount: 1, method: 'card' }, CASH);
  // 3 % от 200 000 = 6000 ровно; проверим дробный случай отдельным счётом.
  const b = billed(db, pid, [[svc, 200000]]);
  db.prepare('UPDATE invoices SET total_amount = 33333, subtotal = 33333 WHERE id = ?').run(b.id);
  recordPayment(db, { invoice_id: b.id, amount: 33333, method: 'cash' }, CASH);
  const cb = cashbackRows(db).find((r) => r.invoice_id === b.id);
  assert.equal(cb.amount, 999, '3 % от 33 333 = 999,99 → 999');
  refundPayment(db, { payment_id: pay(db, b.id, 'cash'), amount: 1 }, CASH);
  assert.equal(db.prepare('SELECT refund_amount FROM patient_deposits WHERE id = ?').get(cb.id).refund_amount, 1, 'доля 0,03 → 1');
  db.close();
});

test('M2: статус и «возвращено» у строк с деньгами меняет только сервер; счёт кэшбэка не перевешивается', () => {
  const { db, pid, svc } = seed({ percent: 5 });
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'cash' }, CASH);
  const cb = cashbackRows(db)[0];
  assert.throws(() => db.prepare("UPDATE patient_deposits SET status = 'refunded', refund_amount = 10000 WHERE id = ?").run(cb.id), /только сервер/);
  assert.throws(() => db.prepare('UPDATE patient_deposits SET refund_amount = 5 WHERE id = ?').run(cb.id), /только сервер/);
  const b = billed(db, pid, [[svc, 200000]]);
  assert.throws(() => db.prepare('UPDATE patient_deposits SET invoice_id = ? WHERE id = ?').run(b.id, cb.id), /кэшбэк|счёт/i);
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 50000 }, REG);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  assert.throws(() => db.prepare("UPDATE patient_deposits SET status = 'refunded', refund_amount = 50000 WHERE id = ?").run(deposit.id), /только сервер/);
  refundDeposit(db, { deposit_id: deposit.id, amount: 10000 }, CASH);   // штатный путь работает
  db.close();
});

test('M3: разрешение на запись баланса — только внутри транзакции', () => {
  const { db } = seed({ percent: 0 });
  assert.throws(() => withLedgerToken(db, () => 1), /транзакц/);
  assert.equal(db.transaction(() => withLedgerToken(db, () => 2))(), 2);
  db.close();
});
