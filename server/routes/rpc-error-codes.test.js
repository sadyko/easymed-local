// SERVICE_EDITOR_V1 — машинный код ошибки доезжает до браузера.
//
// Отдельно от service-save.test.js: там проверяется, что RPC БРОСАЕТ
// {code, params}, а здесь — что routes/rpc.js их не теряет по дороге.
// Исторически маршрут перезаписывал code статусом ('bad_request'/'forbidden'),
// и любой код, назначенный обработчиком, умирал на этой строке — диалог не
// смог бы перевести ни одной динамической ошибки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Босс', 'admin');
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

async function login(base) {
  const res = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
  return res.headers.get('set-cookie').split(';')[0];
}

test('код и параметры обработчика доезжают в JSON ошибки; без кода — прежний bad_request', async () => {
  const { server, base } = await startServer();
  try {
    const cookie = await login(base);

    // Обработчик назначил код: он и едет, вместе с параметрами и фразой.
    let res = await post(base, '/api/rpc/service_save', {
      name: 'Приём', type: 'consultation', price: 1000,
      category_ref: { id: 9999 },
    }, cookie);
    assert.equal(res.status, 400);
    let body = await res.json();
    assert.equal(body.error.code, 'ref_row_missing');
    assert.deepEqual(body.error.params, { table: 'service_categories', id: 9999 });
    assert.match(body.error.message, /service_categories/, 'фраза для логов и старых клиентов остаётся');

    // Обработчик кода не назначал: статусный код, как всегда было.
    res = await post(base, '/api/rpc/service_save', { name: '', type: 'consultation', price: 1000 }, cookie);
    assert.equal(res.status, 400);
    body = await res.json();
    assert.equal(body.error.code, 'bad_request');
    assert.equal('params' in body.error, false, 'пустых params не бывает');
  } finally { server.close(); }
});
