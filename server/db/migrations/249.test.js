// META_LEADS_V1 (мигр. 249; была 246 — номер заняла удалённая ветка) — ЗАЯВКИ ИЗ РЕКЛАМЫ META: настройки подключения
// (одна строка, токен только шифртекстом) и журнал полученных заявок. Только
// CREATE TABLE: прежние таблицы не тронуты; заявка Meta (leadgen_id) в журнале
// одна; удаление карточки CRM не рвёт журнал, а отвязывает его.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// Папка миграций ДО номера включительно: шаг «до/после» сравнивает ровно 246-ю,
// чтобы следующая миграция не ломала этот тест своими таблицами.
function dirUpTo(max) {
  const tmp = tmpDir('em-mig249-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) <= max)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  return tmp;
}
function dbBefore249() {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(248));
  return db;
}
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
const lead = (db, over = {}) => {
  const row = { leadgen_id: 'lg_1', form_id: 'f1', created_time: '2026-10-16T09:00:00+0000', ...over };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO meta_leads (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
};

test('249: две таблицы, строка настроек одна и выключена; прежние таблицы не тронуты', () => {
  const db = dbBefore249();
  const before = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  migrate(db, dirUpTo(249));
  const after = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const added = after.filter((t) => !before.some((b) => b.name === t.name)).map((t) => t.name).sort();
  assert.deepEqual(added, ['meta_leads', 'meta_settings']);
  for (const b of before) assert.equal(after.find((t) => t.name === b.name).sql, b.sql, 'не тронута: ' + b.name);
  const rows = db.prepare('SELECT id, enabled, token_sealed, token_tail, page_id, forms_mode, forms_json, poll_minutes, since_ts, last_error FROM meta_settings').all();
  assert.deepEqual(rows.map((r) => ({ ...r })),
    [{ id: 1, enabled: 0, token_sealed: '', token_tail: '', page_id: '', forms_mode: 'all', forms_json: '[]', poll_minutes: 2, since_ts: 0, last_error: '' }]);
  assert.throws(() => db.prepare('INSERT INTO meta_settings (id) VALUES (2)').run(), /CHECK/);
});

test('249: настройки — режим форм из двух слов, список форм только массивом JSON, период не меньше минуты', () => {
  const db = fresh();
  assert.throws(() => db.prepare("UPDATE meta_settings SET forms_mode = 'some' WHERE id = 1").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE meta_settings SET forms_json = '{}' WHERE id = 1").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE meta_settings SET forms_json = 'oops' WHERE id = 1").run(), /CHECK/);
  assert.throws(() => db.prepare('UPDATE meta_settings SET poll_minutes = 0 WHERE id = 1').run(), /CHECK/);
  db.prepare("UPDATE meta_settings SET forms_mode = 'selected', forms_json = '[{\"id\":\"f1\",\"name\":\"Форма\",\"selected\":1}]', poll_minutes = 5 WHERE id = 1").run();
  assert.equal(db.prepare('SELECT poll_minutes FROM meta_settings WHERE id = 1').get().poll_minutes, 5);
});

test('249: заявка Meta в журнале одна; статус из трёх слов; ответы формы — JSON', () => {
  const db = fresh();
  lead(db, { leadgen_id: 'lg_1' });
  assert.throws(() => lead(db, { leadgen_id: 'lg_1' }), /UNIQUE/);
  assert.throws(() => lead(db, { leadgen_id: 'lg_2', status: 'weird' }), /CHECK/);
  assert.throws(() => lead(db, { leadgen_id: 'lg_3', field_data_json: 'not json' }), /CHECK/);
  for (const s of ['created', 'merged', 'error']) lead(db, { leadgen_id: 'lg_' + s, status: s });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta_leads').get().n, 4);
  const r = db.prepare("SELECT status, error, phone, email, received_at FROM meta_leads WHERE leadgen_id = 'lg_1'").get();
  assert.equal(r.status, 'created');
  assert.equal(r.error, '');
  assert.equal(r.phone, '');
  assert.match(r.received_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('249: удаление карточки CRM отвязывает запись журнала, а не удаляет её', () => {
  const db = fresh();
  const crmId = Number(db.prepare("INSERT INTO crm_requests (full_name, phone) VALUES ('Заявка', '+998901234567')").run().lastInsertRowid);
  lead(db, { leadgen_id: 'lg_9', crm_request_id: crmId });
  db.prepare('DELETE FROM crm_requests WHERE id = ?').run(crmId);
  assert.deepEqual(db.prepare("SELECT crm_request_id FROM meta_leads WHERE leadgen_id = 'lg_9'").get(), { crm_request_id: null });
});
