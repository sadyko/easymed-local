// CALL_RING_V1 (мигр. 250; была 248 — номер заняла удалённая ветка) — у настроек телефонии появляется секрет адреса событий
// станции (ring_token): пустой по умолчанию, строка настроек на месте.
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
  const tmp = tmpDir('em-mig250-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) <= max)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  return tmp;
}
const cols = (db) => db.prepare('PRAGMA table_info(telephony_settings)').all().map((c) => c.name);

test('до 250 колонки нет, после — есть, пустая по умолчанию; строка настроек одна', () => {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(249));
  assert.ok(!cols(db).includes('ring_token'));
  migrate(db, dirUpTo(250));
  assert.ok(cols(db).includes('ring_token'));
  const row = db.prepare('SELECT ring_token FROM telephony_settings WHERE id = 1').get();
  assert.ok(row, 'строки настроек телефонии нет');
  assert.equal(row.ring_token, '');
});

test('свежая база: колонка есть и принимает 32 hex', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('UPDATE telephony_settings SET ring_token = ? WHERE id = 1').run('a'.repeat(32));
  assert.equal(db.prepare('SELECT ring_token FROM telephony_settings WHERE id = 1').get().ring_token, 'a'.repeat(32));
});
