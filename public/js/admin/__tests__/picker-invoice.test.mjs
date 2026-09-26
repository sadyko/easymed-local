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
  // бланк печати (doc-settings.js) навешивает кнопки на найденные узлы
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
// Тосты слышны: toast() (ui.js) пишет текст в #toast.textContent.
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
const DBWRITES = [];
let FAIL_ON = null;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    RPC.push({ name, body });
    const handler = getRpc(name);
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'RPC not implemented: ' + name } }) };
    // Подменить ОДИН ответ сервера (сбой посреди цикла возвратов).
    const forced = FAIL_ON && FAIL_ON(name, body);
    if (forced) return { ok: false, status: 500, json: async () => ({ error: forced }) };
    try { return ok(await handler(DB, body, USER)); }
    // код — как у routes/rpc.js: свой код обработчика, иначе по статусу
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code || (e.status === 403 ? 'forbidden' : 'bad_request'), message: e.message } }) }; }
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

// ═══════════════════════════════════════════════════════════════════════════
// Окно визита (visit-modal.js) — та же болезнь: «Сформировать счёт», «Оплата»
// и «Оставить как долг» писали invoices / invoice_items / payments напрямую.
// ═══════════════════════════════════════════════════════════════════════════
const VM = await import('../views/visit-modal.js');

function vmState() {
  return {
    visit: { id: 40, patient_id: 3, visit_date: new Date().toISOString() },
    patient: { id: 3, full_name: 'Иванов Иван' },
    services: [
      { id: 101, service_id: 21, invoice_item_id: null, __service_name: 'МРТ', unit_price: 900000, quantity: 1 },
      { id: 102, service_id: 22, invoice_item_id: null, __service_name: 'Анализ крови', unit_price: 100000, quantity: 1 },
    ],
  };
}

test('окно визита: «Сформировать счёт» — create_invoice_for_visit, скидку пакета даёт сервер', async () => {
  seed();
  await VM.generateInvoiceFromSelection(vmState(), new Set([101, 102]), () => {});
  const inv = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  assert.ok(inv, 'счёт не создан: ' + JSON.stringify(RPC));
  assert.equal(inv.subtotal, 1000000);
  assert.equal(inv.discount_amount, 20000, 'строка пакета получила свою скидку на сервере');
  assert.ok(RPC.some((r) => r.name === 'create_invoice_for_visit'));
  assert.ok(!DBWRITES.some((t) => ['invoices', 'invoice_items', 'payments'].includes(t)), 'клиентская запись в деньги: ' + DBWRITES.join(','));
  assert.equal(DB.prepare('SELECT COUNT(*) c FROM visit_services WHERE visit_id = 40 AND invoice_item_id IS NOT NULL').get().c, 2);
});

