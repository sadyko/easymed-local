// SLOT_BUSY_LINES_V1 — миграция 288: частичный индекс visit_services(doctor_id, scheduled_at)
// под занятость врача строками визитов (rpc/calendar.js loadLineBusy, lineBusySql).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { lineBusySql } from '../../services/rpc/calendar.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

/** База версии до 288: все миграции ниже 288. */
function before288() {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig288-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 288 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  return db;
}

test('288: индекс «врач строки + время строки» — частичный, данных не меняет, запрос занятости строками идёт по нему', () => {
  const db = before288();
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (7, 'doc', 'x', 'Врач', 'doctor', 1)").run();
    db.prepare("INSERT INTO patients (id, full_name) VALUES (3, 'Пациент')").run();
    db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (1, 3, 7, '2030-01-07T04:00:00.000Z', 'scheduled')").run();
    db.prepare("INSERT INTO visit_services (visit_id, doctor_id, status, scheduled_at) VALUES (1, 7, 'added', '2030-01-07T10:00:00.000Z'), (1, NULL, 'added', NULL)").run();
    const rows = () => db.prepare('SELECT * FROM visit_services ORDER BY id').all();
    const journal = () => db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n;
    const before = rows();
    const jBefore = journal();
    migrate(db);
    assert.deepEqual(rows(), before, 'строки визита изменились');
    assert.equal(journal(), jBefore, 'в журнал синхронизации что-то попало');
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_visit_services_doctor_sched'").get();
    assert.ok(idx && /\(doctor_id, scheduled_at\)/.test(idx.sql) && /WHERE scheduled_at IS NOT NULL/.test(idx.sql), 'нет частичного индекса: ' + (idx && idx.sql));
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + lineBusySql(1)).all(7, '2030-01-06T00:00:00.000Z', '2030-01-09T00:00:00.000Z')
      .map((r) => r.detail).join(' | ');
    assert.match(plan, /idx_visit_services_doctor_sched \(doctor_id=\? AND scheduled_at>\? AND scheduled_at<\?\)/, plan);
    migrate(db);   // повторный запуск ничего не меняет
    assert.deepEqual(rows(), before);
  } finally { db.close(); }
});
