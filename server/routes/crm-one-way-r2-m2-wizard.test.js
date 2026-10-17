// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r2/zz-m2-wizard.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL RE-REVIEW round 2 (money) — wizard «из записи» rows: harness copied from public/js/admin/__tests__/wizard-booking.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── крошечный DOM (тот же стенд, что у room-calendar.test.mjs) ─────────────
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
// CRM_REAL_BOOKING_V1 — ТОСТЫ СЛЫШНЫ. toast() (ui.js) пишет текст в
// el.textContent и следующей строкой кладёт в el._t идентификатор таймера —
// затирая текст. Свой #toast записывает всё сказанное в журнал (тот же обход,
// что в services-catalog.test.mjs и crm-card.test.mjs).
const TOASTS = [];
const TOAST_EL = mk('div');
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
// QUICK_PATIENT_V1 — каталог спрашивает перед уходом (confirmLeaveCatalog) ГОЛЫМ
// confirm(), как это делает браузер. В node его нет вовсе, и любая проверка,
// дошедшая до Escape с набранной сметой, падала бы на «confirm is not defined»
// — то есть по причине, к предмету проверки отношения не имеющей. Умолчание
// «да, закрывай»; проверке, которой важен сам вопрос, эту заглушку подменяют и
// возвращают обратно.
globalThis.confirm = () => true;

function walk(e, o = []) { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; }
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');

// ─── настоящая база + настоящий реестр RPC за фальшивым fetch ───────────────
const { openDb } = await import('../db/connection.js');
const { migrate } = await import('../db/migrate.js');
const { compile } = await import('../db/query-compiler.js');
const { getRpc } = await import('../services/rpc/index.js');
const { stampWriteBody } = await import('../services/domain/package-lines.js');   // SERVICES_PACKAGES_V1
const { readableColumns } = await import('../db/schema-registry.js');
const { calendarSlots, calendarWindows } = await import('../services/rpc/calendar.js');

const USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
// CRM_REAL_BOOKING_V1 — подменить ОДИН ответ ensure_visit (перенос / занятый
// день) при настоящей базе за всем остальным; RPC — журнал вызовов.
let ENSURE_OVERRIDE = null;
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
    if (name === 'ensure_visit' && ENSURE_OVERRIDE) return ok(ENSURE_OVERRIDE);
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
    stampWriteBody(DB, body);   // SERVICES_PACKAGES_V1 — как настоящая дверь (routes/db.js): цена пакета на строке
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    // CRM_REAL_BOOKING_V1 — мастер визита, открытый как экран, ПИШЕТ: строки
    // услуг и правки. Вставка отдаётся так же, как настоящим маршрутом
    // (routes/db.js): строка перечитывается по rowid колонками реестра.
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

// Клиент слотов и записи — ТОТ ЖЕ модуль, который зовут оба мастера.
const SPM = await import('../../public/js/admin/views/service-picker-modal.js');
const { loadSlotDay, freeStartMinutes, calendarBookOrAsk, askEmergencyReason, forgetSlots, hhmmToMin } = SPM;

// ─── посев ──────────────────────────────────────────────────────────────────
// День берётся будущий рабочий: «сегодня» отсекает прошедшие слоты, и тест
// зависел бы от часа запуска.
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function nextWeekday(offset = 2) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * shape:'card'    — карточка сотрудника: {enabled, from, to, lunch…} (форма,
 *                   которой мастер визита НЕ ВИДЕЛ вовсе);
 * shape:'list'    — экран «Сотрудники»: {on, from, to};
 * lunch:true      — обеденный перерыв из карточки.
 */
function seed({ shape = 'card', from = '10:00', to = '16:00', lunch = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const day = nextWeekday();
  const wh = {};
  for (const k of WD) {
    wh[k] = shape === 'card'
      ? { enabled: true, from, to, lunchEnabled: lunch, lunchFrom: '12:00', lunchTo: '13:00' }
      : { on: true, from, to };
  }
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours) VALUES (7,'doc','x','Петров Пётр','doctor',1,'терапевт',?)").run(JSON.stringify(wh));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (4,'Сидорова Мария')").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (21,'Консультация терапевта',100000,30)").run();
  if (DB) DB.close();
  DB = db;
  forgetSlots();
  return { db, day, dayIso: isoOf(day) };
}

