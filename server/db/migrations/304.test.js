// STAFF_ATTENDANCE_V1 — миграция 304: бот сотрудников, точки входа, смены, флаги, правки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (500, 'e', 'x', 'Сотрудник', 'nurse')").run();
  return db;
}

test('бот сотрудников: одна строка настроек, выключен, опоздание после 10 минут', () => {
  const db = fresh();
  const s = db.prepare('SELECT * FROM staff_bot_settings').all();
  assert.equal(s.length, 1);
  assert.equal(s[0].enabled, 0);
  assert.equal(s[0].grace_minutes, 10);
  assert.throws(() => db.prepare('INSERT INTO staff_bot_settings (id) VALUES (2)').run(), /CHECK/);
});

test('Telegram: один активный на сотрудника и сотрудник на Telegram; снятые не мешают', () => {
  const db = fresh();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (501, 'f', 'x', 'Второй', 'nurse')").run();
  db.prepare("INSERT INTO staff_telegram_links (user_id, tg_user_id, chat_id) VALUES (500, '1', '1')").run();
  assert.throws(() => db.prepare("INSERT INTO staff_telegram_links (user_id, tg_user_id, chat_id) VALUES (500, '2', '2')").run(), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO staff_telegram_links (user_id, tg_user_id, chat_id) VALUES (501, '1', '1')").run(), /UNIQUE/);
  db.prepare("UPDATE staff_telegram_links SET revoked_at = 'x' WHERE user_id = 500").run();
  db.prepare("INSERT INTO staff_telegram_links (user_id, tg_user_id, chat_id) VALUES (501, '1', '1')").run();
});

test('точки: секреты не короче нормы; скан одного кода одним человеком — один раз', () => {
  const db = fresh();
  assert.throws(() => db.prepare("INSERT INTO attendance_locations (name, token_secret, display_key) VALUES ('В', 'short', 'k')").run(), /CHECK/);
  db.prepare(`INSERT INTO attendance_locations (id, name, token_secret, display_key) VALUES (1, 'Вход', ?, ?)`).run('s'.repeat(64), 'k'.repeat(48));
  db.prepare("INSERT INTO attendance_scans (location_id, token_window, tg_user_id, kind) VALUES (1, 5, '1', 'in')").run();
  assert.throws(() => db.prepare("INSERT INTO attendance_scans (location_id, token_window, tg_user_id, kind) VALUES (1, 5, '1', 'in')").run(), /UNIQUE/);
  db.prepare("INSERT INTO attendance_scans (location_id, token_window, tg_user_id, kind) VALUES (1, 5, '2', 'in')").run();
});

test('смены: одна открытая на сотрудника; «нет ухода» и аннулированные не держат; уход не раньше прихода', () => {
  const db = fresh();
  db.prepare("INSERT INTO attendance_sessions (user_id, in_at) VALUES (500, '2026-11-27T04:00:00Z')").run();
  assert.throws(() => db.prepare("INSERT INTO attendance_sessions (user_id, in_at) VALUES (500, '2026-11-27T05:00:00Z')").run(), /UNIQUE/);
  db.prepare('UPDATE attendance_sessions SET missing_out = 1').run();
  db.prepare("INSERT INTO attendance_sessions (user_id, in_at) VALUES (500, '2026-11-28T04:00:00Z')").run();
  assert.throws(() => db.prepare("INSERT INTO attendance_sessions (user_id, in_at, out_at) VALUES (500, '2026-11-29T04:00:00Z', '2026-11-29T03:00:00Z')").run(), /CHECK/);
});

test('правка без причины не записывается', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO attendance_sessions (user_id, in_at) VALUES (500, '2026-11-27T04:00:00Z')").run().lastInsertRowid;
  assert.throws(() => db.prepare("INSERT INTO attendance_corrections (session_id, user_id, action, reason) VALUES (?, 500, 'void', '  ')").run(id), /CHECK/);
  db.prepare("INSERT INTO attendance_corrections (session_id, user_id, action, reason) VALUES (?, 500, 'void', 'ошибка')").run(id);
});
