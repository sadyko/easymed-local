// BACKLOG_1011_V1 — КАБИНЕТ ВРАЧА: «ЗАРПЛАТА» И «СТАЦИОНАР» ГЛАЗАМИ АДМИНИСТРАТОРА
// (и администратора-врача).
//
// Стенд не подставляет удобных значений: за фальшивым fetch — настоящая база
// (все миграции), настоящий компилятор, reshape маршрута /api/db и настоящий
// реестр RPC. Номера сотрудников приходят из базы числами, флаг is_doctor —
// числом 1/0, а значение <select> браузер отдаёт СТРОКОЙ — ровно как в клинике.
// Вкладка хранит состояние в модуле, поэтому каждый сценарий берёт свежий
// экземпляр consultation.js (`?inst=`).
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
    Object.defineProperty(e, 'innerHTML', { set() { e.content.firstChild = new F('svg'); }, get() { return ''; } });
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
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, open: () => null,
  easymed: { state: { user: null }, navigate: () => {} }, easymedSetTabSub: () => {}, CLINIC: { id: 1 },
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };
globalThis.confirm = () => true;

// ─── настоящая база за фальшивым fetch ──────────────────────────────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { reshape } = await import('../../../../server/routes/db.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { hashPassword, login, sessionUser } = await import('../../../../server/services/auth.js');

const BOSS = 1;        // администратор, не врач
const KARIMOV = 10;    // обычный врач — первый по алфавиту
const ADMDOC = 20;     // администратор-врач без специальности — последний по алфавиту
const DB = openDb(':memory:');
migrate(DB);
{
  const u = DB.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty) VALUES (?,?,?,?,?,?,?)');
  u.run(BOSS, 'boss', hashPassword('password1'), 'Бобоев Бахром', 'admin', 0, '');
  u.run(KARIMOV, 'doc', hashPassword('password1'), 'Каримов Бахтиёр', 'doctor', 1, 'Кардиолог');
  u.run(ADMDOC, 'admdoc', hashPassword('password1'), 'Юсупова Дилноза', 'admin', 1, '');
  u.run(9, 'kassa', hashPassword('password1'), 'Кассирова Нигора', 'cashier', 0, '');
}

