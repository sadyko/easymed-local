// REFBILL_REVIEW_V1 (2026-09-29) — ревью REFERRAL_BILL_V1, M4: ДВЕРИ СЧЁТА НА
// ЭКРАНЕ — ЗЕРКАЛО СЕРВЕРА.
//
// Сервер пускает врача без денежной роли выставлять только СВОИ строки живого
// визита (billing.js doctorLinesRefusal) — и дверь для этого у врача одна:
// мастер направления («Направить на услуги»). Окно «Счёт и оплата» карточки
// пациента (visit-bill.js, «Выставить счёт» — ВСЕ невыставленные строки
// визита) и окно визита (visit-modal.js, «Сформировать счёт») врачу показывали
// кнопку, по которой он выставлял чужие строки. Теперь эти двери — только
// денежным ролям (администратор, регистратура, касса — CREATE_INVOICE_ROLES
// сервера); врачу вместо кнопки — куда идёт счёт.
//
// Стенд не заглушка: фальшивый fetch пропускает вызовы через настоящий реестр
// RPC и SQLite в памяти — как в picker-invoice.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ─── крошечный DOM (тот же стенд, что у picker-invoice.test.mjs) ────────────
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
  focus() {} blur() {} select() {} scrollTo() {}
  contains() { return false; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
  querySelector() { return new F('div'); }
  querySelectorAll() { return []; }
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

// ─── настоящая база + настоящий реестр RPC за фальшивым fetch ───────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');

let USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
const RPC = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    RPC.push({ name, body });
    const handler = getRpc(name);
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'RPC not implemented: ' + name } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.status === 403 ? 'forbidden' : 'bad_request', message: e.message } }) }; }
  }
  if (u === '/api/db') {
    let compiled;
    try { compiled = compile(body, USER, { db: DB }); }
    catch (e) { return { ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    const rows = meta.op === 'select' ? DB.prepare(sql).all(...params) : (DB.prepare(sql).run(...params), []);
    if (meta.single === 'single') return ok(rows[0]);
    if (meta.single === 'maybe') return ok(rows[0] ?? null);
    return ok(rows);
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (1,'reg','x','Регистратор','registrar',0), (7,'doc','x','Петров','doctor',1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (22,'Анализ крови',100000)").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (40,3,?,'scheduled')").run(new Date().toISOString());
  // Строка регистратуры — не врача.
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (101,40,22,1,100000,100000,'added',1)").run();
  if (DB) DB.close();
  DB = db;
  RPC.length = 0; TOASTS.length = 0;
}

function as(role, extra = []) {
  USER = { id: role === 'doctor' ? 7 : 1, role, extra_roles: extra };
  window.easymed = { state: { user: { ...USER } } };
}

const walk = (e, out = []) => { for (const c of (e && e.children) || []) { out.push(c); walk(c, out); } return out; };
const textOf = (e) => [e, ...walk(e)].map((n) => n._t || '').join(' ');
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const HINT = 'Счёт выставит касса — пациент в «Приём оплат» → «Ждут счёта».';

const VB = await import('../views/visit-bill.js');
const VM = await import('../views/visit-modal.js');

test('зеркала: денежные роли дверей счёта — те же, что CREATE_INVOICE_ROLES сервера', () => {
  const billing = fs.readFileSync(new URL('../../../../server/services/rpc/billing.js', import.meta.url), 'utf8');
  const m = billing.match(/const CREATE_INVOICE_ROLES = \[([^\]]+)\]/);
  assert.ok(m, 'на сервере объявлен CREATE_INVOICE_ROLES');
  const server = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean).sort();
  assert.deepEqual([...VB.BILL_INVOICE_ROLES].sort(), server, 'visit-bill.js');
  assert.deepEqual([...VM.VISIT_INVOICE_ROLES].sort(), server, 'visit-modal.js');
});

