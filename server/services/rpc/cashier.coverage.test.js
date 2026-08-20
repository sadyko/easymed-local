// COVERAGE_SPLIT_V1 — счета страховой/организации не попадают в кассу: по ним
// не берут наличные (расчёт по акту), и «долг», который пациент не может
// закрыть, не должен висеть в «Приём оплат» ни строкой, ни в чипах.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit } from './billing.js';
import { cashierInvoices } from './cashier.js';

const registrar = { id: 1, role: 'registrar' };
const cashier   = { id: 2, role: 'cashier' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1,'reg','x','registrar'),(2,'cash','x','cashier')").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Test')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1,1,'2026-08-16T09:00:00Z')").run();
  db.prepare("INSERT INTO services (id, name, price, active) VALUES (10,'Консультация',50000,1),(11,'Анализ',30000,1)").run();
  db.prepare("INSERT INTO payers (id, name, kind, active) VALUES (7,'ФМС','government',1)").run();
  const vs = [10, 11].map((sid, i) => db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (1,?,1,?,?,'added')"
  ).run(sid, [50000, 30000][i], [50000, 30000][i]).lastInsertRowid);
  return { db, vs };
}

test('a payer invoice never appears in the cashier queue', () => {
  const { db, vs } = seed();
  const payerInv   = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]], payer_id: 7 }, registrar);
  const patientInv = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[1]] }, registrar);

  const { rows } = cashierInvoices(db, {}, cashier);
  const ids = rows.map(r => r.id);
  assert.ok(ids.includes(patientInv.invoice.id), 'patient invoice must be collectable');
  assert.ok(!ids.includes(payerInv.invoice.id), 'payer invoice must NOT be in the cash queue');
});

test('chip totals exclude payer invoices too', () => {
  const { db, vs } = seed();
  createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]], payer_id: 7 }, registrar);   // 50000
  createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[1]] }, registrar);                // 30000

  const { counts } = cashierInvoices(db, {}, cashier);
  // Иначе кассир в конце смены сводил бы кассу на 80 000 вместо 30 000.
  assert.equal(counts.unpaid.n, 1, 'only the patient invoice is unpaid-in-cash');
  assert.equal(counts.unpaid.sum, 30000);
  assert.equal(counts.all.n, 1);
  assert.equal(counts.all.sum, 30000);
});

test('with no payer invoices the queue is unchanged (no regression)', () => {
  const { db, vs } = seed();
  const a = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]] }, registrar);
  const b = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[1]] }, registrar);
  const { rows, counts } = cashierInvoices(db, {}, cashier);
  assert.deepEqual(rows.map(r => r.id).sort(), [a.invoice.id, b.invoice.id].sort());
  assert.equal(counts.unpaid.sum, 80000);
});

test('the row carries the payer name so mixed lists stay readable', () => {
  // Счета плательщика в кассе нет, но поле payer_* используется и в других
  // местах кассы (окно оплаты, список счетов пациента) — оно должно приходить.
  const { db, vs } = seed();
  createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[1]] }, registrar);
  const { rows } = cashierInvoices(db, {}, cashier);
  assert.ok('payer_id' in rows[0], 'payer_id is selected');
  assert.equal(rows[0].payer_id, null);
  assert.equal(rows[0].payer_name, null);
});
