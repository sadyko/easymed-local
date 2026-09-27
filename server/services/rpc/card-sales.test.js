// CARD_SALE_V1 (владелец, 2026-09-27, B2) — продажа подарочной карты /
// сертификата в кассе — настоящая продажа.
//
// Кассир продаёт карту за номинал: счёт CARD-… со строкой «Подарочная карта …»
// и платёж наличными/картой/переводом/эквайрингом — это приход дня (касса,
// смена, дашборд, отчёт кассира). Погашение картой (способ gift_card) приходом
// не считается — одни деньги считаются один раз. Отчёты по строкам счетов
// (выручка по услугам, отчёт владельца) счёт продажи не считают — как DEP-;
// услугу, оплаченную картой, они считают как обычно. Возврат продажи — только
// неизрасходованный остаток, и он выключает карту. Всё — через настоящие RPC и
// SQLite после миграций.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment, recordPaymentSplit, refundPayment } from './billing.js';
import { openCashShift, cashShiftSummary, voidInvoice, shiftReport } from './cashier.js';
import { dashboardSummary } from './dashboard.js';
import { cashierReport } from './cashier-report.js';
import { runReport, ownerReport } from './reports.js';
import { sellCard, refundCardSale, listCardSales } from './card-sales.js';
import { createDeposit, acceptDeposit } from './deposits.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const ADMIN = { id: 1, role: 'admin', full_name: 'Админ' };
const REG   = { id: 7, role: 'registrar', full_name: 'Каримова' };
const CASH  = { id: 9, role: 'cashier', full_name: 'Юлдашева' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (1,'a','x','Админ','admin')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (7,'r','x','Каримова','registrar')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (9,'c','x','Юлдашева','cashier')").run();
  const buyer = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Покупатель', 1)").run().lastInsertRowid;
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Dilshod', 1)").run().lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Кардиолог', 100000)").run().lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, CASH);
  return { db, buyer, pid, svc };
}
function billed(db, pid, svc, price = 100000) {
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,?,?,'added')").run(vid, svc, price, price).lastInsertRowid;
  return createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, REG).invoice;
}
const today = (db) => db.prepare("SELECT date('now','localtime') d").get().d;
const collected = (db) => dashboardSummary(db, {}, CASH).collected_today;
const shift = (db) => cashShiftSummary(db, {}, CASH);
const income = (db) => cashierReport(db, { from: today(db), to: today(db) }, ADMIN).kpi.income;
const card = (db, id) => db.prepare('SELECT * FROM patient_discounts WHERE id = ?').get(id);
const sell = (db, a = {}) => sellCard(db, { kind: 'gift_card', amount: 300000, method: 'cash', patient_id: a.patient_id, ...a }, CASH);

test('продажа карты — приход ОДИН раз: касса, смена, дашборд, отчёт кассира; карта активна с полным номиналом', () => {
  const { db, buyer } = seed();
  const r = sell(db, { patient_id: buyer, name: 'Подарок на юбилей' });
  assert.match(r.invoice.invoice_number, /^CARD-[A-Z]+-\d{2}-00001$/);
  assert.equal(r.invoice.status, 'paid');
  assert.equal(r.invoice.total_amount, 300000);
  assert.equal(r.invoice.paid_amount, 300000);
  assert.equal(r.invoice.visit_id, null);
  const c = card(db, r.card.id);
  assert.equal(c.kind, 'gift_card');
  assert.equal(c.active, 1);
  assert.equal(c.amount, 300000);
  assert.equal(c.remaining, 300000);
  assert.equal(c.sale_invoice_id, r.invoice.id);
  assert.equal(c.sale_number, r.invoice.invoice_number);
  const line = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(r.invoice.id);
  assert.equal(line.length, 1);
  assert.match(line[0].description, /^Подарочная карта/);
  assert.equal(line[0].service_id, null);

  assert.equal(collected(db), 300000);
  assert.equal(shift(db).totals.total, 300000);
  assert.equal(shift(db).expected_drawer, 300000);
  assert.equal(income(db), 300000);
  const x = shiftReport(db, {}, CASH);
  assert.ok(JSON.stringify(x).includes('300000'), 'X-отчёт видит продажу');
  // Второй номер идёт по порядку.
  const r2 = sell(db, { patient_id: buyer, kind: 'certificate', amount: 50000, method: 'card' });
  assert.match(r2.invoice.invoice_number, /-00002$/);
  assert.match(db.prepare('SELECT description FROM invoice_items WHERE invoice_id = ?').get(r2.invoice.id).description, /^Сертификат/);
  db.close();
});

