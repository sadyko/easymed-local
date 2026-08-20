// DOCTOR_OWN_PRICE_V1 — a doctor's own price for a service beats the catalog.
//
// The subtle case throughout is that "no own price" and "an own price of 0" are
// different facts. If they are conflated in any layer, either a free service
// silently bills at the catalog rate, or a doctor with no override silently
// bills at zero — so every layer is tested for it explicitly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { doctorPriceFor, unitPriceFor } from './pricing.js';
import { parseEmployeeFields } from '../../routes/users.js';
import { createInvoiceForVisit } from '../rpc/billing.js';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role) VALUES (7,'reg','x','registrar')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role) VALUES (3,'doc','x','doctor')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role) VALUES (4,'doc2','x','doctor')").run();
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('P',1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,'2026-08-12T09:00:00Z')").run(pid).lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Consultation', 50000)").run().lastInsertRowid;
  return { db, pid, vid, svc };
}

const registrar = { id: 7, role: 'registrar' };

function setRates(db, userId, rates) {
  const parsed = parseEmployeeFields({ service_rates: rates }, db);
  assert.ok(parsed.ok, parsed.message);
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(parsed.fields.service_rates, userId);
}

test('parseEmployeeFields stores an own price and keeps the doctor percentage', () => {
  const { db, svc } = seed();
  const parsed = parseEmployeeFields({
    service_rates: [{ service_id: svc, price: 75000, percentage: 30, branches: [1] }],
  }, db);
  assert.ok(parsed.ok);
  const stored = JSON.parse(parsed.fields.service_rates);
  assert.equal(stored[0].price, 75000);
  // 'percentage' is the editor's name for it; canonical storage is 'pct', which
  // is what the reports read. Before this it was dropped and every rate saved 0.
  assert.equal(stored[0].pct, 30);
  assert.deepEqual(stored[0].branches, [1]);
});

// DOCTOR_FIX_RATE_V1 — the fixed per-unit rate. parseRates whitelists the entry
// shape, so an unrecognised key is dropped WITHOUT error: a rate typed into the
// editor would save "successfully" and pay nothing. These pin the contract.
test('a fixed rate survives the save, alongside the percentage it replaces', () => {
  const { db, svc } = seed();
  const parsed = parseEmployeeFields({
    service_rates: [{ service_id: svc, pct: 30, fix: 50000, branches: [] }],
  }, db);
  assert.ok(parsed.ok, parsed.message);
  const stored = JSON.parse(parsed.fields.service_rates);
  assert.equal(stored[0].fix, 50000);
  // pct is kept so switching the service back to a percentage in the editor
  // restores the rate that was agreed, rather than resetting it to 0.
  assert.equal(stored[0].pct, 30);
});

test('no fixed rate leaves the key out entirely — absence IS the percentage mode', () => {
  const { db, svc } = seed();
  for (const entry of [{ service_id: svc, pct: 30 }, { service_id: svc, pct: 30, fix: null }, { service_id: svc, pct: 30, fix: '' }]) {
    const stored = JSON.parse(parseEmployeeFields({ service_rates: [entry] }, db).fields.service_rates);
    assert.ok(!('fix' in stored[0]), 'a blank fixed rate must not persist as 0 — that would pay the doctor nothing');
  }
});

test('a fixed rate of 0 is a real rate, not "unset"', () => {
  const { db, svc } = seed();
  const stored = JSON.parse(parseEmployeeFields({ service_rates: [{ service_id: svc, pct: 30, fix: 0 }] }, db).fields.service_rates);
  assert.equal(stored[0].fix, 0);
});

test('a nonsensical fixed rate is rejected, not silently clamped', () => {
  const { db, svc } = seed();
  for (const bad of [-1, 1e13, 'abc', Infinity]) {
    const parsed = parseEmployeeFields({ service_rates: [{ service_id: svc, pct: 30, fix: bad }] }, db);
    assert.equal(parsed.ok, false, `fix=${bad} should be rejected`);
  }
});

