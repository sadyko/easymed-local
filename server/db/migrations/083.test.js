// 083.test.js — BRANCH_RECORDS_V1: uid есть у всех и ни у кого не повторяется.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const TABLES = ['patients', 'visits', 'visit_services', 'lab_results'];

test('083: у каждой существующей строки появляется uid', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов Иван')").run();
  for (const t of TABLES) {
    const missing = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE uid IS NULL`).get().n;
    assert.equal(missing, 0, t + ': строка без uid никуда не поедет');
  }
  db.close();
});

test('083: новая строка получает uid без участия прикладного кода', () => {
  const db = openDb(':memory:');
  migrate(db);
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Петров Пётр')").run().lastInsertRowid;
  const uid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(id).uid;
  assert.match(uid, /^[0-9a-f]{32}$/, 'uid проставлен триггером: ' + uid);
  db.close();
});

test('083: uid уникален — две записи под одним uid означали бы двойной приём', () => {
  const db = openDb(':memory:');
  migrate(db);
  const a = db.prepare("INSERT INTO patients (full_name) VALUES ('А')").run().lastInsertRowid;
  const uid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(a).uid;
  db.prepare("INSERT INTO patients (full_name) VALUES ('Б')").run();
  assert.throws(
    () => db.prepare('UPDATE patients SET uid = ? WHERE full_name = ?').run(uid, 'Б'),
    /UNIQUE/,
    'база обязана отказать, а не выбрать одну из двух молча');
  db.close();
});
