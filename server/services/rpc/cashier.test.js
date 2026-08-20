import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment, createInvoiceForAdmission } from './billing.js';
import { openCashShift, closeCashShift, cashShiftSummary, cashMove, shiftReport, cashierInvoices, voidInvoice } from './cashier.js';
import { admitPatient } from './inpatient.js';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  // users referenced by created_by/cashier_id FKs.
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (7,'registrar1','x','registrar')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (9,'cashier1','x','cashier')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (10,'cashier2','x','cashier')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1,'admin1','x','admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (5,'lab1','x','lab')").run();
  // one patient, one visit, two services, two visit_services
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
const cashier2  = { id: 10, role: 'cashier' };
const admin     = { id: 1, role: 'admin' };
const lab       = { id: 5, role: 'lab' };

// 1. openCashShift creates an open shift; a second open for same cashier is rejected.
test('open_cash_shift creates an open shift; a second open is rejected (400)', () => {
  const { db } = seed();
  const res = openCashShift(db, { opening_float: 10000 }, cashier);
  assert.equal(res.shift.status, 'open');
  assert.equal(res.shift.cashier_id, cashier.id);
  assert.equal(res.shift.opening_float, 10000);
  assert.ok(res.shift.id);
  assert.equal(res.shift.closed_at, null);

  assert.throws(() => openCashShift(db, { opening_float: 5000 }, cashier), /open shift|already/i);
  const rows = db.prepare("SELECT COUNT(*) n FROM cash_shifts WHERE cashier_id=? AND status='open'").get(cashier.id).n;
  assert.equal(rows, 1);
});

// 2. openCashShift rejects negative opening_float; rejects non-cashier/non-admin role.
test('open_cash_shift rejects negative opening_float (400) and non-allowed role (403)', () => {
  const { db } = seed();
  assert.throws(() => openCashShift(db, { opening_float: -100 }, cashier), /400|opening_float|negative|finite/i);
  assert.throws(() => openCashShift(db, { opening_float: 0 }, lab), /(allow|forbid|role)/i);
});

test('open_cash_shift defaults opening_float to 0 and accepts admin role', () => {
  const { db } = seed();
  const res = openCashShift(db, {}, admin);
  assert.equal(res.shift.opening_float, 0);
  assert.equal(res.shift.cashier_id, admin.id);
});

test('open_cash_shift sets branch_id only when a positive integer is given', () => {
  const { db } = seed();
  const res1 = openCashShift(db, { opening_float: 0, branch_id: 1 }, cashier);
  assert.equal(res1.shift.branch_id, 1);

  const res2 = openCashShift(db, { opening_float: 0, branch_id: -1 }, cashier2);
  assert.equal(res2.shift.branch_id, null);
});

// 3. recordPayment stamps shift_id when cashier has an open shift; NULL otherwise.
test('record_payment stamps shift_id from the cashier\'s open shift, and NULL when none', () => {
  const { db, vid, vs1 } = seed();
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar); // total 50000

  // SHIFT_AUTO_V2 — первый платёж дня сам открывает смену (нулевой остаток)
  recordPayment(db, { invoice_id: invoice.id, amount: 10000, method: 'cash' }, cashier);
  const p1 = db.prepare('SELECT * FROM payments WHERE invoice_id=? ORDER BY id DESC LIMIT 1').get(invoice.id);
  const shift = db.prepare("SELECT * FROM cash_shifts WHERE cashier_id=? AND status='open'").get(cashier.id);
  assert.ok(shift, 'first payment must auto-open a shift');
  assert.equal(shift.opening_float, 0);
  assert.match(shift.notes, /автоматически/);
  assert.equal(p1.shift_id, shift.id);

  // Дальнейшие платежи идут в ту же (уже открытую) смену
  recordPayment(db, { invoice_id: invoice.id, amount: 10000, method: 'cash' }, cashier);
  const p2 = db.prepare('SELECT * FROM payments WHERE invoice_id=? ORDER BY id DESC LIMIT 1').get(invoice.id);
  assert.equal(p2.shift_id, shift.id);

  // Client-supplied shift_id must be ignored entirely.
  recordPayment(db, { invoice_id: invoice.id, amount: 10000, method: 'cash', shift_id: 999999 }, cashier);
  const p3 = db.prepare('SELECT * FROM payments WHERE invoice_id=? ORDER BY id DESC LIMIT 1').get(invoice.id);
  assert.equal(p3.shift_id, shift.id);
  assert.notEqual(p3.shift_id, 999999);
});