test('окно визита: оплата — record_payment, долг — mark_invoice_debt', async () => {
  seed();
  await VM.generateInvoiceFromSelection(vmState(), new Set([101]), () => {});
  const inv = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  USER = { id: 1, role: 'cashier', extra_roles: [] };
  try {
    RPC.length = 0; DBWRITES.length = 0;
    await VM.takePayment(vmState(), inv, 300000, 'partial', () => {}, 'card');
    let row = DB.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    assert.equal(row.paid_amount, 300000, 'оплата не проведена: ' + JSON.stringify(RPC));
    assert.equal(row.status, 'partial');
    const pay = DB.prepare('SELECT * FROM payments WHERE invoice_id = ?').get(inv.id);
    assert.equal(pay.method, 'card');
    assert.ok(pay.shift_id, 'платёж обязан лечь в смену кассира');
    assert.equal(DB.prepare("SELECT status FROM visit_services WHERE id = 101").get().status, 'queued', 'услуга не отпущена в очередь');

    await VM.markAsDebt(vmState(), row, () => {});
    row = DB.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    assert.equal(row.status, 'debt');
    assert.ok(RPC.some((r) => r.name === 'record_payment') && RPC.some((r) => r.name === 'mark_invoice_debt'));
    assert.ok(!DBWRITES.some((t) => ['invoices', 'invoice_items', 'payments'].includes(t)), 'клиентская запись в деньги: ' + DBWRITES.join(','));
  } finally {
    USER = { id: 1, role: 'registrar', extra_roles: [] };
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Ревью I1 — «Отменить счёт» окна визита (invoice-actions.js cancelInvoice)
// правил invoices и вставлял payments из браузера: «not allowed» у всех ролей.
// ═══════════════════════════════════════════════════════════════════════════
const IA = await import('../views/invoice-actions.js');

test('отмена неоплаченного счёта — void_invoice: услуги остаются в визите, причина в журнале', async () => {
  seed();
  await VM.generateInvoiceFromSelection(vmState(), new Set([101, 102]), () => {});
  const inv = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  USER = { id: 1, role: 'cashier', extra_roles: [] };
  try {
    RPC.length = 0; DBWRITES.length = 0;
    const ok = await IA.cancelInvoice(inv, { reason: 'ошиблись услугой', refundAmount: 0, keepServices: true });
    assert.equal(ok, 'done', 'отмена не прошла: ' + JSON.stringify(RPC));
    assert.equal(DB.prepare('SELECT status FROM invoices WHERE id = ?').get(inv.id).status, 'void');
    assert.equal(DB.prepare('SELECT COUNT(*) c FROM visit_services WHERE visit_id = 40 AND invoice_item_id IS NULL').get().c, 2,
      'галочка «Оставить услуги в визите» оставляет их для повторного выставления');
    assert.equal(DB.prepare("SELECT reason FROM invoice_audit_log WHERE invoice_id = ? AND action = 'void'").get(inv.id).reason, 'ошиблись услугой');
    assert.ok(!DBWRITES.some((t) => ['invoices', 'invoice_items', 'payments', 'visit_services'].includes(t)), 'клиентская запись: ' + DBWRITES.join(','));
  } finally {
    USER = { id: 1, role: 'registrar', extra_roles: [] };
  }
});

test('отмена оплаченного счёта — refund_payment по платежам: частичный, потом полный', async () => {
  seed();
  await VM.generateInvoiceFromSelection(vmState(), new Set([101]), () => {});
  let inv = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  USER = { id: 1, role: 'cashier', extra_roles: [] };
  try {
    await VM.takePayment(vmState(), inv, 500000, 'partial', () => {}, 'cash');
    await VM.takePayment(vmState(), DB.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id), 400000, 'paid', () => {}, 'card');
    inv = DB.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    assert.equal(inv.status, 'paid');
    RPC.length = 0; DBWRITES.length = 0;

    // частичный возврат 600 000: 400 000 по последнему платежу (карта) + 200 000 по первому
    assert.equal(await IA.cancelInvoice(inv, { reason: 'жалоба', refundAmount: 600000 }), 'done');
    inv = DB.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    assert.equal(inv.paid_amount, 300000);
    assert.equal(inv.status, 'partial');
    const refunds = DB.prepare('SELECT amount, method FROM payments WHERE invoice_id = ? AND amount < 0 ORDER BY id').all(inv.id);
    assert.deepEqual(refunds.map((r) => [r.amount, r.method]), [[-400000, 'card'], [-200000, 'cash']], 'возврат обязан идти тем же способом, каким брали');
    assert.deepEqual(RPC.map((r) => r.name), ['refund_payment', 'refund_payment']);
    RPC.length = 0;

    // остаток — полный возврат
    assert.equal(await IA.cancelInvoice(inv, { reason: 'жалоба', refundAmount: 300000 }), 'done');
    inv = DB.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    assert.equal(inv.paid_amount, 0);
    // refund_payment сам оставил бы «не оплачен» — то есть снова долг; полный
    // возврат из окна отмены гасит счёт void_invoice.
    assert.equal(inv.status, 'void');
    assert.ok(!DBWRITES.some((t) => ['invoices', 'invoice_items', 'payments'].includes(t)), 'клиентская запись в деньги: ' + DBWRITES.join(','));
    assert.ok(DB.prepare("SELECT COUNT(*) c FROM invoice_audit_log WHERE invoice_id = ? AND action = 'refunded'").get(inv.id).c >= 1, 'возврат не попал в журнал счёта');
  } finally {
    USER = { id: 1, role: 'registrar', extra_roles: [] };
  }
});

test('отмена чужими руками: сервер отказывает, окно говорит об этом и ничего не меняет', async () => {
  seed();
  await VM.generateInvoiceFromSelection(vmState(), new Set([101]), () => {});
  const inv = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  const ok = await IA.cancelInvoice(inv, { reason: 'x', refundAmount: 0 });   // регистратор: void_invoice — касса/админ
  assert.equal(ok, false);
  assert.equal(DB.prepare('SELECT status FROM invoices WHERE id = ?').get(inv.id).status, 'unpaid');
});

// ─── ревью I1 / I3 / M3 ────────────────────────────────────────────────────
async function paidTwice() {
  seed();
  await VM.generateInvoiceFromSelection(vmState(), new Set([101]), () => {});
  const inv = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  USER = { id: 1, role: 'cashier', extra_roles: [] };
  await VM.takePayment(vmState(), inv, 500000, 'partial', () => {}, 'cash');
  await VM.takePayment(vmState(), DB.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id), 400000, 'paid', () => {}, 'card');
  RPC.length = 0; DBWRITES.length = 0; TOASTS.length = 0;
  return DB.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
}

test('I1: второй возврат сорвался — «Возвращено X из Y, счёт не отменён», первый возврат в журнале, окно перечитывается', async () => {
  const inv = await paidTwice();
  try {
    let calls = 0;
    FAIL_ON = (name) => (name === 'refund_payment' && ++calls === 2 ? { message: 'диск занят' } : null);
    const res = await IA.cancelInvoice(inv, { reason: 'жалоба', refundAmount: 900000 });
    assert.equal(res, 'partial', 'окно обязано узнать, что деньги частично ушли, и перечитаться');
    const norm = (t) => t.replace(/\s/g, ' ');   // ru-RU делит разряды неразрывным пробелом
    assert.ok(TOASTS.some((t) => norm(t) === 'Возвращено 400 000 из 900 000, счёт не отменён.'), 'нет сообщения: ' + TOASTS.join(' | '));
    const row = DB.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    assert.equal(row.paid_amount, 500000);
    assert.notEqual(row.status, 'void', 'счёт с деньгами не отменяется');
    const log = DB.prepare("SELECT refund_amount FROM invoice_audit_log WHERE invoice_id = ? AND action = 'refunded'").all(inv.id);
    assert.deepEqual(log.map((r) => r.refund_amount), [400000], 'частичный возврат обязан попасть в журнал счёта');
    assert.ok(!RPC.some((r) => r.name === 'void_invoice'));
  } finally {
    FAIL_ON = null;
    USER = { id: 1, role: 'registrar', extra_roles: [] };
  }
});

test('I1: окно открыто со старым снимком (оплачено меньше) — полный возврат всё равно гасит счёт', async () => {
  const inv = await paidTwice();
  try {
    const stale = { ...inv, paid_amount: 500000, status: 'partial' };   // окно открыли до второй оплаты
    const res = await IA.cancelInvoice(stale, { reason: 'жалоба', refundAmount: 900000 });
    assert.equal(res, 'done');
    const row = DB.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    assert.equal(row.paid_amount, 0);
    assert.equal(row.status, 'void', 'решение об отмене — по ответу последнего возврата, а не по снимку окна');
  } finally {
    USER = { id: 1, role: 'registrar', extra_roles: [] };
  }
});

test('I3: без галочки «Оставить услуги в визите» неначатые услуги снимаются с визита, как у кассы', async () => {
  seed();
  await VM.generateInvoiceFromSelection(vmState(), new Set([101, 102]), () => {});
  const inv = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  USER = { id: 1, role: 'cashier', extra_roles: [] };
  try {
    assert.equal(await IA.cancelInvoice(inv, { reason: 'ошибка', refundAmount: 0 }), 'done');
    assert.equal(DB.prepare('SELECT COUNT(*) c FROM visit_services WHERE visit_id = 40').get().c, 0);
    assert.equal(RPC.filter((r) => r.name === 'void_invoice').pop().body.keep_services, false);
  } finally {
    USER = { id: 1, role: 'registrar', extra_roles: [] };
  }
});

test('M3: деньги по счёту — касса и администратор; отказ сервера по роли — по-русски', async () => {
  assert.equal(IA.canMoveInvoiceMoney(['registrar']), false);
  assert.equal(IA.canMoveInvoiceMoney(['doctor', 'registrar']), false);
  assert.equal(IA.canMoveInvoiceMoney(['registrar', 'cashier']), true, 'дополнительная роль считается, как на сервере');
  assert.equal(IA.canMoveInvoiceMoney(['admin']), true);
  seed();
  await VM.generateInvoiceFromSelection(vmState(), new Set([101]), () => {});
  const inv = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  TOASTS.length = 0;
  await VM.takePayment(vmState(), inv, 100000, 'partial', () => {}, 'cash');   // регистратор
  assert.ok(TOASTS.includes('Деньги по счёту принимает, возвращает и списывает в долг только касса или администратор.'), TOASTS.join(' | '));
  assert.equal(DB.prepare('SELECT paid_amount FROM invoices WHERE id = ?').get(inv.id).paid_amount, 0);
  // список ролей сервера — тот же, что у экрана
  const fs = await import('node:fs');
  const billing = fs.readFileSync(new URL('../../../../server/services/rpc/billing.js', import.meta.url), 'utf8');
  const cashier = fs.readFileSync(new URL('../../../../server/services/rpc/cashier.js', import.meta.url), 'utf8');
  assert.match(billing, /const PAYMENT_ROLES = \['admin', 'cashier'\];/);
  assert.match(cashier, /const SHIFT_ROLES = \['admin', 'cashier'\];/);
  assert.deepEqual(IA.INVOICE_MONEY_ROLES, ['admin', 'cashier']);
});

test('M4: живые экраны не режут числовой id как строку', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = new URL('../', import.meta.url);
  const DEAD = new Set(['procurement.js', 'employee-editor.js']);   // недостижимы (см. client-rpc-coverage.test.js)
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); continue; }
      if (!e.name.endsWith('.js') || e.name.includes('.test.') || DEAD.has(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/\.id\.slice\(/g)) hits.push(e.name + ':' + src.slice(0, m.index).split('\n').length);
    }
  };
  const { fileURLToPath } = await import('node:url');
  walk(fileURLToPath(root));
  assert.deepEqual(hits, [], 'id офлайн — число: .slice() падает TypeError');
});

