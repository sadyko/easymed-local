// STAFF_SYNC_V1 — сотрудник главной клиники в филиале ТОЛЬКО ДЛЯ ЧТЕНИЯ.
//
// Экран уже прячет «Сохранить» у такой карточки, и этот файл всё равно нужен:
// экран — один из клиентов. Правка, принятая сервером, дожила бы до ближайшей
// синхронизации и молча откатилась через час — то есть человек за стойкой увидел
// бы «Сохранено», а назавтра тот же пустой телефон. Отказ на месте — не
// строгость ради строгости, а единственный ответ, говорящий правду о том, что
// произошло бы.
//
// Харнесс — тот же, что в users.test.js (там он не экспортируется).
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
  // Администратор филиала — заведён ЗДЕСЬ, поэтому себя и своих он править
  // вправе.
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  // Врач, приехавший из главной клиники: ровно то, что делает applyCatalogue.
  db.prepare('INSERT INTO users (username, password_hash, full_name, role, is_local) VALUES (?,?,?,?,0)')
    .run('ivanov', hashPassword('password2'), 'Иванов Иван', 'doctor');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

const send = (base, path, method, body, cookie) => fetch(base + path, {
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function loginAs(base, username, password) {
  const res = await send(base, '/api/auth/login', 'POST', { username, password });
  return res.headers.get('set-cookie').split(';')[0];
}

const idOf = (db, username) => db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;

test('список сотрудников отвечает, кем каждая строка управляется', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAs(base, 'boss', 'password1');
    const { users } = await (await send(base, '/api/users', 'GET', undefined, admin)).json();
    const byName = Object.fromEntries(users.map((u) => [u.username, u]));
    assert.equal(byName.boss.is_local, true, 'своего сотрудника филиал правит сам');
    assert.equal(byName.ivanov.is_local, false, 'этим управляет главная клиника');
    db.close();
  } finally { server.close(); }
});

test('PATCH по сотруднику главной клиники — отказ, а не тихая правка на час', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAs(base, 'boss', 'password1');
    const res = await send(base, '/api/users/' + idOf(db, 'ivanov'), 'PATCH', { phone: '+998900000000' }, admin);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error.message, /main clinic/i);
    assert.equal(db.prepare("SELECT phone FROM users WHERE username = 'ivanov'").get().phone, '',
      'ни одного поля не должно измениться');

    // Своего — правим как раньше: запрет адресный, а не «экран стал только для чтения».
    const own = await send(base, '/api/users/' + idOf(db, 'boss'), 'PATCH', { phone: '+998901112233' }, admin);
    assert.equal(own.status, 200);
    db.close();
  } finally { server.close(); }
});

test('DELETE по сотруднику главной клиники — отказ: он приедет заново под новым id', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAs(base, 'boss', 'password1');
    const id = idOf(db, 'ivanov');
    const res = await send(base, '/api/users/' + id, 'DELETE', undefined, admin);
    assert.equal(res.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(id).n, 1);

    // И проверка «можно ли удалить» обязана сказать это ЗАРАНЕЕ — иначе экран
    // предложил бы удаление, которого не бывает.
    const check = await (await send(base, `/api/users/${id}/delete-check`, 'GET', undefined, admin)).json();
    assert.equal(check.deletable, false);
    assert.match(check.reason, /main clinic/i);
    db.close();
  } finally { server.close(); }
});

test('свой пароль такой человек меняет в главной клинике, а не здесь', async () => {
  const { db, server, base } = await startServer();
  try {
    const doc = await loginAs(base, 'ivanov', 'password2');
    const res = await send(base, '/api/auth/change-password', 'POST',
      { current_password: 'password2', new_password: 'password3' }, doc);
    assert.equal(res.status, 409, 'иначе новый пароль прожил бы до ближайшей синхронизации');
    assert.match((await res.json()).error.message, /main clinic/i);

    // Пароль не тронут: человек по-прежнему входит своим.
    const again = await send(base, '/api/auth/login', 'POST', { username: 'ivanov', password: 'password2' });
    assert.equal(again.status, 200);

    // Свой сотрудник филиала меняет пароль как раньше.
    const boss = await loginAs(base, 'boss', 'password1');
    const ok = await send(base, '/api/auth/change-password', 'POST',
      { current_password: 'password1', new_password: 'password9' }, boss);
    assert.equal(ok.status, 200);
    db.close();
  } finally { server.close(); }
});
