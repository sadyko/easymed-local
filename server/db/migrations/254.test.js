// NAV_VISIBILITY_V1 — миграция 254: таблица скрытых разделов меню.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dirUpTo(max) {
  const tmp = tmpDir('em-mig254-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) <= max)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  return tmp;
}
const has = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

test('до 254 таблицы нет, после — есть и пуста (ничего не скрыто по умолчанию)', () => {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(253));
  assert.ok(!has(db, 'nav_visibility'));
  migrate(db, dirUpTo(254));
  assert.ok(has(db, 'nav_visibility'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nav_visibility').get().n, 0);
});

test('id — ключ: один пункт один раз; удаление сотрудника не стирает строку', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (9, 'adm', 'x', 'admin')").run();
  db.prepare("INSERT INTO nav_visibility (nav_id, hidden_by) VALUES ('admissions', 9)").run();
  assert.throws(() => db.prepare("INSERT INTO nav_visibility (nav_id, hidden_by) VALUES ('admissions', 9)").run());
  db.prepare('DELETE FROM users WHERE id = 9').run();
  const row = db.prepare('SELECT nav_id, hidden_by FROM nav_visibility').get();
  assert.deepEqual(row, { nav_id: 'admissions', hidden_by: null });
});