// ─── ревью I2 / M1 / M2 — смета == счёт ─────────────────────────────────────
const { pickerLinePrice } = await import('../views/service-picker-modal.js');

test('I2: цена строки сметы — как у кассы (pricing.js lineUnitPrice): цена врача, над ней — цена визита по счёту', () => {
  const svc = { id: 21, price: 900000 };
  const doc = { id: 7, service_rates: [{ service_id: 21, price: 1100000, percentage: 30 }] };
  assert.equal(pickerLinePrice({ service: svc, doctor: null }), 900000, 'без врача — каталог');
  assert.equal(pickerLinePrice({ service: svc, doctor: doc }), 1100000, 'своя цена врача');
  assert.equal(pickerLinePrice({ service: svc, doctor: { id: 7 } }, [doc]), 1100000, 'врач без ставок в строке — ищется среди сотрудников по id');
  assert.equal(pickerLinePrice({ service: svc, doctor: { id: 8, service_rates: [{ service_id: 21, price: null }] } }), 900000, 'price null — у врача своей цены нет');
  assert.equal(pickerLinePrice({ service: svc, doctor: { id: 8, service_rates: [{ service_id: 21, price: 0 }] } }), 0, '0 — настоящая бесплатная цена');
  // цена визита по счёту (второй/повторный) бьёт и каталог, и цену врача
  const quoted = { service: { id: 21, price: 450000, __base_price: 900000 }, doctor: doc, tier: { tier: 'repeat', price: 450000 } };
  assert.equal(pickerLinePrice(quoted), 450000);
  // первичный визит по котировке — снова цена врача, а не каталог из котировки
  const primary = { service: { id: 21, price: 900000, __base_price: 900000 }, doctor: doc, tier: { tier: 'primary', price: 900000 } };
  assert.equal(pickerLinePrice(primary), 1100000);
  // консультация: цена уже врачебная (consultPriceFor), строка счёта — ad-hoc
  assert.equal(pickerLinePrice({ service: { id: 'c1', __consult: true, price: 120000 }, doctor: doc }), 120000);
});

