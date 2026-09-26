// INPATIENT_BONUS_V1, ревью I1 (мигр. 156) — направивший врач госпитализации
// отдельной колонкой: лечащий сюда не пишется, старые строки пусты.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('156: admissions.referring_doctor_id — пусто по умолчанию, врача удалили — пусто', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const c = db.prepare('PRAGMA table_info(admissions)').all().find((x) => x.name === 'referring_doctor_id');
    assert.ok(c, 'нет колонки');
    assert.equal(c.notnull, 0);
    assert.equal(c.dflt_value, null);
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (4, 'doc', 'x', 'doctor')").run();
    const pt = db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid;
    const a = db.prepare("INSERT INTO admissions (patient_id, status, doctor_id) VALUES (?, 'active', 4)").run(pt).lastInsertRowid;
    assert.equal(db.prepare('SELECT referring_doctor_id FROM admissions WHERE id = ?').get(a).referring_doctor_id, null,
      'колонка не наследует admissions.doctor_id');
    db.prepare('UPDATE admissions SET referring_doctor_id = 4, doctor_id = NULL WHERE id = ?').run(a);
    db.prepare('DELETE FROM users WHERE id = 4').run();
    assert.equal(db.prepare('SELECT referring_doctor_id FROM admissions WHERE id = ?').get(a).referring_doctor_id, null);
  } finally { db.close(); }
});
