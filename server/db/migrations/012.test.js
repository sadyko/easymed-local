import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('012 creates settings-match config tables with defaults/CHECKs and FKs', () => {
  const db = openDb(':memory:'); migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
  for (const t of ['payer_policies','payment_providers','cashback_rules','referral_source_categories','referral_rewards','patient_discounts','api_tokens','doctor_rates']) assert.ok(tables.includes(t),'missing '+t);

  // patient_discounts kind CHECK + defaults
  const d = db.prepare("INSERT INTO patient_discounts (name) VALUES ('New year')").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT kind, active FROM patient_discounts WHERE id=?').get(d).kind, 'promo');
  assert.throws(() => db.prepare("INSERT INTO patient_discounts (name, kind) VALUES ('X','bogus')").run());

  // payer_policies -> payers FK (payers seeded? no — insert a payer first)
  const pay = db.prepare("INSERT INTO payers (name) VALUES ('Uzbekinvest')").run().lastInsertRowid;
  const pol = db.prepare("INSERT INTO payer_policies (name, payer_id, coverage_percent) VALUES ('Gold', ?, 80)").run(pay).lastInsertRowid;
  assert.equal(db.prepare('SELECT coverage_percent FROM payer_policies WHERE id=?').get(pol).coverage_percent, 80);

  // doctor_rates -> users + services FKs
  const u = db.prepare("INSERT INTO users (username,password_hash,role) VALUES ('doc','x','doctor')").run().lastInsertRowid;
  const s = db.prepare("INSERT INTO services (name, price) VALUES ('Consult', 50000)").run().lastInsertRowid;
  const r = db.prepare("INSERT INTO doctor_rates (doctor_id, service_id, percent) VALUES (?,?,20)").run(u,s).lastInsertRowid;
  assert.equal(db.prepare('SELECT percent FROM doctor_rates WHERE id=?').get(r).percent, 20);
});