test('an omitted price is stored as absent, not as 0', () => {
  const { db, svc } = seed();
  const parsed = parseEmployeeFields({ service_rates: [{ service_id: svc, pct: 10 }] }, db);
  const stored = JSON.parse(parsed.fields.service_rates);
  assert.ok(!('price' in stored[0]), 'no own price must leave the key out entirely');

  for (const blank of [null, '']) {
    const p = parseEmployeeFields({ service_rates: [{ service_id: svc, pct: 10, price: blank }] }, db);
    assert.ok(!('price' in JSON.parse(p.fields.service_rates)[0]), `${JSON.stringify(blank)} must clear the override`);
  }
});

test('an invalid own price is refused rather than silently coerced', () => {
  const { db, svc } = seed();
  for (const bad of [-1, 1e13, 'abc', NaN, Infinity]) {
    const p = parseEmployeeFields({ service_rates: [{ service_id: svc, price: bad }] }, db);
    assert.equal(p.ok, false, `price ${bad} must be rejected`);
    assert.match(p.message, /price/i);
  }
});

test('doctorPriceFor returns the override, and null when there is none', () => {
  const { db, svc } = seed();
  setRates(db, 3, [{ service_id: svc, price: 75000, pct: 30 }]);

  assert.equal(doctorPriceFor(db, 3, svc), 75000);
  assert.equal(doctorPriceFor(db, 4, svc), null, 'a doctor with no rates has no override');
  assert.equal(doctorPriceFor(db, 3, 9999), null, 'a service the doctor has no rate for');
  assert.equal(doctorPriceFor(db, null, svc), null, 'an unassigned line has no override');
});

test('an own price of 0 is a real price, not "unset"', () => {
  const { db, svc } = seed();
  setRates(db, 3, [{ service_id: svc, price: 0, pct: 0 }]);
  assert.equal(doctorPriceFor(db, 3, svc), 0);
  // …and it must beat the catalog rather than falling through to it.
  assert.equal(unitPriceFor(db, { doctorId: 3, serviceId: svc, catalogPrice: 50000 }), 0);
});

test('unitPriceFor falls back to the catalog when the doctor has no own price', () => {
  const { db, svc } = seed();
  setRates(db, 3, [{ service_id: svc, pct: 30 }]);   // rate but no price
  assert.equal(unitPriceFor(db, { doctorId: 3, serviceId: svc, catalogPrice: 50000 }), 50000);
});

test('the invoice bills the performing doctor\'s own price, not the catalog', () => {
  const { db, vid, svc } = seed();
  setRates(db, 3, [{ service_id: svc, price: 75000, pct: 30 }]);

  // Same service, two doctors: one with an own price, one without.
  const own = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total) VALUES (?,?,3,1,50000,50000)").run(vid, svc).lastInsertRowid;
  const plain = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total) VALUES (?,?,4,2,50000,100000)").run(vid, svc).lastInsertRowid;

  const { invoice, items } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [own, plain] }, registrar);

  const byQty = Object.fromEntries(items.map((i) => [i.quantity, i]));
  assert.equal(byQty[1].unit_price, 75000, 'doctor 3 charges their own price');
  assert.equal(byQty[2].unit_price, 50000, 'doctor 4 falls back to the catalog');
  assert.equal(invoice.subtotal, 75000 + 100000);

  // The visit line is synced to what was actually billed, so the patient card
  // and the invoice cannot disagree.
  assert.equal(db.prepare('SELECT unit_price FROM visit_services WHERE id=?').get(own).unit_price, 75000);
});

test('a tampered client price still cannot beat the server: the own price wins', () => {
  const { db, vid, svc } = seed();
  setRates(db, 3, [{ service_id: svc, price: 75000, pct: 30 }]);
  const line = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total) VALUES (?,?,3,1,1,1)").run(vid, svc).lastInsertRowid;
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [line], unit_price: 1 }, registrar);
  assert.equal(invoice.total_amount, 75000);
});

test('a corrupt rates blob degrades to the catalog price instead of throwing', () => {
  const { db, svc } = seed();
  db.prepare("UPDATE users SET service_rates = 'not json' WHERE id = 3").run();
  assert.equal(doctorPriceFor(db, 3, svc), null);
  db.prepare("UPDATE users SET service_rates = ? WHERE id = 3").run(JSON.stringify([{ service_id: svc, price: -5 }]));
  assert.equal(doctorPriceFor(db, 3, svc), null, 'a negative stored price is ignored, never billed');
});
