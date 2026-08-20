import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPaymentSplit } from './billing.js';

// SPLIT_PAY_V1 — оплата счёта несколькими способами одной транзакцией:
// каждая часть — отдельная строка payments со своим способом; статус счёта
// считается по СУММЕ частей; переплата и мусорные части отклоняются целиком.
function seed() {
  const db = openDb(':memory:'); migrate(db);
  const reg = { id: db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('r','x','Reg','registrar')").run().lastInsertRowid, role: 'registrar' };
  const cashier = { id: db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('c','x','Cash','cashier')").run().lastInsertRowid, role: 'cashier' };
  const sid = db.prepare("INSERT INTO services (name, price) VALUES ('Svc', 100000)").run().lastInsertRowid;
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('P')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-08-08T09:00:00Z')").run(pid).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,100000,100000,'added')").run(vid, sid).lastInsertRowid;
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, reg);   // total 100000
  return { db, cashier, invoice };
}

test('split: cash + acquiring fully pays the invoice, two ledger rows', () => {
  const { db, cashier, invoice } = seed();
  const res = recordPaymentSplit(db, {
    invoice_id: invoice.id,
    tenders: [
      { method: 'cash', amount: 60000 },
      { method: 'acquiring', amount: 40000, notes: 'Эквайринг: Payme' },
    ],
  }, cashier);
  assert.equal(res.invoice.status, 'paid');
  assert.equal(res.invoice.paid_amount, 100000);
  assert.ok(res.invoice.paid_at, 'paid_at stamped');

  const pays = db.prepare('SELECT method, amount, notes, shift_id FROM payments WHERE invoice_id=? ORDER BY id').all(invoice.id);
  assert.equal(pays.length, 2);
  assert.deepEqual(pays.map(p => [p.method, p.amount]), [['cash', 60000], ['acquiring', 40000]]);
  assert.match(pays[1].notes, /Payme/);
  assert.ok(pays[0].shift_id && pays[0].shift_id === pays[1].shift_id, 'both parts in the same auto shift');
});

test('split: partial sum leaves invoice partial; services released to queued', () => {
  const { db, cashier, invoice } = seed();
  const res = recordPaymentSplit(db, {
    invoice_id: invoice.id,
    tenders: [{ method: 'cash', amount: 30000 }, { method: 'card', amount: 20000 }],
  }, cashier);
  assert.equal(res.invoice.status, 'partial');
  assert.equal(res.invoice.paid_amount, 50000);
  const vsStatus = db.prepare('SELECT status FROM visit_services').get().status;
  assert.equal(vsStatus, 'queued');
});

test('split: overpay and bad tenders are rejected atomically (no rows written)', () => {
  const { db, cashier, invoice } = seed();
  assert.throws(() => recordPaymentSplit(db, {
    invoice_id: invoice.id,
    tenders: [{ method: 'cash', amount: 90000 }, { method: 'card', amount: 20000 }],
  }, cashier), /exceeds balance/);
  assert.throws(() => recordPaymentSplit(db, {
    invoice_id: invoice.id,
    tenders: [{ method: 'cash', amount: 10000 }, { method: 'bitcoin', amount: 5000 }],
  }, cashier), /unknown method/);
  assert.throws(() => recordPaymentSplit(db, { invoice_id: invoice.id, tenders: [] }, cashier), /non-empty/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 0, 'nothing recorded after rejections');
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(invoice.id).status, 'unpaid');
});

// DEBT_BTN_V1 — «Оставить как долг»
test('debt: zero-payment debt releases services and sets status debt', async () => {
  const { openDb } = await import('../../db/connection.js');
  const { migrate } = await import('../../db/migrate.js');
  const { createInvoiceForVisit, markInvoiceDebt, recordPaymentSplit } = await import('./billing.js');
  const db = openDb(':memory:'); migrate(db);
  const reg = { id: db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('r2','x','Reg','registrar')").run().lastInsertRowid, role: 'registrar' };
  const cashier = { id: db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('c2','x','Cash','cashier')").run().lastInsertRowid, role: 'cashier' };
  const sid = db.prepare("INSERT INTO services (name, price) VALUES ('Svc', 80000)").run().lastInsertRowid;
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('P')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-08-08T09:00:00Z')").run(pid).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,80000,80000,'added')").run(vid, sid).lastInsertRowid;
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, reg);

  const res = markInvoiceDebt(db, { invoice_id: invoice.id }, cashier);
  assert.equal(res.invoice.status, 'debt');
  assert.equal(res.invoice.paid_amount, 0);
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id=?').get(vs).status, 'queued');

  // частичная оплата + долг: платёж записан, статус остаётся debt после mark
  const inv2vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,80000,80000,'added')").run(vid, sid).lastInsertRowid;
  const { invoice: inv2 } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [inv2vs] }, reg);
  recordPaymentSplit(db, { invoice_id: inv2.id, tenders: [{ method: 'cash', amount: 30000 }] }, cashier);
  const res2 = markInvoiceDebt(db, { invoice_id: inv2.id }, cashier);
  assert.equal(res2.invoice.status, 'debt');
  assert.equal(res2.invoice.paid_amount, 30000);

  // полностью оплаченный счёт в долг не переводится
  assert.throws(() => markInvoiceDebt(db, { invoice_id: invoice.id, }, { id: 999, role: 'lab' }), /allow|forbid|role/i);
});

// SVC_CHANGE_V1 — замена услуги с пересчётом неоплаченного счёта
test('change service: unpaid invoice re-priced; paid invoice refused', async () => {
  const { openDb } = await import('../../db/connection.js');
  const { migrate } = await import('../../db/migrate.js');
  const { createInvoiceForVisit, changeUnpaidService, recordPayment } = await import('./billing.js');
  const db = openDb(':memory:'); migrate(db);
  const reg = { id: db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('r3','x','Reg','registrar')").run().lastInsertRowid, role: 'registrar' };
  const cashier = { id: db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('c3','x','Cash','cashier')").run().lastInsertRowid, role: 'cashier' };
  const cheap = db.prepare("INSERT INTO services (name, price) VALUES ('Cheap', 50000)").run().lastInsertRowid;
  const dear  = db.prepare("INSERT INTO services (name, price) VALUES ('Dear', 120000)").run().lastInsertRowid;
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('P')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-08-08T09:00:00Z')").run(pid).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,2,50000,100000,'added')").run(vid, cheap).lastInsertRowid;
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, reg);   // 2 × 50000 = 100000

  // замена на дорогую услугу: строка и счёт пересчитаны (2 × 120000)
  const res = changeUnpaidService(db, { visit_service_id: vs, new_service_id: dear }, reg);
  assert.equal(res.line.service_id, dear);
  assert.equal(res.line.total, 240000);
  assert.equal(res.invoice.subtotal, 240000);
  assert.equal(res.invoice.total_amount, 240000);
  const item = db.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').get(invoice.id);
  assert.equal(item.service_id, dear);
  assert.equal(item.description, 'Dear');
  assert.equal(item.total, 240000);

  // после оплаты замена запрещена
  recordPayment(db, { invoice_id: invoice.id, amount: 240000, method: 'cash' }, cashier);
  assert.throws(() => changeUnpaidService(db, { visit_service_id: vs, new_service_id: cheap }, reg), /оплачен|кассе/);
});