test('погашение картой — не приход; отчёты по строкам считают услугу, а продажу карты — нет', () => {
  const { db, buyer, pid, svc } = seed();
  const r = sell(db, { patient_id: buyer });
  const inv = billed(db, pid, svc);
  recordPayment(db, { invoice_id: inv.id, amount: 100000, method: 'gift_card', card_id: r.card.id }, CASH);
  assert.equal(card(db, r.card.id).remaining, 200000);
  assert.equal(collected(db), 300000, 'приход — только продажа');
  assert.equal(shift(db).totals.total, 300000);
  assert.equal(shift(db).expected_drawer, 300000);
  assert.equal(income(db), 300000);

  const own = ownerReport(db, { from: today(db), to: today(db) }, ADMIN);
  assert.equal(own.kpis.revenue, 100000, 'отчёт владельца: услуга 100 000, продажа карты не услуга');
  assert.ok(!own.byGroup.some((g) => /карта/i.test(g.name)), 'строки «Подарочная карта» нет в выручке по услугам');
  const rev = runReport(db, { kind: 'total_revenue', from: today(db), to: today(db) }, ADMIN);
  assert.ok(!rev.rows.some((row) => String(row[2]).startsWith('CARD-')), 'total_revenue без счёта продажи');
  db.close();
});

test('возврат продажи — только неизрасходованный остаток; карта выключается; приход уменьшается на возврат', () => {
  const { db, buyer, pid, svc } = seed();
  const r = sell(db, { patient_id: buyer });
  const inv = billed(db, pid, svc);
  recordPayment(db, { invoice_id: inv.id, amount: 100000, method: 'gift_card', card_id: r.card.id }, CASH);

  const out = refundCardSale(db, { card_id: r.card.id, reason: 'передумали' }, CASH);
  assert.equal(out.refunded, 200000);
  const c = card(db, r.card.id);
  assert.equal(c.remaining, 0);
  assert.equal(c.active, 0);
  const sale = db.prepare('SELECT * FROM invoices WHERE id = ?').get(r.invoice.id);
  assert.equal(sale.paid_amount, 100000, 'осталась оплаченной потраченная часть');
  assert.equal(sale.total_amount, 100000);
  assert.equal(sale.status, 'paid', 'не «долг» и не «частично»: пациент ничего не должен');
  const neg = db.prepare('SELECT * FROM payments WHERE invoice_id = ? AND amount < 0').get(r.invoice.id);
  assert.equal(neg.amount, -200000);
  assert.equal(neg.method, 'cash', 'возврат тем же способом, каким продали');
  assert.equal(collected(db), 100000);
  assert.equal(shift(db).expected_drawer, 100000);
  assert.equal(income(db), 100000);
  // Уплаченная картой услуга осталась оплаченной.
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(inv.id).status, 'paid');
  // Выключенной картой больше не заплатить; второй возврат — отказ.
  const inv2 = billed(db, pid, svc);
  assert.throws(() => recordPayment(db, { invoice_id: inv2.id, amount: 1000, method: 'gift_card', card_id: r.card.id }, CASH), /выключено|остаток 0/);
  assert.throws(() => refundCardSale(db, { card_id: r.card.id }, CASH), /уже возвращ|потрачен|нечего/);
  db.close();
});