async function openBill() {
  document.body.children.length = 0;
  VB.openVisitBillModal({ ...DB.prepare('SELECT * FROM visits WHERE id = 40').get(), patients: { full_name: 'Иванов Иван', mrn: 'A-1' } }, () => {});
  await flush();
  return document.body.children[document.body.children.length - 1];
}
const invoiceButton = (root) => walk(root).find((n) => n.tagName === 'BUTTON' && /Выставить счёт/.test(textOf(n)));

test('«Счёт и оплата» карточки пациента: врачу кнопки «Выставить счёт» нет — сказано, куда идёт счёт; денежным ролям — есть', async () => {
  seed();
  try {
    for (const [role, extra] of [['doctor', []], ['nurse', ['head_doctor']]]) {
      as(role, extra);
      const modal = await openBill();
      assert.equal(invoiceButton(modal), undefined, role + ': кнопка «Выставить счёт» у врача — выставила бы чужие строки визита');
      assert.ok(textOf(modal).includes(HINT), role + ': не сказано, где счёт: ' + textOf(modal).slice(0, 200));
    }
    for (const [role, extra] of [['registrar', []], ['cashier', []], ['admin', []], ['doctor', ['cashier']]]) {
      as(role, extra);
      const modal = await openBill();
      assert.ok(invoiceButton(modal), role + (extra.length ? '+' + extra : '') + ': у денежной роли пропала кнопка «Выставить счёт»');
    }
  } finally { as('registrar'); }
});

test('окно визита: «Сформировать счёт» — только денежным ролям; врачу — ни кнопки, ни вызова сервера', async () => {
  seed();
  try {
    for (const [role, extra, want] of [['doctor', [], false], ['nurse', ['head_doctor'], false], ['nurse', [], false],
      ['registrar', [], true], ['cashier', [], true], ['admin', [], true], ['doctor', ['cashier'], true]]) {
      as(role, extra);
      assert.equal(VM.canGenerateVisitInvoice(), want, role + '+' + extra.join(','));
    }
    as('doctor');
    const state = { visit: DB.prepare('SELECT * FROM visits WHERE id = 40').get(), patient: { id: 3 },
      services: [{ id: 101, service_id: 22, invoice_item_id: null, unit_price: 100000, quantity: 1 }] };
    await VM.generateInvoiceFromSelection(state, new Set([101]), () => {});
    assert.ok(!RPC.some((c) => c.name === 'create_invoice_for_visit'), 'врач выставил счёт из окна визита');
    assert.equal(DB.prepare('SELECT COUNT(*) c FROM invoices').get().c, 0);
    assert.ok(TOASTS.some((t) => t.includes(HINT)), JSON.stringify(TOASTS));
    // Кнопка в самой вкладке «Услуги» стоит за тем же правилом.
    const src = fs.readFileSync(new URL('../views/visit-modal.js', import.meta.url), 'utf8');
    assert.match(src, /canGenerateVisitInvoice\(\) \? h\('button', \{\s*class: 'btn btn-primary btn-sm',[^]*?Generate invoice'\) : null/,
      'кнопка «Сформировать счёт» во вкладке «Услуги» не спрашивает роль');
  } finally { as('registrar'); }
});

// REFBILL_REVIEW_V1 (ревью m9) — подпись вкладки «Счёт» карточки пациента в
// «Настройки → Роли» говорила «Счета и оплаты пишет только касса» — после
// решения владельца это неправда: счёт по своему направлению выставляет врач.
// Деньги по-прежнему принимает только касса.
test('m9: подпись вкладки «Счёт» в «Ролях» — правда: врач выставляет счёт по своему направлению, деньги принимает только касса', async () => {
  const { PATIENT_TABS } = await import('../permissions.js');
  const note = PATIENT_TABS.find((t) => t.id === 'billing').note;
  assert.equal(note, 'Счёт выставляют касса, регистратура и администратор, а врач — только по своему направлению; принимает деньги только касса; удаления счёта нет нигде');
  assert.ok(!/пишет только касса/.test(note), 'подпись снова говорит, что счёт пишет только касса');
});
