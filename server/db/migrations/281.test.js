// LAB_ONE_BARCODE_V1 (ревью S3, L-4) — миграция 281: след удалённой строки визита
// (lab_line_gone) пишет триггер; существующие строки не тронуты.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '281_lab_line_gone.sql'), 'utf8');

function seed(db) {
  db.exec(`INSERT INTO services (id, name, is_lab) VALUES (40, 'ОАК', 1), (50, 'Приём', 0);
           INSERT INTO patients (id, full_name) VALUES (7, 'Т');
           INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 7, '2026-11-07', 'scheduled');
           INSERT INTO visit_services (id, visit_id, service_id, status, created_at, scheduled_at)
             VALUES (100, 20, 40, 'queued', '2026-11-07T05:00:00Z', NULL), (101, 20, 50, 'added', '2026-11-07T05:01:00Z', '2026-11-07T06:00:00Z');`);
}

test('281: удалённая строка визита оставляет след — визит и даты; живые строки — нет', () => {
  const db = openDb(':memory:');
  migrate(db);
  seed(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_line_gone').get().c, 0);
  db.exec('DELETE FROM visit_services WHERE id = 100');
  assert.deepEqual({ ...db.prepare('SELECT line_id, visit_id, created_at, scheduled_at FROM lab_line_gone').get() },
    { line_id: 100, visit_id: 20, created_at: '2026-11-07T05:00:00Z', scheduled_at: null });
  db.exec('DELETE FROM visit_services WHERE id = 101');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_line_gone').get().c, 2);
  db.close();
});

test('281 на базе клиники: прежние строки не тронуты; повторный прогон — без ошибок и без задвоения', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.exec('DROP TRIGGER visit_services_lab_gone; DROP TABLE lab_line_gone;');
  seed(db);
  const before = JSON.stringify(db.prepare('SELECT * FROM visit_services ORDER BY id').all());
  db.exec(SQL);
  db.exec(SQL);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM visit_services ORDER BY id').all()), before);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_line_gone').get().c, 0, 'задним числом ничего не пишется');
  db.exec('DELETE FROM visit_services WHERE id = 100');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_line_gone').get().c, 1, 'триггер один');
  db.close();
});