test('полностью потраченную карту вернуть нельзя; неиспользованную — целиком, счёт продажи становится «возврат»', () => {
  const { db, buyer, pid, svc } = seed();
  const spent = sell(db, { patient_id: buyer, amount: 100000 });
  const inv = billed(db, pid, svc);
  recordPayment(db, { invoice_id: inv.id, amount: 100000, method: 'gift_card', card_id: spent.card.id }, CASH);
  assert.throws(() => refundCardSale(db, { card_id: spent.card.id }, CASH), /потрачен/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE amount < 0').get().n, 0);

  const fresh = sell(db, { patient_id: buyer, amount: 50000, method: 'acquiring' });
  refundCardSale(db, { card_id: fresh.card.id }, CASH);
  const sale = db.prepare('SELECT * FROM invoices WHERE id = ?').get(fresh.invoice.id);
  assert.equal(sale.status, 'refunded');
  assert.equal(sale.paid_amount, 0);
  assert.equal(db.prepare('SELECT method FROM payments WHERE invoice_id = ? AND amount < 0').get(fresh.invoice.id).method, 'acquiring');
  db.close();
});

test('карта, выданная в настройках без оплаты, через кассу не возвращается — денег за неё не брали', () => {
  const { db } = seed();
  const free = db.prepare("INSERT INTO patient_discounts (name, kind, amount) VALUES ('Промо', 'certificate', 100000)").run().lastInsertRowid;
  assert.throws(() => refundCardSale(db, { card_id: free }, CASH), /без оплаты/);
  db.close();
});

test('счёт CARD- не оплачивается и не возвращается обычными дверями, не отменяется; с баланса и другой картой — тоже нет', () => {
  const { db, buyer } = seed();
  const other = sell(db, { patient_id: buyer, amount: 100000 });
  const r = sell(db, { patient_id: buyer });
  const payId = db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(r.invoice.id).id;
  assert.throws(() => refundPayment(db, { payment_id: payId }, CASH), /продажи карты/);
  assert.throws(() => refundPayment(db, { payment_id: payId, to_balance: true }, CASH), /продажи карты/);
  assert.throws(() => voidInvoice(db, { invoice_id: r.invoice.id }, CASH), /деньги|возврат/i);
  // Даже если бы счёт был не оплачен — к нему нельзя приложить баланс/карту.
  db.prepare("UPDATE invoices SET paid_amount = 0, status = 'unpaid' WHERE id = ?").run(r.invoice.id);
  assert.throws(() => recordPayment(db, { invoice_id: r.invoice.id, amount: 1000, method: 'cash' }, CASH), /продажи карты/);
  assert.throws(() => recordPayment(db, { invoice_id: r.invoice.id, amount: 1000, method: 'gift_card', card_id: other.card.id }, CASH), /продажи карты/);
  assert.throws(() => recordPaymentSplit(db, { invoice_id: r.invoice.id, tenders: [{ method: 'wallet', amount: 1000 }] }, CASH), /продажи карты/);
  db.close();
});

test('продажа карты кэшбэка не даёт; номинал и вид проданной карты в настройках не меняются', () => {
  const { db, buyer } = seed();
  db.prepare("INSERT INTO cashback_rules (name, percent, active) VALUES ('Всем', 10, 1)").run();
  const r = sell(db, { patient_id: buyer });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patient_deposits WHERE kind = 'cashback'").get().n, 0);
  assert.throws(() => db.prepare('UPDATE patient_discounts SET amount = 999999 WHERE id = ?').run(r.card.id), /продана в кассе/);
  assert.throws(() => db.prepare("UPDATE patient_discounts SET kind = 'promo' WHERE id = ?").run(r.card.id), /продана в кассе|оплаты/);
  // Имя, срок, выключатель — можно.
  db.prepare("UPDATE patient_discounts SET name = 'Новое имя', valid_until = '2030-01-01' WHERE id = ?").run(r.card.id);
  db.close();
});

test('проверки входа: роль, номинал, вид, способ, покупатель, срок', () => {
  const { db, buyer } = seed();
  assert.throws(() => sellCard(db, { kind: 'gift_card', amount: 1000, method: 'cash', patient_id: buyer }, REG), (e) => e.status === 403);
  assert.throws(() => sell(db, { patient_id: buyer, amount: 0 }), /номинал/i);
  assert.throws(() => sell(db, { patient_id: buyer, amount: -5 }), /номинал/i);
  assert.throws(() => sell(db, { patient_id: buyer, kind: 'promo' }), /вид/i);
  assert.throws(() => sell(db, { patient_id: buyer, method: 'wallet' }), /способ/i);
  assert.throws(() => sell(db, { patient_id: buyer, method: 'gift_card' }), /способ/i);
  assert.throws(() => sell(db, {}), /покупател/i);
  assert.throws(() => sell(db, { patient_id: 99999 }), /покупател|не найден/i);
  assert.throws(() => sell(db, { patient_id: buyer, valid_until: '2020-01-01' }), /срок/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0, 'ни одного счёта от отказов');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patient_discounts").get().n, 0);
  const ok = sell(db, { patient_id: buyer, valid_until: '2099-12-31', method: 'transfer' });
  assert.equal(card(db, ok.card.id).valid_until, '2099-12-31');
  db.close();
});

test('список карт для кассы: проданные с номером и покупателем, выданные без оплаты — с пометкой; RPC зарегистрированы', () => {
  const { db, buyer } = seed();
  const r = sell(db, { patient_id: buyer });
  db.prepare("INSERT INTO patient_discounts (name, kind, amount) VALUES ('Промо', 'certificate', 100000)").run();
  db.prepare("INSERT INTO patient_discounts (name, kind, percent) VALUES ('Скидка', 'promo', 10)").run();
  const rows = listCardSales(db, {}, CASH).rows;
  assert.equal(rows.length, 2, 'промокод — не карта');
  const sold = rows.find((x) => x.id === r.card.id);
  assert.equal(sold.sale_number, r.invoice.invoice_number);
  assert.equal(sold.buyer_name, 'Покупатель');
  assert.equal(sold.sale_method, 'cash');
  assert.equal(sold.remaining, 300000);
  assert.equal(rows.find((x) => x.id !== r.card.id).sale_number, null);
  assert.throws(() => listCardSales(db, {}, { id: 5, role: 'doctor' }), (e) => e.status === 403);
  for (const n of ['sell_card', 'refund_card_sale', 'list_card_sales']) assert.ok(getRpc(n), n);
  assert.ok(isReadOnlyRpc('list_card_sales'), 'список карт — чистое чтение');
  assert.ok(!isReadOnlyRpc('sell_card') && !isReadOnlyRpc('refund_card_sale'));
  db.close();
});

// B3 — долг по кэшбэку виден кассиру ДО приёма депозита, и приём называет,
// сколько долга он закрыл.
test('приём депозита сначала закрывает долг по кэшбэку и говорит об этом', () => {
  const { db, pid } = seed();
  // Долг по кэшбэку: откат потраченного кэшбэка уводит журнал в минус.
  db.transaction(() => {
    db.prepare('INSERT INTO ledger_write_token DEFAULT VALUES').run();
    db.prepare(`INSERT INTO patient_deposits (patient_id, amount, method, status, kind, notes) VALUES (?, 3000, 'wallet', 'spent', 'spend', 'тест')`).run(pid);
    db.prepare('DELETE FROM ledger_write_token').run();
  })();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 10000 }, REG);
  const r = acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  assert.equal(r.debt_before, 3000);
  assert.equal(r.debt_covered, 3000);
  assert.equal(r.balance, 7000);
  db.close();
});
