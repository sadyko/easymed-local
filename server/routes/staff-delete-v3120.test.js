// V3120_FIX — удаление сотрудника, на которого ссылаются таблицы, появившиеся
// после STAFF_DELETE_V1 (закрытие месяца, осмотры стационара, Telegram…),
// отвечало 500 «внешний ключ». Теперь — тот же понятный отказ 409, что и для
// визитов со счетами.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

test('сотрудник, закрывавший месяц оплаты врачей, не удаляется — 409 по-русски, не 500', async (t) => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  const emp = Number(db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('acc','x','Бухгалтер','cashier')").run().lastInsertRowid);
  db.prepare("INSERT INTO pay_period_log (month, action, user_id) VALUES ('2026-08','close',?)").run(emp);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'password1' }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const chk = await fetch(`${base}/api/users/${emp}/delete-check`, { headers: { Cookie: cookie } });
  assert.equal(chk.status, 200);
  assert.equal((await chk.json()).deletable, false);

  const del = await fetch(`${base}/api/users/${emp}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(del.status, 409);
  assert.match((await del.json()).error.message, /Отключите учётную запись/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(emp).n, 1);
});
