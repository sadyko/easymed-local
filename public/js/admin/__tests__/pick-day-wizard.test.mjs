// PICK_DAY_V1 (решение владельца 2026-11-02) — НЕТ ВРЕМЕНИ СЕГОДНЯ — ДЕНЬ
// ВЫБИРАЕТ РЕГИСТРАТОР.
//
// Мастер визита (visit-wizard.js) ставил врачебной строке первый свободный слот
// за 14 дней: вечером или в выходной врача строка молча уходила на завтра, а
// услуги без врача оставались сегодня — смета делилась на два визита и два
// счёта (на dev — все 12 случаев «одна регистрация — два счёта»).
//
// Стенд — тот же, что у wizard-booking.test.mjs: поддельный DOM, а за
// поддельным fetch — настоящий реестр RPC и настоящая SQLite после миграций
// (calendar_slots считает настоящий slot-engine). Врач НЕ работает в
// сегодняшний день недели — значит, сегодня у него нет ни одного окна при
// любом часе запуска, а ближайшее — завтра в 10:00.
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

const USER = { id: 1, role: 'registrar', extra_roles: [] };
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
        const rows = DB.prepare(sql).all(...params);
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

const { forgetSlots } = await import('../views/service-picker-modal.js');
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

test('нет времени сегодня: у строки врача нет дня, красная пометка, «Ближайшее: …» — завтра 10:00; дальше не пройти', async () => {
  seed();
  await openWizard([21]);
  const ov = overlay();
  assert.ok(textOf(ov).includes('Сегодня у врача нет свободного времени'), 'нет красной пометки: ' + textOf(ov).slice(0, 400));
  const near = byAttr(ov, 'data-pick-nearest', 21);
  assert.ok(near, 'нет кнопки «Ближайшее»');
  assert.equal(textOf(near).replace(/\s+/g, ' ').trim(), nearestButtonText(isoOf(dayOffset(1)), 10 * 60));
  assert.ok(byAttr(ov, 'data-pick-day', 21), 'нет кнопки «Выбрать день»');
  assert.ok(textOf(ov).includes('сегодня у врача нет свободного времени — выберите день или уберите услугу'), 'шаг не говорит, почему дальше нельзя');
  await pressUntilCreate();
  assert.ok(!RPC.some((c) => c.name === 'ensure_visit'), 'строка без дня ушла в запись');
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM visits').get().n, 0, 'визит заведён молча на другой день');
});

test('«Ближайшее» ставит строке завтрашний слот — и визит записывается на завтра 10:00', async () => {
  seed();
  await openWizard([21]);
  byAttr(overlay(), 'data-pick-nearest', 21).click();
  await flush(20);
  assert.ok(!textOf(overlay()).includes('Сегодня у врача нет свободного времени'), 'пометка осталась после выбора дня');
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev && ev.body.book, 'мастер не дошёл до записи: ' + JSON.stringify(TOASTS));
  const start = new Date(ev.body.book.start);
  assert.equal(isoOf(start), isoOf(dayOffset(1)));
  assert.deepEqual([start.getHours(), start.getMinutes()], [10, 0]);
});

test('«Выбрать день» открывает календарь врача: выбранный день ставит время, пометка уходит', async () => {
  seed();
  await openWizard([21]);
  const pick = walk(overlay()).filter((n) => n.attrs && n.attrs['data-pick-day'] === '21');
  assert.ok(pick.length, 'нет кнопки «Выбрать день»');
  pick[0].click();   // кнопка в строке каталога — первая
  await wait(80); await flush(20);
  const pop = walk(overlay()).find((n) => n.style && n.style.width === '252px' && n.style.display === '');
  assert.ok(pop, 'календарь врача не открылся');
  const tomorrow = dayOffset(1);
  if (tomorrow.getMonth() !== new Date().getMonth()) {   // завтра — уже следующий месяц
    walk(pop).find((n) => n.tagName === 'BUTTON' && textOf(n).trim() === '›').click();
    await wait(80); await flush(20);
  }
  // Кнопка дня: первая строка — число месяца, вторая — «N окн».
  const dayBtn = walk(pop).find((n) => n.tagName === 'BUTTON' && !('disabled' in n.attrs)
    && n.children[0] && textOf(n.children[0]).trim() === String(tomorrow.getDate()));
  assert.ok(dayBtn, 'в календаре нет завтрашнего дня с окнами');
  dayBtn.click();
  await flush(20);
  assert.ok(!byAttr(overlay(), 'data-no-today'), 'пометка осталась после выбора дня');
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev && ev.body.book, 'мастер не дошёл до записи');
  assert.equal(isoOf(new Date(ev.body.book.start)), isoOf(tomorrow));
});

test('время сегодня есть — берётся сегодняшнее; на другой день строка сама не уходит никогда', async () => {
  seed({ todayOff: false, from: '00:00', to: '23:59' });
  await openWizard([21]);
  const ov = overlay();
  if (textOf(ov).includes('Сегодня у врача нет свободного времени')) {
    // Часы клиники на сегодня уже кончились: окон нет — и строка без дня, а не на завтра.
    await pressUntilCreate();
    assert.ok(!RPC.some((c) => c.name === 'ensure_visit'));
    return;
  }
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev && ev.body.book, 'мастер не дошёл до записи: ' + JSON.stringify(TOASTS));
  assert.equal(isoOf(new Date(ev.body.book.start)), isoOf(new Date()), 'время поставлено не на сегодня');
});

test('услуга без врача с единственным исполнителем остаётся сегодня — день врача ей не ставится', async () => {
  seed();   // врач 7 сегодня не работает; ЭКГ (23) назначена ему одному
  await openWizard([23]);
  assert.ok(!textOf(overlay()).includes('Сегодня у врача нет свободного времени'), 'услуге без врача не нужен день врача');
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev, 'мастер не дошёл до записи: ' + JSON.stringify(TOASTS));
  assert.ok(!ev.body.book, 'услуга без врача заняла время врача');
  assert.equal(localDayOfIso(ev.body.date), isoOf(new Date()), 'ЭКГ уехала на день врача');
});

test.after(() => { if (DB) DB.close(); DB = null; });
