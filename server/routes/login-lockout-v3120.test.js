// V3120_FIX (M10) — БЛОКИРОВКА ВХОДА И ПРОСТОЙ СЕССИИ.
//
// Инспекция: пять неверных паролей к «admin» с ЛЮБОГО компьютера сети
// запирали администратора на 5 минут — чужой мог держать клинику без
// администратора сколько угодно. И удачные входы съедали предел попыток с
// адреса: десять человек за одной стойкой (один компьютер) — и одиннадцатый
// получал «слишком много попыток». Плюс сессия жила 12 часов независимо от
// того, работает ли за ней кто-то.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword, login, sessionUser, SESSION_IDLE_HOURS } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

function seed(username) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run(username, hashPassword('1'), 'Администратор', 'admin');
  return db;
}

test('пять неверных паролей с чужого адреса не запирают вход с другого', () => {
  const db = seed('boss-lock');
  for (let i = 0; i < 6; i++) login(db, 'boss-lock', 'wrong', { ip: '10.0.0.66' });
  assert.equal(login(db, 'boss-lock', '1', { ip: '10.0.0.66' }).error, 'locked', 'сам подбиравший заперт');
  const ok = login(db, 'boss-lock', '1', { ip: '10.0.0.5' });
  assert.ok(ok.session, 'администратор со своего компьютера входит');
});

test('пароль из одной цифры по-прежнему разрешён (решение владельца)', () => {
  const db = seed('one-digit');
  assert.ok(login(db, 'one-digit', '1', { ip: '10.0.0.7' }).session);
});

test('удачные входы не расходуют предел попыток с адреса', async (t) => {
  const db = seed('desk');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (let i = 0; i < 14; i++) {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'desk', password: '1' }) });
    assert.equal(res.status, 200, 'вход №' + (i + 1));
  }
});

test('сессия без работы дольше предела заканчивается; работа её продлевает', () => {
  const db = seed('idle');
  const { session } = login(db, 'idle', '1', { ip: '10.0.0.8' });
  assert.ok(sessionUser(db, session));
  const stale = new Date(Date.now() - (SESSION_IDLE_HOURS * 3600 + 60) * 1000).toISOString().slice(0, 19) + 'Z';
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(stale, session);
  assert.equal(sessionUser(db, session), null, 'простой больше предела — выход');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE id = ?').get(session).n, 0);

  const second = login(db, 'idle', '1', { ip: '10.0.0.8' }).session;
  const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(recent, second);
  assert.ok(sessionUser(db, second), 'полчаса простоя — сессия жива');
  const seen = db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(second).last_seen_at;
  assert.ok(seen > recent, 'обращение продлевает сессию');
});
