// V3120_FINAL (I5) — ПРОСТОЙ СЕССИИ СЧИТАЕТСЯ ПО ДЕЙСТВИЯМ ЧЕЛОВЕКА.
//
// Правило «4 часа без работы — выход» (services/auth.js) не срабатывало
// никогда: меню опрашивает счётчики каждые 20 секунд, и каждый такой опрос
// продлевал сессию. Теперь запрос, помеченный клиентом как фоновый
// (x-em-background: 1), сессию проверяет, но не продлевает. И сессия,
// открытая до обновления (last_seen_at пуст), не выбрасывается первым же
// запросом: пустая отметка считается «сейчас».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword, login, SESSION_IDLE_HOURS } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19) + 'Z';

async function setup(t) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('idle-desk', hashPassword('1'), 'Регистратор', 'registrar');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = () => login(db, 'idle-desk', '1', { ip: '10.0.0.9' }).session;
  const me = (sid, background) => fetch(base + '/api/auth/me', {
    headers: { Cookie: 'emsid=' + sid, ...(background ? { 'x-em-background': '1' } : {}) },
  });
  const seenAt = (sid) => (db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(sid) || {}).last_seen_at;
  return { db, session, me, seenAt };
}

test('фоновый запрос не продлевает сессию, обычный — продлевает', async (t) => {
  const { db, session, me, seenAt } = await setup(t);
  const sid = session();
  const halfHour = iso(30 * 60 * 1000);
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(halfHour, sid);

  assert.equal((await me(sid, true)).status, 200, 'фоновый опрос живой сессии проходит');
  assert.equal(seenAt(sid), halfHour, 'фоновый опрос отметку не двигает');

  assert.equal((await me(sid, false)).status, 200);
  assert.ok(seenAt(sid) > halfHour, 'действие человека продлевает сессию');
});

test('опросы каждые 20 секунд не держат сессию: простой дольше предела — выход и для фонового запроса', async (t) => {
  const { db, session, me } = await setup(t);
  const sid = session();
  const stale = iso((SESSION_IDLE_HOURS * 3600 + 60) * 1000);
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(stale, sid);
  assert.equal((await me(sid, true)).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE id = ?').get(sid).n, 0);
});

test('сессия, открытая до обновления (last_seen_at пуст), не выбрасывается первым запросом', async (t) => {
  const { db, session, me, seenAt } = await setup(t);
  const sid = session();
  // До миграции отметки не было: вход 6 часов назад, срок 12 часов ещё идёт.
  db.prepare('UPDATE sessions SET last_seen_at = NULL, created_at = ? WHERE id = ?').run(iso(6 * 3600 * 1000), sid);
  assert.equal((await me(sid, true)).status, 200, 'даже фоновый первый запрос не выбрасывает');
  assert.ok(seenAt(sid), 'пустая отметка заполнена «сейчас»');
  assert.equal((await me(sid, false)).status, 200);
});
