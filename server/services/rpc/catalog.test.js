// SERVICE_DELETE_V1 — the rule that decides delete vs deactivate.
//
// The whole point of the RPC is that a service carrying history must NOT be
// removable: an invoice line and a visit record point at it by id, and the name
// on a past bill has to keep resolving. These tests pin each blocking table
// individually, because losing any one of them silently re-opens the hole.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { deleteService, serviceDeleteCheck } from './catalog.js';

const admin     = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const svc = db.prepare("INSERT INTO services (name, price, active) VALUES ('Тест услуга', 50000, 1)").run().lastInsertRowid;
  const patient = db.prepare("INSERT INTO patients (full_name) VALUES ('Тестов Тест')").run().lastInsertRowid;
  return { db, svc, patient };
}

test('deletes a service nothing references', () => {
  const { db, svc } = seed();
  assert.deepEqual(serviceDeleteCheck(db, { p_service_id: svc }, admin).deletable, true);

  const res = deleteService(db, { p_service_id: svc }, admin);
  assert.equal(res.deleted, true);
  assert.equal(res.name, 'Тест услуга');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM services WHERE id = ?').get(svc).n, 0);
});

test('config-only references (doctor rate, recommended link) go with the service', () => {
  const { db, svc } = seed();
  const doc = db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('doc','x','Doc','doctor')").run().lastInsertRowid;
  db.prepare('INSERT INTO doctor_rates (doctor_id, service_id, percent) VALUES (?,?,?)').run(doc, svc, 30);
  db.prepare('INSERT INTO recommended_services (service_id) VALUES (?)').run(svc);

  assert.equal(serviceDeleteCheck(db, { p_service_id: svc }, admin).deletable, true);
  deleteService(db, { p_service_id: svc }, admin);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM services WHERE id = ?').get(svc).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_rates WHERE service_id = ?').get(svc).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recommended_services WHERE service_id = ?').get(svc).n, 0);
});

test('a service used on a visit cannot be deleted — the visit keeps naming it', () => {
  const { db, svc, patient } = seed();
  const visit = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-08-16')").run(patient).lastInsertRowid;
  db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,1,50000,50000)').run(visit, svc);

  const check = serviceDeleteCheck(db, { p_service_id: svc }, admin);
  assert.equal(check.deletable, false);
  assert.deepEqual(check.blocking.map((b) => b.table), ['visit_services']);
  assert.equal(check.blocking[0].count, 1);

  assert.throws(() => deleteService(db, { p_service_id: svc }, admin), (e) => e.status === 409 && /визиты: 1/.test(e.message));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM services WHERE id = ?').get(svc).n, 1, 'the service must survive');
});

test('a service on an invoice cannot be deleted — the bill keeps naming it', () => {
  const { db, svc, patient } = seed();
  const inv = db.prepare("INSERT INTO invoices (patient_id, total_amount, status) VALUES (?, 50000, 'unpaid')").run(patient).lastInsertRowid;
  db.prepare('INSERT INTO invoice_items (invoice_id, service_id, quantity, unit_price, total) VALUES (?,?,1,50000,50000)').run(inv, svc);

  const check = serviceDeleteCheck(db, { p_service_id: svc }, admin);
  assert.equal(check.deletable, false);
  assert.deepEqual(check.blocking.map((b) => b.table), ['invoice_items']);
  assert.throws(() => deleteService(db, { p_service_id: svc }, admin), (e) => e.status === 409 && /счета: 1/.test(e.message));
});

test('the refusal names every table holding the service, not just the first', () => {
  const { db, svc, patient } = seed();
  const visit = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-08-16')").run(patient).lastInsertRowid;
  db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,1,50000,50000)').run(visit, svc);
  const inv = db.prepare("INSERT INTO invoices (patient_id, total_amount, status) VALUES (?, 50000, 'unpaid')").run(patient).lastInsertRowid;
  db.prepare('INSERT INTO invoice_items (invoice_id, service_id, quantity, unit_price, total) VALUES (?,?,1,50000,50000)').run(inv, svc);

  const check = serviceDeleteCheck(db, { p_service_id: svc }, admin);
  assert.deepEqual(check.blocking.map((b) => b.table).sort(), ['invoice_items', 'visit_services']);
  try {
    deleteService(db, { p_service_id: svc }, admin);
    assert.fail('should have refused');
  } catch (e) {
    assert.match(e.message, /визиты: 1/);
    assert.match(e.message, /счета: 1/);
    assert.match(e.message, /Отключите/, 'the refusal must point at the alternative');
  }
});

test('a CRM lead asking for the service blocks deletion', () => {
  const { db, svc } = seed();
  db.prepare("INSERT INTO crm_requests (full_name, phone, service_id) VALUES ('Лид','+998900000000',?)").run(svc);
  assert.equal(serviceDeleteCheck(db, { p_service_id: svc }, admin).deletable, false);
  assert.throws(() => deleteService(db, { p_service_id: svc }, admin), (e) => e.status === 409 && /заявки CRM: 1/.test(e.message));
});

test('a lab panel built on the service blocks deletion', () => {
  const { db, svc } = seed();
  db.prepare("INSERT INTO lab_panels (service_id, name) VALUES (?, 'ОАК')").run(svc);
  assert.equal(serviceDeleteCheck(db, { p_service_id: svc }, admin).deletable, false);
  assert.throws(() => deleteService(db, { p_service_id: svc }, admin), (e) => e.status === 409 && /лабораторные панели: 1/.test(e.message));
});

test('only an admin may delete or even check', () => {
  const { db, svc } = seed();
  assert.throws(() => deleteService(db, { p_service_id: svc }, registrar), (e) => e.status === 403);
  assert.throws(() => serviceDeleteCheck(db, { p_service_id: svc }, registrar), (e) => e.status === 403);
  assert.throws(() => deleteService(db, { p_service_id: svc }, null), (e) => e.status === 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM services WHERE id = ?').get(svc).n, 1);
});

test('validation: unknown id and rubbish input', () => {
  const { db } = seed();
  assert.throws(() => deleteService(db, { p_service_id: 999999 }, admin), (e) => e.status === 404);
  assert.throws(() => deleteService(db, { p_service_id: 0 }, admin), (e) => e.status === 400);
  assert.throws(() => deleteService(db, { p_service_id: 'abc' }, admin), (e) => e.status === 400);
  assert.throws(() => deleteService(db, {}, admin), (e) => e.status === 400);
});
