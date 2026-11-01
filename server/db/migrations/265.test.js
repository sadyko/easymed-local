// PATIENT_LEAD_SOURCE_V1 — миграция 265: откуда пациент о нас узнал.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('мигр. 265: у пациента есть lead_source, по умолчанию пусто', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(patients)').all().map((c) => c.name);
  assert.ok(cols.includes('lead_source'));
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Тест') RETURNING id").get().id;
  assert.equal(db.prepare('SELECT lead_source FROM patients WHERE id = ?').get(id).lead_source, null);
  db.prepare("UPDATE patients SET lead_source = 'walk_in' WHERE id = ?").run(id);
  assert.equal(db.prepare('SELECT lead_source FROM patients WHERE id = ?').get(id).lead_source, 'walk_in');
});
