import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment, removeUnpaidService, refundPayment, markInvoiceDebt } from './billing.js';
import { closeCashShift } from './cashier.js';

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
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, alien] }, registrar), /visit/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0);       // nothing created
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoice_items').get().n, 0);
});

test('create_invoice rejects empty selection and re-invoicing a linked line', () => {
  const { db, vid, vs1 } = seed();
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [] }, registrar), /no|empty|select/i);
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar);
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar), /already|invoiced/i);
});

test('create_invoice forbids non-billing roles', () => {
  const { db, vid, vs1 } = seed();
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, lab), /(allow|forbid|role)/i);
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
  assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: 60000, method:'cash' }, cashier), /balance|exceed|overpay/i);
  assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: 0, method:'cash' }, cashier), /amount/i);
  assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: -10, method:'cash' }, cashier), /amount/i);
  assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: 100, method:'cash' }, lab), /(allow|forbid|role)/i);
  // pay it off, then a further payment is rejected (balance 0)
  recordPayment(db, { invoice_id: invoice.id, amount: 50000, method:'cash' }, cashier);
  assert.throws(() => recordPayment(db, { invoice_id: invoice.id, amount: 1, method:'cash' }, cashier), /balance|paid|exceed/i);
});

test('duplicate visit_service_ids are rejected (no double-bill)', () => {
  const { db, vid, vs1 } = seed();
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs1] }, registrar), /duplicate/i);
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

test('invoice prices a dispensed item from the products catalog', () => {
  const { db, vid } = seed();
  const prod = db.prepare("INSERT INTO products (name,sale_price,on_hand) VALUES ('Bandage',5000,100)").run().lastInsertRowid;
  // a dispensed line (service_id null, clinic_item_id set) with a tampered unit_price 1
  const vs = db.prepare("INSERT INTO visit_services (visit_id, clinic_item_id, quantity, unit_price, total) VALUES (?,?,2,1,2)").run(vid, prod).lastInsertRowid;
  const res = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  assert.equal(res.invoice.total_amount, 10000);   // 2 * 5000 catalog price, not the bogus 1
});

test('invoice rejects a line with zero or negative quantity', () => {
  const { db, vid } = seed();
  const s = db.prepare("INSERT INTO services (name, price) VALUES ('X', 5000)").run().lastInsertRowid;
  const vsZero = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,0,5000,0)").run(vid, s).lastInsertRowid;
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vsZero] }, registrar), /quantity/);
  const vsNeg = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,-2,5000,-10000)").run(vid, s).lastInsertRowid;
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vsNeg] }, registrar), /quantity/);
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

  const partial = refundPayment(db, { payment_id: payId, amount: 20000, reason: 'услуга не оказана' }, cashier);
  assert.equal(partial.invoice.paid_amount, 30000);
  assert.equal(partial.invoice.status, 'partial');
  assert.equal(partial.invoice.paid_at, null);            // no longer settled

  const rest = refundPayment(db, { payment_id: payId }, cashier);   // amount omitted -> the remainder
  assert.equal(rest.invoice.paid_amount, 0);
  assert.equal(rest.invoice.status, 'unpaid');

  // sum(payments) still equals paid_amount — refunds are negative rows, so every
  // drawer and report SUM built on payments stays honest without special-casing.
  assert.equal(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=?').get(invoice.id).s, 0);
  assert.throws(() => refundPayment(db, { payment_id: payId }, cashier), /всё возвращено/);
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

  assert.throws(() => refundPayment(db, { payment_id: payId }, lab), /not allowed/);
  assert.throws(() => refundPayment(db, { payment_id: 9999 }, cashier), /not found/);
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
  assert.throws(() => removeUnpaidService(db, { visit_service_id: vs1 }, lab), /not allowed/);
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
