// ADMIN_DOCTOR_LOCAL_V1 — СЕССИЯ НАЗЫВАЕТ ВРАЧА ФЛАГОМ is_doctor.
//
// Администратор клиники может быть и врачом (ADMIN_DOCTOR_V1): роль у него
// 'admin', а врача в нём узнают только по users.is_doctor. Сессия (вход и
// /api/auth/me) этого флага не отдавала вовсе, и оболочка (auth.js
// actorFromUser) считала врачом только role = 'doctor'. Администратор-врач
// получал пустой «мой день» в кабинете, «Мой профиль» отвечал «нет контекста
// врача», а «Взять» у процедуры пряталось — хотя сервер его пускал.
//
// Здесь закреплено: (1) флаг едет и при входе, и при восстановлении сессии,
// настоящим true/false, а не числом из базы; (2) ФОРМА ответа — ровно эти
// ключи: ни пароля, ни специальности, ни денег сессия не отдаёт.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import * as authService from '../services/auth.js';   // LOGIN_ROLES_V1 — пространством: SESSION_USER_COLUMNS проверяется тестом, а не падением импорта
import { staffById } from '../services/crm/tasks-follow.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const { hashPassword } = authService;

// Ровно то, что отдаёт сессия. Новый ключ — сознательное решение: дописать
// сюда и убедиться, что он не секрет (пароль, деньги, личные данные).
const SESSION_KEYS = ['custom_role_code', 'department_id', 'extra_roles', 'full_name', 'id', 'is_active',
  'is_doctor', 'must_change_password', 'role', 'username'];

// логин, роль, is_doctor, специальность
const PEOPLE = [
  ['boss', 'admin', 0, ''],              // администратор, не врач
  ['admdoc', 'admin', 1, ''],            // администратор-врач без специальности
  ['admdocspec', 'admin', 1, 'Терапевт'],
  ['doc', 'doctor', 1, 'Кардиолог'],     // обычный врач
  ['labdoc', 'lab', 1, ''],              // врач-лаборант: роль не 'doctor'
  ['nurse', 'nurse', 0, 'Процедурная'],  // специальность БЕЗ флага — не врач
];

// LOGIN_ROLES_V1 — своя роль клиники и дополнительные роли.
// логин, роль, своя роль клиники, дополнительные роли
const ROLE_PEOPLE = [
  ['reglite', 'registrar', 'reg_lite', []],
  ['nurselab', 'nurse', null, ['lab', 'senior_nurse']],
  ['admlite', 'admin', 'adm_lite', ['head_doctor']],
];
const EVERYONE = [...PEOPLE.map((p) => p[0]), ...ROLE_PEOPLE.map((p) => p[0])];

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (username, password_hash, full_name, role, is_doctor, specialty, license_number, salary_fixed) VALUES (?,?,?,?,?,?,?,?)');
  for (const [login, role, isDoc, spec] of PEOPLE) ins.run(login, hashPassword('password1'), 'Сотрудник ' + login, role, isDoc, spec, 'AA-1', 5000000);
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('reg_lite', 'Регистратор без CRM', 'registrar'), ('adm_lite', 'Администратор без API', 'admin')").run();
  const insRoles = db.prepare('INSERT INTO users (username, password_hash, full_name, role, custom_role_code, extra_roles) VALUES (?,?,?,?,?,?)');
  for (const [login, role, code, extra] of ROLE_PEOPLE) insRoles.run(login, hashPassword('password1'), 'Сотрудник ' + login, role, code, JSON.stringify(extra));
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function signIn(base, username) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }),
  });
  assert.equal(res.status, 200, 'вход ' + username);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { cookie, user: (await res.json()).user };
}

test('ADMIN_DOCTOR_LOCAL_V1: вход и /api/auth/me называют врача по флагу is_doctor — true/false, не 0/1', async () => {
  const { server, base } = await startServer();
  try {
    const want = { boss: false, admdoc: true, admdocspec: true, doc: true, labdoc: true, nurse: false };
    for (const [login] of PEOPLE) {
      const { cookie, user } = await signIn(base, login);
      assert.equal(user.is_doctor, want[login], `вход ${login}: is_doctor`);
      const me = (await (await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })).json()).user;
      assert.equal(me.is_doctor, want[login], `/me ${login}: is_doctor`);
    }
  } finally { server.close(); }
});

