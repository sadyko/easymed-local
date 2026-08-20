import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('002 creates core tables, seeds one branch, and auto-generates patient MRN', () => {
  const db = openDb(':memory:');
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['branches','patients','payers','referral_sources']) assert.ok(tables.includes(t), `missing ${t}`);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM branches').get().n, 1);

  const info = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Test Patient', 1)").run();
  const row = db.prepare('SELECT mrn FROM patients WHERE id = ?').get(info.lastInsertRowid);
  assert.match(row.mrn, /^P-\d{2}-\d{5}$/);

  const info2 = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Two', 1)").run();
  assert.notEqual(db.prepare('SELECT mrn FROM patients WHERE id=?').get(info2.lastInsertRowid).mrn, row.mrn);
});
