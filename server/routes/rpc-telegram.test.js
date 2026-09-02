// TELEGRAM_BOT_V1 — раздел бота через настоящий HTTP.
//
// Отдельно от server/services/rpc/telegram.test.js: там проверяется логика, а
// здесь — что она переживает дорогу до браузера. Два свойства, которые видны
// только на этом уровне:
//   1. telegram_test_connection асинхронный, и routes/rpc.js обязан ДОЖДАТЬСЯ
//      промиса. Раньше маршрут звал обработчик без await, и промис уходил в
//      res.json() как «{}» — молча, без единой ошибки в логе.
//   2. Токен не появляется в теле ответа и недостижим через /api/db.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';   // LICENCE_CORE_V1
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const TOKEN = '1000000001:TESTONLYtestonlyTESTONLYtestonly123';

process.env.EASYMED_TELEGRAM_KEY_PATH =
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'em-tg-http-')), '.telegram-key');

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Босс', 'admin');
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('reg', hashPassword('password2'), 'Регистратор', 'registrar');
  // LICENCE_CORE_V1 — enrolled+active so the write gate (routes/db.js,
  // routes/rpc.js) never fires; this file predates licensing.
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function post(base, path, body, cookie) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body || {}),
  });
}

async function login(base, username, password) {
  const res = await post(base, '/api/auth/login', { username, password });
  return res.headers.get('set-cookie').split(';')[0];
}

// Перехватывает ТОЛЬКО обращения к api.telegram.org; запросы самого теста к
// локальному серверу идут настоящим fetch.
function stubTelegram(payload, status = 200) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.telegram.org')) {
      return { ok: status >= 200 && status < 300, status, json: async () => payload };
    }
    return real(url, opts);
  };
  return () => { globalThis.fetch = real; };
}

test('администратор сохраняет токен, и токен не возвращается в ответе', async () => {
  const { server, base } = await startServer();
  const restore = stubTelegram({ ok: true, result: { id: 1, username: 'easymed_clinic_bot' } });
  try {
    const admin = await login(base, 'boss', 'password1');
    const res = await post(base, '/api/rpc/telegram_settings_save', { bot_token: TOKEN }, admin);
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.ok(!text.includes(TOKEN), 'токен не должен доехать до браузера');
    assert.ok(!text.includes('AAFeAwoH'), 'секретная часть — тем более');
    const body = JSON.parse(text);
    assert.equal(body.data.has_token, true);
    assert.equal(body.data.token_hint, 'y123');
    // Один ввод токена = рабочий бот: проверка связи и включение происходят сами.
    assert.equal(body.data.enabled, true);
    assert.equal(body.data.auto_enabled, true);
  } finally { restore(); server.close(); }
});

test('регистратор не видит и не меняет настройки бота', async () => {
  const { server, base } = await startServer();
  try {
    const reg = await login(base, 'reg', 'password2');
    for (const rpc of ['telegram_settings_get', 'telegram_settings_save', 'telegram_token_clear', 'telegram_test_connection']) {
      const res = await post(base, '/api/rpc/' + rpc, { bot_token: TOKEN }, reg);
      assert.equal(res.status, 403, rpc);
    }
  } finally { server.close(); }
});

test('без входа в систему раздел недоступен', async () => {
  const { server, base } = await startServer();
  try {
    const res = await post(base, '/api/rpc/telegram_settings_get', {});
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test('асинхронный RPC доезжает до браузера результатом, а не пустым объектом', async () => {
  const { server, base } = await startServer();
  const restore = stubTelegram({ ok: true, result: { id: 5125777202, username: 'easymed_clinic_bot', first_name: 'Клиника' } });
  try {
    const admin = await login(base, 'boss', 'password1');
    await post(base, '/api/rpc/telegram_settings_save', { bot_token: TOKEN }, admin);

    const res = await post(base, '/api/rpc/telegram_test_connection', {}, admin);
    const body = await res.json();

    // Именно это ломалось без await в routes/rpc.js: сериализованный промис.
    assert.notDeepEqual(body.data, {}, 'промис не должен сериализоваться в пустой объект');
    assert.equal(body.data.ok, true);
    assert.equal(body.data.bot.username, 'easymed_clinic_bot');
  } finally { restore(); server.close(); }
});

test('неверный токен показывается администратору текстом, а не падением', async () => {
  const { server, base } = await startServer();
  const restore = stubTelegram({ ok: false, description: 'Unauthorized' }, 401);
  try {
    const admin = await login(base, 'boss', 'password1');
    await post(base, '/api/rpc/telegram_settings_save', { bot_token: TOKEN }, admin);

    const res = await post(base, '/api/rpc/telegram_test_connection', {}, admin);
    assert.equal(res.status, 200, 'отклонённый токен — это результат проверки, а не сбой запроса');
    const body = await res.json();
    assert.equal(body.data.ok, false);
    assert.match(body.data.error, /токен/i);
  } finally { restore(); server.close(); }
});

test('таблица с токеном недостижима через /api/db', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await login(base, 'boss', 'password1');
    await post(base, '/api/rpc/telegram_settings_save', { bot_token: TOKEN }, admin);

    const res = await fetch(base + '/api/db/telegram_settings?select=*', { headers: { Cookie: admin } });
    const text = await res.text();
    assert.notEqual(res.status, 200, 'реестр — белый список, таблицы бота в нём нет');
    assert.ok(!text.includes('AAFeAwoH'));
  } finally { server.close(); }
});
