import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment, removeUnpaidService, changeUnpaidService, refundPayment, markInvoiceDebt } from './billing.js';
import * as billingModule from './billing.js';   // RELEASE_SELECT_V1 — invoiceReleaseLines (через модуль: до её появления тест падает утверждением, а не загрузкой файла)
import { closeCashShift } from './cashier.js';
import { unpaidWorkRefusal } from '../visit-status-guard.js';   // RELEASE_SELECT_V1 — в работу идёт только отпущенная строка

function seed() {
  const db = openDb(':memory:'); migrate(db);
  // users referenced by created_by/cashier_id FKs (invoices.created_by,
  // payments.cashier_id both REFERENCE users(id) with foreign_keys=ON).
  // Ids match the registrar/cashier/lab consts below.
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (7,'registrar1','x','registrar')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (9,'cashier1','x','cashier')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (5,'lab1','x','lab')").run();
  // one patient, one visit, two services, two visit_services (server prices are authoritative)
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('P',1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,'2026-08-12T09:00:00Z')").run(pid).lastInsertRowid;
  const s1 = db.prepare("INSERT INTO services (name, price) VALUES ('Consult', 50000)").run().lastInsertRowid;
  const s2 = db.prepare("INSERT INTO services (name, price) VALUES ('X-ray', 30000)").run().lastInsertRowid;
  const vs1 = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,1,50000,50000)").run(vid,s1).lastInsertRowid;
  const vs2 = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,2,30000,60000)").run(vid,s2).lastInsertRowid;
  return { db, pid, vid, s1, s2, vs1, vs2 };
}
const registrar = { id: 7, role: 'registrar' };
const cashier   = { id: 9, role: 'cashier' };
const lab       = { id: 5, role: 'lab' };

test('create_invoice_for_visit computes subtotal server-side and links items', () => {
  const { db, vid, vs1, vs2 } = seed();
  const res = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, registrar);
  assert.equal(res.invoice.subtotal, 110000);       // 50000 + 2*30000
  assert.equal(res.invoice.total_amount, 110000);
  assert.equal(res.invoice.paid_amount, 0);
  assert.equal(res.invoice.status, 'unpaid');
  // BRANCH_MONEY_NUMBER_V1 (миграция 088) — номер несёт БУКВУ здания: счета
  // ездят между филиалами, а invoice_number объявлен UNIQUE, и без буквы два
  // здания чеканили бы один и тот же 'INV-26-00001'.
  assert.match(res.invoice.invoice_number, /^INV-[A-Z]{1,8}-\d{2}-\d{5}$/);
  assert.equal(res.items.length, 2);
  // visit_services are now linked
  const linked = db.prepare('SELECT invoice_item_id FROM visit_services WHERE id=?').get(vs1).invoice_item_id;
  assert.ok(linked);
});

test('create_invoice ignores client-sent prices (uses DB values only)', () => {
  const { db, vid, vs1 } = seed();
  // even if a malicious client passes unit_price/total in args, the handler must not read them
  const res = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1], unit_price: 1, total: 1 }, registrar);
  assert.equal(res.invoice.total_amount, 50000);
});

test('create_invoice rejects a visit_service from another visit, atomically', () => {
  const { db, vid, vs1 } = seed();
  const otherV = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (1,1,'2026-08-12T10:00:00Z')").run().lastInsertRowid;
  const alien = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,1,1,999,999)").run(otherV).lastInsertRowid;
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, alien] }, registrar), /другому визиту/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0);       // nothing created
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoice_items').get().n, 0);
});

test('create_invoice rejects empty selection and re-invoicing a linked line', () => {
  const { db, vid, vs1 } = seed();
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [] }, registrar), /Не выбрано ни одной услуги/);
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar);
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar), /уже в счёте/);
});

test('create_invoice forbids non-billing roles', () => {
  const { db, vid, vs1 } = seed();
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, lab), /недоступно/);
});

test('record_payment: partial then full, status + paid_at server-computed', () => {
  const { db, vid, vs1, vs2 } = seed();
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, registrar);
  let r = recordPayment(db, { invoice_id: invoice.id, amount: 40000, method: 'cash' }, cashier);
  assert.equal(r.invoice.paid_amount, 40000);
  assert.equal(r.invoice.status, 'partial');
  assert.equal(r.invoice.paid_at, null);
  r = recordPayment(db, { invoice_id: invoice.id, amount: 70000, method: 'cash' }, cashier);
  assert.equal(r.invoice.paid_amount, 110000);
  assert.equal(r.invoice.status, 'paid');
  assert.ok(r.invoice.paid_at);
  // sum(payments) equals paid_amount (bookkeeping invariant)
  assert.equal(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=?').get(invoice.id).s, 110000);
});

test('record_payment rejects overpay, zero, negative, and non-billing role', () => {
  const { db, vid, vs1 } = seed();
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar); // total 50000
  assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: 60000, method:'cash' }, cashier), /больше остатка/);
  assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: 0, method:'cash' }, cashier), /Сумма/);
  assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: -10, method:'cash' }, cashier), /Сумма/);
  assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: 100, method:'cash' }, lab), /недоступно/);
  // pay it off, then a further payment is rejected (balance 0)
  recordPayment(db, { invoice_id: invoice.id, amount: 50000, method:'cash' }, cashier);
  assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: 1, method:'cash' }, cashier), /уже оплачен/);
});

test('duplicate visit_service_ids are rejected (no double-bill)', () => {
  const { db, vid, vs1 } = seed();
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs1] }, registrar), /дважды/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0);
});

test('payment ledger invariant holds for sub-cent amounts', () => {
  const { db, vid, vs1 } = seed(); // total 50000
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar);
  recordPayment(db, { invoice_id: invoice.id, amount: 0.005, method:'cash' }, cashier);
  const inv = db.prepare('SELECT paid_amount FROM invoices WHERE id=?').get(invoice.id).paid_amount;
  const sum = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=?').get(invoice.id).s;
  assert.equal(inv, sum); // ledgers agree (both 0.01 after single rounding)
});

test('zero-total invoice is created already paid', () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (username,password_hash,role) VALUES ('r','x','registrar')").run();
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('P',1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,'2026-08-12T09:00:00Z')").run(pid).lastInsertRowid;
  const s = db.prepare("INSERT INTO services (name, price) VALUES ('Free', 0)").run().lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,1,0,0)").run(vid,s).lastInsertRowid;
  const res = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, { id:1, role:'registrar' });
  assert.equal(res.invoice.total_amount, 0);
  assert.equal(res.invoice.status, 'paid');
});

test('invoice numbers are monotonic and survive a deleted invoice', () => {
  const { db, vid, vs1, vs2 } = seed();
  const a = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar).invoice.invoice_number;
  // simulate a gap: delete the first invoice row directly. visit_services.invoice_item_id
  // REFERENCES invoice_items(id) with foreign_keys=ON, so unlink first or the delete
  // itself raises a FOREIGN KEY constraint (this is DB-level referential integrity,
  // not part of what the test is exercising).
  db.prepare('UPDATE visit_services SET invoice_item_id = NULL').run();
  db.prepare('DELETE FROM invoice_items').run(); db.prepare('DELETE FROM invoices').run();
  const b = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs2] }, registrar).invoice.invoice_number;
  assert.notEqual(a, b); // counter did not reuse the number despite the gap
});

test('invoice uses catalog price, not a tampered visit_service unit_price', () => {
  const { db, vid } = seed();
  // service priced 50000 in catalog, but the visit_service was written with a bogus unit_price 1
  const s = db.prepare("INSERT INTO services (name, price) VALUES ('MRI', 50000)").run().lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,1,1,1)").run(vid, s).lastInsertRowid;
  const res = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  assert.equal(res.invoice.total_amount, 50000);   // catalog price wins, not the bogus 1
  assert.equal(res.items[0].unit_price, 50000);
});

