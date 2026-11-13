// SYMPTEX_FIELDS_V1 (мигр. 285) — ТИП КЛИНИКИ И «ПРИНИМАЕТ» У ВРАЧА.
//
// Владелец (2026-11-13): «add to easymed and also add to the doctor the children/adult option
// too… make changes so it won't affect real clinics settings». Миграция только добавляет две
// колонки с пустым значением по умолчанию: у каждой клиники и каждого врача после обновления
// «не указано», и партнёры получают то же, что до обновления. Прочие колонки строк не меняются.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

// База версии 3.23.0: все миграции ниже 285.
function before285() {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig285-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 285 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  return db;
}

test('285: у существующей клиники и врачей — «не указано», остальное в строках не меняется', () => {
  const db = before285();
  db.prepare("UPDATE doc_settings SET clinic_name = 'Шифо', telegram_channel = '@shifo_news' WHERE id = 1").run();
  db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor, bio_ru) VALUES ('doc1', 'h', 'Врач Один', 'doctor', 1, 'О враче')").run();
  const docBefore = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get();
  const userBefore = db.prepare("SELECT * FROM users WHERE full_name = 'Врач Один'").get();
  migrate(db);
  const docAfter = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get();
  const userAfter = db.prepare("SELECT * FROM users WHERE full_name = 'Врач Один'").get();
  assert.equal(docAfter.clinic_type, '');
  assert.equal(userAfter.patients_age, '');
  delete docAfter.clinic_type;
  delete userAfter.patients_age;
  assert.deepEqual(docAfter, docBefore, 'настройки клиники — как были');
  assert.deepEqual(userAfter, userBefore, 'карточка врача — как была');
});

test('285: принимаются только названные значения', () => {
  const db = openDb(':memory:');
  migrate(db);
  for (const v of ['', 'clinic', 'diagnostics', 'lab', 'children']) db.prepare('UPDATE doc_settings SET clinic_type = ? WHERE id = 1').run(v);
  assert.throws(() => db.prepare("UPDATE doc_settings SET clinic_type = 'hospital' WHERE id = 1").run(), /CHECK/);
  assert.throws(() => db.prepare('UPDATE doc_settings SET clinic_type = NULL WHERE id = 1').run(), /NOT NULL/);
  const id = db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor) VALUES ('doc2', 'h', 'Врач', 'doctor', 1)").run().lastInsertRowid;
  for (const v of ['', 'adults', 'children', 'all']) db.prepare('UPDATE users SET patients_age = ? WHERE id = ?').run(v, id);
  assert.throws(() => db.prepare("UPDATE users SET patients_age = 'teens' WHERE id = ?").run(id), /CHECK/);
  assert.throws(() => db.prepare('UPDATE users SET patients_age = NULL WHERE id = ?').run(id), /NOT NULL/);
});
