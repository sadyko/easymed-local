// FIX_318_V1 (H1) — миграция 256: курсор опроса Meta — у каждой формы свой.
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
  const tmp = tmpDir('em-mig256-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) <= max)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  return tmp;
}
const tables = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));

test('мигр. 256: до неё таблицы курсоров нет, после — есть; прежний общий курсор since_ts не тронут', () => {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(255));
  assert.ok(!tables(db).has('meta_form_cursors'));
  db.prepare('UPDATE meta_settings SET since_ts = 1760000000 WHERE id = 1').run();
  migrate(db, dirUpTo(256));
  assert.ok(tables(db).has('meta_form_cursors'), 'meta_form_cursors не создана');
  const cols = db.prepare('PRAGMA table_info(meta_form_cursors)').all().map((c) => c.name);
  assert.deepEqual(cols, ['form_id', 'since_ts', 'updated_at']);
  assert.equal(db.prepare('SELECT since_ts FROM meta_settings WHERE id = 1').get().since_ts, 1760000000,
    'общий курсор становится нижней границей для форм без своего курсора — значение то же');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta_form_cursors').get().n, 0, 'курсоры форм заводит опрос, не миграция');
});

test('мигр. 256: одна строка на форму (form_id — ключ)', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO meta_form_cursors (form_id, since_ts) VALUES ('f1', 10)").run();
  assert.throws(() => db.prepare("INSERT INTO meta_form_cursors (form_id, since_ts) VALUES ('f1', 20)").run(), /UNIQUE|PRIMARY/);
});