// 4. closeCashShift computes expected drawer from CASH payments only; over_short = counted - expected.
test('close_cash_shift computes expected drawer from CASH only (card excluded) and over_short', () => {
  const { db, vid, vs1, vs2 } = seed();
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, registrar); // total 110000

  const { shift } = openCashShift(db, { opening_float: 5000 }, cashier);
  recordPayment(db, { invoice_id: invoice.id, amount: 30000, method: 'cash' }, cashier);
  recordPayment(db, { invoice_id: invoice.id, amount: 20000, method: 'card' }, cashier);

  // expected = opening_float(5000) + cash(30000) = 35000; counted 35500 -> over_short +500
  const res = closeCashShift(db, { shift_id: shift.id, counted_amount: 35500 }, cashier);
  assert.equal(res.shift.status, 'closed');
  assert.equal(res.shift.expected_amount, 35000);
  assert.equal(res.shift.counted_amount, 35500);
  assert.equal(res.shift.over_short, 500);
  assert.ok(res.shift.closed_at);
});

// 5a. non-owner, non-admin cannot close someone else's shift.
test('close_cash_shift forbids closing another cashier\'s shift (403) unless admin', () => {
  const { db } = seed();
  const { shift } = openCashShift(db, { opening_float: 0 }, cashier);
  assert.throws(() => closeCashShift(db, { shift_id: shift.id, counted_amount: 0 }, cashier2), /403|forbid|allow|own/i);

  // admin CAN close another cashier's shift
  const res = closeCashShift(db, { shift_id: shift.id, counted_amount: 100 }, admin);
  assert.equal(res.shift.status, 'closed');
});

// 5b. double-close is rejected.
test('close_cash_shift rejects closing an already-closed shift (400)', () => {
  const { db } = seed();
  const { shift } = openCashShift(db, { opening_float: 0 }, cashier);
  closeCashShift(db, { shift_id: shift.id, counted_amount: 0 }, cashier);
  assert.throws(() => closeCashShift(db, { shift_id: shift.id, counted_amount: 0 }, cashier), /400|closed|already/i);
});

test('close_cash_shift rejects unknown shift_id, bad shift_id, and negative counted_amount', () => {
  const { db } = seed();
  const { shift } = openCashShift(db, { opening_float: 0 }, cashier);
  assert.throws(() => closeCashShift(db, { shift_id: 999999, counted_amount: 0 }, cashier), /400|not found/i);
  assert.throws(() => closeCashShift(db, { shift_id: 'abc', counted_amount: 0 }, cashier), /400|integer|shift_id/i);
  assert.throws(() => closeCashShift(db, { shift_id: shift.id, counted_amount: -5 }, cashier), /400|counted_amount|negative|finite/i);
});

// 6. cashShiftSummary returns caller's open shift with totals and expected_drawer.
test('cash_shift_summary returns caller\'s open shift, totals by method, and expected_drawer', () => {
  const { db, vid, vs1, vs2 } = seed();
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, registrar); // total 110000

  // SHIFT_AUTO_V2 — «нет смены» не существует: summary сам открывает
  // автоматическую смену с нулевым остатком, платежи идут в неё же.
  const empty = cashShiftSummary(db, {}, cashier);
  assert.ok(empty.shift, 'summary must auto-open a shift');
  assert.equal(empty.shift.opening_float, 0);
  const shift = empty.shift;
  recordPayment(db, { invoice_id: invoice.id, amount: 30000, method: 'cash' }, cashier);
  recordPayment(db, { invoice_id: invoice.id, amount: 20000, method: 'card' }, cashier);

  const res = cashShiftSummary(db, {}, cashier);
  assert.equal(res.shift.id, shift.id);
  assert.equal(res.totals.cash, 30000);
  assert.equal(res.totals.card, 20000);
  assert.equal(res.totals.total, 50000);
  assert.equal(res.totals.count, 2);
  assert.equal(res.expected_drawer, 30000); // SHIFT_AUTO_V2: автосмена с нулевым остатком + 30000 наличными
});