let USER = null;
const RPC = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), text: async () => JSON.stringify({ data }) });
  const fail = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }), text: async () => message });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    RPC.push({ name, body });
    const handler = getRpc(name);
    if (!handler) return fail(501, 'RPC not implemented');
    try { return ok(await handler(DB, body, USER)); } catch (e) { return fail(e.status || 500, e.message); }
  }
  if (u === '/api/db') {
    let compiled;
    try { compiled = compile(body, USER, { db: DB }); } catch (e) { return fail(400, e.message); }
    const { sql, params, meta } = compiled;
    if (meta.op !== 'select') { DB.prepare(sql).run(...params); return ok(null); }
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
const { tr, trf } = await import('../i18n.js');
perms.setFullAccess('test');

const walk = (e, o = []) => { for (const c of (e && e.children) || []) { o.push(c); walk(c, o); } return o; };
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
let inst = 0;

/** Вход настоящим сервером и оболочка по ответу — как admin.js onAuthed. */
function signIn(username) {
  const res = login(DB, username, 'password1');
  assert.ok(res.session, 'вход ' + username);
  USER = sessionUser(DB, res.session);
  window.easymed.state.user = actorFromUser(res.user);
}
/** Свежий кабинет на вкладке `sub`. */
async function openCabinet(username, sub) {
  signIn(username);
  RPC.length = 0;
  const { renderConsultation } = await import('../views/consultation.js?inst=' + (++inst));
  const host = mk('div');
  await renderConsultation(host, { onNavigate: () => {}, payload: { sub } });
  await flush();
  return host;
}
const paySelect = (host) => walk(host).find((n) => n.tagName === 'SELECT');
const selectedId = (host) => {
  const opt = walk(paySelect(host)).find((o) => o.tagName === 'OPTION' && 'selected' in o.attrs);
  return opt ? opt.attrs.value : null;
};
const paySubtitle = (name) => trf('Зарплата, вознаграждения за направления и работа врача: {name}.', { name });
const lastPayCall = () => RPC.filter((c) => c.name === 'doctor_pay_summary').pop();

// ===========================================================================
// 1. Выбор врача в «Зарплате»: значение <select> — строка, номера в списке —
//    числа. Сравнение «строка === число» теряло выбранного врача: шапка
//    говорила «Врач не выбран.», и считалось без карточки врача.
test('«Зарплата»: администратор переключает врача — выбранный врач на экране, а не «Врач не выбран.»', async () => {
  const host = await openCabinet('boss', 'pay');
  assert.ok(host.textContent.includes(paySubtitle('Каримов Бахтиёр')), 'по умолчанию — первый врач по алфавиту');
  const sel = paySelect(host);
  assert.ok(sel, 'у администратора есть выбор врача');
  sel.value = String(ADMDOC);
  sel.dispatchEvent({ type: 'change', target: sel, currentTarget: sel });   // браузер отдаёт значение строкой
  await flush();
  const txt = host.textContent;
  assert.ok(!txt.includes(tr('Врач не выбран.')), 'после переключения шапка сказала «Врач не выбран.»');
  assert.ok(txt.includes(paySubtitle('Юсупова Дилноза')), 'на экране не выбранный врач: ' + txt.slice(0, 160));
  assert.equal(selectedId(host), String(ADMDOC), 'в списке отмечен не выбранный врач');
  const call = lastPayCall();
  assert.ok(call, 'начисления выбранного врача не запрошены');
  assert.strictEqual(call.body.doctor_id, ADMDOC, 'номер врача ушёл на сервер не числом: ' + JSON.stringify(call.body.doctor_id));
  // И обратно — на первого: каждое переключение, а не только первое.
  const sel2 = paySelect(host);
  sel2.value = String(KARIMOV);
  sel2.dispatchEvent({ type: 'change', target: sel2, currentTarget: sel2 });
  await flush();
  assert.ok(host.textContent.includes(paySubtitle('Каримов Бахтиёр')));
  assert.equal(selectedId(host), String(KARIMOV));
});

// 2. «Зарплата» администратора-врача открывается на НЁМ САМОМ: это его
//    кабинет. Прежде — на первом враче по алфавиту, и свои деньги он искал в
//    списке. Остальные врачи в списке остаются: администратор видит всех.
test('«Зарплата» администратора-врача открывается на нём самом, а не на первом по алфавиту; выбор других врачей остаётся', async () => {
  const host = await openCabinet('admdoc', 'pay');
  assert.ok(host.textContent.includes(paySubtitle('Юсупова Дилноза')),
    'кабинет администратора-врача открылся не на нём: ' + host.textContent.slice(0, 160));
  assert.equal(selectedId(host), String(ADMDOC));
  assert.strictEqual(lastPayCall().body.doctor_id, ADMDOC, 'начисления запрошены не его');
  const ids = walk(paySelect(host)).filter((o) => o.tagName === 'OPTION').map((o) => o.attrs.value);
  assert.ok(ids.includes(String(KARIMOV)), 'администратор-врач потерял выбор остальных врачей: ' + ids.join(','));
});

test('«Зарплата»: администратор не врач — по-прежнему первый врач по алфавиту; обычный врач — только он сам', async () => {
  const boss = await openCabinet('boss', 'pay');
  assert.ok(boss.textContent.includes(paySubtitle('Каримов Бахтиёр')));
  assert.equal(selectedId(boss), String(KARIMOV));
  const doc = await openCabinet('doc', 'pay');
  assert.ok(doc.textContent.includes(paySubtitle('Каримов Бахтиёр')));
  assert.equal(paySelect(doc), undefined, 'у врача под своим входом выбора врача нет');
});
