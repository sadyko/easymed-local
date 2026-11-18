// PATIENT_DUP_RULE_V3 — миграция 290: отметки «Не дубликат» (patient_dup_dismissals).
// Только добавление: новая таблица и индекс. Карты пациентов и журнал связи зданий
// (084) не трогаются; пара хранится один раз, младший id — в a; удаление карты
// уносит её отметки; удаление сотрудника отметкам не мешает (кто — копией имени).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

/** База версии до 290: все миграции ниже 290. */
function before290() {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig290-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 290 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  return db;
}

test('290: таблица отметок «Не дубликат» — колонки, ссылки, пара один раз; карты и журнал связи зданий не тронуты', () => {
  const db = before290();
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1, 'adm', 'x', 'Админ', 'admin')").run();
    db.prepare("INSERT INTO patients (id, full_name, phone, date_of_birth) VALUES (102, 'Sardor Alimov', '998977654321', '1991-04-23'), (103, 'ТЕст 2 Тест 2', '+998977654321', '1991-04-23'), (104, 'Третий', '', '')").run();
    const snap = () => ({
      patients: db.prepare('SELECT * FROM patients ORDER BY id').all(),
      journal: db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n,
    });
    const before = snap();
    migrate(db);
    assert.deepEqual(snap(), before, 'карты пациентов или журнал связи зданий изменились');

    const cols = db.prepare('PRAGMA table_info(patient_dup_dismissals)').all().map((c) => c.name);
    for (const c of ['id', 'patient_id_a', 'patient_id_b', 'reasons', 'dismissed_by', 'dismissed_by_name', 'created_at']) {
      assert.ok(cols.includes(c), 'нет колонки ' + c);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM patient_dup_dismissals').get().n, 0, 'миграция сама отметок не заводит');

    const fks = db.prepare('SELECT "table" t, "from" f, on_delete d FROM pragma_foreign_key_list(?)').all('patient_dup_dismissals');
    const fk = (f) => fks.find((x) => x.f === f);
    assert.equal(fk('patient_id_a').t, 'patients');
    assert.equal(fk('patient_id_a').d, 'CASCADE', 'удалённая карта уносит свои отметки');
    assert.equal(fk('patient_id_b').t, 'patients');
    assert.equal(fk('patient_id_b').d, 'CASCADE');
    assert.equal(fk('dismissed_by').t, 'users');
    assert.equal(fk('dismissed_by').d, 'SET NULL', 'удаление сотрудника отметкам не мешает');

    const ins = db.prepare("INSERT INTO patient_dup_dismissals (patient_id_a, patient_id_b, reasons, dismissed_by, dismissed_by_name) VALUES (?, ?, 'phone_dob', 1, 'Админ')");
    ins.run(102, 103);
    assert.throws(() => ins.run(102, 103), /UNIQUE/, 'пара хранится один раз');
    assert.throws(() => ins.run(103, 102), /CHECK/, 'младший id — всегда в a');
    assert.throws(() => ins.run(102, 102), /CHECK/, 'карта сама с собой — не пара');
    const row = db.prepare('SELECT * FROM patient_dup_dismissals').get();
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'когда — временем сервера');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n, before.journal, 'отметка не едет журналом связи зданий');

    // Удаление сотрудника — имя остаётся, ссылка обнуляется.
    db.prepare('DELETE FROM users WHERE id = 1').run();
    const kept = db.prepare('SELECT dismissed_by, dismissed_by_name FROM patient_dup_dismissals').get();
    assert.deepEqual(kept, { dismissed_by: null, dismissed_by_name: 'Админ' });
    // Удаление карты уносит её отметки.
    db.prepare('DELETE FROM patients WHERE id = 103').run();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM patient_dup_dismissals').get().n, 0);
  } finally {
    db.close();
  }
});
