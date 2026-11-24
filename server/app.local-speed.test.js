// LOCAL_SPEED_V1 (2026-11-24) — статика не платит за сессию и лицензию.
//
// Открытие экрана — 385 запросов файлов. Каждый (и 304, и 404) раньше проходил
// общий attachUser (сессия из базы, отметка «был здесь») и attachControl
// (control.json + licence.dat с диска + проверка подписи) — ≈1,4 мс работы
// единственного потока на файл, которому ни сессия, ни лицензия не нужны.
// Теперь обе проверки — только для /api (без учёта регистра, как express).
//
// Считаем по самой базе: sessionUser спрашивает таблицу sessions, а
// controlState — control_state (часы лицензии). Файл не должен коснуться ни той,
// ни другой; запрос API — обеих.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { hashPassword } from './services/auth.js';
import { createApp } from './app.js';
import { licensedDataDir } from './services/control/licensed-fixture.js';
import http from 'node:http';
import { listen } from '../control-plane/server/test-helpers/listen.js';

async function stand(t) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Админ', 'admin');
  const server = await listen(createApp(db, { dataDir: licensedDataDir(), live: { enabled: false } }));
  server.unref();
  t.after(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
  });
  assert.equal(login.status, 200, 'вход');
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  // Шпион на prepare: какие SQL прозвучали за время одного запроса.
  const realPrepare = db.prepare.bind(db);
  let seen = [];
  db.prepare = (sql) => { seen.push(String(sql)); return realPrepare(sql); };
  const during = async (fn) => { seen = []; await fn(); return seen.slice(); };
  return { base, cookie, during };
}

// Условный запрос — через node:http: fetch (undici) If-None-Match так, как браузер, не шлёт.
function rawGet(base, p, headers) {
  const u = new URL(base + p);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); });
    req.on('error', reject); req.end();
  });
}

const touchesSession = (sqls) => sqls.some((s) => /\bsessions\b/i.test(s));
const touchesLicence = (sqls) => sqls.some((s) => /\bcontrol_state\b/i.test(s));

test('файл статики (200, 304 и 404) не трогает ни сессию, ни лицензию', async (t) => {
  const { base, cookie, during } = await stand(t);
  let etag = null;
  const first = await during(async () => {
    const res = await fetch(base + '/js/api.js', { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    etag = res.headers.get('etag');
    await res.arrayBuffer();
  });
  assert.equal(touchesSession(first), false, 'статика без sessionUser: ' + first.join(' | '));
  assert.equal(touchesLicence(first), false, 'статика без controlState: ' + first.join(' | '));

  const again = await during(async () => {
    const res = await rawGet(base, '/js/api.js', { Cookie: cookie, 'If-None-Match': etag });
    assert.equal(res.status, 304);
  });
  assert.equal(touchesSession(again) || touchesLicence(again), false, '304 — тоже без них');

  const missing = await during(async () => {
    const res = await fetch(base + '/js/no-such-file.js', { headers: { Cookie: cookie } });
    assert.equal(res.status, 404);
    await res.arrayBuffer();
  });
  assert.equal(touchesSession(missing) || touchesLicence(missing), false, '404 файла — тоже без них');

  const page = await during(async () => {
    const res = await fetch(base + '/admin.html', { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  });
  assert.equal(touchesSession(page) || touchesLicence(page), false, 'страница — тоже без них');
});

test('запрос API по-прежнему читает и сессию, и лицензию — в любом регистре пути', async (t) => {
  const { base, cookie, during } = await stand(t);
  for (const p of ['/api/auth/me', '/API/Auth/me']) {
    let body = null;
    const sqls = await during(async () => {
      const res = await fetch(base + p, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200, p);
      body = await res.json();
    });
    assert.equal(body.user && body.user.username, 'boss', p + ': пользователь положен в запрос');
    assert.equal(touchesSession(sqls), true, p + ': sessionUser');
    assert.equal(touchesLicence(sqls), true, p + ': controlState');
  }
});

test('ворота лицензии на /api работают как прежде (запрос без входа — 401, а не пропуск)', async (t) => {
  const { base } = await stand(t);
  const res = await fetch(base + '/api/db', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table: 'patients', op: 'select' }),
  });
  assert.equal(res.status, 401);
  await res.arrayBuffer();
});
