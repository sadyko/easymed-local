// RPC_PORT_V1 — СЧЁТ КАЛЬКУЛЯТОРА УСЛУГ ВЫСТАВЛЯЕТ СЕРВЕР.
//
// Ревью C1: калькулятор (service-picker-modal.js) писал invoices,
// invoice_items и payments напрямую через /api/db. Реестр не даёт этим
// таблицам записи с клиента НИ ОДНОЙ роли — «счёт не создан: not allowed»
// после каждой записи. Касса потом выставляла счёт сама
// (create_invoice_for_visit) уже БЕЗ скидки: пациенту назвали 900 000, а
// выставили 1 000 000.
//
// Теперь шаг счёта — invoicePickerLines(): один вызов create_invoice_for_visit
// со скидкой, посчитанной pickerDiscount() по тем же строкам, что показывает
// смета (M2). Стенд не заглушка: фальшивый fetch пропускает вызовы через
// настоящий реестр RPC и SQLite в памяти, прошедшую миграции — как в
// wizard-booking.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM (тот же стенд, что у wizard-booking.test.mjs) ────────────
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
  querySelector() { return null; }
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
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
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
const DBWRITES = [];

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
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message } }) }; }
  }
  if (u === '/api/db') {
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    if (meta.op !== 'select') DBWRITES.push(meta.table);
    const rows = meta.op === 'select' ? DB.prepare(sql).all(...params) : (DB.prepare(sql).run(...params), []);
    if (meta.single === 'single') return ok(rows[0]);
    if (meta.single === 'maybe') return ok(rows[0] ?? null);
    return ok(rows);
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const { pickerDiscount, invoicePickerLines } = await import('../views/service-picker-modal.js');

// ─── посев ──────────────────────────────────────────────────────────────────
// Визит на 900 000 + 100 000; вторая услуга — по пакету «Чек-ап» со скидкой 20 %.
function seed({ categoryPct = 0 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'reg','x','Регистратор','registrar')").run();
  if (categoryPct) {
    db.prepare('INSERT INTO patient_categories (id, name, discount_percent, active) VALUES (5, ?, ?, 1)').run('VIP', categoryPct);
    db.prepare("INSERT INTO patients (id, full_name, category_id) VALUES (3,'Иванов Иван',5)").run();
  } else {
    db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  }
  db.prepare("INSERT INTO services (id, name, price) VALUES (21,'МРТ',900000)").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (22,'Анализ крови',100000)").run();
  db.prepare("INSERT INTO service_templates (id, name, service_ids, discount_percent) VALUES (9,'Чек-ап','[22]',20)").run();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (40,3,?,'scheduled')").run(now);
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status) VALUES (101,40,21,1,900000,900000,'added')").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status, package_id) VALUES (102,40,22,1,100000,100000,'added',9)").run();
  if (DB) DB.close();
  DB = db;
  RPC.length = 0; DBWRITES.length = 0;
  return db;
}

const LINES = [
  { visit_service_id: 101, service_id: 21, price: 900000, packaged: false },
  { visit_service_id: 102, service_id: 22, price: 100000, packaged: true, packagePct: 20 },
];

test('pickerDiscount: лояльность и скидка — только по строкам без пакета', () => {
  const d = pickerDiscount(LINES, { pct: 10, promo: null });
  assert.equal(d.subtotal, 1000000);
  assert.equal(d.restSubtotal, 900000);
  assert.equal(d.loyalty, 90000, '10 % берутся с 900 000, а не со всей сметы');
  assert.equal(d.packageOff, 20000, 'скидка пакета — 20 % его строки');
  assert.equal(d.discount, 90000, 'в счёт уходит только скидка строк без пакета — пакет сервер считает сам');
  assert.equal(d.payable, 890000);
  const withPromo = pickerDiscount(LINES, { pct: 10, promo: { percent: 0, amount: 50000, service_ids: [] } });
  assert.equal(withPromo.promoOff, 50000);
  assert.equal(withPromo.discount, 140000);
});

test('счёт выставляет create_invoice_for_visit — прямых записей в invoices/items/payments нет', async () => {
  seed();
  const out = await invoicePickerLines({ visitId: 40, lines: LINES, pct: 10, promo: null });
  assert.equal(out.error, null, 'сервер отказал: ' + (out.error && out.error.message));
  const inv = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  assert.ok(inv, 'счёт не создан');
  assert.equal(inv.subtotal, 1000000);
  assert.equal(inv.discount_amount, 90000 + 20000, 'скидка счёта = лояльность + пакет');
  assert.equal(inv.total_amount, 890000);
  assert.equal(inv.total_amount, out.payable, 'смета и счёт обязаны совпасть — ревью: «назвали 900 000, выставили 1 000 000»');
  const linked = DB.prepare('SELECT COUNT(*) c FROM visit_services WHERE visit_id = 40 AND invoice_item_id IS NOT NULL').get().c;
  assert.equal(linked, 2, 'строки визита не привязаны к счёту');
  assert.deepEqual(RPC.map((r) => r.name), ['create_invoice_for_visit']);
  assert.deepEqual(RPC[0].body, { visit_id: 40, visit_service_ids: [101, 102], discount_amount: 90000 });
  assert.ok(!DBWRITES.some((t) => ['invoices', 'invoice_items', 'payments'].includes(t)), 'клиентская запись в деньги: ' + DBWRITES.join(','));
  assert.ok(Array.isArray(out.data.items) && out.data.items.length === 2, 'строки бланка берутся из ответа RPC');
});

test('скидка группы пациента — пол: меньшая ручная скидка не отнимает у VIP его процент', async () => {
  seed({ categoryPct: 15 });
  const out = await invoicePickerLines({ visitId: 40, lines: LINES, pct: 5, promo: null });
  assert.equal(out.error, null);
  const inv = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  // строки без пакета: max(5 % · 900 000, 15 % · 900 000) = 135 000; строка пакета: max(20, 15) % · 100 000 = 20 000
  assert.equal(inv.discount_amount, 155000);
});

test('отказ сервера возвращается экрану, а не глотается', async () => {
  seed();
  USER = { id: 1, role: 'doctor', extra_roles: [] };
  try {
    const out = await invoicePickerLines({ visitId: 40, lines: LINES, pct: 0, promo: null });
    assert.ok(out.error, 'врач не выставляет счета — сервер обязан отказать');
    assert.equal(DB.prepare('SELECT COUNT(*) c FROM invoices').get().c, 0);
  } finally {
    USER = { id: 1, role: 'registrar', extra_roles: [] };
  }
});

// Дополнение к поведенческим проверкам выше: сам мастер зовёт именно этот шаг,
// а не держит рядом старую копию, и смета считает тем же правилом.
test('wizSave выставляет счёт через invoicePickerLines, смета — через pickerDiscount', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../views/service-picker-modal.js', import.meta.url), 'utf8');
  assert.match(src, /await invoicePickerLines\(\{ visitId: visit\.id, lines: patientRows\.map\(billLineOf\)/);
  assert.match(src, /function wizTotals\(\)[^]*?pickerDiscount\(previewBillLines\(\)/);
  for (const t of ['invoices', 'invoice_items', 'payments', 'patient_deposits']) {
    const direct = new RegExp("from\\('" + t + "'\\)\\s*\\.(insert|update|delete)");
    assert.ok(direct.test(".from('" + t + "').insert({})"), 'сама проверка сломана');
    assert.ok(!direct.test(src), 'прямая запись в ' + t);
  }
});
