// REP_BOT_V1 — миграция 260: таблицы бота для медпредставителей и триггер отзыва.
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
  const tmp = tmpDir('em-mig260-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) <= max)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  return tmp;
}
const TABLES = ['rep_bot_settings', 'rep_bot_links', 'rep_bot_state', 'rep_bot_drafts', 'rep_bot_additions'];
const tables = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));

test('до 260 таблиц нет, после — пять; строка настроек одна и выключена', () => {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(259));
  for (const t of TABLES) assert.ok(!tables(db).has(t), t);
  migrate(db, dirUpTo(260));
  for (const t of TABLES) assert.ok(tables(db).has(t), t + ' не создана');
  const rows = db.prepare('SELECT * FROM rep_bot_settings').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].enabled, 0);
  assert.throws(() => db.prepare('INSERT INTO rep_bot_settings (id) VALUES (2)').run());
});

test('связка — по умолчанию ждёт; триггер: увольнение, смена роли или номера по цифрам — отзыв; другая запись того же номера — нет', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, phone, custom_role_code) VALUES (5, 'rep', 'x', 'callcenter', 'Представитель', '+998903106570', 'medrep')").run();
  const link = () => db.prepare("INSERT INTO rep_bot_links (user_id, chat_id, phone) VALUES (5, '700', '998903106570')").run();
  const open = () => db.prepare('SELECT COUNT(*) n FROM rep_bot_links WHERE revoked_at IS NULL').get().n;
  link();
  assert.equal(db.prepare('SELECT status FROM rep_bot_links').get().status, 'pending');
  assert.throws(() => db.prepare("UPDATE rep_bot_links SET status = 'maybe'").run(), /CHECK/);

  db.prepare("UPDATE users SET phone = '998 90 310-65-70' WHERE id = 5").run();
  assert.equal(open(), 1, 'тот же номер другой записью');
  db.prepare("UPDATE users SET full_name = 'Другое Имя' WHERE id = 5").run();
  assert.equal(open(), 1, 'имя — не повод');
  db.prepare("UPDATE users SET phone = '+998911111111' WHERE id = 5").run();
  assert.equal(open(), 0, 'номер сменился');

  db.prepare("UPDATE users SET phone = '+998903106570' WHERE id = 5").run();
  link();
  db.prepare("UPDATE users SET custom_role_code = NULL WHERE id = 5").run();
  assert.equal(open(), 0, 'роль снята');

  db.prepare("UPDATE users SET custom_role_code = 'medrep' WHERE id = 5").run();
  link();
  db.prepare('UPDATE users SET is_active = 0 WHERE id = 5').run();
  assert.equal(open(), 0, 'уволен');
});
