// LAB_ROUND_V1 — миграция 279: настройка округления клиники (по умолчанию
// включена, и у существующей строки) и колонка полного значения прибора;
// существующие результаты не тронуты.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '279_lab_round.sql'), 'utf8');

test('279: doc_settings.lab_round_analyzer — 1 по умолчанию, только 0 или 1; lab_results.raw_value — пусто', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.equal(db.prepare('SELECT lab_round_analyzer AS v FROM doc_settings WHERE id = 1').get().v, 1);
  assert.throws(() => db.prepare('UPDATE doc_settings SET lab_round_analyzer = 2 WHERE id = 1').run(), /CHECK/);
  db.prepare('UPDATE doc_settings SET lab_round_analyzer = 0 WHERE id = 1').run();
  const col = db.prepare("SELECT * FROM pragma_table_info('lab_results') WHERE name = 'raw_value'").get();
  assert.ok(col, 'нет lab_results.raw_value');
  assert.equal(col.notnull, 0);
  db.close();
});

test('279 на базе клиники: прежние результаты и настройки не тронуты; строка настроек получает 1', () => {
  const db = openDb(':memory:');
  migrate(db);
  // Состояние клиники «до 279»: колонок ещё нет.
  db.exec('ALTER TABLE lab_results DROP COLUMN raw_value; ALTER TABLE doc_settings DROP COLUMN lab_round_analyzer;');
  db.exec(`UPDATE doc_settings SET clinic_name = 'Клиника', lab_scope = 'building' WHERE id = 1;
           INSERT INTO services (id, name, is_lab) VALUES (40, 'ОАК', 1); INSERT INTO patients (id, full_name) VALUES (7, 'Т'); INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 7, '2026-11-07', 'scheduled');
           INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (100, 20, 40, 'resulted');
           INSERT INTO lab_results (id, visit_service_id, parameter, value, numeric_value, flag, source) VALUES (1, 100, 'WBC', '4.152122', 4.152122, 'normal', 'analyzer');`);
  db.exec(SQL);
  assert.deepEqual({ ...db.prepare('SELECT clinic_name, lab_scope, lab_round_analyzer FROM doc_settings WHERE id = 1').get() },
    { clinic_name: 'Клиника', lab_scope: 'building', lab_round_analyzer: 1 });
  assert.deepEqual({ ...db.prepare('SELECT value, numeric_value, raw_value FROM lab_results WHERE id = 1').get() },
    { value: '4.152122', numeric_value: 4.152122, raw_value: null });
  db.close();
});
