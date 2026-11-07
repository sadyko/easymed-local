// DISCOUNT_V2 (решение владельца 2026-11-07, п. 4) — ВЫБОР ОДНОЙ СКИДКИ В МАСТЕРЕ ВИЗИТА.
//
// Окно показывает все скидки, что подходят пациенту: скидку группы, промокоды, «Своя
// скидка (вручную)», «Без скидки». Выбирается одна; по умолчанию — скидка группы. Рядом с
// итогом — почему скидка такая. Сервер получает выбор (discount_choice) и считает сам.
// Стенд — тот же, что у pick-day-wizard.test.mjs (настоящая база и реестр RPC).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM (как в wizard-booking.test.mjs) ─────────────────────────
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
  focus() {} blur() {} select() {} scrollTo() {} scrollIntoView() {}
  contains() { return false; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get textContent() { return this._t; }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() {
    const s = this;
    return {
      contains: (c) => String(s.className).split(/\s+/).includes(c),
      add(c) { if (!String(s.className).split(/\s+/).includes(c)) s.className = (s.className + ' ' + c).trim(); },
      remove(c) { s.className = String(s.className).split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle() {},
    };
  }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => { const e = new F(t); if (String(t).toLowerCase() === 'template') e.content = new F('#fragment'); return e; };
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const TOASTS = [];
const TOAST_EL = mk('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
};
// I18N_LOCALE_PIN_V1 — русский ДО импорта видов (CI на en-US).
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.confirm = () => true;

function walk(e, o = []) { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; }
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');

// ─── настоящая база + настоящий реестр RPC за фальшивым fetch ───────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { stampWriteBody } = await import('../../../../server/services/domain/package-lines.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');
const { reshape } = await import('../../../../server/routes/db.js');   // ревью-2 — связи (patient_categories) вложенными, как настоящий маршрут

let USER = { id: 1, role: 'registrar', extra_roles: [] };   // INVOICE_APPEND_V1 (ревью M1) — тест баланса идёт администратором
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
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'no rpc ' + name } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
    stampWriteBody(DB, body);
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    try {
      if (meta.op === 'select') {
        const rows = reshape(DB.prepare(sql).all(...params), meta);
        // ревью S1 M-1 — JSON-колонки (service_ids промокода) — массивом, как отдаёт настоящий маршрут.
        for (const r of rows) for (const c of meta.json || []) if (r && typeof r[c] === 'string') { try { r[c] = JSON.parse(r[c]); } catch { /* как есть */ } }
        if (meta.single === 'single') return ok(rows[0]);
        if (meta.single === 'maybe') return ok(rows[0] ?? null);
        return ok(rows);
      }
      if (meta.op === 'insert') {
        const info = DB.prepare(sql).run(...params);
        if (!meta.returning) return ok(null);
        const row = DB.prepare(
          `SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`
        ).get(info.lastInsertRowid);
        if (meta.single === 'single') return ok(row);
        if (meta.single === 'maybe') return ok(row ?? null);
        return ok([row]);
      }
      DB.prepare(sql).run(...params);
      return ok(null);
    } catch (e) {
      return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: e.message } }) };
    }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const { forgetSlots } = await import('../views/service-picker-modal.js?v=ownrep4');
const { nearestButtonText, manyDaysWarning } = await import('../views/pick-day.js');

// ─── посев ──────────────────────────────────────────────────────────────────
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayOffset = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const localDayOfIso = (iso) => isoOf(new Date(iso));

/**
 * todayOff — врач не работает в сегодняшний день недели (окон сегодня нет при
 * любом часе запуска); иначе — работает каждый день с from до to.
 * 21 — консультация (нужен врач), 22 — анализ (без врача), 23 — ЭКГ без врача,
 * но с единственным назначенным исполнителем (врач 7, «Услуги и ставки»).
 */
function seed({ todayOff = true, from = '10:00', to = '16:00' } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const todayKey = WD[new Date().getDay()];
  const wh = {};
  for (const k of WD) wh[k] = { enabled: !(todayOff && k === todayKey), from, to };
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours, service_rates) VALUES (7,'doc','x','Петров Пётр','doctor',1,'терапевт',?,?)")
    .run(JSON.stringify(wh), JSON.stringify([{ service_id: 23, pct: 10 }]));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes, requires_doctor) VALUES (21,'Консультация терапевта',100000,30,1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, requires_doctor) VALUES (22,'Анализ крови',40000,'lab',1,0)").run();
  db.prepare("INSERT INTO services (id, name, price, requires_doctor) VALUES (23,'ЭКГ',50000,0)").run();
  if (DB) DB.close();
  DB = db;
  forgetSlots();
  return db;
}

