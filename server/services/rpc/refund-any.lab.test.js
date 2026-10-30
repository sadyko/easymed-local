// REFUND_ANY_V1 (2026-10-29) — «УСЛУГА ВОЗВРАЩЕНА»: ЛАБОРАТОРИЯ И ДОКУМЕНТЫ.
//
// Касса отпускает со счёта строку, за которую пациенту вернули деньги
// (refund_invoice_line, отмена счёта после возврата), и строка остаётся в
// визите со СВОИМ статусом ('queued', 'collected', 'in_progress'…): статус
// здесь не переписывается — по нему платят врачу и ведут работу. Отметка —
// pay_refund_releases 'out' (мигр. 162), её снимает новый счёт
// (create_invoice_for_visit). Лаборатория и анализатор проверяли только статус,
// и возвращённая проба продолжала идти. Теперь «возвращена» = отметка есть и
// строка без счёта:
//   • refunded_lines — какие из строк возвращены (лист лаборатории, кабинет);
//   • save_lab_results и перевод в работу — отказ, пока результата нет;
//     внесённый результат правится, как прежде;
//   • visit_document_archive — новый документ на возвращённую строку не
//     подписывается; прежние остаются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment, refundInvoiceLine, refundedLines } from './billing.js';
import { openCashShift } from './cashier.js';
import { saveLabResults } from './lab.js';
import { visitDocumentArchive } from './patient-card.js';
import { unpaidWorkRefusal } from '../visit-status-guard.js';
import { refundedOpenLineIds, refundedWithoutResult } from '../domain/pay-releases.js';
import { REFUNDED_LAB_REFUSAL, REFUNDED_SIGN_REFUSAL } from '../../../public/js/shared/refunded-line.js';
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const registrar = { id: 7, role: 'registrar' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const lab = { id: 2, role: 'lab' };
const doctor = { id: 20, role: 'doctor', full_name: 'Врач' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(2, 'lab', 'x', 'lab', 'Лаборант', 0);
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0);
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0);
  u.run(20, 'doc', 'x', 'doctor', 'Врач', 1);
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Пациент', 1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const cbc = db.prepare("INSERT INTO services (name, price, type, is_lab) VALUES ('ОАК', 40000, 'lab', 1)").run().lastInsertRowid;
  const glu = db.prepare("INSERT INTO services (name, price, type, is_lab) VALUES ('Глюкоза', 30000, 'lab', 1)").run().lastInsertRowid;
  const consult = db.prepare("INSERT INTO services (name, price, type) VALUES ('Приём', 100000, 'consultation')").run().lastInsertRowid;
  const line = db.prepare('INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total) VALUES (?, ?, ?, 1, 0, 0)');
  const a = line.run(vid, cbc, null).lastInsertRowid;
  const b = line.run(vid, glu, null).lastInsertRowid;
  const c = line.run(vid, consult, 20).lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, cashier);
  const inv = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [a, b, c] }, registrar).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, cashier);
  return { db, pid, vid, a, b, c, inv };
}
const itemOf = (db, id) => db.prepare('SELECT invoice_item_id i FROM visit_services WHERE id = ?').get(id).i;
const statusOf = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;
const one = [{ parameter: 'Hb', value: '120', flag: 'normal' }];
// Проба взята, потом пациенту вернули деньги строкой.
function refundedSample() {
  const f = seed();
  f.db.prepare("UPDATE visit_services SET status = 'collected', sample_collected_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(f.a);
  refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.a) }, cashier);
  return f;
}

test('возвращённая строка: отметка «out», без счёта; статус прежний; новый счёт снимает «возвращена»', () => {
  const f = refundedSample();
  assert.equal(statusOf(f.db, f.a), 'collected', 'статус не переписан');
  assert.deepEqual(refundedOpenLineIds(f.db, [f.a, f.b, f.c]), [f.a]);
  assert.equal(refundedWithoutResult(f.db, f.a), true);
  assert.deepEqual(refundedLines(f.db, { line_ids: [f.a, f.b] }, lab).line_ids, [f.a]);
  createInvoiceForVisit(f.db, { visit_id: f.vid, visit_service_ids: [f.a], rebill_refunded: true }, registrar);
  assert.deepEqual(refundedOpenLineIds(f.db, [f.a]), [], 'выставили заново — снова обычная строка');
});

test('refunded_lines: только номера; не список или больше 1000 — отказ; RPC чтения', () => {
  const f = seed();
  assert.throws(() => refundedLines(f.db, { line_ids: 'x' }, lab), (e) => e.status === 400);
  assert.throws(() => refundedLines(f.db, { line_ids: Array.from({ length: 1001 }, (_, i) => i + 1) }, lab), (e) => e.status === 400);
  assert.throws(() => refundedLines(f.db, { line_ids: [1] }, null), (e) => e.status === 401);
  assert.deepEqual(refundedLines(f.db, { line_ids: [] }, lab).line_ids, []);
  assert.equal(typeof RPC.refunded_lines, 'function');
  assert.equal(isReadOnlyRpc('refunded_lines'), true);
});

test('лаборатория: результат на возвращённую пробу не принимается, в работу она не идёт; с результатом — правка как прежде', () => {
  const f = refundedSample();
  assert.throws(() => saveLabResults(f.db, { visit_service_id: f.a, rows: one }, lab), (e) => e.status === 400 && e.message === REFUNDED_LAB_REFUSAL);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lab_results WHERE visit_service_id = ?').get(f.a).n, 0);
  assert.equal(unpaidWorkRefusal(f.db, [f.a], 'in_progress'), REFUNDED_LAB_REFUSAL);
  assert.equal(unpaidWorkRefusal(f.db, [f.a], 'cancelled'), null, 'отменить — можно');
  assert.equal(unpaidWorkRefusal(f.db, [f.b], 'collected'), null, 'оплаченная проба — как прежде');
  // Результат внесли ДО возврата — он остаётся, его правят.
  const g = seed();
  g.db.prepare("UPDATE visit_services SET status = 'collected' WHERE id = ?").run(g.b);
  saveLabResults(g.db, { visit_service_id: g.b, rows: one }, lab);
  refundInvoiceLine(g.db, { invoice_item_id: itemOf(g.db, g.b) }, cashier);
  assert.equal(refundedWithoutResult(g.db, g.b), false);
  saveLabResults(g.db, { visit_service_id: g.b, rows: [{ parameter: 'Hb', value: '121', flag: 'normal' }] }, lab);
  assert.equal(unpaidWorkRefusal(g.db, [g.b], 'completed'), null, 'внесённое выдают, как прежде');
});

test('кабинет врача: новый документ на возвращённую строку не подписывается; прежний остаётся', () => {
  const f = seed();
  f.db.prepare("UPDATE visit_services SET status = 'in_progress' WHERE id = ?").run(f.c);
  visitDocumentArchive(f.db, { visit_service_id: f.c, doc_type: 'protocol', title: 'Протокол', body: { complaints: 'Кашель' } }, doctor);
  refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.c) }, cashier);
  assert.throws(() => visitDocumentArchive(f.db, { visit_service_id: f.c, doc_type: 'protocol', title: 'Протокол', body: { complaints: 'Кашель, итог' } }, doctor),
    (e) => e.status === 409 && e.code === 'refunded_line' && e.message === REFUNDED_SIGN_REFUSAL);
  const docs = f.db.prepare('SELECT body, voided_at FROM visit_documents WHERE visit_service_id = ?').all(f.c);
  assert.equal(docs.length, 1, 'прежний документ на месте');
  assert.equal(docs[0].voided_at, null, 'и не отозван');
});
