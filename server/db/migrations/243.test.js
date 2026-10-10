// DOCTOR_PROFILE_V1 (мигр. 243) — ПУБЛИЧНЫЙ ПРОФИЛЬ ВРАЧА: только ADD COLUMN и
// один индекс; бэкфилл — только новой колонки «работает с» из прежнего стажа.
// Прежние колонки, строки и их число не тронуты; CHECK и UNIQUE — запасной
// замок для /api/db.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dbBefore243() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig243-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 243)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

test('243: врачи скрыты, языков нет, запись на 14 дней, очередь не показывается; «работает с» — из стажа; прежнее не тронуто', () => {
  const db = dbBefore243();
  const ins = db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor, experience_years) VALUES (?, 'x', ?, 'doctor', 1, ?)");
  ins.run('d12', 'Врач Двенадцать', 12);
  ins.run('dnull', 'Врач Без стажа', null);
  const before = db.prepare('SELECT * FROM users ORDER BY id').all();
  migrate(db);
  const after = db.prepare('SELECT * FROM users ORDER BY id').all();
  assert.equal(after.length, before.length);
  const year = Number(db.prepare("SELECT strftime('%Y', 'now', 'localtime') AS y").get().y);
  after.forEach((row, i) => {
    for (const [k, v] of Object.entries(before[i])) assert.equal(row[k], v, 'прежнее ' + k);
    assert.deepEqual([row.is_public, row.languages, row.booking_days, row.show_queue_count], [0, '[]', 14, 0]);
  });
  const by = (u) => after.find((r) => r.username === u);
  assert.equal(by('d12').practice_since, year - 12);
  assert.equal(by('dnull').practice_since, null);
});

test('243: виды консультаций — 30 минут, без вида для партнёров, name_en пуст; прежнее не тронуто', () => {
  const db = dbBefore243();
  db.prepare("INSERT INTO consultation_types (name, name_ru, price) VALUES ('Первичный', 'Первичный приём', 100000)").run();
  const before = db.prepare('SELECT * FROM consultation_types ORDER BY id').all();
  migrate(db);
  const after = db.prepare('SELECT * FROM consultation_types ORDER BY id').all();
  assert.equal(after.length, before.length);
  after.forEach((row, i) => {
    for (const [k, v] of Object.entries(before[i])) assert.equal(row[k], v, 'прежнее ' + k);
    assert.deepEqual([row.duration_minutes, row.api_kind, row.name_en], [30, '', null]);
  });
});

test('243: CHECK и единственность вида для партнёров — запасной замок', () => {
  const db = openDb(':memory:'); migrate(db);
  const uid = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('d', 'x', 'doctor')").run().lastInsertRowid;
  const setU = (col, v) => db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(v, uid);
  for (const [col, bad, good] of [['is_public', 2, 1], ['booking_days', 10, 30], ['show_queue_count', 5, 1], ['practice_since', 1800, 2015]]) {
    assert.throws(() => setU(col, bad), /CHECK/, col + ' = ' + bad);
    setU(col, good);
  }
  const ct = (name, kind, min = 30) => db.prepare('INSERT INTO consultation_types (name, api_kind, duration_minutes) VALUES (?, ?, ?)').run(name, kind, min);
  assert.throws(() => ct('A', 'first'), /CHECK/);
  assert.throws(() => ct('B', '', 4), /CHECK/);
  assert.throws(() => ct('C', '', 481), /CHECK/);
  ct('Первичный', 'initial');
  ct('Повторный', 'repeat');
  ct('Онлайн', '');
  ct('Ещё один', '');
  assert.throws(() => ct('Второй первичный', 'initial'), /UNIQUE/);
});
