// SOFTPHONE_V1 (решение владельца: «Only admin assigns») — НОМЕР ДЛЯ ТЕЛЕФОНА
// EASY-MED НАЗНАЧАЕТ КАРТОЧКА СОТРУДНИКА.
//
// Браузер получает пароль SIP этого номера, а пароль работает в любой SIP-программе
// и после увольнения. Поэтому номер, на котором включается телефон Easy-Med
// (users.pbx_extension_assigned), пишет только карточка сотрудника — тот, кому
// выдано «Сотрудники → Изменение», и не в своей карточке; «Моя трубка» и /api/db
// его не трогают.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const BOSS = 1, HEAD = 60, PLAIN = 61, REG = 62;

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
  ins.run(BOSS, 'boss', pw, 'Boss', 'admin', '[]');
  ins.run(HEAD, 'head', pw, 'Head Nurse', 'nurse', '[]');     // старшая медсестра: ей выдают «Сотрудников»
  ins.run(PLAIN, 'plain', pw, 'Plain Nurse', 'nurse', '[]');
  ins.run(REG, 'reg', pw, 'Registrar', 'registrar', '[]');    // оператор: набор есть, «Сотрудников» нет
  addGrants(db, 'registrar', { 'settings.employees': 'none' });
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base };
}
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
async function login(base, username) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
  assert.equal(res.status, 200, 'вход ' + username);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const cols = (db, id) => db.prepare('SELECT pbx_extension, pbx_extension_assigned FROM users WHERE id = ?').get(id);

test('карточка сотрудника назначает номер: заведение и правка пишут обе колонки, пустое поле стирает обе', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    const made = await call(base, boss, 'POST', '/api/users', { username: 'op.new', password: 'pw', role: 'registrar', pbx_extension: '108' });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const id = made.json.user.id;
    assert.deepEqual(cols(db, id), { pbx_extension: '108', pbx_extension_assigned: '108' });
    assert.equal((await call(base, boss, 'PATCH', '/api/users/' + id, { pbx_extension: ' 109 ' })).status, 200);
    assert.deepEqual(cols(db, id), { pbx_extension: '109', pbx_extension_assigned: '109' });
    // Правка без поля номера номер не трогает.
    assert.equal((await call(base, boss, 'PATCH', '/api/users/' + id, { phone: '+998901112233' })).status, 200);
    assert.deepEqual(cols(db, id), { pbx_extension: '109', pbx_extension_assigned: '109' });
    assert.equal((await call(base, boss, 'PATCH', '/api/users/' + id, { pbx_extension: '' })).status, 200);
    assert.deepEqual(cols(db, id), { pbx_extension: null, pbx_extension_assigned: null });
    // Без номера в карточке — ничего не назначено.
    const bare = await call(base, boss, 'POST', '/api/users', { username: 'op.bare', password: 'pw', role: 'registrar' });
    assert.deepEqual(cols(db, bare.json.user.id), { pbx_extension: null, pbx_extension_assigned: null });
  } finally { server.close(); }
});