test('I2: своя цена врача — смета и счёт сходятся (было: назвали 900 000, выставили 1 100 000)', async () => {
  seed();
  DB.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates) VALUES (7,'doc','x','Петров','doctor',1,?)")
    .run(JSON.stringify([{ service_id: 21, price: 1100000, percentage: 30 }]));
  DB.prepare('UPDATE visit_services SET doctor_id = 7 WHERE id = 101').run();
  DB.prepare('UPDATE visit_services SET package_id = NULL WHERE id = 102').run();
  const docRow = { id: 7, service_rates: [{ service_id: 21, price: 1100000, percentage: 30 }] };
  const items = [
    { service: { id: 21, price: 900000 }, doctor: docRow },
    { service: { id: 22, price: 100000 }, doctor: null },
  ];
  const lines = items.map((a, i) => ({ visit_service_id: 101 + i, service_id: a.service.id, price: pickerLinePrice(a), packaged: false }));
  const out = await invoicePickerLines({ visitId: 40, lines, pct: 10, promo: null });
  assert.equal(out.error, null);
  const inv = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  assert.equal(inv.subtotal, 1200000);
  assert.equal(inv.total_amount, out.payable, 'смета ' + out.payable + ' ≠ счёт ' + inv.total_amount);
});

test('M1: скидка группы пациента — пол в смете, как в счёте; на строке пакета — большая из пакета и группы', async () => {
  seed({ categoryPct: 15 });
  const d = pickerDiscount(LINES, { pct: 5, promo: null, categoryPct: 15 });
  assert.equal(d.packageOff, 20000, 'строка пакета: max(20, 15) %');
  assert.equal(d.categoryOff, 135000 - 45000, 'группа поднимает скидку остальных строк с 45 000 до 135 000');
  const out = await invoicePickerLines({ visitId: 40, lines: LINES, pct: 5, promo: null, categoryPct: 15 });
  const inv = DB.prepare('SELECT * FROM invoices WHERE visit_id = 40').get();
  assert.equal(inv.total_amount, out.payable, 'смета ' + out.payable + ' ≠ счёт ' + inv.total_amount);
  assert.equal(out.payable, 845000);
  // группа выше пакета: пакет 20 %, группа 30 % → строка пакета по группе
  const hi = pickerDiscount(LINES, { pct: 0, promo: null, categoryPct: 30 });
  assert.equal(hi.packageOff, 30000);
  seed({ categoryPct: 30 });
  const out2 = await invoicePickerLines({ visitId: 40, lines: LINES, pct: 0, promo: null, categoryPct: 30 });
  assert.equal(DB.prepare('SELECT total_amount FROM invoices WHERE visit_id = 40').get().total_amount, out2.payable);
});

test('M2: срок пакета в смете и при записи строки проверяется по одному дню — дню визита', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../views/service-picker-modal.js', import.meta.url), 'utf8');
  assert.match(src, /function cartVisitDateIso\(\)/);
  assert.match(src, /const visitDate = cartVisitDateIso\(\);/, 'запись визита берёт день из той же функции');
  assert.match(src, /function previewBillLines\(\) \{[^]*?const day = localDayOf\(cartVisitDateIso\(\)\)/, 'смета — тоже');
  assert.ok(!/localDayOf\(a\.startISO \|\| scheduledISO\) \|\| offerDay\(\)/.test(src), 'остался собственный день строки');
});