const at = (day, hh, mm = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0).toISOString();
const countVisits = () => DB.prepare('SELECT COUNT(*) c FROM visits').get().c;

const isWizard = (n) => !!(n && n.style && n.style.position === 'fixed');
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function pressUntilCreate() {
  for (let i = 0; i < 6; i++) {
    const ov = document.body.children.find(isWizard);
    if (!ov) break;
    const btn = walk(ov).filter((n) => n.tagName === 'BUTTON')
      .find((n) => /^\s*(Далее|Сформировать счёт|Записать услуги)/.test(textOf(n).replace(/\s+/g, ' ').trim()));
    if (!btn) break;
    btn.click();
    await wait(60); await flush(30);
    if (RPC.some((c) => c.name === 'ensure_visit')) break;
  }
  await wait(80); await flush(30);
}
const live22 = () => DB.prepare(`SELECT vs.id, vs.visit_id, v.visit_date FROM visit_services vs JOIN visits v ON v.id = vs.visit_id
                                  WHERE v.patient_id = 3 AND vs.service_id = ? AND vs.status <> 'cancelled' ORDER BY vs.id`);

// M2-S2 — the wizard shows today's booked analysis «из записи»; the registrar moves it to TOMORROW
// (date field of the line — not locked for a booked line). Booked line of another visit → normal
// insert there; today's booked line is neither dropped nor reused → the analysis is in two visits.
// CRM_ONE_WAY_V1 — ОЖИДАНИЕ ОБНОВЛЕНО: правка S2 (bea1f11d) убрала у строки «из записи» поле дня — перенести
// записанный анализ на завтра мастером нельзя («Перенос записи — в календаре», O6); безопасный исход тот же —
// у пациента ОДИН анализ.
test('CRM_ONE_WAY_V1 (повтор r2) — M2-S2: wizard — the booked analysis has no date field (move in the calendar): the patient holds ONE analysis line, not two', async () => {
  seed({});
  DB.prepare("INSERT INTO services (id, name, price, type, is_lab, requires_doctor) VALUES (22,'Анализ крови',40000,'lab',1,0)").run();
  const slot = new Date(); slot.setHours(23, 0, 0, 0);
  const vid = Number(DB.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, duration_minutes, status, created_by) VALUES (3, NULL, ?, 30, 'scheduled', 1)").run(slot.toISOString()).lastInsertRowid);
  const vs = Number(DB.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier, created_by) VALUES (?, 22, NULL, 1, 40000, 40000, 'added', 'primary', 1)").run(vid).lastInsertRowid);
  document.body.children.length = 0;
  TOASTS.length = 0; RPC.length = 0;
  const { openVisitWizard } = await import('../../public/js/admin/views/visit-wizard.js');
  await openVisitWizard(() => {}, { id: 3, full_name: 'Иванов Иван' }, {});
  await flush(30);
  const ov = document.body.children.find(isWizard);
  assert.ok(ov && walk(ov).some((n) => n.attrs && n.attrs['data-booked-line'] === String(vs)), 'precondition: booked row in the cart: ' + JSON.stringify(TOASTS));
  const dateInp = walk(ov).find((n) => n.tagName === 'INPUT' && n.attrs && n.attrs.type === 'date');
  assert.equal(dateInp, undefined, 'the booked line can be moved to another day in the wizard');
  await pressUntilCreate();
  const rows = live22().all(22);
  console.log('S2 RPC', JSON.stringify(RPC.map((c) => c.name)), 'lines of svc 22:', JSON.stringify(rows), 'toasts', JSON.stringify(TOASTS.slice(-3)));
  assert.equal(rows.length, 1, 'booked analysis left in today\'s visit AND inserted again tomorrow (two analyses for the patient)');
});

// CRM_ONE_WAY_V1 — УБРАН: M2-S2c ×2 — у строки «из записи» мастера поля врача больше нет (правка S2/S2c, bea1f11d): перевести её к другому врачу экраном нельзя.
