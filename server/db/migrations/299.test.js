// INPATIENT_REQUIRED_V1 (ревью) — миграция 299: госпитализация помнит, что лечащего врача
// назначили прямо с койки, без осмотра (admissions.attending_without_exam). Умолчание 0 —
// обычный путь; старые строки (и перенесённые 091 «лечащимися» без осмотра) — 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// База клиники, которая работала до 299 (все миграции ниже 299).
function dbBefore299() {
  const db = openDb(':memory:');
  const tmp = tmpDir('mig299-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 299)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

test('299 INPATIENT_REQUIRED_V1 (ревью): колонка attending_without_exam — NOT NULL, умолчание 0, только 0 или 1', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const c = db.prepare('PRAGMA table_info(admissions)').all().find((x) => x.name === 'attending_without_exam');
    assert.ok(c, 'нет колонки');
    assert.equal(c.notnull, 1);
    assert.equal(c.dflt_value, '0');
    const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Тестов Пациент')").run().lastInsertRowid;
    const a = db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'ordered')").run(pid).lastInsertRowid;
    assert.equal(db.prepare('SELECT attending_without_exam FROM admissions WHERE id = ?').get(a).attending_without_exam, 0);
    db.prepare('UPDATE admissions SET attending_without_exam = 1 WHERE id = ?').run(a);
    assert.equal(db.prepare('SELECT attending_without_exam FROM admissions WHERE id = ?').get(a).attending_without_exam, 1);
    assert.throws(() => db.prepare('UPDATE admissions SET attending_without_exam = 2 WHERE id = ?').run(a), /CHECK/);
    assert.throws(() => db.prepare('UPDATE admissions SET attending_without_exam = NULL WHERE id = ?').run(a), /NOT NULL/);
  } finally { db.close(); }
});

test('299: клиника, которая уже работает, — старые госпитализации (и «лечащиеся» без осмотра из 091) получают 0', () => {
  const db = dbBefore299();
  try {
    assert.equal(db.prepare('PRAGMA table_info(admissions)').all().some((x) => x.name === 'attending_without_exam'), false);
    const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Тестов Пациент')").run().lastInsertRowid;
    // Как 091 переносит лежавших до обновления: active, examined_* пусты.
    const legacy = db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'active')").run(pid).lastInsertRowid;
    const ordered = db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'ordered')").run(pid).lastInsertRowid;
    migrate(db);
    for (const id of [legacy, ordered]) {
      const r = db.prepare('SELECT status, examined_at, attending_without_exam FROM admissions WHERE id = ?').get(id);
      assert.equal(r.attending_without_exam, 0, String(id));
    }
    const r = db.prepare('SELECT status, examined_at, examined_by FROM admissions WHERE id = ?').get(legacy);
    assert.deepEqual({ ...r }, { status: 'active', examined_at: null, examined_by: null }, 'остальное не тронуто');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE name = '299_admission_attending_without_exam.sql'").get().n, 1);
  } finally { db.close(); }
});
