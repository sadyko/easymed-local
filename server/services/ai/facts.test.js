import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { clinicFacts } from './facts.js';

test('сведения о клинике — только публичное: ни пациента, ни его телефона', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (full_name, phone, mrn) VALUES ('Маркер Пациентов', '+998 90 777 66 55', 'P-MARK')").run();
  const facts = clinicFacts(db);
  const text = JSON.stringify(facts);
  for (const secret of ['Маркер', '777 66 55', '998907776655', 'P-MARK']) assert.ok(!text.includes(secret), 'утекло: ' + secret);
  assert.ok(Array.isArray(facts.services) && Array.isArray(facts.doctors) && Array.isArray(facts.branches));
  assert.equal(typeof facts.clinic, 'object');
});

test('2000 публичных услуг укладываются в лимит запроса', () => {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare("INSERT INTO services (name, name_uz, name_en, price, active, online_booking) VALUES (?,?,?,?,1,1)");
  db.transaction(() => { for (let i = 0; i < 2000; i++) ins.run('Услуга номер ' + i, 'Xizmat ' + i, 'Service ' + i, 10000 + i); })();
  const facts = clinicFacts(db);
  assert.equal(facts.services.length, 2000, 'услуги действительно показаны');
  assert.equal(typeof facts.services[0].name, 'string');
  assert.ok(!('id' in facts.services[0]));
  assert.ok(JSON.stringify(facts).length < 200_000);
});