const isWizard = (n) => !!(n && n.style && n.style.position === 'fixed');
const overlay = () => document.body.children.find(isWizard);
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const byAttr = (root, k, v) => walk(root).find((n) => n.attrs && n.attrs[k] !== undefined && (v === undefined || n.attrs[k] === String(v)));

async function openWizard(presetServiceIds) {
  document.body.children.length = 0;
  TOASTS.length = 0; RPC.length = 0;
  const { openVisitWizard } = await import('../views/visit-wizard.js');
  await openVisitWizard(() => {}, { id: 3, full_name: 'Иванов Иван' }, { presetServiceIds });
  await flush(20); await wait(80); await flush(20);   // autoPickSlot → calendar_slots (настоящий)
  assert.ok(overlay(), 'мастер визита не открылся');
}

/** «Далее / Сформировать счёт» — как человек: выключенную кнопку браузер не нажимает. */
async function pressUntilCreate() {
  for (let i = 0; i < 6; i++) {
    const ov = overlay();
    if (!ov) break;
    const btn = walk(ov).filter((n) => n.tagName === 'BUTTON' && !('disabled' in n.attrs))
      .find((n) => /^\s*(Далее|Сформировать счёт|Записать услуги)/.test(textOf(n).replace(/\s+/g, ' ').trim()));
    if (!btn) break;
    btn.click();
    await wait(60); await flush(30);
    if (RPC.some((c) => c.name === 'ensure_visit')) break;
  }
  await wait(80); await flush(30);
}

const vipPatient = (pct = 10) => {
  const cat = DB.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', ?, 1)").run(pct).lastInsertRowid;
  DB.prepare('UPDATE patients SET category_id = ? WHERE id = 3').run(cat);
};
const choiceSel = () => walk(overlay()).find((n) => n.tagName === 'SELECT' && n.attrs['data-discount-choice'] !== undefined);
const optionTexts = (sel) => sel.children.filter((o) => o.tagName === 'OPTION').map((o) => textOf(o).replace(/\s+/g, ' ').trim());
async function choose(text) {
  const sel = choiceSel();
  const opt = sel.children.find((o) => textOf(o).includes(text));
  assert.ok(opt, 'нет варианта ' + text + ': ' + JSON.stringify(optionTexts(sel)));
  sel.value = opt.attrs.value;
  sel.dispatchEvent({ type: 'change', target: sel, currentTarget: sel });
  await flush(5);
}
const reason = () => { const el = byAttr(overlay(), 'data-discount-reason'); return el && el.style.display !== 'none' ? el._t : ''; };
const invoiceCall = () => RPC.find((c) => c.name === 'create_invoice_for_visit');
const money = () => DB.prepare('SELECT subtotal, discount_amount, total_amount, discount_source, discount_note FROM invoices ORDER BY id').all();

test('VIP 10 %: в выборе — «Без скидки», «Скидка группы «VIP» — 10%» (выбрана), «Своя скидка»; причина у итога; счёт по выбору «группа»', async () => {
  seed({ todayOff: false, from: '00:00', to: '23:59' });
  vipPatient(10);
  await openWizard([22, 23]);
  const sel = choiceSel();
  assert.ok(sel, 'нет выбора скидки');
  assert.deepEqual(optionTexts(sel), ['Без скидки', 'Скидка группы «VIP» — 10%', 'Своя скидка (вручную)']);
  assert.equal(sel.value, 'group');
  assert.equal(reason(), 'Скидка группы «VIP» — 10%');
  await pressUntilCreate();
  assert.equal(invoiceCall().body.discount_choice, 'group');
  const [inv] = money();
  assert.deepEqual([inv.subtotal, inv.discount_amount, inv.total_amount, inv.discount_source, inv.discount_note], [90000, 9000, 81000, 'group', 'Скидка группы «VIP» — 10%']);
});

test('VIP 10 % → «Без скидки»: смета без скидки, счёт без скидки (пол группы не ложится)', async () => {
  seed({ todayOff: false, from: '00:00', to: '23:59' });
  vipPatient(10);
  await openWizard([22, 23]);
  await choose('Без скидки');
  assert.equal(reason(), '');
  await pressUntilCreate();
  assert.equal(invoiceCall().body.discount_choice, 'none');
  const [inv] = money();
  assert.deepEqual([inv.discount_amount, inv.total_amount, inv.discount_source], [0, 90000, 'none']);
});