test('ad-hoc line with null service_id keeps its stored price', () => {
  const { db, vid } = seed();
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,NULL,1,12345,12345)").run(vid).lastInsertRowid;
  const res = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  assert.equal(res.invoice.total_amount, 12345);
});

// INPATIENT_MONEY_FIX_V1 — a dispensed line is billed at the price stored on
// it at dispense time, in the line's own quantity unit: the holdings door
// dispenses TABLETS (sale price of the box / consumption factor), the
// warehouse door BOXES. Re-pricing «box price × tablet count» billed 400 000
// for a 20 000 dispense (audit 27.09). The stored price cannot be forged from
// the browser: /api/db neither inserts clinic_item_id nor updates unit_price
// on visit_services (schema-registry.js) — only the dispense RPCs write it.
test('invoice prices a dispensed item at the price stored on the line (per its unit)', async () => {
  const { db, vid } = seed();
  const prod = db.prepare("INSERT INTO products (name,sale_price,on_hand,consumption_unit,consumption_factor) VALUES ('Tabs',40000,100,'tab',20)").run().lastInsertRowid;
  // 10 tablets at 2 000 = 20 000 (as dispense_from_holding writes it)
  const vs = db.prepare("INSERT INTO visit_services (visit_id, clinic_item_id, quantity, unit_price, total) VALUES (?,?,10,2000,20000)").run(vid, prod).lastInsertRowid;
  const res = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  assert.equal(res.invoice.total_amount, 20000);
  const { tableEntry } = await import('../../db/schema-registry.js');
  const w = tableEntry('visit_services').write;
  assert.ok(!w.insert.columns.includes('clinic_item_id'), 'the browser cannot create a dispensed line');
  assert.ok(!w.update.columns.includes('unit_price'), 'the browser cannot re-price a line');
});

test('invoice rejects a line with zero or negative quantity', () => {
  const { db, vid } = seed();
  const s = db.prepare("INSERT INTO services (name, price) VALUES ('X', 5000)").run().lastInsertRowid;
  const vsZero = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,0,5000,0)").run(vid, s).lastInsertRowid;
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vsZero] }, registrar), /количество/);
  const vsNeg = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,-2,5000,-10000)").run(vid, s).lastInsertRowid;
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vsNeg] }, registrar), /количество/);
});

// ---- SVC_UNPAID_REMOVE_V1 ---------------------------------------------------
test('remove_unpaid_service: shrinks an unpaid invoice, deletes it when emptied', () => {
  const { db, vid, vs1, vs2 } = seed();
  const res = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, registrar);
  const invId = res.invoice.id;

  // remove one line -> invoice recalculated (110000 - 50000)
  const r1 = removeUnpaidService(db, { visit_service_id: vs1 }, registrar);
  assert.equal(r1.invoice_deleted, false);
  assert.equal(r1.invoice.subtotal, 60000);
  assert.equal(r1.invoice.total_amount, 60000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id=?').get(vs1).n, 0);

  // remove the last line -> the empty invoice disappears with it
  const r2 = removeUnpaidService(db, { visit_service_id: vs2 }, registrar);
  assert.equal(r2.invoice_deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE id=?').get(invId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoice_items WHERE invoice_id=?').get(invId).n, 0);
});

// ── SVC_UNPAID_REMOVE_V1 × HOLDINGS_FIRST_V1 ────────────────────────────────
// «Убрать» на вкладке «Услуги» карточки пациента достаёт и ТОВАРНЫЕ строки:
// вкладка показывает все строки визита, а списанный на пациента бинт — такая
// же строка. До этой правки удаление просто стирало её: товар не возвращался
// никому, подотчёт медсестры оставался пустым, а в журнале навсегда повисало
// движение расхода, у которого больше нет ни строки, ни пациента.
function stockSeed(base) {
  const { db } = base;
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (11,'nurse1','x','Медсестра Алиева','nurse')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (12,'inv1','x','Кладовщик Каримов','inventory')").run();
  db.prepare("INSERT INTO products (id, name, code, unit, base_unit, sale_price, on_hand, avg_cost, active) VALUES (3,'Бинт','BND','шт','шт',2000,20,100,1)").run();
  return { nurse: { id: 11, role: 'nurse', extra_roles: [] }, inv: { id: 12, role: 'inventory', extra_roles: [] } };
}
const heldBy = (db, type, id, product) => {
  const r = db.prepare('SELECT qty FROM stock_holdings WHERE holder_type=? AND holder_id=? AND product_id=?').get(type, id, product);
  return r ? r.qty : 0;
};
const onHandOf = (db, id) => db.prepare('SELECT on_hand FROM products WHERE id=?').get(id).on_hand;

test('remove_unpaid_service возвращает товар в подотчёт, из которого его взяли', async () => {
  const base = seed();
  const { db, vid } = base;
  const { nurse, inv } = stockSeed(base);
  const { issueStockLines } = await import('./procurement.js');
  const { dispenseItem } = await import('./inventory.js');

  issueStockLines(db, { holder: { type: 'staff', id: 11 }, lines: [{ product_id: 3, qty: 5, unit: 'base' }] }, inv);
  assert.equal(heldBy(db, 'staff', 11, 3), 5);
  assert.equal(onHandOf(db, 3), 15);

  const d = dispenseItem(db, { product_id: 3, quantity: 3, visit_id: vid }, nurse);
  assert.deepEqual(d.sources.map((s) => [s.type, s.qty]), [['staff', 3]], 'списали не с подотчёта — проверять нечего');
  assert.equal(heldBy(db, 'staff', 11, 3), 2);

  removeUnpaidService(db, { visit_service_id: d.visit_service_id }, registrar);

  assert.equal(heldBy(db, 'staff', 11, 3), 5, 'три бинта исчезли у медсестры: подотчёт съеден удалением строки');
  assert.equal(onHandOf(db, 3), 15, 'товар вернулся НЕ туда, откуда его брали — склад получил чужое');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id=?').get(d.visit_service_id).n, 0);

  // Журнал сошёлся: на каждое движение расхода есть отмена, и «висящего»
  // расхода на пациента, у которого больше нет ни строки, ни получателя, не
  // осталось — иначе он навсегда сидел бы в «Расходе на пациентов» отдела.
  const net = db.prepare("SELECT COALESCE(SUM(qty),0) s FROM stock_movements WHERE reference_type='visit' AND reference_id=?").get(d.visit_service_id).s;
  assert.equal(net, 0, 'в журнале остался расход без строки визита — сирота');
});

test('remove_unpaid_service не трогает склад на строке без товара', () => {
  const base = seed();
  const { db, vs1 } = base;
  stockSeed(base);
  removeUnpaidService(db, { visit_service_id: vs1 }, registrar);
  assert.equal(onHandOf(db, 3), 20);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 0,
      'удаление услуги без товара написало движение склада');
});

test('товарная строка в ОПЛАЧЕННОМ счёте не удаляется — прежняя защита на месте', async () => {
  const base = seed();
  const { db, vid } = base;
  const { nurse, inv } = stockSeed(base);
  const { issueStockLines } = await import('./procurement.js');
  const { dispenseItem } = await import('./inventory.js');
  issueStockLines(db, { holder: { type: 'staff', id: 11 }, lines: [{ product_id: 3, qty: 5, unit: 'base' }] }, inv);
  const d = dispenseItem(db, { product_id: 3, quantity: 3, visit_id: vid }, nurse);
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [d.visit_service_id] }, registrar);
  recordPayment(db, { invoice_id: invoice.id, amount: invoice.total_amount, method: 'cash' }, cashier);

  assert.throws(() => removeUnpaidService(db, { visit_service_id: d.visit_service_id }, registrar), /оплачен/);
  assert.equal(heldBy(db, 'staff', 11, 3), 2, 'отказ всё-таки вернул товар — транзакция не откатилась');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id=?').get(d.visit_service_id).n, 1);
});

