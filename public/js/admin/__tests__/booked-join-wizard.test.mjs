// BOOKED_JOIN_V1 (решение владельца 2026-11-07) — УСЛУГА К ВРАЧУ, К КОТОРОМУ ПАЦИЕНТ
// УЖЕ ЗАПИСАН В ЭТОТ ДЕНЬ, ИДЁТ В ЭТУ ЗАПИСЬ.
//
// Колл-центр записал пациента к врачу; регистратор добавляет к тому же врачу ещё услугу.
// Мастер визита отвечал «Сегодня у врача нет свободного времени»: строка записи в смете
// держала своё время, а другого окна у врача не было. Теперь новая строка встаёт на
// время записи (метка «в запись · ЧЧ:ММ»), уходит в тот же визит без брони слота, и
// счёт — один на обе услуги.
//
// Стенд — тот же, что у pick-day-wizard.test.mjs: поддельный DOM, а за поддельным fetch —
// настоящий реестр RPC и настоящая SQLite после миграций. Врач работает сегодня ровно
// 23:00–23:30 — единственное окно дня, и его держит запись пациента.
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


function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const wh = {};
  for (const k of WD) wh[k] = { enabled: true, from: '23:00', to: '23:30' };
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours, service_rates) VALUES (7,'doc','x','Петров Пётр','doctor',1,'терапевт',?,?)")
    .run(JSON.stringify(wh), JSON.stringify([{ service_id: 21 }, { service_id: 24 }]));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes, requires_doctor) VALUES (21,'Консультация терапевта',100000,30,1)").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes, requires_doctor) VALUES (24,'ЭКГ с расшифровкой',50000,30,1)").run();
  if (DB) DB.close();
  DB = db;
  forgetSlots();
  return db;
}
/** Запись колл-центра: визит пациента к врачу 7 на день offset в 23:00 и строка консультации. */
function bookAt(offset = 0) {
  const d = dayOffset(offset); d.setHours(23, 0, 0, 0);
  const vid = Number(DB.prepare("INSERT INTO visits (patient_id, visit_date, doctor_id, status, created_by) VALUES (3, ?, 7, 'scheduled', 1)").run(d.toISOString()).lastInsertRowid);
  DB.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, scheduled_at, created_by) VALUES (?, 21, 7, 1, 100000, 100000, 'added', ?, 1)").run(vid, d.toISOString());
  return { vid, start: d };
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
  await flush(20); await wait(120); await flush(20);
  assert.ok(overlay(), 'мастер визита не открылся');
}
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

test('запись сегодня к врачу 7 (единственное окно дня): ЭКГ к нему же — «в запись · 23:00», без брони слота, в тот же визит, один счёт', async () => {
  seed();
  const { vid } = bookAt(0);
  await openWizard([24]);
  const ov = overlay();
  assert.ok(!textOf(ov).includes('Сегодня у врача нет свободного времени'), 'у врача «нет времени»: ' + textOf(ov).slice(0, 300));
  assert.ok(byAttr(ov, 'data-booked-line'), 'строка записи не встала в смету');
  const chip = byAttr(ov, 'data-join-booked', 24);
  assert.ok(chip, 'нет метки «в запись»');
  assert.ok(textOf(chip).includes('23:00'), textOf(chip));
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev, 'мастер не дошёл до записи: ' + JSON.stringify(TOASTS));
  assert.equal(ev.body.book, undefined, 'строка в запись бронирует слот заново');
  assert.equal(DB.prepare("SELECT COUNT(*) n FROM visits WHERE status NOT IN ('cancelled','no_show')").get().n, 1, 'второй визит');
  const lines = DB.prepare("SELECT service_id, scheduled_at FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY service_id").all(vid);
  assert.deepEqual(lines.map((l) => l.service_id), [21, 24]);
  const ecg = lines.find((l) => l.service_id === 24);
  const s = new Date(ecg.scheduled_at);
  assert.deepEqual([s.getHours(), s.getMinutes()], [23, 0], 'ЭКГ не на время записи');
  const inv = DB.prepare('SELECT subtotal, total_amount FROM invoices').all();
  assert.deepEqual(inv.map((i) => [i.subtotal, i.total_amount]), [[150000, 150000]], 'счёт не один на обе услуги');
});

test('записи нет — прежнее правило: единственное окно занято чужим пациентом — «нет свободного времени»', async () => {
  seed();
  DB.prepare("INSERT INTO patients (id, full_name) VALUES (4,'Чужой Пациент')").run();
  const d = dayOffset(0); d.setHours(23, 0, 0, 0);
  DB.prepare("INSERT INTO visits (patient_id, visit_date, doctor_id, status, created_by) VALUES (4, ?, 7, 'scheduled', 1)").run(d.toISOString());
  await openWizard([24]);
  assert.ok(textOf(overlay()).includes('Сегодня у врача нет свободного времени'), 'чужая запись не держит время');
  assert.ok(!byAttr(overlay(), 'data-join-booked'), 'строка ушла в чужую запись');
});

test('запись на послезавтра к врачу 7: в календаре врача на этот день время записи — выбор (BOOKED_JOIN_V1)', async () => {
  seed();
  bookAt(2);
  const { loadPatientBookings, bookedJoinFor } = await import('../views/booked-rows.js');
  const list = await loadPatientBookings(3);
  const j = bookedJoinFor(list, 7, isoOf(dayOffset(2)));
  assert.ok(j, 'запись на послезавтра не найдена: ' + JSON.stringify(list));
  assert.equal(j.when, isoOf(dayOffset(2)) + 'T23:00');
  assert.equal(bookedJoinFor(list, 7, isoOf(dayOffset(0))), null, 'сегодня записи нет');
  assert.equal(bookedJoinFor(list, 8, isoOf(dayOffset(2))), null, 'запись к другому врачу');
});

test.after(() => { if (DB) DB.close(); DB = null; });