test('VIP 10 % и промокод «ЛЕТО» 15 %: выбран промокод — одна скидка 15 % (13 500), причина — промокод', async () => {
  seed({ todayOff: false, from: '00:00', to: '23:59' });
  vipPatient(10);
  const id = DB.prepare("INSERT INTO patient_discounts (name, kind, percent, amount, active) VALUES ('ЛЕТО', 'promo', 15, 0, 1)").run().lastInsertRowid;
  DB.prepare("INSERT INTO patient_discounts (name, kind, percent, amount, active) VALUES ('Подарок', 'gift_card', 0, 50000, 1)").run();
  await openWizard([22, 23]);
  assert.ok(!optionTexts(choiceSel()).some((t) => t.includes('Подарок')), 'карта — не скидка');
  await choose('ЛЕТО');
  assert.equal(reason(), 'Промокод «ЛЕТО» — −15%');
  await pressUntilCreate();
  const body = invoiceCall().body;
  assert.deepEqual([body.discount_choice, body.discount_id, body.discount_amount], ['promo', Number(id), 13500]);
  const [inv] = money();
  assert.deepEqual([inv.discount_amount, inv.total_amount, inv.discount_note], [13500, 76500, 'Промокод «ЛЕТО» — 15%']);
});

test('без группы и промокодов: выбор «Без скидки» по умолчанию; своё число в поле — «Своя скидка (вручную)»', async () => {
  seed({ todayOff: false, from: '00:00', to: '23:59' });
  await openWizard([22, 23]);
  assert.equal(choiceSel().value, 'none');
  const inp = walk(overlay()).find((n) => n.tagName === 'INPUT' && n.max === '100');
  inp.value = '10';
  inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
  await flush(5);
  assert.equal(choiceSel().value, 'manual');
  assert.equal(reason(), 'Своя скидка (вручную)');
  await pressUntilCreate();
  assert.equal(invoiceCall().body.discount_choice, 'manual');
  assert.equal(money()[0].discount_amount, 9000);
});

// DISCOUNT_V2 (ревью S1 M-1, пробы A6/A11) — СМЕТА НА ДВА ДНЯ И ПРОМОКОД НА ЧАСТЬ УСЛУГ. Выбор скидки
// один на смету, а счёт — на каждый день. Мастер слал промокод в счёт КАЖДОГО дня, и сервер отказывал
// дню, где нет ни одной услуги промокода («Промокод … действует на другие услуги») — счёт этого дня не
// выставлялся. Теперь такой день идёт «Без скидки»: скидка одна — промокод, и ложится только там, где
// действует; смета и сумма счетов сходятся.
test('ревью S1 M-1: смета на два дня, промокод только на консультацию — оба счёта выставлены: день анализа «Без скидки», день консультации — промокод', async () => {
  seed();   // врач сегодня не работает: консультация — на завтра, анализ — сегодня
  vipPatient(10);
  const id = Number(DB.prepare("INSERT INTO patient_discounts (name, kind, percent, amount, active, service_ids) VALUES ('КОНС20', 'promo', 20, 0, 1, '[21]')").run().lastInsertRowid);
  await openWizard([21, 22]);
  byAttr(overlay(), 'data-pick-nearest', 21).click();
  await flush(20);
  assert.ok(byAttr(overlay(), 'data-many-days', 2), 'смета не на два дня');
  await choose('КОНС20');
  assert.ok(textOf(overlay()).includes('120 000 сум'), 'смета — не 120 000 к оплате (140 000 − 20 000 промокода)');
  await pressUntilCreate();
  const calls = RPC.filter((c) => c.name === 'create_invoice_for_visit').map((c) => [c.body.discount_choice, c.body.discount_id ?? null, c.body.discount_amount]);
  assert.deepEqual(calls, [['none', null, 0], ['promo', id, 20000]], 'выбор скидки по дням');
  assert.ok(!TOASTS.some((t) => /не выставлен/.test(t)), 'счёт дня не выставлен: ' + JSON.stringify(TOASTS));
  assert.deepEqual(money().map((m) => [m.subtotal, m.discount_amount, m.total_amount, m.discount_source]),
    [[40000, 0, 40000, 'none'], [100000, 20000, 80000, 'promo:' + id]]);
});

test('ревью S1 M-1: промокод на все услуги — оба дня по промокоду, как прежде (перенос остатка)', async () => {
  seed();
  const id = Number(DB.prepare("INSERT INTO patient_discounts (name, kind, percent, amount, active) VALUES ('ВСЕМ', 'promo', 0, 50000, 1)").run().lastInsertRowid);
  await openWizard([21, 22]);
  byAttr(overlay(), 'data-pick-nearest', 21).click();
  await flush(20);
  await choose('ВСЕМ');
  await pressUntilCreate();
  const calls = RPC.filter((c) => c.name === 'create_invoice_for_visit').map((c) => [c.body.discount_choice, c.body.discount_id ?? null]);
  assert.deepEqual(calls, [['promo', id], ['promo', id]]);
  assert.equal(money().reduce((n, m) => n + m.discount_amount, 0), 50000, 'промокод суммой дан не один раз');
});

test.after(() => { if (DB) DB.close(); DB = null; });