// ── SVC_CHANGE_V1 × HOLDINGS_FIRST_V1 — ТОВАР НЕ ПОДМЕНЯЕТСЯ УСЛУГОЙ ────────
//
// Вкладка «Услуги» карточки пациента показывает и товарные строки, а рядом с
// корзиной там же стояла «Заменить услугу». Промах мимо корзины давал химеру:
// строка начинала считаться консультацией, три бинта оставались списанными,
// clinic_item_id — на месте, и карточка отдела считала этот расход против
// строки с названием «Консультация терапевта». Разобрать такую строку потом
// нечем: цена уже от услуги, товар уже у пациента.
test('товарную строку нельзя ПОДМЕНИТЬ услугой — иначе выдача превращается в консультацию', async () => {
  const base = seed();
  const { db, vid, s1, s2, vs1 } = base;
  const { nurse, inv } = stockSeed(base);
  const { issueStockLines } = await import('./procurement.js');
  const { dispenseItem } = await import('./inventory.js');

  issueStockLines(db, { holder: { type: 'staff', id: 11 }, lines: [{ product_id: 3, qty: 5, unit: 'base' }] }, inv);
  const d = dispenseItem(db, { product_id: 3, quantity: 3, visit_id: vid }, nurse);
  const before = db.prepare('SELECT * FROM visit_services WHERE id=?').get(d.visit_service_id);

  assert.throws(() => changeUnpaidService(db, { visit_service_id: d.visit_service_id, new_service_id: s1 }, registrar),
      (e) => e.status === 400 && /товар/i.test(e.message) && /спишите|верните|уберите/i.test(e.message));

  const after = db.prepare('SELECT * FROM visit_services WHERE id=?').get(d.visit_service_id);
  assert.equal(after.service_id, null, 'строка стала услугой: товар списан, а счёт говорит «консультация»');
  assert.equal(after.clinic_item_id, 3, 'товар отвязали от строки — расход остался без хозяина');
  assert.equal(after.unit_price, before.unit_price, 'цена товара подменена ценой услуги');
  assert.equal(after.total, before.total);
  assert.equal(heldBy(db, 'staff', 11, 3), 2, 'отказ тронул подотчёт — транзакция не откатилась');

  // Обычную услугу по-прежнему меняют — запрет ровно про товар.
  // DUP_STOP_V1 — X-ray (s2) уже в визите: замена на неё — повтор; меняем на третью услугу.
  const s3 = Number(db.prepare("INSERT INTO services (name, price) VALUES ('ECG', 40000)").run().lastInsertRowid);
  const ok = changeUnpaidService(db, { visit_service_id: vs1, new_service_id: s3 }, registrar);
  assert.equal(ok.changed, true);
  assert.equal(db.prepare('SELECT service_id FROM visit_services WHERE id=?').get(vs1).service_id, s3);
});

// DEBT_STICKY_V2 — «Оставить как долг» records an arrangement, not just an
// amount. The old amount-only ladder turned the invoice into 'partial' on the
// first instalment, so the arrangement vanished from the Долг chip the moment
// the patient paid anything towards it.
test('an invoice parked as debt stays debt while part-paid, and settles when cleared', () => {
  const { db, vid, vs1, vs2 } = seed();   // total 110000
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, registrar);
  markInvoiceDebt(db, { invoice_id: invoice.id }, cashier);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(invoice.id).status, 'debt');

  const part = recordPayment(db, { invoice_id: invoice.id, amount: 40000, method: 'cash' }, cashier);
  assert.equal(part.invoice.status, 'debt', 'a part-paid debt is still a debt');
  assert.equal(part.invoice.paid_amount, 40000);

  const settled = recordPayment(db, { invoice_id: invoice.id, amount: 70000, method: 'cash' }, cashier);
  assert.equal(settled.invoice.status, 'paid');
  assert.ok(settled.invoice.paid_at);

  // An ordinary unpaid invoice is unaffected — it still walks unpaid -> partial.
  const { db: db2, vid: v2, vs1: a2 } = seed();
  const plain = createInvoiceForVisit(db2, { visit_id: v2, visit_service_ids: [a2] }, registrar).invoice;
  assert.equal(recordPayment(db2, { invoice_id: plain.id, amount: 10000, method: 'cash' }, cashier).invoice.status, 'partial');
});

// ---------------------------------------------------------------------------
// refund_payment (CASHIER_REFUND_V1) — was entirely untested.
// ---------------------------------------------------------------------------

test('refund_payment: partial then full, invoice rolls back, ledger invariant holds', () => {
  const { db, vid, vs1 } = seed();   // total 50000
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar);
  recordPayment(db, { invoice_id: invoice.id, amount: 50000, method: 'cash' }, cashier);
  const payId = db.prepare('SELECT id FROM payments WHERE invoice_id=? ORDER BY id').get(invoice.id).id;

  // V3120_FIX — reopen_balance: явный выбор «оплатят снова»; без него частичный
  // возврат оплаченного счёта — скидка после продажи (money-desk.v3120.test.js).
  const partial = refundPayment(db, { payment_id: payId, amount: 20000, reason: 'услуга не оказана', reopen_balance: true }, cashier);
  assert.equal(partial.invoice.paid_amount, 30000);
  assert.equal(partial.invoice.status, 'partial');
  assert.equal(partial.invoice.paid_at, null);            // no longer settled

  const rest = refundPayment(db, { payment_id: payId }, cashier);   // amount omitted -> the remainder
  assert.equal(rest.invoice.paid_amount, 0);
  // BILLING_AUDIT_FIX_V1 (B2) — полный возврат закрывает счёт отменой, а не
  // возвращает его в «Не оплачен» (долг за услугу, от которой отказались).
  assert.equal(rest.invoice.status, 'void');
  assert.equal(rest.voided, true);

  // sum(payments) still equals paid_amount — refunds are negative rows, so every
  // drawer and report SUM built on payments stays honest without special-casing.
  assert.equal(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=?').get(invoice.id).s, 0);
  assert.throws(() => refundPayment(db, { payment_id: payId }, cashier), /всё возвращено/);
});

test('BILLING_AUDIT_FIX_V1 (B2): void_when_zero:false — явный выбор «оставить счёт открытым»', () => {
  const { db, vid, vs1 } = seed();
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar);
  recordPayment(db, { invoice_id: invoice.id, amount: 50000, method: 'cash' }, cashier);
  const payId = db.prepare('SELECT id FROM payments WHERE invoice_id=?').get(invoice.id).id;
  const r = refundPayment(db, { payment_id: payId, void_when_zero: false }, cashier);
  assert.equal(r.invoice.status, 'unpaid');
  assert.equal(r.voided, false);
});

