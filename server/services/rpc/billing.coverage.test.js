// COVERAGE_SPLIT_V1 — визит делится на два счёта: покрытые услуги идут
// контрагенту (invoices.payer_id), остальные — пациенту (payer_id IS NULL).
// Деньги, поэтому проверяется и то, что подделать плательщика нельзя.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit } from './billing.js';

const registrar = { id: 1, role: 'registrar' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  // invoices.created_by REFERENCES users(id) and foreign_keys are ON.
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1,'reg1','x','registrar')").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Test Test')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1,1,'2026-08-16T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, price, active) VALUES (10,'Консультация',50000,1),(11,'Анализ',30000,1),(12,'УЗИ',20000,1)").run();
  db.prepare("INSERT INTO payers (id, name, kind, active) VALUES (7,'Esado','insurance',1),(8,'Закрытая','insurance',0)").run();
  const vs = [10, 11, 12].map((sid, i) => db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (1,?,1,?,?,'added')"
  ).run(sid, [50000, 30000, 20000][i], [50000, 30000, 20000][i]).lastInsertRowid);
  return { db, vs };
}

test('split: covered lines bill the payer, the rest bill the patient', () => {
  const { db, vs } = seed();
  const ins = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0], vs[1]], payer_id: 7 }, registrar);
  const pat = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[2]] }, registrar);

  assert.equal(ins.invoice.total_amount, 80000);
  assert.equal(pat.invoice.total_amount, 20000);

  const row = (id) => db.prepare('SELECT payer_id, total_amount FROM invoices WHERE id = ?').get(id);
  assert.equal(row(ins.invoice.id).payer_id, 7, 'insurer invoice carries the payer');
  assert.equal(row(pat.invoice.id).payer_id, null, 'patient invoice has no payer');

  // Обе половины вместе — весь визит, ничего не потеряно и не задвоено.
  assert.equal(row(ins.invoice.id).total_amount + row(pat.invoice.id).total_amount, 100000);
});

test('omitting payer_id keeps the old behaviour (patient invoice)', () => {
  const { db, vs } = seed();
  const r = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]] }, registrar);
  assert.equal(db.prepare('SELECT payer_id FROM invoices WHERE id = ?').get(r.invoice.id).payer_id, null);
});

test('explicit null payer_id is accepted as "patient pays"', () => {
  const { db, vs } = seed();
  const r = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]], payer_id: null }, registrar);
  assert.equal(db.prepare('SELECT payer_id FROM invoices WHERE id = ?').get(r.invoice.id).payer_id, null);
});

test('a line cannot be billed twice — second invoice for the same service is refused', () => {
  const { db, vs } = seed();
  createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]], payer_id: 7 }, registrar);
  assert.throws(
    () => createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]] }, registrar),
    /already invoiced/,
    'the same service must not land on both the payer and the patient invoice'
  );
});

test('unknown payer is rejected', () => {
  const { db, vs } = seed();
  assert.throws(() => createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]], payer_id: 999 }, registrar), /payer 999 not found/);
});

test('inactive payer is rejected', () => {
  const { db, vs } = seed();
  assert.throws(() => createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]], payer_id: 8 }, registrar), /inactive/);
});

test('malformed payer_id is rejected (no silent coercion)', () => {
  const { db, vs } = seed();
  for (const bad of [0, -3, 1.5, 'ten', {}]) {
    assert.throws(
      () => createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]], payer_id: bad }, registrar),
      /payer_id must be a positive integer/,
      'payer_id=' + JSON.stringify(bad)
    );
  }
});

test('discount applies to the patient invoice only when the caller says so', () => {
  const { db, vs } = seed();
  const ins = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[0]], payer_id: 7, discount_amount: 0 }, registrar);
  const pat = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs[1]], discount_amount: 5000 }, registrar);
  assert.equal(ins.invoice.discount_amount, 0);
  assert.equal(pat.invoice.total_amount, 25000);
});
