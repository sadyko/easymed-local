// CARD_BALANCE_V1 — подарочные карты и сертификаты с остатком.
//
// Владелец: «amount should be set». Карта платит своим остатком (способ
// 'gift_card'), остаток уменьшается и возвращается при возврате; пустая карта
// отказывает по-русски. Всё — через настоящие RPC и SQLite после миграций.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment, recordPaymentSplit, refundPayment } from './billing.js';
import { openCashShift, cashShiftSummary, voidInvoice } from './cashier.js';
import { dashboardSummary } from './dashboard.js';
import { cashierReport } from './cashier-report.js';

const ADMIN = { id: 1, role: 'admin', full_name: 'Админ' };
const REG   = { id: 7, role: 'registrar', full_name: 'Каримова' };
const CASH  = { id: 9, role: 'cashier', full_name: 'Юлдашева' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (1,'a','x','Админ','admin')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (7,'r','x','Каримова','registrar')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (9,'c','x','Юлдашева','cashier')").run();
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Dilshod', 1)").run().lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Кардиолог', 200000)").run().lastInsertRowid;
  const lab = db.prepare("INSERT INTO services (name, price) VALUES ('Анализ', 50000)").run().lastInsertRowid;
  // Карту заводит админ обычной строкой настроек — остаток рождается триггером.
  const card = db.prepare("INSERT INTO patient_discounts (name, kind, amount) VALUES ('Подарок-500', 'gift_card', 300000)").run().lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, CASH);
  return { db, pid, svc, lab, card };
}
function billed(db, pid, lines) {
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const ids = lines.map(([sid, price]) => db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,?,?,'added')")
    .run(vid, sid, price, price).lastInsertRowid);
  return createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, REG).invoice;
}
const remaining = (db, id) => db.prepare('SELECT remaining FROM patient_discounts WHERE id = ?').get(id).remaining;
const today = (db) => db.prepare("SELECT date('now','localtime') d").get().d;

test('номинал задан — остаток уменьшается с каждой оплатой, а не снимается целиком с каждого визита', () => {
  const { db, pid, svc, card } = seed();
  assert.equal(remaining(db, card), 300000, 'новая карта — полный номинал');
  const a = billed(db, pid, [[svc, 200000]]);
  const r = recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'gift_card', card_id: card }, CASH);
  assert.equal(r.invoice.status, 'paid');
  assert.equal(remaining(db, card), 100000);
  const b = billed(db, pid, [[svc, 200000]]);
  assert.throws(() => recordPayment(db, { invoice_id: b.id, amount: 200000, method: 'gift_card', card_id: card }, CASH),
    /на карте осталось 100000/);
  // Остаток + наличные — одной оплатой частями.
  recordPaymentSplit(db, { invoice_id: b.id, tenders: [
    { method: 'gift_card', amount: 100000, card_id: card }, { method: 'cash', amount: 100000 }] }, CASH);
  assert.equal(remaining(db, card), 0);
  const ledger = db.prepare('SELECT amount FROM card_ledger WHERE discount_id = ? ORDER BY id').all(card).map((x) => x.amount);
  assert.deepEqual(ledger, [-200000, -100000]);
  db.close();
});

test('пустая карта отказывает по-русски; выключенная, истёкшая и чужой группы — тоже', () => {
  const { db, pid, svc, card } = seed();
  db.prepare('UPDATE patient_discounts SET remaining = 0 WHERE id = ?').run(card);
  const a = billed(db, pid, [[svc, 200000]]);
  assert.throws(() => recordPayment(db, { invoice_id: a.id, amount: 1000, method: 'gift_card', card_id: card }, CASH), /остаток 0 — карта исчерпана/);
  const off = db.prepare("INSERT INTO patient_discounts (name, kind, amount, active) VALUES ('Выкл', 'certificate', 100000, 0)").run().lastInsertRowid;
  assert.throws(() => recordPayment(db, { invoice_id: a.id, amount: 1000, method: 'gift_card', card_id: off }, CASH), /Сертификат «Выкл»: использование выключено/);
  const old = db.prepare("INSERT INTO patient_discounts (name, kind, amount, valid_until) VALUES ('Старая', 'gift_card', 100000, '2020-01-01')").run().lastInsertRowid;
  assert.throws(() => recordPayment(db, { invoice_id: a.id, amount: 1000, method: 'gift_card', card_id: old }, CASH), /срок истёк 01\.01\.2020/);
  const cat = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 0, 1)").run().lastInsertRowid;
  const vip = db.prepare("INSERT INTO patient_discounts (name, kind, amount, category_id) VALUES ('VIP', 'gift_card', 100000, ?)").run(cat).lastInsertRowid;
  assert.throws(() => recordPayment(db, { invoice_id: a.id, amount: 1000, method: 'gift_card', card_id: vip }, CASH), /другой группы/);
  const promo = db.prepare("INSERT INTO patient_discounts (name, kind, percent) VALUES ('Акция', 'promo', 10)").run().lastInsertRowid;
  assert.throws(() => recordPayment(db, { invoice_id: a.id, amount: 1000, method: 'gift_card', card_id: promo }, CASH), /не найдены/);
  assert.throws(() => recordPayment(db, { invoice_id: a.id, amount: 1000, method: 'gift_card' }, CASH), /Выберите карту/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 0, 'ни одного платежа');
  db.close();
});

