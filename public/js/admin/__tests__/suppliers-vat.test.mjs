// SUPPLIERS_VAT_V1 (2026-09-28) — экраны склада: карточка товара, карточка
// поставщика, «Принять товар», импорт Excel и фильтр отчёта.
//
// Стенд не заглушка: фальшивый fetch пропускает вызовы через НАСТОЯЩИЙ
// компилятор запросов, настоящий реестр RPC и SQLite в памяти после всех
// миграций (тот же приём, что picker-invoice.test.mjs). Поэтому здесь видно не
// «экран позвал что-то», а что именно легло в базу: тип, ставка НДС, связи
// «товар ↔ поставщик», НДС прихода.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM ──────────────────────────────────────────────────────────
// Как в браузере: атрибут value задаёт значение поля, атрибут checked — отметку,
// а значение <select> без явной записи — у выбранного <option> (иначе первого).
class F {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {};
    this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
    this._v = undefined; this.checked = false; this.disabled = false; this.parentElement = null;
  }
  get value() {
    if (this._v !== undefined) return this._v;
    if (this.tagName === 'SELECT') {
      const opts = this.children.filter((c) => c.tagName === 'OPTION');
      const sel = opts.find((o) => 'selected' in o.attrs) || opts[0];
      return sel ? (sel.attrs.value ?? '') : '';
    }
    return '';
  }
  set value(v) { this._v = String(v); }
  appendChild(c) { if (c && typeof c === 'object') { c.parentElement = this; this.children.push(c); } return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); if (c) c.parentElement = null; return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'type') this.type = String(v);
    if (k === 'value' && this.tagName !== 'OPTION') this._v = String(v);
    if (k === 'checked') this.checked = true;
  }
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
  get textContent() { return this._t + this.children.map((c) => c.textContent || '').join(''); }
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
const BODY = mk('body');
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: BODY, documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, open: () => null,
  easymed: { state: { user: { id: 2, role: 'inventory' } } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.confirm = () => true;

// ─── настоящая база + настоящий реестр RPC за фальшивым fetch ───────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
// Связи (products(...), suppliers(...)) — во вложенный вид, как отдаёт маршрут /api/db.
const { reshape } = await import('../../../../server/routes/db.js');

const USER = { id: 2, role: 'inventory', extra_roles: [] };
let DB = null;
const RPC = [];
const DBWRITES = [];   // таблицы, в которые экран писал через /api/db
let FAIL_TABLE = null;   // таблица, чтение которой «не загрузилось»

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
    if (FAIL_TABLE && body.table === FAIL_TABLE) return { ok: false, status: 500, json: async () => ({ error: { message: 'сбой сети' } }) };
    let compiled;
    try { compiled = compile(body, USER, { db: DB }); }
    catch (e) { return { ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    if (meta.op !== 'select') DBWRITES.push(meta.table);
    const rows = meta.op === 'select' ? reshape(DB.prepare(sql).all(...params), meta) : (DB.prepare(sql).run(...params), []);
    if (meta.single === 'single') return ok(rows[0]);
    if (meta.single === 'maybe') return ok(rows[0] ?? null);
    return ok(rows);
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const products = await import('../views/inventory-products.js');
const suppliers = await import('../views/inventory-suppliers.js');
const sklad = await import('../views/inventory-sklad.js');
const { REPORT_DEFS, optionsFor, reportArgs } = await import('../views/reports-hub.js');
const docs = await import('../views/inventory-docs.js');

// ─── помощники ──────────────────────────────────────────────────────────────
const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._t || '').join('');
const flat = (e) => textOf(e).replace(/\s+/g, ' ').trim();
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const modal = () => BODY.children[BODY.children.length - 1];
const byAria = (root, label) => walk(root).filter((e) => e.attrs && e.attrs['aria-label'] === label);
const byPlaceholder = (root, re) => walk(root).find((e) => e.tagName === 'INPUT' && re.test(e.attrs.placeholder || ''));
const button = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && flat(e) === label);
const click = (el) => el.dispatchEvent({ type: 'click', currentTarget: el, preventDefault() {}, stopPropagation() {} });
const setVal = (el, v, type = 'input') => { el.value = String(v); el.dispatchEvent({ type, currentTarget: el, target: el }); };
const mousedownOn = (root, text) => {
  const el = walk(root).find((e) => e.tagName === 'DIV' && e._l.mousedown && flat(e).startsWith(text));
  assert.ok(el, 'нет строки результата: ' + text);
  el.dispatchEvent({ type: 'mousedown', currentTarget: el, preventDefault() {} });
};

function seed() {
  if (DB) DB.close();
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (2, 'inv', 'x', 'inventory', 'Кладовщик')").run();
  db.prepare("INSERT INTO suppliers (id, name) VALUES (1, 'ООО Аптека'), (2, 'ООО Бинты')").run();
  db.prepare(`INSERT INTO products (id, name, base_unit, unit, purchase_unit, pack_factor, procurement_category, vat_rate, sale_price, supplier_id)
              VALUES (10, 'Анальгин', 'таб', 'таб', 'уп', 10, 'medicines', 12, 300, 1), (11, 'Бинт', 'шт', 'шт', NULL, 1, 'consumables', NULL, 5000, NULL)`).run();
  db.prepare('INSERT INTO item_suppliers (product_id, supplier_id, last_price, vat_rate, pack_factor, purchase_unit) VALUES (10, 1, 1000, 12, 10, ?)').run('уп');
  db.prepare('INSERT INTO item_suppliers (product_id, supplier_id, last_price, vat_rate, pack_factor, purchase_unit) VALUES (10, 2, 950, NULL, 10, ?)').run('уп');
  DB = db;
  RPC.length = 0; DBWRITES.length = 0; TOASTS.length = 0; FAIL_TABLE = null;
  BODY.children.length = 0;
  return db;
}
const links = (pid) => DB.prepare('SELECT supplier_id, last_price, vat_rate FROM item_suppliers WHERE product_id = ? ORDER BY supplier_id').all(pid).map((r) => ({ ...r }));

// ─── карточка товара ────────────────────────────────────────────────────────
test('карточка товара: категория — ровно восемь без пустого варианта; НДС нового товара — 12 %; сохранение — product_save', async () => {
  seed();
  products.openProductModal(null, null);
  await settle();
  const m = modal();
  const typeSel = byAria(m, 'Категория')[0];
  const opts = walk(typeSel).filter((e) => e.tagName === 'OPTION');
  assert.deepEqual(opts.map((o) => o.attrs.value), ['medicines', 'consumables', 'equipment', 'lab_supplies', 'dental', 'radiology', 'office_it', 'facility']);
  assert.ok(opts.every((o) => o.attrs.value), 'пустого варианта нет');
  const vat = byAria(m, 'Ставка НДС')[0];
  assert.equal(vat.value, '12');
  assert.deepEqual(walk(vat).filter((e) => e.tagName === 'OPTION').map((o) => o.attrs.value), ['12', '0', 'none']);

  setVal(byPlaceholder(m, /Перчатки/), 'Шприц 5 мл');
  setVal(typeSel, 'consumables', 'change');
  setVal(vat, 'none', 'change');
  // Поставщик — из поиска карточки.
  const sup = byPlaceholder(m, /Поиск поставщика/);
  setVal(sup, 'Бинт', 'focus');
  mousedownOn(m, 'ООО Бинты');
  click(button(m, 'Добавить'));
  await settle();
  const call = RPC.find((r) => r.name === 'product_save');
  assert.ok(call, 'product_save не позван');
  assert.equal(call.body.procurement_category, 'consumables');
  assert.equal(call.body.vat_rate, null, '«Без НДС» уходит как null');
  assert.deepEqual(call.body.suppliers.map((s) => s.supplier_id), [2]);
  const p = DB.prepare("SELECT * FROM products WHERE name = 'Шприц 5 мл'").get();
  assert.equal(p.procurement_category, 'consumables');
  assert.equal(p.vat_rate, null);
  assert.equal(p.supplier_id, 2);
  assert.deepEqual(links(p.id), [{ supplier_id: 2, last_price: null, vat_rate: null }]);
});

test('карточка товара, правка: цена и НДС поставщика сохраняются; связи не загрузились — не стираются', async () => {
  seed();
  const p = DB.prepare('SELECT * FROM products WHERE id = 10').get();
  products.openProductModal(p, null);
  await settle();
  let m = modal();
  const prices = walk(m).filter((e) => e.tagName === 'INPUT' && e.attrs['placeholder'] === 'цена');
  assert.equal(prices.length, 2, 'две связи с поставщиками');
  setVal(prices[1], '990');
  const vats = byAria(m, 'Ставка НДС');   // товар + две связи
  assert.equal(vats.length, 3);
  assert.equal(vats[0].value, '12');
  assert.equal(vats[2].value, 'none');
  setVal(vats[2], '12', 'change');
  click(button(m, 'Сохранить'));
  await settle();
  assert.deepEqual(links(10), [{ supplier_id: 1, last_price: 1000, vat_rate: 12 }, { supplier_id: 2, last_price: 990, vat_rate: 12 }]);

  // Связи не загрузились: «Сохранить» не отправляет список — связи целы.
  seed();
  FAIL_TABLE = 'item_suppliers';
  products.openProductModal(DB.prepare('SELECT * FROM products WHERE id = 10').get(), null);
  await settle();
  m = modal();
  assert.match(flat(m), /Поставщики не загрузились/);
  click(button(m, 'Сохранить'));
  await settle();
  const call = RPC.find((r) => r.name === 'product_save');
  assert.equal(call.body.suppliers, undefined, 'список связей не отправлен');
  FAIL_TABLE = null;
  assert.equal(links(10).length, 2);
});

// ─── карточка поставщика ────────────────────────────────────────────────────
test('карточка поставщика: все его товары с ценой и НДС; «Добавить товар» привязывает; сохранение — supplier_save', async () => {
  seed();
  const s = DB.prepare('SELECT * FROM suppliers WHERE id = 2').get();
  suppliers.openSupplierModal(s, null);
  await settle();
  const m = modal();
  assert.match(flat(m), /Товары поставщика/);
  assert.match(flat(m), /Анальгин/);
  const add = byPlaceholder(m, /Добавить товар/);
  setVal(add, 'Бинт', 'focus');
  mousedownOn(m, 'Бинт');
  const prices = walk(m).filter((e) => e.tagName === 'INPUT' && e.attrs['aria-label'] === 'Цена без НДС');
  assert.equal(prices.length, 2);
  setVal(prices[1], '4000');
  click(button(m, 'Сохранить'));
  await settle();
  const call = RPC.find((r) => r.name === 'supplier_save');
  assert.ok(call, 'supplier_save не позван');
  assert.deepEqual(call.body.products.map((x) => x.product_id).sort(), [10, 11]);
  assert.deepEqual(links(11), [{ supplier_id: 2, last_price: 4000, vat_rate: null }]);
  assert.equal(DB.prepare('SELECT supplier_id FROM products WHERE id = 11').get().supplier_id, 2, 'у бинта основной поставщик — этот');
  assert.equal(links(10).length, 2, 'прежняя связь осталась');
});

test('короткая форма поставщика (из карточки товара) — без товаров; supplier_save без списка', async () => {
  seed();
  suppliers.openSupplierModal(null, null, { withProducts: false });
  await settle();
  const m = modal();
  assert.doesNotMatch(flat(m), /Товары поставщика/);
  setVal(walk(m).find((e) => e.tagName === 'INPUT' && e.attrs.type === 'text'), 'ООО Новый');
  click(button(m, 'Добавить'));
  await settle();
  const call = RPC.find((r) => r.name === 'supplier_save');
  assert.equal(call.body.products, undefined);
  assert.ok(DB.prepare("SELECT 1 FROM suppliers WHERE name = 'ООО Новый'").get());
});

// ─── «Принять товар» ────────────────────────────────────────────────────────
test('«Принять товар»: цена и НДС — из связи с поставщиком; суммы без НДС / НДС / с НДС; сервер пишет НДС прихода', async () => {
  seed();
  products.openReceiveModal(null);
  await settle();
  const m = modal();
  const search = byPlaceholder(m, /Поиск товара/);
  setVal(search, 'Анальгин', 'focus');
  mousedownOn(m, 'Анальгин');
  const cost = byAria(m, 'Цена без НДС')[0];
  assert.equal(cost.value, '1000', 'цена поставщика «ООО Аптека» (основного)');
  const vat = byAria(m, 'Ставка НДС')[0];
  assert.equal(vat.value, '12');
  setVal(byAria(m, 'Количество')[0], '2');
  assert.match(flat(m), /Без НДС: 2 000 · НДС: 240 · Итого с НДС: 2 240 UZS/);
  // Смена поставщика подставляет ЕГО цену и ставку.
  setVal(byAria(m, 'Поставщик')[0], '2', 'change');
  assert.equal(byAria(modal(), 'Цена без НДС')[0].value, '950');
  assert.equal(byAria(modal(), 'Ставка НДС')[0].value, 'none');
  setVal(byAria(modal(), 'Ставка НДС')[0], '12', 'change');
  setVal(byAria(modal(), 'Количество')[0], '2');
  click(button(modal(), 'Приход'));
  await settle();
  const call = RPC.find((r) => r.name === 'receive_stock_lines');
  assert.ok(call, 'receive_stock_lines не позван');
  assert.deepEqual({ ...call.body.lines[0], batch_no: undefined, expiry_date: undefined },
    { product_id: 10, unit: 'purchase', qty: 2, unit_cost: 950, vat_rate: 12, supplier_id: 2, batch_no: undefined, expiry_date: undefined });
  const mv = DB.prepare("SELECT qty, unit_cost, vat_rate, vat_amount, supplier_id FROM stock_movements WHERE kind = 'receive'").get();
  assert.deepEqual({ ...mv }, { qty: 20, unit_cost: 106.4, vat_rate: 12, vat_amount: 228, supplier_id: 2 });
  assert.deepEqual(links(10)[1], { supplier_id: 2, last_price: 950, vat_rate: 12 }, 'связь помнит цену и ставку прихода');
});

test('чистые правила окна прихода: суммы строки и цена по умолчанию без связи', () => {
  assert.deepEqual(products.receiptLineMoney({ qty: 3, unitCost: 1000, vat: 12 }), { net: 3000, vat: 360, gross: 3360 });
  assert.deepEqual(products.receiptLineMoney({ qty: 3, unitCost: 1000, vat: null }), { net: 3000, vat: 0, gross: 3000 });
  // Без связи: себестоимость (с НДС) × упаковка, пересчитанная в цену без НДС.
  assert.deepEqual(products.receiptDefaults({ id: 5, avg_cost: 112, pack_factor: 10, vat_rate: 12 }, null, []), { unitCost: 1000, vat: 12 });
  assert.deepEqual(products.receiptDefaults({ id: 5, avg_cost: 0, pack_factor: 1, vat_rate: null }, 3, []), { unitCost: null, vat: null });
  // Ревью F2 — строка прихода в упаковке товара (уп = 10 таб), цена связи — за её кор (100 таб): 9 000 → 900 за уп.
  assert.deepEqual(products.receiptDefaults({ id: 5, pack_factor: 10, vat_rate: 0 }, 3, [{ product_id: 5, supplier_id: 3, last_price: 9000, vat_rate: 12, pack_factor: 100 }]), { unitCost: 900, vat: 12 });
  assert.deepEqual(products.receiptDefaults({ id: 5, pack_factor: 10, vat_rate: 0 }, 3, [{ product_id: 5, supplier_id: 3, last_price: 950, vat_rate: null }]), { unitCost: 950, vat: null }, 'у связи нет своей упаковки — упаковка товара');
  assert.deepEqual(products.receiveLinesPayload([{ product: { id: 5 }, qty: '2', unitCost: '10', vat: null, supplierId: null, batchNo: '', expiry: '' }]),
    [{ product_id: 5, unit: 'purchase', qty: 2, unit_cost: 10, vat_rate: null, supplier_id: null, batch_no: null, expiry_date: null }]);
  assert.equal(products.suppliersCellText(['А', 'Б', 'В', 'Г']), 'А, Б +2');
  assert.equal(products.suppliersCellText([]), '—');
});

// ─── импорт Excel ───────────────────────────────────────────────────────────
// Ревью F3 — «НДС» разделён: «НДС прихода» (строка прихода) и «НДС продажи» (карточка товара).
test('импорт: шаблон со сроком ДД.ММ.ГГГГ, категорией и двумя НДС; дата-ячейка Excel уходит как ДД.ММ.ГГГГ', () => {
  assert.deepEqual(sklad.IMPORT_COLUMNS, ['Название*', 'Категория*', 'Единица', 'Кол-во', 'Цена закупки без НДС', 'НДС прихода', 'Цена продажи', 'НДС продажи',
    'Мин. остаток', 'Поставщик', 'Партия', 'Срок годности (ДД.ММ.ГГГГ)']);
  const rows = sklad.importRowsFromMatrix([
    sklad.IMPORT_COLUMNS,
    ['Парацетамол', 'Медикаменты', 'шт', 10, 1500, '12%', 2500, '0%', 5, 'ООО Медснаб', 'A-1', new Date(2027, 11, 31)],
    ['Бинт', 'Расходники', 'шт', '', '', '', '', 0.12, '', '', '', '31.12.2027'],
    ['', '', '', '', '', '', '', '', '', '', '', ''],   // пустая строка пропускается
    ['Шприц', 'Расходники', 'шт', 1, 100, '', '', '', '', '', '', 46387],
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { name: 'Парацетамол', category: 'Медикаменты', unit: 'шт', qty: 10, unit_cost: 1500, receipt_vat_rate: '12%', sale_price: 2500,
    sale_vat_rate: '0%', vat_rate: '', reorder_level: 5, supplier: 'ООО Медснаб', batch_no: 'A-1', expiry_date: '31.12.2027' });
  assert.equal(rows[1].expiry_date, '31.12.2027');
  assert.equal(rows[1].sale_vat_rate, 0.12);
  assert.equal(rows[2].expiry_date, 46387, 'число без формата даты — как есть, сервер его отклонит');
  // Старый шаблон («Себестоимость») читается той же колонкой.
  const old = sklad.importRowsFromMatrix([['Название*', 'Единица', 'Кол-во', 'Себестоимость', 'Мин. остаток', 'Поставщик'], ['Вата', 'уп', 3, 900, 1, '']]);
  assert.equal(old[0].unit_cost, 900);
  assert.throws(() => sklad.importRowsFromMatrix([['Товар'], ['x']]), /Не найдена колонка «Название»/);
});

test('импорт через экранные строки: срок в прошлом и несуществующая дата — отказ с номером строки, файл не проходит', async () => {
  seed();
  const rows = sklad.importRowsFromMatrix([
    sklad.IMPORT_COLUMNS,
    ['Новый бинт', 'Расходники', 'шт', 5, 100, 'без НДС', 200, '', '', 'ООО Бинты', 'B-9', new Date(2030, 0, 15)],
    ['Вата', 'Расходники', 'шт', 5, 100, '', '', '', '', '', '', '31.02.2030'],
  ]);
  await assert.rejects(async () => getRpc('import_products_excel')(DB, { rows }, USER), /^Error: Строка 3: срок годности 31\.02\.2030 — такой даты нет/);
  assert.equal(DB.prepare("SELECT COUNT(*) n FROM products WHERE name IN ('Новый бинт', 'Вата')").get().n, 0);
  const ok = await getRpc('import_products_excel')(DB, { rows: rows.slice(0, 1) }, USER);
  assert.deepEqual(ok, { created: 1, updated: 0, received: 1 });
  const mv = DB.prepare("SELECT expiry_date, batch_no, vat_rate, vat_amount FROM stock_movements WHERE reference_type = 'import'").get();
  assert.deepEqual({ ...mv }, { expiry_date: '2030-01-15', batch_no: 'B-9', vat_rate: null, vat_amount: 0 });
});

test('«Склад»: отбор по поставщику видит всех поставщиков товара, а не только основного', () => {
  const linksOf = new Map([[10, new Set([1, 2])], [11, new Set()]]);
  const a = { id: 10, supplier_id: 1 }, b = { id: 11, supplier_id: null };
  assert.equal(sklad.matchesSupplier(a, '2', linksOf), true, 'второй поставщик товара');
  assert.equal(sklad.matchesSupplier(a, '1', linksOf), true);
  assert.equal(sklad.matchesSupplier(b, '2', linksOf), false);
  assert.equal(sklad.matchesSupplier(b, 'none', linksOf), true);
  assert.equal(sklad.matchesSupplier(a, 'none', linksOf), false);
  assert.equal(sklad.matchesSupplier(a, 'all', linksOf), true);
});

// ─── отчёт ──────────────────────────────────────────────────────────────────
test('«Закупки и склад»: фильтр «Поставщик» — выпадающий список только у «Прихода по поставщикам»', () => {
  const d = REPORT_DEFS.find((r) => r.kind === 'procurement');
  assert.deepEqual(optionsFor(d, 'procurement').map((o) => o.arg), ['category', 'supplier_id']);
  const o = optionsFor(d, 'procurement').find((x) => x.arg === 'supplier_id');
  assert.equal(o.type, 'select');
  assert.deepEqual(o.choices, [['', 'Все поставщики']]);
  assert.deepEqual(optionsFor(d, 'stock_statement').map((x) => x.arg), ['category']);
  assert.deepEqual(reportArgs(d, 'procurement', { category: 'all', supplier_id: '' }), { category: 'all' }, '«все» не уезжает');
  assert.deepEqual(reportArgs(d, 'procurement', { category: 'all', supplier_id: '7' }), { category: 'all', supplier_id: '7' });
});

// ─── заказ на закупку с НДС ─────────────────────────────────────────────────
test('заказ на закупку: цена и ставка — из связи с поставщиком заказа, ручная правка остаётся; один purchase_order_create; окно заказа показывает НДС', async () => {
  seed();
  const root = mk('div');
  docs.renderPurchaseOrdersTab(root);
  await settle();
  click(button(root, 'Новый заказ'));
  await settle();
  let m = modal();
  const supSel = walk(m).find((e) => e.tagName === 'SELECT' && walk(e).some((o) => o.tagName === 'OPTION' && flat(o) === 'ООО Аптека'));
  setVal(supSel, '1', 'change');
  setVal(byAria(m, 'Товар')[0], '10', 'change');
  assert.equal(byAria(m, 'Цена без НДС')[0].value, '100', 'связь: 1 000 за упаковку / 10');
  assert.equal(byAria(m, 'Ставка НДС')[0].value, '12');
  setVal(byAria(m, 'Количество')[0], '20');
  assert.match(flat(m), /Без НДС: 2 000 · НДС: 240 · Итого с НДС: 2 240/);
  // Другой поставщик — его цена и ставка.
  setVal(supSel, '2', 'change');
  assert.equal(byAria(m, 'Цена без НДС')[0].value, '95');
  assert.equal(byAria(m, 'Ставка НДС')[0].value, 'none');
  // Поправленная руками цена смену поставщика переживает, нетронутая ставка — нет.
  setVal(byAria(m, 'Цена без НДС')[0], '90');
  setVal(supSel, '1', 'change');
  assert.equal(byAria(m, 'Цена без НДС')[0].value, '90');
  assert.equal(byAria(m, 'Ставка НДС')[0].value, '12');
  click(button(m, 'Создать заказ'));
  await settle();
  const call = RPC.find((r) => r.name === 'purchase_order_create');
  assert.ok(call, 'purchase_order_create не позван');
  assert.deepEqual(call.body, { supplier_id: 1, notes: null, lines: [{ product_id: 10, qty: 20, unit_cost: 90, vat_rate: 12 }] });
  const po = DB.prepare('SELECT * FROM purchase_orders').get();
  assert.equal(po.total, 2016, 'сумма заказа с НДС: 1 800 + 216');
  assert.deepEqual(DBWRITES, [], 'заказ и его строки больше не пишутся через /api/db');
  // Строка заказа до учёта НДС — рядом, «не указан».
  DB.prepare('INSERT INTO purchase_order_items (po_id, product_id, qty_ordered, unit_cost) VALUES (?, 11, 2, 500)').run(po.id);
  await settle();
  const row = walk(root).find((e) => e.tagName === 'TR' && e._l.click && flat(e).includes(po.po_number));
  assert.ok(row, 'заказ в списке');
  click(row);
  await settle();
  m = modal();
  assert.match(flat(m), /12 %/);
  assert.match(flat(m), /не указан/);
  assert.match(flat(m), /Без НДС: 2 800 · НДС: 216 · Итого с НДС: 3 016/);
});

test('чистые правила заказа: цена и ставка по умолчанию, деньги строки, строка до НДС', () => {
  const p = { id: 10, pack_factor: 10, vat_rate: 0 };
  const links = [{ product_id: 10, supplier_id: 1, last_price: 1000, vat_rate: 12 }];
  assert.deepEqual(docs.poLineDefaults(p, 1, links), { cost: 100, vat: 12 });
  assert.deepEqual(docs.poLineDefaults(p, 2, links), { cost: null, vat: 0 }, 'без связи — ставка товара');
  assert.deepEqual(docs.poLineDefaults({ id: 11, vat_rate: null }, null, links), { cost: null, vat: null });
  // Ревью F2 — у связи своя упаковка: 9 000 за кор из 100 таб → 90 за таблетку (не 900 по упаковке товара).
  assert.deepEqual(docs.poLineDefaults(p, 1, [{ product_id: 10, supplier_id: 1, last_price: 9000, vat_rate: 12, pack_factor: 100 }]), { cost: 90, vat: 12 });
  assert.deepEqual(docs.poLineMoney({ qty: 20, cost: 90, vat: 12 }), { net: 1800, vat: 216, gross: 2016 });
  assert.deepEqual(docs.poItemMoney({ qty_ordered: 2, unit_cost: 500, vat_rate: null, vat_amount: null }), { net: 1000, vat: null, gross: 1000, rate: 'не указан' });
  assert.deepEqual(docs.poItemMoney({ qty_ordered: 2, unit_cost: 500, vat_rate: null, vat_amount: 0 }), { net: 1000, vat: 0, gross: 1000, rate: 'Без НДС' });
  assert.deepEqual(docs.poCreatePayload({ supplierId: null, notes: '  ', lines: [{ product: { id: 5 }, qty: 1, cost: null, vat: null }] }),
    { supplier_id: null, notes: null, lines: [{ product_id: 5, qty: 1, vat_rate: null }] });
});

// Ревью M4 — дата-ячейка со временем: книга читается числами, день — как написан.
test('ревью M4: «28.09.2026 18:00» и «31.12.2027 23:59» в ячейке срока — тот же день, а не следующий', async () => {
  const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
  const header = sklad.IMPORT_COLUMNS;
  const exp = header.length - 1;
  const row = (name, when) => { const r = header.map(() => ''); r[0] = name; r[1] = 'Расходники'; r[3] = 1; r[exp] = when; return r; };
  const ws0 = XLSX.utils.aoa_to_sheet([header,
    row('Вата', new Date(2026, 8, 28, 18, 0)),
    row('Бинт', new Date(2027, 11, 31, 23, 59)),
    row('Маска', new Date(2027, 11, 31)),
  ]);
  ws0[XLSX.utils.encode_cell({ r: 4, c: 0 })] = { t: 's', v: 'Шприц' };
  ws0[XLSX.utils.encode_cell({ r: 4, c: 1 })] = { t: 's', v: 'Расходники' };
  ws0[XLSX.utils.encode_cell({ r: 4, c: exp })] = { t: 'n', v: 46387 };   // число без формата даты
  ws0['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 4, c: exp } });
  const wb0 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb0, ws0, 'Импорт');
  const buf = XLSX.write(wb0, { type: 'buffer', bookType: 'xlsx' });
  const wb = XLSX.read(buf, { cellDates: false, cellNF: true });
  const rows = sklad.importRowsFromMatrix(sklad.sheetMatrix(XLSX, wb.Sheets[wb.SheetNames[0]]));
  assert.deepEqual(rows.map((r) => [r.name, r.expiry_date]),
    [['Вата', '28.09.2026'], ['Бинт', '31.12.2027'], ['Маска', '31.12.2027'], ['Шприц', 46387]]);
});
