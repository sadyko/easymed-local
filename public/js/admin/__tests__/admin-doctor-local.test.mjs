// ADMIN_DOCTOR_LOCAL_V1 — АДМИНИСТРАТОР-ВРАЧ ВИДЕН ВРАЧОМ ВЕЗДЕ, ГДЕ ЕГО ИЩУТ.
//
// Администратор клиники может быть и врачом (ADMIN_DOCTOR_V1): роль 'admin',
// флаг users.is_doctor = 1, специальности может не быть. Было сломано двумя
// путями сразу:
//   1. сессия (вход, /api/auth/me) флага не отдавала, и оболочка
//      (auth.js actorFromUser) знала врача только по role = 'doctor' — пустой
//      «мой день», «Мой профиль» отвечал «нет контекста врача», «Взять» у
//      процедуры пряталось;
//   2. списки врачей спрашивали `u.is_doctor === true`, а /api/db отдаёт флаг
//      ЧИСЛОМ 1 — и администратор-врач без специальности выпадал из списка
//      врачей вкладки «Зарплата» и из выбора врача у рекомендации.
//
// Стенд НЕ подставляет удобные true: за фальшивым fetch стоят настоящая база
// (все миграции), настоящий компилятор запросов и тот же reshape, что у
// маршрута /api/db, — флаг приходит ровно так, как в клинике: 1. Сессия
// берётся настоящими login() / sessionUser() сервера.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM ──────────────────────────────────────────────────────────
class F {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.style = { setProperty() {}, getPropertyValue() { return ''; } };
    this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
    this.value = ''; this.checked = false; this.disabled = false; this.parentElement = null;
  }
  appendChild(c) { if (c.parentElement) c.parentElement.removeChild(c); this.children.push(c); c.parentElement = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  insertBefore(c) { return this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); c.parentElement = null; return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren(...cs) { this.children.length = 0; for (const c of cs) this.appendChild(c); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} select() {} scrollTo() {} scrollIntoView() {}
  contains() { return false; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  closest() { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get textContent() { return this._t + this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => {
  const e = new F(t);
  if (String(t).toLowerCase() === 'template') {
    e.content = { firstChild: null };
    Object.defineProperty(e, 'innerHTML', { set(v) { const s = new F('svg'); s._t = ''; e.content.firstChild = s; }, get() { return ''; } });
  }
  return e;
};
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null,
};
// Язык экрана — явно, до импорта видов (i18n выбирает его один раз).
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, open: () => null,
  easymed: { state: { user: null } }, easymedSetTabSub: () => {},
  CLINIC: { id: 1 },   // LOCAL_SINGLE_CLINIC_V1 — офлайн клиника всегда одна и всегда известна
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };
globalThis.confirm = () => true;

// ─── настоящая база, настоящий компилятор и reshape за фальшивым fetch ──────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { reshape } = await import('../../../../server/routes/db.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { hashPassword, login, sessionUser } = await import('../../../../server/services/auth.js');

const ADMIN_DOC = 20;   // администратор-врач БЕЗ специальности
const DOC = 10;         // обычный врач
const KASSA = 9;        // кассир — не врач

const DB = openDb(':memory:');
migrate(DB);
{
  const u = DB.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, license_number) VALUES (?,?,?,?,?,?,?,?)');
  u.run(ADMIN_DOC, 'admdoc', hashPassword('password1'), 'Админова Дилноза', 'admin', 1, '', '');
  u.run(DOC, 'doc', hashPassword('password1'), 'Каримов Бахтиёр', 'doctor', 1, 'Кардиолог', '');
  u.run(KASSA, 'kassa', hashPassword('password1'), 'Кассирова Нигора', 'cashier', 0, '', '');
  DB.prepare("INSERT INTO patients (id, full_name) VALUES (3, 'Иванов Иван')").run();
  DB.prepare("INSERT INTO services (id, name, price) VALUES (22, 'УЗИ брюшной полости', 150000)").run();
  DB.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (40, 3, ?, 'scheduled')").run(new Date().toISOString());
  DB.prepare("INSERT INTO recommended_services (patient_id, service_id, service_name, recommended_by, status) VALUES (3, 22, 'УЗИ брюшной полости', ?, 'pending')").run(ADMIN_DOC);
}

let USER = { id: ADMIN_DOC, role: 'admin', extra_roles: [] };   // кто спрашивает сервер
const DBCALLS = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), text: async () => JSON.stringify({ data }) });
  const fail = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }), text: async () => message });
  if (u.startsWith('/api/rpc/')) {
    const handler = getRpc(decodeURIComponent(u.slice('/api/rpc/'.length)));
    if (!handler) return fail(501, 'RPC not implemented');
    try { return ok(await handler(DB, body, USER)); } catch (e) { return fail(e.status || 500, e.message); }
  }
  if (u === '/api/db') {
    DBCALLS.push(body);
    let compiled;
    try { compiled = compile(body, USER, { db: DB }); } catch (e) { return fail(400, e.message); }
    const { sql, params, meta } = compiled;
    if (meta.op !== 'select') { DB.prepare(sql).run(...params); return ok(null); }
    // Как routes/db.js respondRows: связи — вложенными, JSON-колонки — объектами.
    const rows = reshape(DB.prepare(sql).all(...params), meta);
    for (const r of rows) for (const c of meta.json || []) if (typeof r[c] === 'string') { try { r[c] = JSON.parse(r[c]); } catch { r[c] = null; } }
    if (meta.single === 'single') return ok(rows[0]);
    if (meta.single === 'maybe') return ok(rows[0] ?? null);
    return ok(rows);
  }
  return fail(404, 'no route ' + u);
};