test('refund_payment: the refund tag matches on a boundary, not a bare prefix', () => {
  // REGRESSION: the refunded-so-far total was found with LIKE 'REFUND#<id>%',
  // so refunds of payment 11 were counted against payment 1 and payment 1 could
  // no longer be refunded at all. Needs ids on both sides of the collision, so
  // this pays one invoice off in eleven instalments.
  const { db, vid, vs1, vs2 } = seed();   // total 110000
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, registrar);
  for (let i = 0; i < 11; i++) recordPayment(db, { invoice_id: invoice.id, amount: 10000, method: 'cash' }, cashier);
  const ids = db.prepare('SELECT id FROM payments WHERE invoice_id=? ORDER BY id').all(invoice.id).map(r => r.id);
  const [first, eleventh] = [ids[0], ids[10]];
  assert.ok(String(eleventh).startsWith(String(first)), 'test needs colliding id prefixes (e.g. 1 and 11)');

  refundPayment(db, { payment_id: eleventh }, cashier);          // fully refund #11

  // #1 is untouched and must still be fully refundable.
  const r = refundPayment(db, { payment_id: first }, cashier);
  assert.equal(r.invoice.paid_amount, 90000);                    // 110000 - 10000 - 10000
  const refundRows = db.prepare('SELECT notes FROM payments WHERE amount < 0 ORDER BY id').all().map(x => x.notes);
  assert.deepEqual(refundRows, ['REFUND#' + eleventh, 'REFUND#' + first]);
});

test('refund_payment: a refund with no open shift opens the day rather than escaping the drawer', () => {
  // REGRESSION: refunds used a bare open-shift lookup and fell back to
  // shift_id NULL, so a refund taken before the day's first payment vanished
  // from the X-report and from the expected-drawer maths.
  const { db, vid, vs1 } = seed();
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar);
  recordPayment(db, { invoice_id: invoice.id, amount: 50000, method: 'cash' }, cashier);
  const payId = db.prepare('SELECT id FROM payments WHERE invoice_id=? ORDER BY id').get(invoice.id).id;

  // Close the shift the payment opened: the cashier now has none open.
  const shiftId = db.prepare("SELECT id FROM cash_shifts WHERE cashier_id=? AND status='open'").get(cashier.id).id;
  closeCashShift(db, { shift_id: shiftId, counted_amount: 50000 }, cashier);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cash_shifts WHERE cashier_id=? AND status='open'").get(cashier.id).n, 0);

  refundPayment(db, { payment_id: payId, amount: 20000 }, cashier);

  const refundRow = db.prepare('SELECT shift_id FROM payments WHERE amount < 0').get();
  assert.ok(refundRow.shift_id, 'refund must be attached to a shift, never shift_id NULL');
  const fresh = db.prepare("SELECT id FROM cash_shifts WHERE cashier_id=? AND status='open'").get(cashier.id);
  assert.equal(refundRow.shift_id, fresh.id, 'refund belongs to the shift open NOW, not the closed one');
  assert.notEqual(refundRow.shift_id, shiftId);
});

test('refund_payment: refuses refunding a refund, an unknown payment, and a non-cashier role', () => {
  const { db, vid, vs1 } = seed();
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar);
  recordPayment(db, { invoice_id: invoice.id, amount: 50000, method: 'cash' }, cashier);
  const payId = db.prepare('SELECT id FROM payments WHERE invoice_id=? ORDER BY id').get(invoice.id).id;

  assert.throws(() => refundPayment(db, { payment_id: payId }, lab), /недоступно/);
  assert.throws(() => refundPayment(db, { payment_id: 9999 }, cashier), /не найден/);
  assert.throws(() => refundPayment(db, { payment_id: payId, amount: 60000 }, cashier), /Максимум/);

  refundPayment(db, { payment_id: payId }, cashier);
  const negId = db.prepare('SELECT id FROM payments WHERE amount < 0').get().id;
  assert.throws(() => refundPayment(db, { payment_id: negId }, cashier), /вернуть возврат нельзя/);
});

