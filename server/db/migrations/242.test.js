// CLINIC_API_STEP7_V1 (мигр. 242) — ПОДКЛЮЧЕНИЯ API: только CREATE TABLE.
//
// Имя в адресе — одна строка; подключение держит ключ и секрет, пока живо, и
// не держит ничего после удаления; один ключ — одно подключение; сайт клиники
// — один; свой источник CRM — у одного подключения; прежняя заглушка
// api_tokens и справочник источников не тронуты.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { insertConnectionRow } from '../../test-helpers/api-connection-row.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dbBefore242() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig242-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 242)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('242: три таблицы; имя в адресе пустое; api_tokens и crm_sources не тронуты', () => {
  const db = dbBefore242();
  db.prepare("INSERT INTO api_tokens (name, token) VALUES ('Записка', 'вписано руками')").run();
  const sources = db.prepare('SELECT * FROM crm_sources ORDER BY key').all();
  migrate(db);
  assert.deepEqual(db.prepare('SELECT id, slug FROM api_settings').all().map((r) => ({ ...r })), [{ id: 1, slug: '' }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_connections').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_journal').get().n, 0);
  assert.equal(db.prepare('SELECT token FROM api_tokens').get().token, 'вписано руками', 'прежняя заглушка не стёрта');
  assert.deepEqual(db.prepare('SELECT * FROM crm_sources ORDER BY key').all(), sources);
});

test('242: имя в адресе — латиница, цифры, дефис; 3–40; без дефиса по краям; строка одна', () => {
  const db = fresh();
  const set = (v) => db.prepare('UPDATE api_settings SET slug = ? WHERE id = 1').run(v);
  for (const bad of ['ab', 'Klinika', 'klinika_demo', '-klinika', 'klinika-', 'клиника', 'a'.repeat(41)]) {
    assert.throws(() => set(bad), /CHECK/, bad);
  }
  for (const good of ['abc', 'klinika-demo', 'shifo24', '']) set(good);
  assert.throws(() => db.prepare('INSERT INTO api_settings (id) VALUES (2)').run(), /CHECK/);
});

test('242: вид, https, массивы прав и событий, лимит, срок, длины', () => {
  const db = fresh();
  for (const over of [
    { kind: 'robot' },
    { site_url: 'http://med24.uz' },
    { webhook_url: 'http://med24.uz/hook' },
    { scopes: '{"a":1}' },
    { webhook_events: 'нет' },
    { rate_limit: 50 },
    { key_ttl: '2y' },
    { name: '' },
    { contact: 'x'.repeat(121) },
  ]) {
    assert.throws(() => insertConnectionRow(db, over), /CHECK/, JSON.stringify(over));
  }
  assert.ok(insertConnectionRow(db, { site_url: 'https://med24.uz', webhook_url: 'https://med24.uz/hook', rate_limit: 300, key_ttl: '1y' }));
});

test('242: у сайта клиники адреса нет (он в «Компании»); сайт один', () => {
  const db = fresh();
  assert.throws(() => insertConnectionRow(db, { kind: 'site', name: 'Сайт клиники', crm_source_key: 'website', owns_source: 0, site_url: 'https://x.uz' }), /CHECK/);
  insertConnectionRow(db, { kind: 'site', name: 'Сайт клиники', crm_source_key: 'website', owns_source: 0 });
  assert.throws(() => insertConnectionRow(db, { kind: 'site', name: 'Второй', crm_source_key: 'website', owns_source: 0 }), /UNIQUE/);
});

test('242: живое подключение держит ключ и секрет; удалённое — ни того, ни другого, и выключено', () => {
  const db = fresh();
  assert.throws(() => insertConnectionRow(db, { key_hash: '' }), /CHECK/);
  assert.throws(() => insertConnectionRow(db, { secret_sealed: '' }), /CHECK/);
  const id = insertConnectionRow(db);
  const del = (sets) => db.prepare(`UPDATE api_connections SET deleted_at = '2026-10-10T10:00:00Z', ${sets} WHERE id = ?`).run(id);
  assert.throws(() => del("active = 0, key_hash = '', key_sealed = ''"), /CHECK/, 'секрет остался');
  assert.throws(() => del("key_hash = '', key_sealed = '', secret_sealed = ''"), /CHECK/, 'осталось включённым');
  del("active = 0, key_hash = '', key_sealed = '', secret_sealed = ''");
});

test('242: один ключ — одно подключение; свой источник CRM — у одного подключения', () => {
  const db = fresh();
  const hash = 'a'.repeat(64);
  insertConnectionRow(db, { key_hash: hash });
  assert.throws(() => insertConnectionRow(db, { key_hash: hash, crm_source_key: 'api_other', name: 'other' }), /UNIQUE/);
  insertConnectionRow(db, { crm_source_key: 'api_x', name: 'x' });
  assert.throws(() => insertConnectionRow(db, { crm_source_key: 'api_x', name: 'y' }), /UNIQUE/);
});

test('242: журнал — известные действия, детали объектом', () => {
  const db = fresh();
  const add = (action, detail = '{}') => db.prepare('INSERT INTO api_journal (action, detail) VALUES (?, ?)').run(action, detail);
  for (const a of ['slug_saved', 'created', 'updated', 'enabled', 'disabled', 'key_revealed', 'key_regenerated',
    'secret_revealed', 'secret_regenerated', 'deleted']) add(a);
  assert.throws(() => add('key_copied'), /CHECK/);
  assert.throws(() => add('created', '[1]'), /CHECK/);
  assert.throws(() => add('created', 'не json'), /CHECK|JSON|malformed/i);
});
