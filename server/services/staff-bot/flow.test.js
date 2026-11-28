// STAFF_ATTENDANCE_V1 — бот сотрудников целиком: подключение кодом, скан QR, подтверждение, меню без «отметиться».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { handleUpdate, MENU } from './flow.js';
import { issueLinkCode } from './linking.js';
import { startParam, currentWindow } from '../attendance/tokens.js';
import { attendanceScreenApi } from '../../routes/attendance-screen.js';

const T0 = Date.parse('2026-11-27T04:00:00Z');

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_active) VALUES (1, 'adm', 'x', 'admin', 'Админ', 1), (10, 'n', 'x', 'nurse', 'Медсестра <Анна>', 1), (11, 'g', 'x', 'nurse', 'Уволенная', 0)").run();
  db.prepare(`INSERT INTO attendance_locations (id, name, token_secret, display_key) VALUES (1, 'Главный вход', ?, ?)`).run('s'.repeat(64), 'k'.repeat(48));
  return db;
}
function recorder() {
  const calls = [];
  const call = async (method, params) => { calls.push({ method, params }); return { message_id: calls.length }; };
  return { calls, call, last: () => calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').at(-1) };
}
const msg = (from, text, type = 'private') => ({ message: { message_id: 1, chat: { id: from, type }, from: { id: from, username: 'anna' }, text } });
const cb = (from, data) => ({ callback_query: { id: 'q1', from: { id: from }, data, message: { message_id: 5, chat: { id: from } } } });
const qr = (db, nowMs = T0) => { const l = db.prepare('SELECT * FROM attendance_locations WHERE id = 1').get(); return '/start ' + startParam(l, currentWindow(l.rotate_secs, nowMs)); };

test('подключение одноразовым кодом: привязка, повтор того же кода — отказ, имя экранировано', async () => {
  const db = fresh();
  const r = recorder();
  const { start } = issueLinkCode(db, 10, 1, T0);
  await handleUpdate(db, 't', msg(5001, '/start ' + start), { call: r.call, nowMs: T0 + 1000 });
  assert.match(r.last().params.text, /Медсестра &lt;Анна&gt;/);
  assert.equal(db.prepare('SELECT user_id FROM staff_telegram_links WHERE tg_user_id = ? AND revoked_at IS NULL').get('5001').user_id, 10);
  // Клавиатура: посещаемость, профиль, язык — и НИКАКОЙ кнопки отметки.
  const kb = JSON.stringify(r.last().params.reply_markup.keyboard);
  assert.ok(kb.includes(MENU.ru.attendance));
  assert.doesNotMatch(kb, /приход|уход|отмет/i);
  await handleUpdate(db, 't', msg(5002, '/start ' + start), { call: r.call, nowMs: T0 + 2000 });
  assert.match(r.last().params.text, /не подошёл/);
});

test('код истёк через 15 минут; код уволенного — отказ', async () => {
  const db = fresh();
  const r = recorder();
  const { start } = issueLinkCode(db, 10, 1, T0);
  await handleUpdate(db, 't', msg(5001, '/start ' + start), { call: r.call, nowMs: T0 + 16 * 60000 });
  assert.match(r.last().params.text, /не подошёл/);
  const g = issueLinkCode(db, 11, 1, T0);
  await handleUpdate(db, 't', msg(5003, '/start ' + g.start), { call: r.call, nowMs: T0 + 1000 });
  assert.match(r.last().params.text, /отключена/);
});

test('скан QR → «Отметить приход?» → «Подтвердить» → приход записан', async () => {
  const db = fresh();
  db.prepare("INSERT INTO staff_telegram_links (user_id, tg_user_id, chat_id) VALUES (10, '5001', '5001')").run();
  const r = recorder();
  await handleUpdate(db, 't', msg(5001, qr(db)), { call: r.call, nowMs: T0 });
  const prompt = r.last().params;
  assert.match(prompt.text, /приход/);
  const btn = prompt.reply_markup.inline_keyboard[0][0];
  assert.match(btn.callback_data, /^att:\d+$/);
  await handleUpdate(db, 't', cb(5001, btn.callback_data), { call: r.call, nowMs: T0 + 3000 });
  assert.equal(r.last().method, 'editMessageText');
  assert.match(r.last().params.text, /Приход отмечен/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions WHERE user_id = 10').get().n, 1);
});

test('чужой Telegram по QR — отказ на двух языках, ничего не записано; «Отмена» гасит скан', async () => {
  const db = fresh();
  const r = recorder();
  await handleUpdate(db, 't', msg(9999, qr(db)), { call: r.call, nowMs: T0 });
  assert.match(r.last().params.text, /не подключён[\s\S]*ulanmagan/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attendance_scans').get().n, 0);

  db.prepare("INSERT INTO staff_telegram_links (user_id, tg_user_id, chat_id) VALUES (10, '5001', '5001')").run();
  await handleUpdate(db, 't', msg(5001, qr(db)), { call: r.call, nowMs: T0 });
  const cancel = r.last().params.reply_markup.inline_keyboard[0][1].callback_data;
  await handleUpdate(db, 't', cb(5001, cancel), { call: r.call, nowMs: T0 + 1000 });
  assert.match(r.last().params.text, /отменена/);
  const confirm = cancel.replace('attx', 'att');
  await handleUpdate(db, 't', cb(5001, confirm), { call: r.call, nowMs: T0 + 2000 });
  assert.match(r.last().params.text, /Время подтверждения вышло/);
});

test('меню: «Моя посещаемость» и смена языка; в группе бот молчит', async () => {
  const db = fresh();
  db.prepare("INSERT INTO staff_telegram_links (user_id, tg_user_id, chat_id) VALUES (10, '5001', '5001')").run();
  const r = recorder();
  await handleUpdate(db, 't', msg(5001, MENU.ru.attendance), { call: r.call });
  assert.match(r.last().params.text, /Моя посещаемость/);
  await handleUpdate(db, 't', msg(5001, MENU.ru.lang), { call: r.call });
  assert.equal(db.prepare("SELECT lang FROM staff_telegram_links WHERE tg_user_id = '5001'").get().lang, 'uz');
  await handleUpdate(db, 't', msg(5001, MENU.uz.attendance), { call: r.call });
  assert.match(r.last().params.text, /Mening davomatim/);
  const before = r.calls.length;
  await handleUpdate(db, 't', msg(5001, qr(db), 'group'), { call: r.call, nowMs: T0 });
  assert.equal(r.calls.length, before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attendance_flags WHERE kind = 'not_private'").get().n, 1);
});

test('экран у входа: неверный ключ — 404; бот выключен — без кода; включён — SVG со ссылкой на бота', async () => {
  const db = fresh();
  const app = express();
  app.use('/api/attendance-screen', attendanceScreenApi(db));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/attendance-screen/1/qr?k=`;
  try {
    assert.equal((await fetch(base + 'wrong')).status, 404);
    let j = await (await fetch(base + 'k'.repeat(48))).json();
    assert.equal(j.state, 'bot_off');
    assert.equal(j.svg, '');
    db.prepare("UPDATE staff_bot_settings SET enabled = 1, bot_username = 'clinic_staff_bot', bot_token_enc = 'x' WHERE id = 1").run();
    j = await (await fetch(base + 'k'.repeat(48))).json();
    assert.equal(j.state, 'ok');
    assert.match(j.svg, /^<svg/);
    assert.equal(j.location, 'Главный вход');
    assert.ok(j.seconds_left >= 1 && j.seconds_left <= 20);
  } finally { server.close(); }
});