test('ADMIN_DOCTOR_LOCAL_V1 · LOGIN_ROLES_V1: форма сессии закреплена — ни пароля, ни специальности, ни денег; у входа и /me одна', async () => {
  const { server, base } = await startServer();
  try {
    for (const login of ['admdoc', 'reglite', 'nurselab', 'admlite']) {
      const { cookie, user } = await signIn(base, login);
      assert.deepEqual(Object.keys(user).sort(), SESSION_KEYS, `ответ входа ${login}`);
      const me = (await (await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })).json()).user;
      assert.deepEqual(Object.keys(me).sort(), SESSION_KEYS, `ответ /me ${login}`);
      for (const secret of ['password_hash', 'specialty', 'license_number', 'salary_fixed']) {
        assert.ok(!(secret in user), `вход не отдаёт ${secret}`);
        assert.ok(!(secret in me), `/me не отдаёт ${secret}`);
      }
    }
  } finally { server.close(); }
});

// LOGIN_ROLES_V1 — ВХОД ОТДАЁТ РОВНО ТО ЖЕ, ЧТО /me. Вход через форму НЕ
// перезагружает страницу: оболочка (admin.js onAuthed) строит права по ответу
// входа. Тот не брал из базы ни своей роли клиники, ни дополнительных ролей —
// и до первого F5 человек со своей ролью получал экраны её ОСНОВЫ (своя роль
// для того и заводится, чтобы видеть меньше), а администратор со своей ролью —
// без её «Нет». Теперь у всех трёх чтений сессии один список колонок.
test('LOGIN_ROLES_V1: ответ входа — тот же, что /me и staffById: своя роль клиники и дополнительные роли с первой минуты', async () => {
  const { db, server, base } = await startServer();
  try {
    for (const login of EVERYONE) {
      const { cookie, user } = await signIn(base, login);
      const me = (await (await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })).json()).user;
      assert.deepEqual(user, me, `${login}: ответ входа разошёлся с /me`);
      assert.deepEqual(staffById(db, me.id), me, `${login}: staffById разошёлся с /me`);
    }
    const as = async (login) => (await signIn(base, login)).user;
    const reg = await as('reglite');
    assert.equal(reg.custom_role_code, 'reg_lite', 'вход потерял свою роль клиники');
    assert.deepEqual(reg.extra_roles, []);
    assert.deepEqual((await as('nurselab')).extra_roles, ['lab', 'senior_nurse'], 'вход потерял дополнительные роли');
    const adm = await as('admlite');
    assert.equal(adm.custom_role_code, 'adm_lite');
    assert.deepEqual(adm.extra_roles, ['head_doctor']);
  } finally { server.close(); }
});

test('LOGIN_ROLES_V1: один список колонок сессии на все чтения — и он совпадает с формой ответа', () => {
  const { SESSION_USER_COLUMNS } = authService;
  assert.ok(Array.isArray(SESSION_USER_COLUMNS), 'services/auth.js экспортирует SESSION_USER_COLUMNS');
  assert.deepEqual([...SESSION_USER_COLUMNS].sort(), SESSION_KEYS, 'publicUser отдаёт ровно прочитанные колонки');
  assert.ok(!SESSION_USER_COLUMNS.includes('password_hash'), 'хэш пароля в общий список не входит: его читает только вход');
});

test('ADMIN_DOCTOR_LOCAL_V1: сотрудник для CRM (staffById, тот же publicUser) тоже знает флаг, а не врёт «не врач»', async () => {
  const { db, server } = await startServer();
  try {
    const id = (login) => db.prepare('SELECT id FROM users WHERE username = ?').get(login).id;
    assert.equal(staffById(db, id('admdoc')).is_doctor, true);
    assert.equal(staffById(db, id('boss')).is_doctor, false);
    assert.deepEqual(Object.keys(staffById(db, id('admdoc'))).sort(), SESSION_KEYS);
  } finally { server.close(); }
});