const { actorFromUser } = await import('../auth.js');
const perms = await import('../permissions.js');
const { canTakeProcedure } = await import('../views/procedures.js');
const { renderConsultation } = await import('../views/consultation.js');
const VM = await import('../views/visit-modal.js');
const { tr } = await import('../i18n.js');
perms.setFullAccess('test');

const walk = (e, o = []) => { for (const c of (e && e.children) || []) { o.push(c); walk(c, o); } return o; };
const textOf = (e) => (e ? e.textContent : '');
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** Вход настоящим сервером → сессия, как её получает оболочка (вход и /me). */
function sessionOf(username) {
  const res = login(DB, username, 'password1');
  assert.ok(res.session, 'вход ' + username);
  return { atLogin: res.user, atMe: sessionUser(DB, res.session) };
}
function signInAs(username, id, role) {
  const { atMe } = sessionOf(username);
  window.easymed.state.user = actorFromUser(atMe);
  USER = { id, role, extra_roles: [] };
  return window.easymed.state.user;
}

// ===========================================================================
test('сессия → оболочка: администратор-врач — врач (флаг is_doctor), администратор остаётся администратором', () => {
  for (const [login_, want] of [['admdoc', true], ['doc', true], ['kassa', false]]) {
    const { atLogin, atMe } = sessionOf(login_);
    assert.equal(actorFromUser(atLogin).is_doctor, want, login_ + ': вход');
    assert.equal(actorFromUser(atMe).is_doctor, want, login_ + ': восстановление сессии (/me)');
  }
  const a = actorFromUser(sessionOf('admdoc').atMe);
  assert.equal(a.is_admin, true, 'администратор-врач не перестал быть администратором');
  // Подстраховка: флаг, прочитанный 0/1-безопасно, — если строку дадут сырой из базы.
  assert.equal(actorFromUser({ role: 'admin', is_doctor: 1 }).is_doctor, true, 'is_doctor: 1 из базы — врач');
  assert.equal(actorFromUser({ role: 'admin', is_doctor: 0 }).is_doctor, false, 'is_doctor: 0 — не врач');
  assert.equal(actorFromUser({ role: 'admin', is_doctor: false }).is_doctor, false);
});

test('selfDoctorId() администратора-врача — его номер (кабинет: «мой день» и «Мой профиль»); видимость — по-прежнему вся клиника', () => {
  signInAs('admdoc', ADMIN_DOC, 'admin');
  assert.equal(perms.selfDoctorId(), ADMIN_DOC);
  assert.equal(perms.scopedDoctorId(), null, 'администратор видит всех — сужения «только мои пациенты» нет');
  signInAs('kassa', KASSA, 'cashier');
  assert.equal(perms.selfDoctorId(), null, 'кассир — не врач');
});

