// REFUND_ANY_V1 (2026-10-29) — ЧТО ОСТАЁТСЯ ЗАПРЕЩЁННЫМ (защита денег).
//
// Возврат строкой теперь доходит до любой услуги — счёт за любой день (поиск),
// строка стационара, «Оставить услугу в визите». Границы денег не сдвинулись,
// и здесь они проверены на тех же дверях: счёт депозита и продажи карты
// строкой не возвращается (иначе деньги выдаются дважды — moneyDocRefusal),
// чужое здание — только там (assertOwnBuilding), по счёту без денег (в том
// числе счёт плательщику) возвращать нечего, больше оплаченного не вернуть.
// Оплата картой — только на ту же карту, кэшбэк — только на баланс: тесты
// billing.final-money.test.js (I2) и wallet.test.js стоят как были.
// После каждой попытки — сумма платежей = «оплачено» по счёту.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { refundInvoiceLine, refundPayment, createInvoiceForAdmission, recordPayment } from './billing.js';
import { openCashShift } from './cashier.js';
import { DEPOSIT_INVOICE_REFUSAL, CARD_SALE_INVOICE_REFUSAL } from '../domain/wallet.js';

const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (9,'cash','x','cashier','Кассир')").run();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, cashier);
  return { db, pid };
}
// Счёт с одной строкой и одной оплатой наличными — прямо в базе.
function paidDoc(db, pid, number, { payer = null, origin = null, paid = 100000 } = {}) {
  const inv = db.prepare(`INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, paid_amount, status, payer_id, sync_origin)
                          VALUES (?, ?, 100000, 100000, ?, ?, ?, ?)`).run(number, pid, paid, paid >= 100000 ? 'paid' : 'unpaid', payer, origin).lastInsertRowid;
  const item = db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?, 'Строка', 1, 100000, 100000)").run(inv).lastInsertRowid;
  if (paid > 0) db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id) VALUES (?, ?, 'cash', 9)").run(inv, paid);
  return { inv, item };
}
const ledgerOk = (db, id) => {
  const s = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE invoice_id = ?').get(id).s;
  assert.equal(Math.round(s * 100) / 100, db.prepare('SELECT paid_amount p FROM invoices WHERE id = ?').get(id).p, 'сумма платежей = оплачено по счёту');
};

test('счёт депозита и продажи карты строкой не возвращается — их деньги возвращают свои вкладки', () => {
  const { db, pid } = seed();
  const dep = paidDoc(db, pid, 'DEP-A-26-00001');
  assert.throws(() => refundInvoiceLine(db, { invoice_item_id: dep.item }, cashier), (e) => e.status === 400 && e.message === DEPOSIT_INVOICE_REFUSAL);
  const card = paidDoc(db, pid, 'CARD-A-26-00001');
  assert.throws(() => refundInvoiceLine(db, { invoice_item_id: card.item }, cashier), (e) => e.status === 400 && e.message === CARD_SALE_INVOICE_REFUSAL);
  ledgerOk(db, dep.inv);
  ledgerOk(db, card.inv);
});

test('чужое здание — только там; без денег (и у плательщика) — нечего возвращать; больше оплаченного — нельзя', () => {
  const { db, pid } = seed();
  const foreign = paidDoc(db, pid, 'INV-B-26-00001', { origin: 'B' });
  assert.throws(() => refundInvoiceLine(db, { invoice_item_id: foreign.item }, cashier), (e) => e.status === 403);
  ledgerOk(db, foreign.inv);
  const payer = db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid;
  const toPayer = paidDoc(db, pid, 'INV-A-26-00002', { payer, paid: 0 });
  assert.throws(() => refundInvoiceLine(db, { invoice_item_id: toPayer.item }, cashier), (e) => e.status === 400 && /не принято денег/.test(e.message));
  // Строка стационара без денег — тоже не возврат, а правка счёта.
  const adm = db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'active')").run(pid).lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price, type) VALUES ('Перевязка', 50000, 'procedure')").run().lastInsertRowid;
  const line = db.prepare("INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, billable) VALUES (?, ?, 1, 50000, 50000, 1)").run(adm, svc).lastInsertRowid;
  const inv = createInvoiceForAdmission(db, { admission_id: adm, admission_service_ids: [line] }, cashier).invoice;
  const item = db.prepare('SELECT invoice_item_id i FROM admission_services WHERE id = ?').get(line).i;
  assert.throws(() => refundInvoiceLine(db, { invoice_item_id: item }, cashier), (e) => e.status === 400 && /не принято денег/.test(e.message));
  recordPayment(db, { invoice_id: inv.id, amount: 50000, method: 'cash' }, cashier);
  const pay = db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(inv.id).id;
  assert.throws(() => refundPayment(db, { payment_id: pay, amount: 50001 }, cashier), (e) => e.status === 400 && /Максимум к возврату/.test(e.message));
  ledgerOk(db, inv.id);
});
