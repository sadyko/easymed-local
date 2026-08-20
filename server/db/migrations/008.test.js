import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('008 creates a single seeded doc_settings row', () => {
  const db = openDb(':memory:'); migrate(db);
  const row = db.prepare('SELECT * FROM doc_settings WHERE id=1').get();
  assert.ok(row, 'seeded row exists');
  assert.equal(row.accent_color, '#167873');   // default accent
  assert.equal(row.paper_size, 'A4');
  // id is pinned to 1 (single-row table)
  assert.throws(() => db.prepare("INSERT INTO doc_settings (id, clinic_name) VALUES (2,'x')").run());
  // update works
  db.prepare("UPDATE doc_settings SET clinic_name='My Clinic' WHERE id=1").run();
  assert.equal(db.prepare('SELECT clinic_name FROM doc_settings WHERE id=1').get().clinic_name, 'My Clinic');
});
