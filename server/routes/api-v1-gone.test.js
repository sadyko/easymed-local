// CLINIC_API_STEP7_V1 — спецификация, «Старое»: по прежнему адресу /api/v1 ничего
// не открывается. Остатки gw() облачных экранов (gateway.js) попадают в общий
// ответ «Неизвестный адрес API» (app.js), а не в живой обработчик.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

test('по /api/v1 — 404 not_found и вошедшему администратору; без входа — не 2xx', async () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run('boss', hashPassword('password1'), 'Босс', 'admin');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'password1' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const [method, p] of [['GET', '/api/v1/keys'], ['POST', '/api/v1/keys'], ['GET', '/api/v1/public-site/branches'],
      ['POST', '/api/v1/appointments'], ['GET', '/api/v1/shifo/v1/doctors']]) {
      const r = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 404, method + ' ' + p);
      assert.equal((await r.json()).error.code, 'not_found');
      const anon = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.ok(anon.status >= 400, 'без входа ' + p + ' ответил ' + anon.status);
    }
  } finally { server.close(); }
});
