// TG_DEEPLINK_V1 (мигр. 251) — ССЫЛКИ ДЛЯ РЕКЛАМЫ В TELEGRAM: сами ссылки
// (ключ в адресе, ответ бота на трёх языках, файл, кнопки, тип заявки), журнал
// переходов и журнал заявок, заведённых по ссылке. Только CREATE TABLE; ключ
// ссылки один; удаление ссылки уносит её журналы, удаление карточки CRM — лишь
// отвязывает запись о заявке.
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
  const tmp = tmpDir('em-mig251-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) <= max)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  return tmp;
}
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
const link = (db, over = {}) => {
  const row = { key: 'price', name: 'Цена пакетов', lead_kind: 'callback', answer_ru: 'Роды — от 19 999 000 сум', ...over };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO telegram_deeplinks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
};

test('251: три таблицы; прежние не тронуты', () => {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(250));
  const before = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  migrate(db, dirUpTo(251));
  const after = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const added = after.filter((t) => !before.some((b) => b.name === t.name)).map((t) => t.name).sort();
  assert.deepEqual(added, ['telegram_deeplink_hits', 'telegram_deeplink_leads', 'telegram_deeplinks']);
  for (const b of before) assert.equal(after.find((t) => t.name === b.name).sql, b.sql, 'не тронута: ' + b.name);
});

test('251: ключ один и без учёта регистра; тип заявки из трёх слов; кнопки — массив JSON; умолчания', () => {
  const db = fresh();
  link(db, { key: 'price' });
  assert.throws(() => link(db, { key: 'price' }), /UNIQUE/);
  assert.throws(() => link(db, { key: 'PRICE' }), /UNIQUE/, 'ключ сравнивается без учёта регистра');
  assert.throws(() => link(db, { key: 'tour', lead_kind: 'weird' }), /CHECK/);
  assert.throws(() => link(db, { key: 'tour2', buttons_json: '{}' }), /CHECK/);
  assert.throws(() => link(db, { key: 'tour3', file_kind: 'video' }), /CHECK/);
  const id = link(db, { key: 'tour' });
  const r = db.prepare('SELECT * FROM telegram_deeplinks WHERE id = ?').get(id);
  assert.equal(r.active, 1);
  assert.equal(r.answer_uz, '');
  assert.equal(r.answer_en, '');
  assert.equal(r.buttons_json, '[]');
  assert.equal(r.file_path, '');
  assert.equal(r.file_kind, '');
  assert.match(r.created_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('251: журналы — переход и заявка идут за ссылкой (удаление ссылки уносит их), карточка CRM при удалении только отвязывается', () => {
  const db = fresh();
  const id = link(db, { key: 'price' });
  db.prepare("INSERT INTO telegram_deeplink_hits (deeplink_id, chat_id, tg_user_id, lang) VALUES (?, '100', '100', 'ru')").run(id);
  const crmId = Number(db.prepare("INSERT INTO crm_requests (full_name, phone) VALUES ('Заявка', '+998901234567')").run().lastInsertRowid);
  db.prepare("INSERT INTO telegram_deeplink_leads (deeplink_id, crm_request_id, chat_id) VALUES (?, ?, '100')").run(id, crmId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_deeplink_hits').get().n, 1);
  db.prepare('DELETE FROM crm_requests WHERE id = ?').run(crmId);
  assert.deepEqual(db.prepare('SELECT crm_request_id FROM telegram_deeplink_leads').get(), { crm_request_id: null }, 'заявка остаётся в счётчике ссылки');
  db.prepare('DELETE FROM telegram_deeplinks WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_deeplink_hits').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_deeplink_leads').get().n, 0);
});
