import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { bootstrapAdmin, FIRST_RUN_PASSWORD } from '../services/auth.js';
import { createApp } from '../app.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';   // LICENCE_CORE_V1 — иначе запись в /api/users упрётся в 402

// PASSWORD_CHANGE_V2 (2026-09-23) — владелец: «check for admin password
// changing — we cannot change» и «give permission to 1 or 2 character
// passwords». Сервер пароль из одного символа принимал и раньше
// (PASSWORD_CLINIC_RULE_V1, services/auth.js validPassword); не могли экраны.
// Эти проверки закрепляют серверную сторону теми самыми запросами, которые
// теперь шлют экраны: смена своего пароля из меню аватара и «Сменить пароль»
// в карточке сотрудника — и главное, что с новым паролем потом ВХОДЯТ.

function makeApp() {
  const db = openDb(':memory:');
  migrate(db);
  bootstrapAdmin(db);
  return { db, app: createApp(db, { dataDir: licensedDataDir() }) };
}

const base = (server) => `http://127.0.0.1:${server.address().port}`;

async function login(server, password) {
  const res = await fetch(`${base(server)}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  return { res, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}

const request = (server, cookie, method, url, body) =>
  fetch(`${base(server)}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

test('администратор меняет свой пароль на «1» через /api/auth/change-password и входит с ним', async (t) => {
  const { app } = makeApp();
  const server = await listen(app);
  t.after(() => server.close());

  const { cookie } = await login(server, FIRST_RUN_PASSWORD);
  const r = await request(server, cookie, 'POST', '/api/auth/change-password',
    { current_password: FIRST_RUN_PASSWORD, new_password: '1' });
  assert.equal(r.status, 200, 'пароль из одного символа — решение владельца, сервер его принимает');

  const again = await login(server, '1');
  assert.equal(again.res.status, 200, 'с новым паролем «1» вход обязан пройти');
  assert.equal((await again.res.json()).user.must_change_password, false);

  const old = await login(server, FIRST_RUN_PASSWORD);
  assert.equal(old.res.status, 401, 'старый пароль больше не подходит');
});

test('неверный текущий пароль и пустой новый — отказ с кодом, который экран переводит в слова', async (t) => {
  const { app } = makeApp();
  const server = await listen(app);
  t.after(() => server.close());
  const { cookie } = await login(server, FIRST_RUN_PASSWORD);

  const wrong = await request(server, cookie, 'POST', '/api/auth/change-password',
    { current_password: 'не тот', new_password: '1' });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, 'invalid_credentials');

  const empty = await request(server, cookie, 'POST', '/api/auth/change-password',
    { current_password: FIRST_RUN_PASSWORD, new_password: '' });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'weak_password');
});

test('«Сменить пароль» в карточке: PATCH /api/users/:id только с { password } — своему же администратору, без ФИО и телефона', async (t) => {
  const { db, app } = makeApp();
  const server = await listen(app);
  t.after(() => server.close());
  const first = await login(server, FIRST_RUN_PASSWORD);
  await request(server, first.cookie, 'POST', '/api/auth/change-password',
    { current_password: FIRST_RUN_PASSWORD, new_password: 'x' });

  const { cookie } = await login(server, 'x');
  const me = db.prepare("SELECT id, phone, last_name FROM users WHERE username = 'admin'").get();
  assert.ok(!me.phone && !me.last_name, 'учётная запись первого запуска — без телефона и ФИО, ровно как у владельца');

  const r = await request(server, cookie, 'PATCH', `/api/users/${me.id}`, { password: '2' });
  assert.equal(r.status, 200, 'смена пароля не зависит от ФИО, телефона и категории');

  const after = await login(server, '2');
  assert.equal(after.res.status, 200, 'и с этим паролем тоже входят');
  const row = db.prepare('SELECT role, is_active FROM users WHERE id = ?').get(me.id);
  assert.deepEqual({ ...row }, { role: 'admin', is_active: 1 }, 'только пароль — роль и активность не тронуты');
});