test('remove_unpaid_service: refuses once money moved; uninvoiced line just deletes', () => {
  const { db, vid, vs1, vs2 } = seed();
  const res = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar);
  recordPayment(db, { invoice_id: res.invoice.id, amount: 10000, method: 'cash' }, cashier);
  assert.throws(() => removeUnpaidService(db, { visit_service_id: vs1 }, registrar), /оплачен/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id=?').get(vs1).n, 1);   // line survives

  // vs2 was never invoiced -> plain delete works
  const r = removeUnpaidService(db, { visit_service_id: vs2 }, registrar);
  assert.equal(r.invoice_deleted, false);
  assert.equal(r.invoice, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id=?').get(vs2).n, 0);
});

test('remove_unpaid_service: in-progress/completed lines and foreign roles refuse', () => {
  const { db, vs1 } = seed();
  db.prepare("UPDATE visit_services SET status='in_progress' WHERE id=?").run(vs1);
  assert.throws(() => removeUnpaidService(db, { visit_service_id: vs1 }, registrar), /уже оказыва/);
  db.prepare("UPDATE visit_services SET status='added' WHERE id=?").run(vs1);
  assert.throws(() => removeUnpaidService(db, { visit_service_id: vs1 }, lab), /недоступно/);
});

// ---------------------------------------------------------------------------
// BRANCH_MONEY_GUARD_V1 — чужие деньги только для чтения.
//
// С миграции 087 счета, позиции и платежи соседнего здания лежат в этой базе:
// за этим они и едут — чтобы главная клиника видела отчёт по всем зданиям. Но
// править их отсюда нельзя ничем: касса, взявшая эти деньги, стоит в другом
// здании, и вторая правда об одной сумме здесь никому не нужна. Экран кассы это
// уже запрещает (f9615ab), но экран — не граница: RPC зовут по invoice_id.
// ---------------------------------------------------------------------------

/** Счёт соседнего здания — ровно так он и выглядит после приёма порции. */
function foreign(db, { letter = 'B', name = 'Чиланзар' } = {}) {
  db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)').run(name, letter);
  const pid = db.prepare("INSERT INTO patients (full_name, sync_origin) VALUES ('Приезжий', ?)").run(letter).lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date, sync_origin) VALUES (?, '2026-09-02', ?)")
    .run(pid, letter).lastInsertRowid;
  const vsid = db.prepare(`INSERT INTO visit_services (visit_id, service_id, quantity, status, sync_origin)
                           VALUES (?, 1, 1, 'added', ?)`).run(vid, letter).lastInsertRowid;
  const iid = db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, total_amount,
                            paid_amount, status, sync_origin)
                          VALUES ('INV-B-26-00001', ?, ?, 50000, 50000, 50000, 'paid', ?)`)
    .run(vid, pid, letter).lastInsertRowid;
  const payid = db.prepare(`INSERT INTO payments (invoice_id, amount, method, sync_origin)
                            VALUES (?, 50000, 'cash', ?)`).run(iid, letter).lastInsertRowid;
  return { pid, vid, vsid, iid, payid };
}

test('чужой счёт: оплатить отсюда нельзя, и отказ называет здание', () => {
  const { db } = seed();
  const f = foreign(db);
  assert.throws(
    () => recordPayment(db, { invoice_id: f.iid, amount: 1000 }, cashier),
    (e) => {
      assert.match(e.message, /Чиланзар \(B\)/, 'отказ обязан называть филиал теми же словами, что и метки в списках');
      assert.equal(e.status, 403);
      return true;
    });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE invoice_id = ?').get(f.iid).n, 1,
    'ни одной новой строки: деньги чужого здания эта касса не трогает');
});

test('чужой счёт: долг, возврат и повторное выставление тоже отказывают', () => {
  const { db } = seed();
  const f = foreign(db);
  assert.throws(() => markInvoiceDebt(db, { invoice_id: f.iid }, cashier), /Чиланзар/);
  assert.throws(() => refundPayment(db, { payment_id: f.payid, amount: 100 }, cashier), /Чиланзар/);
  assert.throws(() => createInvoiceForVisit(db, { visit_id: f.vid, visit_service_ids: [f.vsid] }, registrar), /Чиланзар/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE visit_id = ?').get(f.vid).n, 1,
    'второй счёт по чужому визиту — это второе требование денег за одну работу');
});

test('чужая услуга: удалить отсюда нельзя — надгробие стёрло бы её и в том здании', () => {
  const { db } = seed();
  const f = foreign(db);
  assert.throws(() => removeUnpaidService(db, { visit_service_id: f.vsid }, registrar), /Чиланзар/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id = ?').get(f.vsid).n, 1);
});

test('чужой счёт: имя филиала ещё не приехало — в отказе остаётся буква', () => {
  const { db } = seed();
  const pid = db.prepare("INSERT INTO patients (full_name, sync_origin) VALUES ('Приезжий', 'E')").run().lastInsertRowid;
  const iid = db.prepare(`INSERT INTO invoices (invoice_number, patient_id, total_amount, status, sync_origin)
                          VALUES ('INV-E-26-00001', ?, 1000, 'unpaid', 'E')`).run(pid).lastInsertRowid;
  assert.throws(() => recordPayment(db, { invoice_id: iid, amount: 100 }, cashier), /филиала E/);
});

test('своя работа не задета: счёт и оплата в своём здании идут как прежде', () => {
  const { db, vid, vs1 } = seed();
  foreign(db);   // рядом лежат чужие деньги — они ничему не мешают
  const res = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar);
  assert.equal(res.invoice.sync_origin, null, 'выписано здесь');
  const paid = recordPayment(db, { invoice_id: res.invoice.id, amount: 50000 }, cashier);
  assert.equal(paid.invoice.status, 'paid');
});

// ═══════════════════════════════════════════════════════════════════════════
// RELEASE_SELECT_V1 (3.25.0) — частичная оплата и долг отпускают в работу только
// строки, отмеченные кассиром; полная оплата — всё, как прежде; деньги те же.
// ═══════════════════════════════════════════════════════════════════════════

// Строки, которые читает лист лаборатории (laboratory.js LAB_OPEN_STATUSES):
// неотпущенная ('added') туда не попадает.
const LAB_READ = ['queued', 'collected', 'in_progress', 'resulted'];

function seedRelease() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (7,'registrar1','x','registrar')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'cashier1','x','Кассир Анна','cashier')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (10,'doc','x','Иванов','doctor',1)").run();
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('P',1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,'2026-08-12T09:00:00Z')").run(pid).lastInsertRowid;
  const sC = db.prepare("INSERT INTO services (name, price, type) VALUES ('Консультация терапевта', 100000, 'consultation')").run().lastInsertRowid;
  const sA = db.prepare("INSERT INTO services (name, price, type, is_lab) VALUES ('Общий анализ крови', 40000, 'lab', 1)").run().lastInsertRowid;
  const consult = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,10,1,100000,100000,'added')").run(vid, sC).lastInsertRowid);
  const analysis = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,40000,40000,'added')").run(vid, sA).lastInsertRowid);
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [consult, analysis] }, registrar);   // 140 000
  return { db, vid, pid, consult, analysis, invoice };
}
const lineStatus = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;
const labRead = (db) => db.prepare(`SELECT id FROM visit_services WHERE status IN (${LAB_READ.map(() => '?').join(',')})`).all(...LAB_READ).map((r) => r.id);
const releaseLog = (db, invoiceId) => db.prepare("SELECT * FROM invoice_audit_log WHERE invoice_id = ? AND action = 'release_unpaid' ORDER BY id").all(invoiceId);

test('RELEASE_SELECT_V1: частичная 100 000 из 140 000 с отмеченной консультацией — в работу только она; 40 000 потом — и анализ', () => {
  const { db, consult, analysis, invoice } = seedRelease();
  assert.equal(invoice.total_amount, 140000);
  const r = recordPayment(db, { invoice_id: invoice.id, amount: 100000, method: 'cash', release_line_ids: [consult] }, cashier);
  assert.equal(r.invoice.status, 'partial');
  assert.equal(r.invoice.paid_amount, 100000);
  assert.equal(lineStatus(db, consult), 'queued', 'отмеченная консультация — в работе');
  assert.equal(lineStatus(db, analysis), 'added', 'неотмеченный анализ ждёт оплаты');
  assert.deepEqual(labRead(db), [consult], 'анализ не попадает в лист лаборатории');
  assert.equal(unpaidWorkRefusal(db, [analysis], 'collected') !== null, true, 'пробу неотпущенного анализа не берут');
  assert.equal(unpaidWorkRefusal(db, [consult], 'in_progress'), null, 'отпущенную консультацию начинают');
  // Журнал: кто и что отпустил до полной оплаты.
  const log = releaseLog(db, invoice.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_user_id, 9);
  assert.equal(log[0].actor_name, 'Кассир Анна');
  assert.match(log[0].notes, /Частичная оплата/);
  assert.match(log[0].notes, /Консультация терапевта/);
  assert.doesNotMatch(log[0].notes, /анализ крови/);
  assert.equal(log[0].amount, 0, 'запись журнала — не деньги');

  const done = recordPayment(db, { invoice_id: invoice.id, amount: 40000, method: 'card' }, cashier);
  assert.equal(done.invoice.status, 'paid');
  assert.equal(lineStatus(db, analysis), 'queued', 'полная оплата отпускает оставшееся само');
  assert.deepEqual(labRead(db).sort(), [consult, analysis].sort());
  assert.equal(releaseLog(db, invoice.id).length, 1, 'полная оплата — не выбор кассира, лишней строки журнала нет');
  assert.equal(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=?').get(invoice.id).s, 140000);
});

test('RELEASE_SELECT_V1: частичная без аргумента — не отпускается ничего (безопасное умолчание)', () => {
  const { db, consult, analysis, invoice } = seedRelease();
  recordPayment(db, { invoice_id: invoice.id, amount: 100000, method: 'cash' }, cashier);
  assert.equal(lineStatus(db, consult), 'added');
  assert.equal(lineStatus(db, analysis), 'added');
  assert.deepEqual(labRead(db), []);
  assert.equal(releaseLog(db, invoice.id).length, 0);
});

test('RELEASE_SELECT_V1: долг без отметок — в работе ничего; долг с отмеченным анализом — только он', () => {
  const a = seedRelease();
  const d1 = markInvoiceDebt(a.db, { invoice_id: a.invoice.id, release_line_ids: [] }, cashier);
  assert.equal(d1.invoice.status, 'debt');
  assert.equal(lineStatus(a.db, a.consult), 'added');
  assert.equal(lineStatus(a.db, a.analysis), 'added');
  assert.deepEqual(labRead(a.db), [], 'в лаборатории ничего');
  assert.equal(releaseLog(a.db, a.invoice.id).length, 0, 'ничего не отпущено — и журнал молчит');

  const b = seedRelease();
  markInvoiceDebt(b.db, { invoice_id: b.invoice.id, release_line_ids: [b.analysis] }, cashier);
  assert.equal(lineStatus(b.db, b.analysis), 'queued');
  assert.equal(lineStatus(b.db, b.consult), 'added');
  assert.deepEqual(labRead(b.db), [b.analysis]);
  const log = releaseLog(b.db, b.invoice.id);
  assert.equal(log.length, 1);
  assert.match(log[0].notes, /^Долг/);
  assert.match(log[0].notes, /Общий анализ крови/);
  assert.equal(log[0].from_status, 'unpaid');
  assert.equal(log[0].to_status, 'debt');

  // Долг без аргумента (старый экран) — тоже ничего.
  const c = seedRelease();
  markInvoiceDebt(c.db, { invoice_id: c.invoice.id }, cashier);
  assert.deepEqual([lineStatus(c.db, c.consult), lineStatus(c.db, c.analysis)], ['added', 'added']);
});

test('RELEASE_SELECT_V1: полная оплата отпускает всё — без списка', () => {
  const { db, consult, analysis, invoice } = seedRelease();
  const r = recordPayment(db, { invoice_id: invoice.id, amount: 140000, method: 'cash' }, cashier);
  assert.equal(r.invoice.status, 'paid');
  assert.deepEqual([lineStatus(db, consult), lineStatus(db, analysis)], ['queued', 'queued']);
  assert.equal(releaseLog(db, invoice.id).length, 0);
});

test('RELEASE_SELECT_V1: отмеченная строка чужого счёта, уже отпущенная, отменённая или мусор — 400, денег не записано', () => {
  const { db, pid, consult, analysis, invoice } = seedRelease();
  const sX = db.prepare("INSERT INTO services (name, price) VALUES ('ЭКГ', 30000)").run().lastInsertRowid;
  // Строка ДРУГОГО счёта (другой визит того же пациента): в неоплаченный счёт этого
  // визита новая строка дописалась бы (INVOICE_APPEND_V1) и стала бы «своей».
  const vid2 = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,'2026-08-13T09:00:00Z')").run(pid).lastInsertRowid;
  const alien = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,30000,30000,'added')").run(vid2, sX).lastInsertRowid);
  const other = createInvoiceForVisit(db, { visit_id: vid2, visit_service_ids: [alien] }, registrar).invoice;
  assert.notEqual(other.id, invoice.id, 'строка — в другом счёте');
  const pays = () => db.prepare('SELECT COUNT(*) n FROM payments WHERE invoice_id = ?').get(invoice.id).n;
  const refused = (args, re) => assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: 50000, method: 'cash', ...args }, cashier),
    (e) => e.status === 400 && re.test(e.message));
  refused({ release_line_ids: [alien] }, /не из этого счёта/);
  refused({ release_line_ids: [999999] }, /не из этого счёта/);
  refused({ release_line_ids: ['1'] }, /указаны неверно/);
  refused({ release_line_ids: 'x' }, /указаны неверно/);
  assert.throws(() => markInvoiceDebt(db, { invoice_id: invoice.id, release_line_ids: [alien] }, cashier), (e) => e.status === 400 && /не из этого счёта/.test(e.message));
  assert.equal(pays(), 0, 'отказ — ни одного платежа');
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoice.id).status, 'unpaid', 'отказ долга — счёт не тронут');
  assert.deepEqual([lineStatus(db, consult), lineStatus(db, analysis)], ['added', 'added']);

  recordPayment(db, { invoice_id: invoice.id, amount: 50000, method: 'cash', release_line_ids: [consult] }, cashier);
  refused({ release_line_ids: [consult] }, /уже передана в работу/);
  db.prepare("UPDATE visit_services SET status = 'cancelled' WHERE id = ?").run(analysis);
  refused({ release_line_ids: [analysis] }, /отменена/);
  assert.equal(pays(), 1);
});

test('RELEASE_SELECT_V1: старый частично оплаченный счёт (до обновления) — его строки в работе и работают', () => {
  const { db, consult, analysis, invoice } = seedRelease();
  // Так их оставил 3.24: оплата части отпустила весь счёт.
  db.prepare("UPDATE invoices SET paid_amount = 50000, status = 'partial' WHERE id = ?").run(invoice.id);
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id) VALUES (?, 50000, 'cash', 9)").run(invoice.id);
  db.prepare("UPDATE visit_services SET status = 'queued' WHERE id IN (?, ?)").run(consult, analysis);
  assert.equal(unpaidWorkRefusal(db, [analysis], 'collected'), null, 'проба берётся, как вчера');
  assert.equal(unpaidWorkRefusal(db, [consult], 'in_progress'), null);
  assert.deepEqual(labRead(db).sort(), [consult, analysis].sort());
  // Доплата закрывает счёт — строки не сбрасываются и не дублируются.
  const r = recordPayment(db, { invoice_id: invoice.id, amount: 90000, method: 'cash' }, cashier);
  assert.equal(r.invoice.status, 'paid');
  assert.deepEqual([lineStatus(db, consult), lineStatus(db, analysis)], ['queued', 'queued']);
});

test('RELEASE_SELECT_V1: деньги те же — отметки меняют только строки, не суммы, платежи и статусы', () => {
  const ticked = seedRelease();
  const plain = seedRelease();
  const pay = (s, ids) => {
    recordPayment(s.db, { invoice_id: s.invoice.id, amount: 60000, method: 'cash', ...(ids ? { release_line_ids: ids } : {}) }, cashier);
    markInvoiceDebt(s.db, { invoice_id: s.invoice.id, ...(ids ? { release_line_ids: [] } : {}) }, cashier);
    recordPayment(s.db, { invoice_id: s.invoice.id, amount: 30000, method: 'card' }, cashier);
  };
  pay(ticked, [ticked.consult, ticked.analysis]);
  pay(plain, null);
  const money = (s) => ({
    inv: s.db.prepare('SELECT subtotal, discount_amount, total_amount, paid_amount, status FROM invoices WHERE id = ?').get(s.invoice.id),
    pays: s.db.prepare('SELECT amount, method FROM payments WHERE invoice_id = ? ORDER BY id').all(s.invoice.id),
    items: s.db.prepare('SELECT total, discount_amount FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(s.invoice.id),
  });
  assert.deepEqual(money(ticked), money(plain));
  assert.deepEqual(money(plain).inv, { subtotal: 140000, discount_amount: 0, total_amount: 140000, paid_amount: 90000, status: 'debt' });
  assert.deepEqual([lineStatus(ticked.db, ticked.consult), lineStatus(ticked.db, ticked.analysis)], ['queued', 'queued']);
  assert.deepEqual([lineStatus(plain.db, plain.consult), lineStatus(plain.db, plain.analysis)], ['added', 'added']);
});

test('RELEASE_SELECT_V1: invoice_release_lines — неотпущенные строки этого счёта, только для кассы', () => {
  const { db, consult, analysis, invoice } = seedRelease();
  const r1 = billingModule.invoiceReleaseLines(db, { invoice_id: invoice.id }, cashier);
  assert.deepEqual(r1.lines.map((l) => [l.id, l.name, l.total]), [[consult, 'Консультация терапевта', 100000], [analysis, 'Общий анализ крови', 40000]]);
  recordPayment(db, { invoice_id: invoice.id, amount: 10000, method: 'cash', release_line_ids: [consult] }, cashier);
  assert.deepEqual(billingModule.invoiceReleaseLines(db, { invoice_id: invoice.id }, cashier).lines.map((l) => l.id), [analysis]);
  assert.throws(() => billingModule.invoiceReleaseLines(db, { invoice_id: invoice.id }, lab), /недоступно/);
  assert.throws(() => billingModule.invoiceReleaseLines(db, { invoice_id: 0 }, cashier), (e) => e.status === 400);
});

// ═══════════════════════════════════════════════════════════════════════════
// RELEASE_SELECT_V1 (ревью) — СЧЁТ СТАЛ ОПЛАЧЕННЫМ: В РАБОТУ УХОДИТ ТОЛЬКО
// НЕОТПУЩЕННОЕ ('added'). Отмеченный при части анализ лаборатория уже взяла или
// внесла по нему результат — доплата не возвращает его в «Забор»; отменённая
// строка счёта отменённой и остаётся. Деньги те же.
// ═══════════════════════════════════════════════════════════════════════════
const admin = { id: 1, role: 'admin' };

test('RELEASE_SELECT_V1 (ревью): доплата record_payment не сбрасывает взятую пробу и не оживляет отменённую строку', () => {
  const a = seedRelease();
  recordPayment(a.db, { invoice_id: a.invoice.id, amount: 40000, method: 'cash', release_line_ids: [a.analysis] }, cashier);
  a.db.prepare("UPDATE visit_services SET status = 'collected' WHERE id = ?").run(a.analysis);   // лаборатория взяла пробу
  const r = recordPayment(a.db, { invoice_id: a.invoice.id, amount: 100000, method: 'cash' }, cashier);
  assert.equal(r.invoice.status, 'paid');
  assert.equal(lineStatus(a.db, a.analysis), 'collected', 'проба взята — доплата не отправляет её снова в «Забор»');
  assert.equal(lineStatus(a.db, a.consult), 'queued', 'неотпущенная консультация отпущена полной оплатой');

  const c = seedRelease();
  recordPayment(c.db, { invoice_id: c.invoice.id, amount: 40000, method: 'cash', release_line_ids: [] }, cashier);
  c.db.prepare("UPDATE visit_services SET status = 'cancelled' WHERE id = ?").run(c.analysis);
  recordPayment(c.db, { invoice_id: c.invoice.id, amount: 100000, method: 'cash' }, cashier);
  assert.equal(lineStatus(c.db, c.analysis), 'cancelled', 'отменённая строка не оживает');
  assert.equal(lineStatus(c.db, c.consult), 'queued');
});

test('RELEASE_SELECT_V1 (ревью): доплата частями не сбрасывает внесённый результат и не оживляет отменённую строку', () => {
  const b = seedRelease();
  markInvoiceDebt(b.db, { invoice_id: b.invoice.id, release_line_ids: [b.analysis] }, cashier);
  b.db.prepare("UPDATE visit_services SET status = 'resulted' WHERE id = ?").run(b.analysis);   // результат внесён
  const r = billingModule.recordPaymentSplit(b.db, { invoice_id: b.invoice.id, tenders: [{ amount: 70000, method: 'cash' }, { amount: 70000, method: 'card' }] }, cashier);
  assert.equal(r.invoice.status, 'paid');
  assert.equal(lineStatus(b.db, b.analysis), 'resulted', 'результат внесён — доплата его не сбрасывает');
  assert.equal(lineStatus(b.db, b.consult), 'queued');

  const c = seedRelease();
  billingModule.recordPaymentSplit(c.db, { invoice_id: c.invoice.id, tenders: [{ amount: 40000, method: 'cash' }], release_line_ids: [] }, cashier);
  c.db.prepare("UPDATE visit_services SET status = 'cancelled' WHERE id = ?").run(c.consult);
  billingModule.recordPaymentSplit(c.db, { invoice_id: c.invoice.id, tenders: [{ amount: 50000, method: 'cash' }, { amount: 50000, method: 'card' }] }, cashier);
  assert.equal(lineStatus(c.db, c.consult), 'cancelled');
  assert.equal(lineStatus(c.db, c.analysis), 'queued');
});

test('RELEASE_SELECT_V1 (ревью): счёт стал оплаченным возвратом строки или скидкой 100 % — отменённая строка не оживает, проба не сбрасывается', () => {
  // Возврат неотпущенной строки закрывает счёт: деньги покрыли остальное.
  const a = seedRelease();
  a.db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1,'admin1','x','admin')").run();
  const sE = a.db.prepare("INSERT INTO services (name, price) VALUES ('ЭКГ', 30000)").run().lastInsertRowid;
  const ecg = Number(a.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,30000,30000,'added')").run(a.vid, sE).lastInsertRowid);
  const app = createInvoiceForVisit(a.db, { visit_id: a.vid, visit_service_ids: [ecg] }, registrar);
  assert.equal(app.invoice.id, a.invoice.id, 'ЭКГ дописана в тот же счёт (170 000)');
  recordPayment(a.db, { invoice_id: a.invoice.id, amount: 140000, method: 'cash', release_line_ids: [a.consult] }, cashier);
  a.db.prepare("UPDATE visit_services SET status = 'cancelled' WHERE id = ?").run(a.analysis);
  const item = a.db.prepare('SELECT invoice_item_id i FROM visit_services WHERE id = ?').get(ecg).i;
  billingModule.refundInvoiceLine(a.db, { invoice_item_id: item, reason: 'не нужна' }, admin);
  assert.equal(a.db.prepare('SELECT status FROM invoices WHERE id = ?').get(a.invoice.id).status, 'paid');
  assert.equal(lineStatus(a.db, a.analysis), 'cancelled', 'возврат строки не оживляет отменённую');
  assert.equal(lineStatus(a.db, a.consult), 'queued');

  // Скидка 100 % на долг без денег: счёт закрыт на ноль (settleZeroTotal).
  const b = seedRelease();
  b.db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1,'admin1','x','admin')").run();
  markInvoiceDebt(b.db, { invoice_id: b.invoice.id, release_line_ids: [b.analysis] }, cashier);
  b.db.prepare("UPDATE visit_services SET status = 'collected' WHERE id = ?").run(b.analysis);
  b.db.prepare("UPDATE visit_services SET status = 'cancelled' WHERE id = ?").run(b.consult);
  billingModule.cashierInvoiceDiscountChange(b.db, { invoice_id: b.invoice.id, mode: 'pct', value: 100, reason: 'r' }, admin);
  assert.equal(b.db.prepare('SELECT status FROM invoices WHERE id = ?').get(b.invoice.id).status, 'paid');
  assert.equal(lineStatus(b.db, b.analysis), 'collected');
  assert.equal(lineStatus(b.db, b.consult), 'cancelled', 'счёт на ноль не оживляет отменённую строку');
});

// ═══════════════════════════════════════════════════════════════════════════
// RELEASE_SELECT_V1 (ревью) — «ОСТАВИТЬ КАК ДОЛГ» С ДЕНЬГАМИ — ОДНА ОПЕРАЦИЯ.
// Окно кассы проводило часть денег (record_payment), брало новый ключ повтора и
// только потом звало mark_invoice_debt; упал долг — повторное нажатие писало
// второй платёж. Теперь mark_invoice_debt принимает части оплаты (tenders) и
// проводит их в той же транзакции, что и долг, с ключом повтора на всю операцию.
// ═══════════════════════════════════════════════════════════════════════════
const payRows = (db, id) => db.prepare('SELECT amount, method FROM payments WHERE invoice_id = ? ORDER BY id').all(id);
const invOf = (db, id) => db.prepare('SELECT status, paid_amount, total_amount FROM invoices WHERE id = ?').get(id);

test('RELEASE_SELECT_V1 (ревью): долг с деньгами — платёж и долг одной транзакцией; повтор с тем же ключом — без второго платежа', () => {
  const { db, consult, analysis, invoice } = seedRelease();
  const args = { invoice_id: invoice.id, tenders: [{ amount: 30000, method: 'cash' }], release_line_ids: [analysis], idempotency_key: 'debt-key-0001' };
  const r = markInvoiceDebt(db, args, cashier);
  assert.equal(r.invoice.status, 'debt');
  assert.equal(r.invoice.paid_amount, 30000);
  assert.deepEqual(payRows(db, invoice.id), [{ amount: 30000, method: 'cash' }]);
  assert.deepEqual([lineStatus(db, analysis), lineStatus(db, consult)], ['queued', 'added']);
  // Журнал: отпущено при долге (часть денег записана), а не «частичной оплатой».
  const log = releaseLog(db, invoice.id);
  assert.equal(log.length, 1);
  assert.match(log[0].notes, /^Долг/);
  assert.match(log[0].notes, /частичн/i);
  assert.doesNotMatch(log[0].notes, /^Частичная оплата/);
  assert.equal(log[0].amount, 0, 'запись журнала — не деньги');
  // Ответ потерялся, кассир нажал ещё раз: та же форма, тот же ключ — квитанция, а не второй платёж.
  const again = markInvoiceDebt(db, { ...args }, cashier);
  assert.equal(again.repeated, true);
  assert.deepEqual(payRows(db, invoice.id), [{ amount: 30000, method: 'cash' }]);
  // Тот же ключ с другой суммой — отказ 409, денег не прибавилось.
  assert.throws(() => markInvoiceDebt(db, { ...args, tenders: [{ amount: 20000, method: 'cash' }] }, cashier), (e) => e.status === 409);
  assert.equal(payRows(db, invoice.id).length, 1);
  assert.equal(invOf(db, invoice.id).paid_amount, 30000);
});

test('RELEASE_SELECT_V1 (ревью): долг с деньгами — отказ где угодно не оставляет ни платежа, ни долга', () => {
  const { db, consult, analysis, invoice } = seedRelease();
  // Отметка устарела (строка уже отпущена) — отказ до денег.
  recordPayment(db, { invoice_id: invoice.id, amount: 10000, method: 'cash', release_line_ids: [consult] }, cashier);
  assert.throws(() => markInvoiceDebt(db, { invoice_id: invoice.id, tenders: [{ amount: 20000, method: 'cash' }], release_line_ids: [consult] }, cashier),
    (e) => e.status === 400 && /уже передана в работу/.test(e.message));
  // Вторая часть падает ВНУТРИ (карты нет) — первая часть откатывается вместе с долгом.
  assert.throws(() => markInvoiceDebt(db, { invoice_id: invoice.id, tenders: [{ amount: 20000, method: 'cash' }, { amount: 5000, method: 'gift_card', card_id: 999999 }], release_line_ids: [analysis] }, cashier));
  // Сумма покрывает остаток — это оплата, а не долг.
  assert.throws(() => markInvoiceDebt(db, { invoice_id: invoice.id, tenders: [{ amount: 130000, method: 'cash' }] }, cashier),
    (e) => e.status === 400 && /покрывает/.test(e.message));
  assert.deepEqual(payRows(db, invoice.id), [{ amount: 10000, method: 'cash' }], 'кроме первой оплаты — ни одного платежа');
  assert.deepEqual(invOf(db, invoice.id), { status: 'partial', paid_amount: 10000, total_amount: 140000 }, 'счёт не стал долгом');
  assert.equal(lineStatus(db, analysis), 'added');
  // Две части одним долгом — две строки платежей, одна запись журнала.
  const r = markInvoiceDebt(db, { invoice_id: invoice.id, tenders: [{ amount: 20000, method: 'cash' }, { amount: 15000, method: 'card' }], release_line_ids: [analysis] }, cashier);
  assert.deepEqual([r.invoice.status, r.invoice.paid_amount], ['debt', 45000]);
  assert.deepEqual(payRows(db, invoice.id).map((p) => p.amount), [10000, 20000, 15000]);
  assert.equal(lineStatus(db, analysis), 'queued');
});

test('RELEASE_SELECT_V1 (ревью): деньги долга с частью те же, что у прежних двух вызовов', () => {
  const one = seedRelease();
  const two = seedRelease();
  markInvoiceDebt(one.db, { invoice_id: one.invoice.id, tenders: [{ amount: 60000, method: 'cash' }], release_line_ids: [one.consult] }, cashier);
  recordPayment(two.db, { invoice_id: two.invoice.id, amount: 60000, method: 'cash', release_line_ids: [two.consult] }, cashier);
  markInvoiceDebt(two.db, { invoice_id: two.invoice.id, release_line_ids: [] }, cashier);
  const money = (s) => ({
    inv: s.db.prepare('SELECT subtotal, discount_amount, total_amount, paid_amount, status FROM invoices WHERE id = ?').get(s.invoice.id),
    pays: s.db.prepare('SELECT amount, method, cashier_id, shift_id IS NOT NULL AS shift FROM payments WHERE invoice_id = ? ORDER BY id').all(s.invoice.id),
  });
  assert.deepEqual(money(one), money(two));
  assert.deepEqual([lineStatus(one.db, one.consult), lineStatus(one.db, one.analysis)], ['queued', 'added']);
});

// ═══════════════════════════════════════════════════════════════════════════
// RELEASE_SELECT_V1 (ревью) — СЧЁТ ИЗМЕНИЛСЯ, ПОКА ОКНО ОПЛАТЫ БЫЛО ОТКРЫТО
// (INVOICE_APPEND_V1: в тот же неоплаченный счёт дописали услугу). Окно шлёт
// остаток, который видело (expected_balance); не тот — 409 invoice_changed до
// записи денег: «полная» оплата по старому остатку не становится молча частичной.
// ═══════════════════════════════════════════════════════════════════════════
test('RELEASE_SELECT_V1 (ревью): expected_balance — не тот остаток: 409 invoice_changed, денег не записано; тот — оплата идёт', () => {
  const { db, vid, consult, analysis, invoice } = seedRelease();   // окно открыто на 140 000
  const sE = db.prepare("INSERT INTO services (name, price) VALUES ('ЭКГ', 30000)").run().lastInsertRowid;
  const ecg = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,30000,30000,'added')").run(vid, sE).lastInsertRowid);
  assert.equal(createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [ecg] }, registrar).appended, true, 'дописана в тот же счёт: 170 000');
  const changed = (e) => e.status === 409 && e.code === 'invoice_changed' && /Счёт изменился/.test(e.message);
  assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: 140000, method: 'cash', expected_balance: 140000 }, cashier), changed);
  assert.throws(() => billingModule.recordPaymentSplit(db, { invoice_id: invoice.id, tenders: [{ amount: 100000, method: 'cash' }, { amount: 40000, method: 'card' }], expected_balance: 140000 }, cashier), changed);
  assert.throws(() => markInvoiceDebt(db, { invoice_id: invoice.id, tenders: [{ amount: 50000, method: 'cash' }], release_line_ids: [], expected_balance: 140000 }, cashier), changed);
  assert.throws(() => markInvoiceDebt(db, { invoice_id: invoice.id, release_line_ids: [consult], expected_balance: 140000 }, cashier), changed);
  assert.equal(payRows(db, invoice.id).length, 0, 'ни одного платежа');
  assert.equal(invOf(db, invoice.id).status, 'unpaid');
  assert.deepEqual([lineStatus(db, consult), lineStatus(db, analysis), lineStatus(db, ecg)], ['added', 'added', 'added']);
  assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: 1000, method: 'cash', expected_balance: 'x' }, cashier), (e) => e.status === 400);
  // Окно открыто заново с новым остатком — полная оплата отпускает всё.
  const r = recordPayment(db, { invoice_id: invoice.id, amount: 170000, method: 'cash', expected_balance: 170000, idempotency_key: 'full-key-0001' }, cashier);
  assert.equal(r.invoice.status, 'paid');
  assert.deepEqual([lineStatus(db, consult), lineStatus(db, analysis), lineStatus(db, ecg)], ['queued', 'queued', 'queued']);
  // Повтор той же формы после удачной оплаты — квитанция, а не «счёт изменился».
  assert.equal(recordPayment(db, { invoice_id: invoice.id, amount: 170000, method: 'cash', expected_balance: 170000, idempotency_key: 'full-key-0001' }, cashier).repeated, true);
  // Без expected_balance (старые экраны) — как прежде.
  const b = seedRelease();
  assert.equal(recordPayment(b.db, { invoice_id: b.invoice.id, amount: 140000, method: 'cash' }, cashier).invoice.status, 'paid');
});
