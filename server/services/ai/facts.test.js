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