test('карта на отдельные услуги платит только за них', () => {
  const { db, pid, svc, lab } = seed();
  const labCard = db.prepare("INSERT INTO patient_discounts (name, kind, amount, service_ids) VALUES ('Анализы', 'certificate', 500000, ?)").run(JSON.stringify([lab])).lastInsertRowid;
  const a = billed(db, pid, [[svc, 200000], [lab, 50000]]);
  assert.throws(() => recordPayment(db, { invoice_id: a.id, amount: 100000, method: 'gift_card', card_id: labCard }, CASH), /не больше 50000/);
  recordPayment(db, { invoice_id: a.id, amount: 50000, method: 'gift_card', card_id: labCard }, CASH);
  assert.equal(remaining(db, labCard), 450000);
  const b = billed(db, pid, [[svc, 200000]]);
  assert.throws(() => recordPayment(db, { invoice_id: b.id, amount: 1000, method: 'gift_card', card_id: labCard }, CASH), /в этом счёте их нет/);
  db.close();
});

test('возврат и отмена счёта, оплаченного картой: остаток вернулся на ту же карту, наличные не выдаются', () => {
  const { db, pid, svc, card } = seed();
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'gift_card', card_id: card }, CASH);
  const pay = db.prepare('SELECT * FROM payments WHERE amount > 0').get();
  const drawer = cashShiftSummary(db, {}, CASH).expected_drawer;
  const r = refundPayment(db, { payment_id: pay.id, to_balance: false, void_when_zero: false }, CASH);   // B2: отмена ниже — отдельным шагом
  assert.equal(r.to_card.card_id, card);
  assert.equal(remaining(db, card), 300000);
  assert.equal(cashShiftSummary(db, {}, CASH).expected_drawer, drawer, 'наличные из ящика не вышли');
  assert.equal(db.prepare('SELECT method FROM payments WHERE amount < 0').get().method, 'gift_card');
  voidInvoice(db, { invoice_id: a.id }, CASH);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(a.id).status, 'void');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patient_deposits").get().n, 0, 'на баланс пациента карта не переезжает');
  db.close();
});

test('погашение картой — не приход: смена, «собрано сегодня» и «Отчёт кассира» его не считают', () => {
  const { db, pid, svc, card } = seed();
  const a = billed(db, pid, [[svc, 200000]]);
  recordPaymentSplit(db, { invoice_id: a.id, tenders: [
    { method: 'gift_card', amount: 150000, card_id: card }, { method: 'cash', amount: 50000 }] }, CASH);
  const s = cashShiftSummary(db, {}, CASH);
  assert.equal(s.totals.gift_card, 150000, 'кассир видит погашение отдельной строкой');
  assert.equal(s.totals.total, 50000);
  assert.equal(s.expected_drawer, 50000);
  assert.equal(dashboardSummary(db, {}, CASH).collected_today, 50000);
  assert.equal(cashierReport(db, { from: today(db), to: today(db) }, ADMIN).kpi.income, 50000);
  db.close();
});

test('правка номинала в настройках: остаток = номинал − потраченное; вид карты с оплатами не меняется; минус запрещён базой', () => {
  const { db, pid, svc, card } = seed();
  const a = billed(db, pid, [[svc, 200000]]);
  recordPayment(db, { invoice_id: a.id, amount: 200000, method: 'gift_card', card_id: card }, CASH);
  db.prepare('UPDATE patient_discounts SET amount = 400000 WHERE id = ?').run(card);
  assert.equal(remaining(db, card), 200000, 'потраченное не вернулось и не потерялось');
  db.prepare('UPDATE patient_discounts SET name = ? WHERE id = ?').run('Новое имя', card);
  assert.equal(remaining(db, card), 200000, 'правка имени остаток не трогает');
  assert.throws(() => db.prepare('UPDATE patient_discounts SET remaining = -1 WHERE id = ?').run(card), /CHECK/);
  // Ревью I2 — у карты с оплатами вид не меняется; у нетронутой — меняется, остатка нет.
  assert.throws(() => db.prepare("UPDATE patient_discounts SET kind = 'promo' WHERE id = ?").run(card), /вид/);
  const fresh = db.prepare("INSERT INTO patient_discounts (name, kind, amount) VALUES ('Новая', 'gift_card', 1000)").run().lastInsertRowid;
  db.prepare("UPDATE patient_discounts SET kind = 'promo' WHERE id = ?").run(fresh);
  assert.equal(remaining(db, fresh), null);
  db.close();
});

test('права: картой платит только касса и админ', () => {
  const { db, pid, svc, card } = seed();
  const a = billed(db, pid, [[svc, 200000]]);
  assert.throws(() => recordPayment(db, { invoice_id: a.id, amount: 1000, method: 'gift_card', card_id: card }, REG), (e) => e.status === 403);
  recordPayment(db, { invoice_id: a.id, amount: 1000, method: 'gift_card', card_id: card }, ADMIN);
  assert.equal(remaining(db, card), 299000);
  db.close();
});
