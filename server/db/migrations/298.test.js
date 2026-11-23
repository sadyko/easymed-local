// INPATIENT_REQUIRED_V1 — миграция 298: что в стационаре обязательно (одна строка настроек),
// журнал «кто менял» и обязательность документов истории болезни. Умолчания = поведение до 298.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// База клиники, которая работала до 298 (все миграции ниже 298).
function dbBefore298() {
  const db = openDb(':memory:');
  const tmp = tmpDir('mig298-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 298)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

test('298 INPATIENT_REQUIRED_V1: одна строка настроек, умолчания — сегодняшнее поведение', () => {
  const db = openDb(':memory:');
  migrate(db);
  const rows = db.prepare('SELECT * FROM inpatient_settings').all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, {
    id: 1, intake_before_attending: 1, admitting_at_placement: 1, primary_needs_diagnosis: 1,
    discharge_needs_epicrisis: 1, title_required: 1,
    title_required_fields: '["height_cm","weight_kg","temp_c","bp_sys","bp_dia","pulse_bpm","pediculosis","sanitation"]',
    updated_at: null, updated_by: null,
  });
  assert.throws(() => db.prepare('INSERT INTO inpatient_settings (id) VALUES (2)').run(), /CHECK/);
  for (const col of ['intake_before_attending', 'admitting_at_placement', 'primary_needs_diagnosis', 'discharge_needs_epicrisis', 'title_required']) {
    assert.throws(() => db.prepare(`UPDATE inpatient_settings SET ${col} = 2`).run(), /CHECK/, col);
  }
  db.close();
});

test('298: журнал — кто, когда, что; время ставится само', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'adm','x','Сотрудник adm','admin')").run();
  db.prepare("INSERT INTO inpatient_settings_log (user_id, field, old_value, new_value) VALUES (1, 'intake_before_attending', '1', '0')").run();
  const r = db.prepare('SELECT * FROM inpatient_settings_log').get();
  assert.match(r.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual([r.user_id, r.field, r.old_value, r.new_value], [1, 'intake_before_attending', '1', '0']);
  db.close();
});

test('298: каждый документ набора (и уже засеянный 115, и новый) — обязательный, без обязательных разделов', () => {
  const db = openDb(':memory:');
  migrate(db);
  const rows = db.prepare('SELECT kind, required, required_sections FROM case_doc_types').all();
  assert.ok(rows.length >= 10, 'встроенный набор 115 на месте');
  for (const r of rows) {
    assert.equal(r.required, 1, r.kind);
    assert.equal(r.required_sections, '[]', r.kind);
  }
  assert.throws(() => db.prepare("UPDATE case_doc_types SET required = 5 WHERE kind = 'intake'").run(), /CHECK/);
  db.prepare("INSERT INTO case_doc_types (kind, title) VALUES ('own_99', 'Тестовый лист')").run();
  assert.deepEqual({ ...db.prepare("SELECT required, required_sections FROM case_doc_types WHERE kind = 'own_99'").get() },
    { required: 1, required_sections: '[]' });
  db.close();
});

test('298: клиника, которая уже работает, — после обновления всё как было (свой документ и выключенный тоже обязательные)', () => {
  const db = dbBefore298();
  try {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'inpatient_settings'").get().n, 0);
    db.prepare("INSERT INTO case_doc_types (kind, title, due_rule, sort_order) VALUES ('own_5', 'Тестовый лист', 'none', 200)").run();
    db.prepare("UPDATE case_doc_types SET active = 0 WHERE kind = 'interim'").run();
    migrate(db);
    assert.deepEqual({ ...db.prepare('SELECT intake_before_attending, admitting_at_placement, primary_needs_diagnosis, discharge_needs_epicrisis, title_required FROM inpatient_settings WHERE id = 1').get() },
      { intake_before_attending: 1, admitting_at_placement: 1, primary_needs_diagnosis: 1, discharge_needs_epicrisis: 1, title_required: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM inpatient_settings_log').get().n, 0, 'журнал пуст');
    for (const kind of ['own_5', 'interim', 'intake', 'discharge']) {
      assert.deepEqual({ ...db.prepare('SELECT required, required_sections FROM case_doc_types WHERE kind = ?').get(kind) },
        { required: 1, required_sections: '[]' }, kind);
    }
  } finally { db.close(); }
});
