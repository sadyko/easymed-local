// LAB_MATRIX_PANEL_V1 — миграция 280: вид панели и устройство таблицы; существующие
// панели остаются обычными, их показатели не тронуты.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '280_lab_matrix_panel.sql'), 'utf8');

test('280: lab_panels.kind — пусто по умолчанию, только \'\' или \'matrix\'; matrix_json — пусто', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO lab_panels (id, name, modality, active) VALUES (1, 'ОАК', 'lab', 1)").run();
  assert.deepEqual({ ...db.prepare('SELECT kind, matrix_json FROM lab_panels WHERE id = 1').get() }, { kind: '', matrix_json: null });
  db.prepare("UPDATE lab_panels SET kind = 'matrix' WHERE id = 1").run();
  assert.throws(() => db.prepare("UPDATE lab_panels SET kind = 'grid' WHERE id = 1").run(), /CHECK/);
  db.close();
});

test('280 на базе клиники: существующие панели и показатели не тронуты, вид — обычная', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.exec('ALTER TABLE lab_panels DROP COLUMN matrix_json; ALTER TABLE lab_panels DROP COLUMN kind;');
  db.exec(`INSERT INTO lab_panels (id, name, modality, active) VALUES (7, 'Мазок', 'lab', 1);
           INSERT INTO lab_panel_analytes (id, panel_id, name, value_type, sort_order, group_label) VALUES (70, 7, 'Лейкоциты', 'numeric', 0, 'U');`);
  db.exec(SQL);
  assert.deepEqual({ ...db.prepare('SELECT name, kind, matrix_json FROM lab_panels WHERE id = 7').get() }, { name: 'Мазок', kind: '', matrix_json: null });
  assert.deepEqual({ ...db.prepare('SELECT name, group_label FROM lab_panel_analytes WHERE id = 70').get() }, { name: 'Лейкоциты', group_label: 'U' });
  db.close();
});