test('«Взять» у процедуры без исполнителя: администратору-врачу — есть (как и сервер), администратору без флага — нет', () => {
  signInAs('admdoc', ADMIN_DOC, 'admin');
  assert.equal(canTakeProcedure(), true, 'администратор-врач, вошедший в систему, потерял «Взять»');
  assert.equal(canTakeProcedure({ role: 'admin', is_doctor: 1 }), true, 'флаг из базы числом 1');
  assert.equal(canTakeProcedure({ role: 'admin', is_doctor: 0 }), false, 'флаг 0 — администратор без флага врача');
  assert.equal(canTakeProcedure({ role: 'admin', is_doctor: true }), true);
  signInAs('kassa', KASSA, 'cashier');
  assert.equal(canTakeProcedure(), false, 'кассир — не исполнитель');
});

test('кабинет → «Зарплата»: администратор-врач без специальности есть в списке врачей (флаг из базы — 1)', async () => {
  signInAs('admdoc', ADMIN_DOC, 'admin');
  const fromDb = DB.prepare('SELECT is_doctor FROM users WHERE id = ?').get(ADMIN_DOC).is_doctor;
  assert.equal(fromDb, 1, 'стенд честный: база отдаёт флаг числом');
  const host = mk('div');
  await renderConsultation(host, { onNavigate: () => {}, payload: { sub: 'pay' } });
  await flush();
  const options = walk(host).filter((n) => n.tagName === 'OPTION');
  const ids = options.map((o) => o.attrs.value);
  assert.ok(ids.includes(String(ADMIN_DOC)), 'администратора-врача нет в списке врачей «Зарплаты»: ' + JSON.stringify(ids));
  assert.ok(ids.includes(String(DOC)), 'обычный врач на месте');
  assert.ok(!ids.includes(String(KASSA)), 'кассир в список врачей не попал');
});

test('кабинет → «Мой профиль» открывается у администратора-врача и читает ЕГО строку', async () => {
  signInAs('admdoc', ADMIN_DOC, 'admin');
  DBCALLS.length = 0;
  const host = mk('div');
  await renderConsultation(host, { onNavigate: () => {}, payload: { sub: 'profile' } });
  await flush();
  const txt = textOf(host);
  assert.ok(!txt.includes(tr('Нет контекста врача/клиники — откройте раздел из аккаунта врача на поддомене клиники.')),
    '«Мой профиль» отказал администратору-врачу: ' + txt.slice(0, 200));
  const own = DBCALLS.find((c) => c.table === 'users'
    && (c.filters || []).some((f) => f.col === 'id' && f.op === 'eq' && String(f.val) === String(ADMIN_DOC)));
  assert.ok(own, 'профиль не спросил строку администратора-врача: ' + JSON.stringify(DBCALLS.map((c) => c.table)));
});

test('окно визита → рекомендация: выбор врача показывает администратора-врача и сразу ставит его — он рекомендовал', async () => {
  signInAs('admdoc', ADMIN_DOC, 'admin');
  document.body.children.length = 0;
  VM.openVisitModal({ visit: DB.prepare('SELECT * FROM visits WHERE id = 40').get(), patient: { id: 3, full_name: 'Иванов Иван' } });
  await flush();
  const addLabel = tr('Add to visit');
  const btn = walk(document.body).find((n) => n.tagName === 'BUTTON' && textOf(n).includes(addLabel));
  assert.ok(btn, 'рекомендация не нарисована: ' + textOf(document.body).slice(0, 300));
  btn.click();
  await flush();
  const dialog = document.body.children[document.body.children.length - 1];
  const select = walk(dialog).find((n) => n.tagName === 'SELECT');
  assert.ok(select, 'в окне рекомендации нет выбора врача');
  const opts = walk(select).filter((n) => n.tagName === 'OPTION');
  const mine = opts.find((o) => o.attrs.value === String(ADMIN_DOC));
  assert.ok(mine, 'администратора-врача нет в выборе врача: ' + JSON.stringify(opts.map((o) => o.attrs.value)));
  assert.ok('selected' in mine.attrs, 'рекомендовавший врач не выбран по умолчанию');
  assert.ok(!opts.some((o) => o.attrs.value === String(KASSA)), 'кассир в выборе врача');
});
