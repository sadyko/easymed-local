// STAFF_EDIT_V1 (2026-11-02) — АДМИНИСТРАТОР МЕНЯЕТ ЛОГИН, ДАННЫЕ И ПАРОЛЬ СОТРУДНИКА.
//
// Спецификация — docs/specs/2026-11-02-3210-batch-design.md, U4. Здесь — сервер
// (routes/users.js PATCH):
//   • сброс пароля снимает блокировку входа (5 ошибок → 5 минут);
//   • пароль отключённому — ответ с признаком password_inactive;
//   • значения, равные сохранённым, не проверяются: старое неверное значение не
//     держит сохранение;
//   • логин меняет администратор (не «вход как сотрудник»): правило заведения,
//     занятость без учёта регистра, гонка UNIQUE, другой регистр — ничего,
//     подключены филиалы — 409.
// Блокировка входа живёт в памяти процесса (services/auth.js) и общая для всех
// тестов файла — поэтому у каждого теста свои логины.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { writePairing, clearPairing } from '../services/branch-sync/pairing.js';

const BOSS = 1, REG = 2, NURSE = 3;

function addGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  const pw = hashPassword('password1');
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, extra_roles, must_change_password) VALUES (?,?,?,?,?,?,0)');
  ins.run(BOSS, 'boss', pw, 'Петров П.', 'admin', '[]');
  ins.run(REG, 'reg', pw, 'Регистратор Р.', 'registrar', '[]');
  ins.run(NURSE, 'nurse.a', pw, 'Медсестра А.', 'nurse', '[]');
  // Регистратуре выдано «Сотрудники: Изменение» — отказ ей должен прийти от
  // правила логина, а не от раздела.
  addGrants(db, 'registrar', { settings: 'view', 'settings.employees': 'edit' });
  const dataDir = licensedDataDir();
  const server = await listen(createApp(db, { dataDir }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base, dataDir };
}

// Вкладка, работающая от имени сотрудника, шлёт номер входа от имени (X-Em-Act-As).
const TAB = new Map();
async function call(base, cookie, method, path, body) {
  const tab = cookie && TAB.has(cookie) ? { 'X-Em-Act-As': String(TAB.get(cookie)) } : {};
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...tab },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
async function tryLogin(base, username, password = 'password1') {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  return { status: res.status, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}
async function login(base, username, password = 'password1') {
  const r = await tryLogin(base, username, password);
  assert.equal(r.status, 200, 'вход ' + username);
  return r.cookie;
}
const usernameOf = (db, id) => db.prepare('SELECT username FROM users WHERE id = ?').get(id).username;

test('STAFF_EDIT_V1: сброс пароля администратором снимает блокировку входа', async () => {
  const { db, server, base } = await startServer();
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (20, 'lock.reset', ?, 'Забывчивая З.', 'nurse')")
      .run(hashPassword('old-pass'));
    const boss = await login(base, 'boss');
    for (let i = 0; i < 4; i += 1) assert.equal((await tryLogin(base, 'lock.reset', 'wrong')).status, 401);
    assert.equal((await tryLogin(base, 'lock.reset', 'wrong')).status, 429, 'пятая ошибка запирает вход');
    assert.equal((await tryLogin(base, 'lock.reset', 'old-pass')).status, 429, 'и верный пароль не пускает');
    const r = await call(base, boss, 'PATCH', '/api/users/20', { password: 'new-pass' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await tryLogin(base, 'lock.reset', 'new-pass')).status, 200, 'с новым паролем — сразу, без пяти минут ожидания');
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: пароль отключённому — признак password_inactive; включённому и без пароля — нет', async () => {
  const { db, server, base } = await startServer();
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active) VALUES (21, 'gone.one', 'x', 'Уволенный У.', 'nurse', 0)").run();
    const boss = await login(base, 'boss');
    let r = await call(base, boss, 'PATCH', '/api/users/21', { password: 'pw-1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.password_inactive, true, 'экран не узнает, что сотрудник не войдёт');
    assert.equal((await tryLogin(base, 'gone.one', 'pw-1')).status, 401, 'отключённый не входит — потому и предупреждение');
    r = await call(base, boss, 'PATCH', '/api/users/21', { password: 'pw-2', is_active: true });
    assert.equal(r.status, 200);
    assert.ok(!('password_inactive' in r.json), 'включили в том же сохранении — предупреждать не о чем');
    r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { password: 'pw-3' });
    assert.ok(!('password_inactive' in r.json));
    r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { phone: '+998901234567' });
    assert.ok(!('password_inactive' in r.json), 'без пароля признака нет');
  } finally { server.close(); }
});
