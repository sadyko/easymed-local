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
import { STRINGS } from '../../public/js/admin/i18n-strings.js';   // STAFF_EDIT_V1 — отказы переводятся экраном
import { LOGIN_RULE_MESSAGE, LOGIN_TAKEN_MESSAGE, LOGIN_ADMIN_ONLY_MESSAGE, LOGIN_BRANCHES_MESSAGE } from './users.js';

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

test('STAFF_EDIT_V1: значения, равные сохранённым, не проверяются — старое неверное не мешает сменить телефон', async () => {
  const { db, server, base } = await startServer();
  try {
    db.prepare(`INSERT INTO users (id, username, password_hash, full_name, last_name, first_name, role, staff_type, is_doctor,
                  hire_date, doctor_category, employment_type, salary_percent, phone)
                VALUES (30, 'old.doc', 'x', 'Каримов Анвар', 'Каримов', 'Анвар', 'doctor', 'Врач', 1,
                  '15.01.2020', 'Высшая', 'штат', 150, '+998901112233')`).run();
    const boss = await login(base, 'boss');
    // Старая вкладка карточки (и импорт) шлёт всё, что хранится, — и неверное тоже.
    const stale = { hire_date: '15.01.2020', doctor_category: 'Высшая', employment_type: 'штат', staff_type: 'Врач', salary_percent: 150 };
    let r = await call(base, boss, 'PATCH', '/api/users/30', { ...stale, phone: '+998901112244' });
    assert.equal(r.status, 200, 'посторонний отказ: ' + JSON.stringify(r.json));
    const row = db.prepare('SELECT phone, hire_date, doctor_category, employment_type, staff_type, salary_percent, is_doctor FROM users WHERE id = 30').get();
    assert.equal(row.phone, '+998901112244');
    assert.deepEqual([row.hire_date, row.doctor_category, row.employment_type, row.staff_type, row.salary_percent, row.is_doctor],
      ['15.01.2020', 'Высшая', 'штат', 'Врач', 150, 1], 'нетронутые значения переписаны или признак врача сброшен');
    // Изменённое по-прежнему проверяется.
    r = await call(base, boss, 'PATCH', '/api/users/30', { hire_date: '16.01.2020' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.message, 'Дата указана неверно.');
    r = await call(base, boss, 'PATCH', '/api/users/30', { doctor_category: 'Первая' });
    assert.equal(r.status, 400);
    r = await call(base, boss, 'PATCH', '/api/users/30', { salary_percent: 151 });
    assert.equal(r.status, 400);
  } finally { server.close(); }
});

const RULE_MSG = 'Логин — от 3 до 30 символов: латинские буквы, цифры, точка, _ и -.';
const TAKEN_MSG = 'Такой логин уже занят.';
const ADMIN_ONLY_MSG = 'Логин меняет только администратор.';
const BRANCH_MSG = 'Логин нельзя менять, пока подключены филиалы: филиалы узнают сотрудника по логину.';

test('STAFF_EDIT_V1: администратор меняет логин — новый входит, старый нет; пробелы и регистр приводятся; сеанс сотрудника жив', async () => {
  const { db, server, base } = await startServer();
  try {
    const nurse = await login(base, 'nurse.a');
    const boss = await login(base, 'boss');
    // Под будущим логином кто-то ошибался, пока такого логина не было: эта
    // блокировка к сотруднику отношения не имеет и снимается вместе со сменой.
    for (let i = 0; i < 5; i += 1) await tryLogin(base, 'nurse.b', 'wrong');
    const r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: '  Nurse.B ' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.user.username, 'nurse.b');
    assert.equal(usernameOf(db, NURSE), 'nurse.b');
    assert.equal((await tryLogin(base, 'nurse.a')).status, 401, 'старый логин всё ещё входит');
    assert.equal((await tryLogin(base, 'nurse.b')).status, 200, 'новый логин не входит');
    const me = await call(base, nurse, 'GET', '/api/auth/me');
    assert.equal(me.status, 200, 'открытый сеанс сотрудника закрылся');
    assert.equal(me.json.user.username, 'nurse.b');
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: тот же логин в другом регистре — ничего не меняется', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    const r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: 'NURSE.A' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(usernameOf(db, NURSE), 'nurse.a');
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: занятый логин (другой регистр, пробелы) и неверный — 400 с полем username', async () => {
  const { db, server, base } = await startServer();
  try {
    db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('taken.one', 'x', 'Занятый З.', 'nurse')").run();
    const boss = await login(base, 'boss');
    let r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: ' TAKEN.ONE ' });
    assert.equal(r.status, 400);
    assert.deepEqual([r.json.error.message, r.json.error.field], [TAKEN_MSG, 'username']);
    for (const bad of ['ab', 'имя.фамилия', 'a b c', 'x'.repeat(31), '']) {
      r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.deepEqual([r.json.error.message, r.json.error.field], [RULE_MSG, 'username'], JSON.stringify(bad));
    }
    assert.equal(usernameOf(db, NURSE), 'nurse.a');
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: логин заняли между проверкой и записью — 400 «Такой логин уже занят.», ничего не записано', async () => {
  const { db, server, base } = await startServer();
  try {
    // Второй администратор «успевает» завести 'racer' ровно в миг записи:
    // триггер вставляет его перед обновлением строки, UNIQUE срабатывает на записи.
    db.exec(`CREATE TRIGGER race_login BEFORE UPDATE OF username ON users WHEN NEW.username = 'racer'
             BEGIN INSERT INTO users (username, password_hash, full_name, role) VALUES ('racer', 'x', 'Гонщик Г.', 'nurse'); END;`);
    const boss = await login(base, 'boss');
    const r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: 'racer', phone: '+998901234567' });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.deepEqual([r.json.error.message, r.json.error.field], [TAKEN_MSG, 'username']);
    assert.equal(usernameOf(db, NURSE), 'nurse.a');
    assert.notEqual(db.prepare('SELECT phone FROM users WHERE id = ?').get(NURSE).phone, '+998901234567', 'правка записалась наполовину');
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: логин меняет только администратор — не-администратору с «Сотрудники: Изменение» 403', async () => {
  const { db, server, base } = await startServer();
  try {
    const reg = await login(base, 'reg');
    let r = await call(base, reg, 'PATCH', '/api/users/' + NURSE, { username: 'nurse.z' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.message, ADMIN_ONLY_MSG);
    r = await call(base, reg, 'PATCH', '/api/users/' + REG, { username: 'reg.z' });
    assert.equal(r.status, 403, 'свой логин — тоже через администратора');
    assert.equal(r.json.error.message, ADMIN_ONLY_MSG);
    assert.deepEqual([usernameOf(db, REG), usernameOf(db, NURSE)], ['reg', 'nurse.a']);
    // Тот же логин (старая вкладка, импорт) — не смена и не отказ.
    r = await call(base, reg, 'PATCH', '/api/users/' + REG, { username: 'REG', phone: '+998901234567' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: работая от имени сотрудника, логин не меняется', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    const start = await call(base, boss, 'POST', '/api/auth/act-as', { user_id: REG });
    assert.equal(start.status, 200, JSON.stringify(start.json));
    TAB.set(boss, start.json.act_as_id);
    let r = await call(base, boss, 'PATCH', '/api/users/' + REG, { username: 'reg.z' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.message, ADMIN_ONLY_MSG);
    r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: 'nurse.z' });
    assert.equal(r.status, 403);
    assert.deepEqual([usernameOf(db, REG), usernameOf(db, NURSE)], ['reg', 'nurse.a']);
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: пока установка в группе филиалов — 409 и логин прежний; связь сняли — меняется', async () => {
  const { db, server, base, dataDir } = await startServer();
  try {
    writePairing(dataDir, { role: 'main', group_id: 'BR-TEST', secret: 's3cret' });
    const boss = await login(base, 'boss');
    let r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: 'nurse.b' });
    assert.equal(r.status, 409);
    assert.deepEqual([r.json.error.message, r.json.error.field], [BRANCH_MSG, 'username']);
    assert.equal(usernameOf(db, NURSE), 'nurse.a');
    r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: 'nurse.a', phone: '+998901234567' });
    assert.equal(r.status, 200, 'тот же логин при филиалах — не отказ');
    clearPairing(dataDir);
    r = await call(base, boss, 'PATCH', '/api/users/' + NURSE, { username: 'nurse.b' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(usernameOf(db, NURSE), 'nurse.b');
  } finally { server.close(); }
});