// Поле номера в карточке — НАЗНАЧЕННЫЙ номер, и карточка шлёт его при каждом
// сохранении (views/employees.js). Назначение — только когда его поменяли: иначе
// сохранение ради телефона или ставок молча назначило бы номер, выбранный самим
// сотрудником в «Моя трубка», — и сбросило бы ему этот выбор.
test('сохранение карточки с прежним назначенным номером не трогает ни выбор сотрудника, ни назначение', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    db.prepare("UPDATE users SET pbx_extension = '107', pbx_extension_assigned = '108' WHERE id = ?").run(PLAIN);
    const list = await call(base, boss, 'GET', '/api/users');
    const plain = list.json.users.find((u) => u.id === PLAIN);
    assert.equal(plain.pbx_extension_assigned, '108', 'карточке не из чего показать назначенный номер');
    assert.equal(plain.pbx_extension, '107');
    assert.equal(list.json.users.find((u) => u.id === REG).pbx_extension_assigned, '', 'не назначен — пустая строка');
    // Тело — как у карточки: все поля, номер — назначенный, без изменений.
    const card = { last_name: 'Plain', first_name: 'Nurse', middle_name: '', phone: '+998901112233', email: '', staff_type: 'mid_low',
      scheduling_mode: 'schedulable', pbx_extension: plain.pbx_extension_assigned, department_id: null, specialty: '', doctor_category: '',
      hire_date: '', specialties: [], license_number: '', license_expiry_date: '', branch_id: null, employment_type: '', salary_type: '',
      salary_fixed: 0, salary_percent: 0, working_hours: '{}', service_rates: [], referral_rates: [], inpatient_rates: [],
      inpatient_referral_pct: 0, inpatient_referral_fixed: 0, role: 'nurse', custom_role_code: '', extra_roles: [], is_active: true };
    const saved = await call(base, boss, 'PATCH', '/api/users/' + PLAIN, card);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(cols(db, PLAIN), { pbx_extension: '107', pbx_extension_assigned: '108' },
      'сохранение карточки назначило самовыбранный номер или сбросило выбор сотрудника');
    assert.equal(db.prepare('SELECT phone FROM users WHERE id = ?').get(PLAIN).phone, '+998901112233', 'остальное сохранилось');
    // Пробелы по краям — тот же номер.
    assert.equal((await call(base, boss, 'PATCH', '/api/users/' + PLAIN, { pbx_extension: ' 108 ' })).status, 200);
    assert.deepEqual(cols(db, PLAIN), { pbx_extension: '107', pbx_extension_assigned: '108' });
    // Поменяли номер — назначение: обе колонки.
    assert.equal((await call(base, boss, 'PATCH', '/api/users/' + PLAIN, { ...card, pbx_extension: '107' })).status, 200);
    assert.deepEqual(cols(db, PLAIN), { pbx_extension: '107', pbx_extension_assigned: '107' });
    // Стёрли — обе пусты.
    assert.equal((await call(base, boss, 'PATCH', '/api/users/' + PLAIN, { ...card, pbx_extension: '' })).status, 200);
    assert.deepEqual(cols(db, PLAIN), { pbx_extension: null, pbx_extension_assigned: null });
    // Не назначен, а сотрудник выбрал себе 107: карточка с пустым полем ничего не стирает.
    db.prepare("UPDATE users SET pbx_extension = '107' WHERE id = ?").run(PLAIN);
    assert.equal((await call(base, boss, 'PATCH', '/api/users/' + PLAIN, { ...card, pbx_extension: '' })).status, 200);
    assert.deepEqual(cols(db, PLAIN), { pbx_extension: '107', pbx_extension_assigned: null });
  } finally { server.close(); }
});

test('назначенный номер нельзя прислать полем: ни администратору, ни кому-то ещё', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    db.prepare("UPDATE users SET pbx_extension = '108', pbx_extension_assigned = '108' WHERE id = ?").run(PLAIN);
    assert.equal((await call(base, boss, 'PATCH', '/api/users/' + PLAIN, { pbx_extension_assigned: '777' })).status, 200);
    assert.deepEqual(cols(db, PLAIN), { pbx_extension: '108', pbx_extension_assigned: '108' });
    const made = await call(base, boss, 'POST', '/api/users', { username: 'op.x', password: 'pw', role: 'registrar', pbx_extension_assigned: '777' });
    assert.equal(made.status, 201);
    assert.deepEqual(cols(db, made.json.user.id), { pbx_extension: null, pbx_extension_assigned: null });
  } finally { server.close(); }
});

test('свою карточку не-администратор правит, но номер себе не назначает; чужую — назначает с «Сотрудники → Изменение»', async () => {
  const { db, server, base } = await startServer();
  try {
    addGrants(db, 'nurse', { settings: 'view', 'settings.employees': 'edit' });
    const head = await login(base, 'head');
    assert.equal((await call(base, head, 'PATCH', '/api/users/' + HEAD, { pbx_extension: '107' })).status, 200);
    assert.deepEqual(cols(db, HEAD), { pbx_extension: '107', pbx_extension_assigned: null },
      'не-администратор назначил номер сам себе своей же карточкой');
    // Номер, назначенный себе ранее администратором, своей карточкой не снимается и не меняется.
    db.prepare("UPDATE users SET pbx_extension_assigned = '105' WHERE id = ?").run(HEAD);
    assert.equal((await call(base, head, 'PATCH', '/api/users/' + HEAD, { pbx_extension: '' })).status, 200);
    assert.deepEqual(cols(db, HEAD), { pbx_extension: null, pbx_extension_assigned: '105' });
    // Своя карточка с прежним (назначенным) номером в поле — выбор в «Моя трубка» цел.
    db.prepare("UPDATE users SET pbx_extension = '107' WHERE id = ?").run(HEAD);
    assert.equal((await call(base, head, 'PATCH', '/api/users/' + HEAD, { pbx_extension: '105', phone: '+998905556677' })).status, 200);
    assert.deepEqual(cols(db, HEAD), { pbx_extension: '107', pbx_extension_assigned: '105' },
      'сохранение своей карточки сбросило выбор сотрудника на назначенный номер');
    // Чужая карточка — назначение, как у администратора.
    assert.equal((await call(base, head, 'PATCH', '/api/users/' + PLAIN, { pbx_extension: '110' })).status, 200);
    assert.deepEqual(cols(db, PLAIN), { pbx_extension: '110', pbx_extension_assigned: '110' });
    // Администратор в своей карточке — назначает: решение и есть его.
    const boss = await login(base, 'boss');
    assert.equal((await call(base, boss, 'PATCH', '/api/users/' + BOSS, { pbx_extension: '101' })).status, 200);
    assert.deepEqual(cols(db, BOSS), { pbx_extension: '101', pbx_extension_assigned: '101' });
  } finally { server.close(); }
});