test('open/close/summary reject roles outside admin/cashier', () => {
  const { db } = seed();
  assert.throws(() => openCashShift(db, {}, lab), /403|allow|forbid|role/i);
  assert.throws(() => cashShiftSummary(db, {}, lab), /403|allow|forbid|role/i);
  assert.throws(() => closeCashShift(db, { shift_id: 1, counted_amount: 0 }, lab), /403|allow|forbid|role/i);
});

// ---------------------------------------------------------------------------
// CASHIER_DESIGN_V2 — drawer movements, shift report, invoice list, void
// ---------------------------------------------------------------------------
test('cash_move: in/out affect drawer + close math; overdraw and no-shift rejected', () => {
  const { db, vid, vs1 } = seed();
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar); // 50000

  // no open shift -> rejected
  assert.throws(() => cashMove(db, { kind: 'in', amount: 1000 }, cashier), /смен|shift/i);

  const { shift } = openCashShift(db, { opening_float: 10000 }, cashier);
  recordPayment(db, { invoice_id: invoice.id, amount: 20000, method: 'cash' }, cashier);
  cashMove(db, { kind: 'in', amount: 5000, article: 'Спонсорская помощь' }, cashier);
  cashMove(db, { kind: 'out', amount: 8000, article: 'Инкассация' }, cashier);

  // drawer = 10000 + 20000 + 5000 - 8000 = 27000
  const sum = cashShiftSummary(db, {}, cashier);
  assert.equal(sum.cash_in, 5000);
  assert.equal(sum.cash_out, 8000);
  assert.equal(sum.expected_drawer, 27000);

  // withdrawing more than the drawer is rejected
  assert.throws(() => cashMove(db, { kind: 'out', amount: 27001 }, cashier), /кассе|нельзя/i);
  assert.throws(() => cashMove(db, { kind: 'sideways', amount: 100 }, cashier), /kind/i);
  assert.throws(() => cashMove(db, { kind: 'in', amount: 0 }, cashier), /amount|positive/i);

  // close: expected includes the movements
  const res = closeCashShift(db, { shift_id: shift.id, counted_amount: 27000 }, cashier);
  assert.equal(res.shift.expected_amount, 27000);
  assert.equal(res.shift.over_short, 0);
});

test('shift_report returns totals, payments and movements; own-shift gate', () => {
  const { db, vid, vs1, vs2 } = seed();
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, registrar); // 110000
  const { shift } = openCashShift(db, { opening_float: 1000 }, cashier);
  recordPayment(db, { invoice_id: invoice.id, amount: 40000, method: 'cash' }, cashier);
  recordPayment(db, { invoice_id: invoice.id, amount: 15000, method: 'acquiring' }, cashier);
  cashMove(db, { kind: 'out', amount: 500, article: 'Транспорт' }, cashier);

  const r = shiftReport(db, {}, cashier);
  assert.equal(r.shift.id, shift.id);
  assert.equal(r.totals.cash, 40000);
  assert.equal(r.totals.acquiring, 15000);
  assert.equal(r.payments.length, 2);
  assert.equal(r.movements.length, 1);
  assert.equal(r.expected_drawer, 40500); // 1000 + 40000 - 500
  assert.ok(r.payments[0].patient);

  // another cashier may not read this shift by id; admin may
  assert.throws(() => shiftReport(db, { shift_id: shift.id }, cashier2), /403|own/i);
  assert.equal(shiftReport(db, { shift_id: shift.id }, admin).shift.id, shift.id);
});

test('cashier_invoices returns joined rows and per-status chip aggregates', () => {
  const { db, vid, vs1, vs2 } = seed();
  db.prepare("UPDATE users SET full_name='Доктор Д.' WHERE id=5").run();
  db.prepare('UPDATE visits SET doctor_id=5 WHERE id=?').run(vid);
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, registrar); // 110000, 2 items
  openCashShift(db, { opening_float: 0 }, cashier);
  recordPayment(db, { invoice_id: invoice.id, amount: 10000, method: 'cash' }, cashier);

  const r = cashierInvoices(db, {}, cashier);
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.patient_name, 'P');
  assert.equal(row.doctor_name, 'Доктор Д.');
  assert.equal(row.items_count, 2);
  assert.equal(row.first_item, 'Consult');
  assert.equal(row.methods, 'cash');
  assert.equal(row.status, 'partial');
  assert.equal(r.counts.partial.n, 1);
  assert.equal(r.counts.all.n, 1);
  assert.equal(r.counts.all.sum, 110000);
});