// Ревью 2 — заведение сотрудника (POST) — тоже установка пароля: пять ошибок
// под логином, которого ещё не было, запирали нового сотрудника на 5 минут.
test('STAFF_EDIT_V1 (ревью 2): новый сотрудник входит сразу, хотя под его логином ошибались до заведения', async () => {
  const { server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    for (let i = 0; i < 4; i += 1) assert.equal((await tryLogin(base, 'fresh.one', 'wrong')).status, 401);
    assert.equal((await tryLogin(base, 'fresh.one', 'wrong')).status, 429, 'пятая ошибка запирает вход');
    const r = await call(base, boss, 'POST', '/api/users', { username: ' Fresh.One ', password: 'pw-fresh', role: 'nurse',
      last_name: 'Фрешева', first_name: 'Ольга', phone: '+998901234500' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal((await tryLogin(base, 'fresh.one', 'pw-fresh')).status, 200, 'нового сотрудника заперли чужие ошибки');
  } finally { server.close(); }
});

test('STAFF_EDIT_V1: отказы смены логина — ключи словаря на трёх языках', () => {
  for (const m of [LOGIN_RULE_MESSAGE, LOGIN_TAKEN_MESSAGE, LOGIN_ADMIN_ONLY_MESSAGE, LOGIN_BRANCHES_MESSAGE]) {
    const e = STRINGS[m];
    assert.ok(e && e.ru === m && e.uz && e.en, 'нет перевода: ' + m);
  }
});