test('без «Сотрудников» — ни карточки, ни /api/db: номер не назначить ни себе, ни другому', async () => {
  const { db, server, base } = await startServer();
  try {
    const reg = await login(base, 'reg');
    assert.equal((await call(base, reg, 'PATCH', '/api/users/' + REG, { pbx_extension: '107' })).status, 403);
    assert.equal((await call(base, reg, 'PATCH', '/api/users/' + PLAIN, { pbx_extension: '107' })).status, 403);
    for (const values of [{ pbx_extension_assigned: '107' }, { pbx_extension: '107', pbx_extension_assigned: '107' }]) {
      const w = await call(base, reg, 'POST', '/api/db', { table: 'users', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: REG }] });
      assert.ok(w.status >= 400 && w.status < 500, 'запись в users через /api/db: ' + w.status);
    }
    const r = await call(base, reg, 'POST', '/api/db', { table: 'users', op: 'select', columns: 'id,pbx_extension_assigned', filters: [{ col: 'id', op: 'eq', val: REG }] });
    assert.ok(r.status >= 400 && r.status < 500, 'назначенный номер читается через /api/db: ' + r.status);
    // И администратор через /api/db его не пишет: путь один — карточка.
    const boss = await login(base, 'boss');
    const b = await call(base, boss, 'POST', '/api/db', { table: 'users', op: 'update', values: { pbx_extension_assigned: '107' }, filters: [{ col: 'id', op: 'eq', val: REG }] });
    assert.ok(b.status >= 400 && b.status < 500, 'администратор записал назначенный номер через /api/db: ' + b.status);
    assert.deepEqual(cols(db, REG), { pbx_extension: null, pbx_extension_assigned: null });
  } finally { server.close(); }
});

// Вход от имени: администратор — это сотрудник со своими правами. Назначить себе
// номер его карточкой нельзя, как нельзя и самому сотруднику; без «Сотрудников» —
// карточка закрыта вовсе.
test('от имени сотрудника номер не назначается: ни в его карточке, ни без его права «Сотрудники»', async () => {
  const { db, server, base } = await startServer();
  try {
    addGrants(db, 'nurse', { settings: 'view', 'settings.employees': 'edit' });
    const boss = await login(base, 'boss');
    const as = await call(base, boss, 'POST', '/api/auth/act-as', { user_id: HEAD });
    assert.equal(as.status, 200, JSON.stringify(as.json));
    TAB.set(boss, as.json.act_as_id);
    assert.equal((await call(base, boss, 'PATCH', '/api/users/' + HEAD, { pbx_extension: '107' })).status, 200);
    assert.deepEqual(cols(db, HEAD), { pbx_extension: '107', pbx_extension_assigned: null }, 'от имени сотрудника назначен номер ему же');
    const backRes = await call(base, boss, 'DELETE', '/api/auth/act-as');
    assert.equal(backRes.status, 200);
    TAB.set(boss, backRes.json.act_as_id);
    const asReg = await call(base, boss, 'POST', '/api/auth/act-as', { user_id: REG });
    assert.equal(asReg.status, 200, JSON.stringify(asReg.json));
    TAB.set(boss, asReg.json.act_as_id);
    assert.equal((await call(base, boss, 'PATCH', '/api/users/' + REG, { pbx_extension: '107' })).status, 403);
    assert.deepEqual(cols(db, REG), { pbx_extension: null, pbx_extension_assigned: null });
  } finally { server.close(); }
});
