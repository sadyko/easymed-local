// LOGIN_ROLES_V1 — ПРАВА ОБОЛОЧКИ СРАЗУ ПОСЛЕ ВХОДА — ТЕ ЖЕ, ЧТО ПОСЛЕ F5.
//
// Вход через форму НЕ перезагружает страницу: admin.js onAuthed строит
// оболочку по ОТВЕТУ ВХОДА (server/services/auth.js login → publicUser), а
// после перезагрузки — по /api/auth/me (sessionUser). Вход не брал из базы
// своей роли клиники (custom_role_code) и дополнительных ролей, и до первого
// F5:
//   • сотрудник со своей ролью получал экраны её ОСНОВЫ — а своя роль ради
//     того и заводится, чтобы видеть МЕНЬШЕ основы;
//   • администратор со своей ролью терял её «Нет» (закрытые плитки настроек).
//
// Стенд гоняет НАСТОЯЩУЮ applyActorPermissions из admin.js (текст функции,
// зависимости — настоящий модуль прав и настоящий supabase-клиент) по
// настоящей базе за фальшивым fetch (компилятор и reshape маршрута /api/db).
// Ответы входа и /me — настоящими login() / sessionUser() сервера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ─── минимальное окружение браузера ─────────────────────────────────────────
class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this.dataset = {}; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener() {} removeEventListener() {}
  get textContent() { return this._t; } set textContent(v) { this._t = String(v); }
  get classList() { return { contains: () => false, add() {}, remove() {}, toggle() {} }; }
}
globalThis.Node = F;
globalThis.document = {
  createElement: (t) => new F(t), createElementNS: (_n, t) => new F(t), createTextNode: (t) => new F('#text'),
  head: new F('head'), body: new F('body'), documentElement: new F('html'),
  addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null,
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, easymed: { state: { user: null } }, CLINIC: { id: 1 } };

// ─── настоящая база за фальшивым fetch ──────────────────────────────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { reshape } = await import('../../../../server/routes/db.js');
const { hashPassword, login, sessionUser } = await import('../../../../server/services/auth.js');

const DB = openDb(':memory:');
migrate(DB);
{
  const role = DB.prepare('INSERT INTO custom_roles (code, name, base_role) VALUES (?,?,?)');
  role.run('reg_lite', 'Регистратор без CRM', 'registrar');
  role.run('adm_lite', 'Администратор без API', 'admin');
  const perm = DB.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)');
  // Своя роль регистратора: без CRM и без коек — меньше основы.
  perm.run('reg_lite', JSON.stringify({ sections: ['patients', 'dashboard', 'registration', 'queue'],
    levels: { patients: 'editor', registration: 'editor', queue: 'viewer' } }));
  // Своя роль администратора: полный доступ, но плитка «API и подключения» — «Нет».
  perm.run('adm_lite', JSON.stringify({ sections: [], levels: {}, grants: { 'settings.api': 'none' } }));
  const u = DB.prepare('INSERT INTO users (username, password_hash, full_name, role, custom_role_code, extra_roles) VALUES (?,?,?,?,?,?)');
  u.run('reglite', hashPassword('password1'), 'Регистратор Лайт', 'registrar', 'reg_lite', '[]');
  u.run('nursereg', hashPassword('password1'), 'Медсестра с регистратурой', 'nurse', null, JSON.stringify(['registrar']));
  u.run('admlite', hashPassword('password1'), 'Администратор Лайт', 'admin', 'adm_lite', '[]');
}

let USER = null;   // кто спрашивает сервер: сессия, как req.user любого запроса после входа
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  const fail = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });
  if (String(url) !== '/api/db') return fail(404, 'no route ' + url);
  let compiled;
  try { compiled = compile(body, USER, { db: DB }); } catch (e) { return fail(400, e.message); }
  const { sql, params, meta } = compiled;
  const rows = reshape(DB.prepare(sql).all(...params), meta);
  for (const r of rows) for (const c of meta.json || []) if (typeof r[c] === 'string') { try { r[c] = JSON.parse(r[c]); } catch { r[c] = null; } }
  if (meta.single === 'single') return ok(rows[0]);
  if (meta.single === 'maybe') return ok(rows[0] ?? null);
  return ok(rows);
};

