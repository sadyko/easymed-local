// DIAG_ROUTE_V1 (D4, решение владельца 2026-11-03) — «СЧЁТ ВИЗИТА» → «ДОБАВИТЬ»:
// ИСПОЛНИТЕЛЬ — ПО УСЛУГЕ, НЕ ВРАЧ ВИЗИТА.
//
// Расследование (пробы VB1/VB2): УЗИ «без врача», добавленное в визит терапевта,
// ложилось без исполнителя (его не видел ни один кабинет), а УЗИ «нужен врач» —
// терапевту, который ведёт визит. Теперь у услуги кабинета врача (всё, кроме
// «Лаборатории» и «Процедур») выбирается исполнитель: отмеченные ей в «Услугах и
// ставках», иначе все врачи; один — сам; без выбора строка не ложится.
//
// Стенд — как у refbill-review-doors.test.mjs: фальшивый fetch пропускает вызовы
// через настоящий реестр RPC, компилятор /api/db и SQLite в памяти.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class F {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {};
    this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
    this.value = ''; this.checked = false; this.disabled = false;
  }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} select() {} scrollTo() {}
  contains() { return false; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
  querySelector() { return new F('div'); }
  querySelectorAll() { return []; }
  get selectedOptions() { return this.children.filter((o) => o.tagName === 'OPTION' && o.attrs.value === String(this.value)); }
  get textContent() { return this._t; }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { return { contains: () => false, add() {}, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => { const e = new F(t); if (String(t).toLowerCase() === 'template') e.content = new F('#fragment'); return e; };
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const TOASTS = [];
const TOAST_EL = new F('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.confirm = () => true;

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');

let USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const handler = getRpc(decodeURIComponent(u.slice('/api/rpc/'.length)));
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'RPC not implemented' } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { message: e.message } }) }; }
  }
  if (u === '/api/db') {
    let compiled;
    try { compiled = compile(body, USER, { db: DB }); }
    catch (e) { return { ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    try {
      if (meta.op === 'insert') {
        const info = DB.prepare(sql).run(...params);
        const row = DB.prepare(`SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`).get(info.lastInsertRowid);
        return ok(meta.single ? row : [row]);
      }
      const rows = meta.op === 'select' ? DB.prepare(sql).all(...params) : (DB.prepare(sql).run(...params), []);
      if (meta.single === 'single') return ok(rows[0]);
      if (meta.single === 'maybe') return ok(rows[0] ?? null);
      return ok(rows);
    } catch (e) { return { ok: false, status: 500, json: async () => ({ error: { message: e.message } }) }; }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

/** Визит 40 ведёт терапевт 7. УЗИ 50 «без врача», УЗИ 51 «нужен врач», анализ 52; perf — кому отмечены 50/51. */
function seed(perf) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (1,'reg','x','Регистратор','registrar',0), (7,'ter','x','Терапевт','doctor',1)").run();
  const rates = JSON.stringify([{ service_id: 50, percentage: 0 }, { service_id: 51, percentage: 0 }]);
  for (const id of perf) db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates) VALUES (?,?,'x',?,'doctor',1,?)").run(id, 'u' + id, 'Сонолог-' + id, rates);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO services (id, name, price, type, requires_doctor) VALUES (50,'УЗИ печени',100000,'imaging',0), (51,'УЗИ сердца',120000,'imaging',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (52,'ОАК',30000,'lab',1)").run();
  db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (40,3,7,?,'arrived')").run(new Date().toISOString());
  if (DB) DB.close();
  DB = db;
  TOASTS.length = 0;
  USER = { id: 1, role: 'registrar', extra_roles: [] };
  window.easymed = { state: { user: { ...USER } } };
}
const walk = (e, out = []) => { for (const c of (e && e.children) || []) { out.push(c); walk(c, out); } return out; };
const textOf = (e) => [e, ...walk(e)].map((n) => n._t || '').join(' ');
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const VB = await import('../views/visit-bill.js');

async function openBill() {
  document.body.children.length = 0;
  VB.openVisitBillModal({ ...DB.prepare('SELECT * FROM visits WHERE id = 40').get(), patients: { full_name: 'Иванов Иван', mrn: 'A-1' } }, () => {});
  await flush();
  const modal = document.body.children[document.body.children.length - 1];
  const svcSel = walk(modal).find((n) => n.tagName === 'SELECT' && n.children[0] && textOf(n.children[0]).includes('Выберите услугу'));
  const perf = walk(modal).find((n) => n.tagName === 'SELECT' && n.attrs && 'data-bill-performer' in n.attrs);
  const add = walk(modal).find((n) => n.tagName === 'BUTTON' && /^\s*Добавить\s*$/.test(textOf(n)));
  assert.ok(svcSel && perf && add, 'в окне счёта нет выбора услуги / исполнителя / «Добавить»');
  const pick = (sid) => { svcSel.value = String(sid); svcSel.dispatchEvent({ type: 'change', target: svcSel, currentTarget: svcSel }); };
  return { modal, svcSel, perf, add, pick };
}
const lineDoc = (sid) => { const r = DB.prepare('SELECT doctor_id FROM visit_services WHERE visit_id = 40 AND service_id = ?').get(sid); return r ? r.doctor_id : undefined; };
const ids = (sel) => sel.children.filter((o) => o.tagName === 'OPTION').map((o) => o.attrs.value).filter(Boolean).map(Number).sort((a, b) => a - b);

test('VB1 / VB2: УЗИ в визите терапевта — исполнитель единственный отмеченный сонолог, а не врач визита и не «никто»', async () => {
  seed([21]);
  const w = await openBill();
  for (const sid of [50, 51]) {
    w.pick(sid);
    assert.deepEqual(ids(w.perf), [21], 'кандидаты — отмеченные услуге');
    assert.equal(w.perf.value, '21', 'единственный исполнитель не выбран сам');
    w.add.click();
    await flush(60);
    assert.equal(lineDoc(sid), 21, 'услуга ' + sid + ': исполнитель — не отмеченный сонолог (врач визита — 7)');
  }
});

test('два исполнителя — без выбора строка не ложится; выбранный — в строке; анализ — без исполнителя', async () => {
  seed([21, 22]);
  const w = await openBill();
  w.pick(50);
  assert.deepEqual(ids(w.perf), [21, 22]);
  assert.equal(w.perf.value, '');
  w.add.click();
  await flush(60);
  assert.equal(lineDoc(50), undefined, 'строка легла без исполнителя');
  assert.ok(TOASTS.some((t) => /Укажите врача для услуги «УЗИ печени»/.test(t)), 'отказ не сказан: ' + JSON.stringify(TOASTS));
  w.perf.value = '22';
  w.add.click();
  await flush(60);
  assert.equal(lineDoc(50), 22);
  w.pick(52);
  w.add.click();
  await flush(60);
  assert.equal(lineDoc(52), null, 'анализ получил исполнителя');
});
