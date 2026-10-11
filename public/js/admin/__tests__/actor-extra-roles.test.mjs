// BACKLOG_1011_V1 — ДОПОЛНИТЕЛЬНЫЕ РОЛИ ДОЕЗЖАЮТ ДО ОБОЛОЧКИ.
//
// Сессия отдаёт extra_roles (services/auth.js SESSION_USER_COLUMNS), а
// actorFromUser (auth.js) их отбрасывал: window.easymed.state.user знал только
// основную роль. Сервер же считает роли объединением основной и
// дополнительных (roles.js effectiveRoles) — и регистратор с надстройкой
// «старшая медсестра» не видел «Взять» у процедуры, которую сервер
// (rpc/procedures.js canPerformProcedures) ему отдаёт.
//
// Стенд: настоящая база, вход настоящими login() / sessionUser(), права
// оболочки — настоящей applyActorPermissions из admin.js, решение сервера —
// его же canPerformProcedures по строке users.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ─── крошечный DOM ──────────────────────────────────────────────────────────
class F {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.style = { setProperty() {}, getPropertyValue() { return ''; } };
    this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
    this.value = ''; this.parentElement = null;
  }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  get textContent() { return this._t + this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { return { contains: () => false, add() {}, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
const mk = (t) => {
  const e = new F(t);
  if (String(t).toLowerCase() === 'template') {
    e.content = { firstChild: null };
    Object.defineProperty(e, 'innerHTML', { set() { e.content.firstChild = new F('svg'); }, get() { return ''; } });
  }
  return e;
};
globalThis.Node = F;
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => { const n = new F('#text'); n._t = String(t); return n; },
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null,
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, easymed: { state: { user: null } }, CLINIC: { id: 1 } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

// ─── настоящая база за фальшивым fetch ──────────────────────────────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { reshape } = await import('../../../../server/routes/db.js');
const { hashPassword, login, sessionUser } = await import('../../../../server/services/auth.js');
const { canPerformProcedures } = await import('../../../../server/services/rpc/procedures.js');

const DB = openDb(':memory:');
migrate(DB);
// логин, роль, дополнительные роли, is_doctor
const PEOPLE = [
  ['regsn', 'registrar', ['senior_nurse'], 0],          // исполнитель процедур только надстройкой
  ['reg', 'registrar', [], 0],                          // не исполнитель
  ['cashnurse', 'cashier', ['nurse'], 0],               // исполнитель дополнительной ролью
  ['admx', 'admin', ['head_doctor', 'nurse', 'lab'], 0],// администратор с надстройками
  ['admplain', 'admin', [], 0],                         // администратор без надстроек
  ['admdocx', 'admin', ['head_doctor'], 1],             // администратор-врач с надстройкой
];
{
  const u = DB.prepare('INSERT INTO users (username, password_hash, full_name, role, extra_roles, is_doctor) VALUES (?,?,?,?,?,?)');
  for (const [login_, role, extra, doc] of PEOPLE) u.run(login_, hashPassword('password1'), 'Сотрудник ' + login_, role, JSON.stringify(extra), doc);
}

let USER = null;
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
const { isAdminActor } = await import('../admin-actor.js');
const { canTakeProcedure } = await import('../views/procedures.js');

const SHELL = fs.readFileSync(new URL('../../admin.js', import.meta.url), 'utf8');
const start = SHELL.indexOf('async function applyActorPermissions(');
const applyActorPermissions = new Function(
  'supabase', 'setFullAccess', 'setEffectiveFromRole', 'setEffectiveFromRoles', 'setOwnCustomGrants', 'setActorRoleGrants',
  SHELL.slice(start, SHELL.indexOf('\n}\n', start) + 2) + '\nreturn applyActorPermissions;',
)(supabase, perms.setFullAccess, perms.setEffectiveFromRole, perms.setEffectiveFromRoles, perms.setOwnCustomGrants, perms.setActorRoleGrants);

const KEYS = [...new Set([...perms.allPermissionKeys(), 'settings', 'reports-hub', 'employees', 'services', 'procedures',
  'api-settings', 'telegram-settings', 'telephony-settings', 'crm-settings', 'consultation-types', 'rooms-setup', 'mar-sheet', 'appointments'])].sort();
const snapshot = () => ({
  label: perms.currentRoleLabel(),
  modules: KEYS.filter((k) => perms.isModuleAllowed(k)),
  routes: KEYS.filter((k) => perms.isRouteAllowed(k)),
  levels: KEYS.map((k) => k + ':' + (perms.canEdit(k) ? 'edit' : perms.canView(k) ? 'view' : 'none')),
  admin: isAdminActor() && perms.actorIsAdmin(),
});
/** Сессия → оболочка, как admin.js onAuthed. */
async function signIn(username, override = null) {
  const res = login(DB, username, 'password1');
  assert.ok(res.session, 'вход ' + username);
  USER = sessionUser(DB, res.session);
  perms.setFullAccess(null);
  const actor = actorFromUser(override ? { ...res.user, ...override } : res.user);
  window.easymed.state.user = actor;
  await applyActorPermissions(actor);
  return actor;
}
const row = (username) => DB.prepare('SELECT id, role, extra_roles, is_doctor, is_active FROM users WHERE username = ?').get(username);

// ===========================================================================
test('сессия → оболочка: дополнительные роли едут в state.user (как у сервера), и строкой из базы тоже понимаются', async () => {
  for (const [login_, , extra] of PEOPLE) {
    const actor = await signIn(login_);
    assert.deepEqual(actor.extra_roles, extra, login_ + ': дополнительные роли не доехали до оболочки');
  }
  // Строка users, взятая из базы как есть, несёт роли JSON-строкой — понимаются оба вида.
  assert.deepEqual(actorFromUser({ role: 'nurse', extra_roles: '["registrar"]' }).extra_roles, ['registrar']);
  assert.deepEqual(actorFromUser({ role: 'nurse', extra_roles: '' }).extra_roles, []);
  assert.deepEqual(actorFromUser({ role: 'nurse', extra_roles: 'не JSON' }).extra_roles, []);
  assert.deepEqual(actorFromUser({ role: 'nurse' }).extra_roles, []);
});

test('«Взять» у процедуры — то же решение, что у сервера (canPerformProcedures), считая дополнительные роли', async () => {
  for (const [login_] of PEOPLE) {
    await signIn(login_);
    const server = canPerformProcedures(row(login_));
    assert.equal(canTakeProcedure(), server, `${login_}: «Взять» ${server ? 'спрятано' : 'показано'}, а сервер ${server ? 'пускает' : 'откажет'}`);
  }
  await signIn('regsn');
  assert.equal(canTakeProcedure(), true, 'регистратор со «старшей медсестрой» — исполнитель');
  // Подстраховка: роли строкой из базы — как parseRoles сервера.
  assert.equal(canTakeProcedure({ role: 'registrar', extra_roles: '["senior_nurse"]' }), true);
  assert.equal(canTakeProcedure({ role: 'registrar', extra_roles: '[]' }), false);
});

test('ни один экран администратора не сужается от дополнительных ролей: меню, маршруты, уровни — те же, администратор остаётся администратором', async () => {
  for (const login_ of ['admx', 'admdocx']) {
    await signIn(login_);
    const withExtras = snapshot();
    await signIn(login_, { extra_roles: [] });
    const without = snapshot();
    assert.deepEqual(withExtras, without, login_ + ': дополнительные роли изменили экраны администратора');
    assert.equal(withExtras.admin, true, login_ + ': перестал быть администратором');
  }
  // И администратор по ДОПОЛНИТЕЛЬНОЙ роли — администратор (так считает и сервер).
  window.easymed.state.user = actorFromUser({ id: 77, role: 'nurse', extra_roles: ['admin'] });
  assert.equal(isAdminActor(), true, 'медсестра с дополнительной ролью «администратор» — администратор, как на сервере');
});