const { supabase } = await import('../../supabase.js');
const { actorFromUser } = await import('../auth.js');
const perms = await import('../permissions.js');

// Настоящая applyActorPermissions из admin.js — её зависимости те, что она импортирует.
const SHELL = fs.readFileSync(new URL('../../admin.js', import.meta.url), 'utf8');
const start = SHELL.indexOf('async function applyActorPermissions(');
assert.ok(start > -1, 'admin.js: applyActorPermissions не найдена');
const fnSrc = SHELL.slice(start, SHELL.indexOf('\n}\n', start) + 2);
const applyActorPermissions = new Function(
  'supabase', 'setFullAccess', 'setEffectiveFromRole', 'setEffectiveFromRoles', 'setOwnCustomGrants', 'setActorRoleGrants',
  fnSrc + '\nreturn applyActorPermissions;',
)(supabase, perms.setFullAccess, perms.setEffectiveFromRole, perms.setEffectiveFromRoles, perms.setOwnCustomGrants, perms.setActorRoleGrants);

const KEYS = [...new Set([...perms.allPermissionKeys(), 'settings', 'reports-hub', 'employees', 'services',
  'api-settings', 'telegram-settings', 'telephony-settings', 'crm-settings', 'consultation-types', 'rooms-setup'])].sort();
function snapshot() {
  return {
    label: perms.currentRoleLabel(),
    roles: perms.actorRoleCodes().slice().sort(),
    modules: KEYS.filter((k) => perms.isModuleAllowed(k)),
    routes: KEYS.filter((k) => perms.isRouteAllowed(k)),
    levels: KEYS.map((k) => k + ':' + (perms.canEdit(k) ? 'edit' : perms.canView(k) ? 'view' : 'none')),
  };
}
/** Оболочка, собранная по ответу `payload` (вход или /me), — как admin.js onAuthed. */
async function shellFrom(payload, session) {
  USER = session;
  perms.setFullAccess(null);   // свежая страница: ничего от прошлого входа
  const actor = actorFromUser(payload);
  window.easymed.state.user = actor;
  await applyActorPermissions(actor);
  return snapshot();
}
async function loginThenReload(username) {
  const res = login(DB, username, 'password1');
  assert.ok(res.session, 'вход ' + username);
  const me = sessionUser(DB, res.session);
  return { me, afterLogin: await shellFrom(res.user, me), afterReload: await shellFrom(me, me) };
}

// ===========================================================================
test('LOGIN_ROLES_V1: своя роль клиники — сразу после входа те же экраны, что после F5 (меньше основы)', async () => {
  const { me, afterLogin, afterReload } = await loginThenReload('reglite');
  assert.deepEqual(afterLogin, afterReload, 'после входа оболочка собрана не по своей роли клиники');
  assert.ok(!afterReload.modules.includes('crm'), 'своя роль закрыла CRM: ' + afterReload.modules.join(','));
  assert.ok(afterReload.modules.includes('registration'));
  // Стенд различает: основа (регистратор) CRM видит — значит, равенство выше не пустое.
  const base = await shellFrom({ ...me, custom_role_code: null }, me);
  assert.ok(base.modules.includes('crm'), 'основа без своей роли — с CRM');
  assert.notDeepEqual(base, afterReload);
});

test('LOGIN_ROLES_V1: дополнительные роли — сразу после входа те же экраны, что после F5', async () => {
  const { afterLogin, afterReload } = await loginThenReload('nursereg');
  assert.deepEqual(afterLogin, afterReload);
  assert.ok(afterReload.modules.includes('registration'), 'дополнительная роль «регистратура» не открыла свой раздел');
  assert.ok(afterReload.modules.includes('procedures'), 'основа (медсестра) на месте');
});

test('LOGIN_ROLES_V1: администратор со своей ролью — её «Нет» действует сразу после входа, а не после F5', async () => {
  const { me, afterLogin, afterReload } = await loginThenReload('admlite');
  assert.deepEqual(afterLogin, afterReload, 'после входа администратор открыл то, что закрыла его роль');
  assert.ok(!afterReload.routes.includes('api-settings'), 'своя роль закрыла «API и подключения»');
  const plain = await shellFrom({ ...me, custom_role_code: null }, me);
  assert.ok(plain.routes.includes('api-settings'), 'обычный администратор «API и подключения» открывает');
});