test('void_invoice cancels only money-free invoices and re-opens visit services', () => {
  const { db, vid, vs1, vs2 } = seed();
  const inv1 = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar).invoice;
  const inv2 = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs2] }, registrar).invoice;
  openCashShift(db, { opening_float: 0 }, cashier);
  recordPayment(db, { invoice_id: inv2.id, amount: 5000, method: 'cash' }, cashier);

  const res = voidInvoice(db, { invoice_id: inv1.id }, cashier);
  assert.equal(res.invoice.status, 'void');
  // the visit line is free for re-billing again
  const vsRow = db.prepare('SELECT invoice_item_id, status FROM visit_services WHERE id=?').get(vs1);
  assert.equal(vsRow.invoice_item_id, null);
  assert.equal(vsRow.status, 'added');
  // double-void rejected; paid invoice rejected
  assert.throws(() => voidInvoice(db, { invoice_id: inv1.id }, cashier), /отмен/i);
  assert.throws(() => voidInvoice(db, { invoice_id: inv2.id }, cashier), /возврат|деньги/i);
});

// Money inputs are capped so round2 can never overflow a finite value to Infinity
// (which would poison expected/over_short and any SUM across shifts).
test('open/close reject absurd money inputs (> 1e12) with 400, not Infinity', () => {
  const { db } = seed();
  assert.throws(() => openCashShift(db, { opening_float: 1e308 }, cashier), /400|1e12|finite|between/i);
  const { shift } = openCashShift(db, { opening_float: 0 }, cashier);
  assert.throws(() => closeCashShift(db, { shift_id: shift.id, counted_amount: 1e308 }, cashier), /400|1e12|finite|between/i);
  // the shift stays open and uncorrupted after the rejected close
  const still = db.prepare('SELECT status, expected_amount FROM cash_shifts WHERE id=?').get(shift.id);
  assert.equal(still.status, 'open');
  assert.equal(still.expected_amount, null);
});

// ADM_LINE_RELEASE_V1 — REGRESSION: void released visit_services only, so an
// admission's lines stayed bolted to the voided invoice. Re-billing refused them
// ("already invoiced") and «Из счёта» refused them (invoice no longer 'unpaid'),
// leaving the treatment permanently unbillable.
test('voiding an admission invoice releases its admission lines so they can be re-billed', () => {
  const { db, pid } = seed();
  const ward = db.prepare("INSERT INTO wards (name) VALUES ('W')").run().lastInsertRowid;
  const bed = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('B1',?,'free')").run(ward).lastInsertRowid;
  const adm = admitPatient(db, { patient_id: pid, bed_id: bed }, { id: 1, role: 'admin' }).admission;
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Дренаж', 40000)").run().lastInsertRowid;
  const line = db.prepare("INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, status, billable) VALUES (?,?,1,40000,40000,'added',1)").run(adm.id, svc).lastInsertRowid;

  const { invoice } = createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [line] }, registrar);
  assert.ok(db.prepare('SELECT invoice_item_id FROM admission_services WHERE id=?').get(line).invoice_item_id);

  voidInvoice(db, { invoice_id: invoice.id }, cashier);

  const after = db.prepare('SELECT invoice_item_id, status FROM admission_services WHERE id=?').get(line);
  assert.equal(after.invoice_item_id, null, 'the line must be released, not stranded');
  assert.equal(after.status, 'added');

  // Proof it is genuinely usable again: it re-bills onto a fresh invoice.
  const second = createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [line] }, registrar);
  assert.equal(second.invoice.total_amount, 40000);
  assert.notEqual(second.invoice.id, invoice.id);
});

test('void refuses an already-void invoice via the lifecycle table', () => {
  const { db, vid, vs1 } = seed();
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar);
  voidInvoice(db, { invoice_id: invoice.id }, cashier);
  assert.throws(() => voidInvoice(db, { invoice_id: invoice.id }, cashier), /отменён/i);
});
