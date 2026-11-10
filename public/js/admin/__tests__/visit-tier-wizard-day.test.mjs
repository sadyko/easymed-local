// 3.23.0, поток G — ЦЕНА ВТОРОГО ВИЗИТА В СМЕТЕ МАСТЕРА ВИЗИТА (снимки 68/69).
//
// Владелец: «applied price changes in the service settings not applying». На снимке
// «Вторичная консультация невро…» «в запись · 09:00» — 80 000, без чипа «Второй визит», хотя
// в настройках услуги второй визит 20 000 (3–5 дн.). Прошлая строка этой услуги у пациента —
// в ТОЙ ЖЕ записи: 0 дней, раньше «не раньше чем через 3» — по правилу это первичный визит
// (server/services/domain/visit-tier.js). Здесь закреплено:
//   • настоящий второй визит (прошлый — 4 дня назад, окно 3–5) — чип «Второй визит»,
//     20 000 в смете, строка «второй» 20 000 и счёт 20 000;
//   • услуга в ту же запись, где она уже есть, — первичный, 80 000, без чипа;
//   • строка на другой день (завтра) — котировка на день строки.
//
// Стенд — как у booked-join-wizard.test.mjs: поддельный DOM, за поддельным fetch — настоящий
// реестр RPC и настоящая SQLite после миграций.
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

// ─── посев ──────────────────────────────────────────────────────────────────
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayOffset = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };

// Визит сервер находит по местному дню SQLite, а мастер — по часам JS. Предзагрузка tz-late
// двигает только пояс JS: дни расходятся, проверки дней здесь не имеют смысла.
const TZ_SPLIT = (() => {
  const db = openDb(':memory:');
  const iso = '2030-01-07T00:30:00Z';
  const sql = db.prepare("SELECT strftime('%Y-%m-%d %H:%M', ?, 'localtime') AS v").get(iso).v;
  db.close();
  const d = new Date(iso);
  const js = `${isoOf(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sql === js ? false : 'пояс JS не совпадает с поясом SQLite (предзагрузка tz-late) — дни визитов не сверить';
})();

// Услуга владельца: первый 80 000, второй 20 000 через 3–5 дн., повторный 10 000 через 6–10 дн.
// 24 — нужен врач (7); 25 — без врача («на дату»).
function seed({ todayOff = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const wh = {};
  const today = dayOffset(0).getDay();
  WD.forEach((k, i) => { wh[k] = { enabled: !(todayOff && i === today), from: '00:00', to: '23:59' }; });
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours, service_rates) VALUES (7,'doc','x','Неврологов Нурали','doctor',1,'невролог',?,?)")
    .run(JSON.stringify(wh), JSON.stringify([{ service_id: 24 }]));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Тестов Тест')").run();
  const tier = "price_secondary, secondary_days_from, secondary_days_to, price_repeat, repeat_days_from, repeat_days_to";
  db.prepare(`INSERT INTO services (id, name, price, duration_minutes, requires_doctor, ${tier}) VALUES (24,'Вторичная консультация невролога',80000,30,1, 20000,3,5,10000,6,10)`).run();
  db.prepare(`INSERT INTO services (id, name, price, duration_minutes, requires_doctor, ${tier}) VALUES (25,'ЭЭГ',80000,30,0, 20000,3,5,10000,6,10)`).run();
  if (DB) DB.close();
  DB = db;
  forgetSlots();
  return db;
}
/** Прошлый визит пациента: строка услуги `sid` выполнена `daysAgo` дней назад, ярус первичный. */
function pastLine(sid, daysAgo) {
  const d = dayOffset(-daysAgo); d.setHours(10, 0, 0, 0);
  const vid = Number(DB.prepare("INSERT INTO visits (patient_id, visit_date, doctor_id, status, created_by) VALUES (3, ?, 7, 'arrived', 1)").run(d.toISOString()).lastInsertRowid);
  DB.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier, created_by) VALUES (?, ?, 7, 1, 80000, 80000, 'completed', 'primary', 1)").run(vid, sid);
  return vid;
}

const isWizard = (n) => !!(n && n.style && n.style.position === 'fixed');
const overlay = () => document.body.children.find(isWizard);
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const byAttr = (root, k, v) => walk(root).find((n) => n.attrs && n.attrs[k] !== undefined && (v === undefined || n.attrs[k] === String(v)));
const tierChip = () => walk(overlay()).find((n) => String(n.className || '').split(/\s+/).includes('wzc-tier'));

async function openWizard(presetServiceIds) {
  document.body.children.length = 0;
  TOASTS.length = 0; RPC.length = 0;
  const { openVisitWizard } = await import('../views/visit-wizard.js');
  await openVisitWizard(() => {}, { id: 3, full_name: 'Тестов Тест' }, { presetServiceIds });
  await flush(20); await wait(150); await flush(20);
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
  await wait(120); await flush(30);
}
const quotes = () => RPC.filter((c) => c.name === 'service_price_quote').map((c) => c.body);
const newLine = (sid) => DB.prepare("SELECT vs.price_tier, vs.unit_price, vs.visit_id FROM visit_services vs WHERE vs.service_id = ? AND vs.status = 'added' ORDER BY vs.id DESC").get(sid);

test('настоящий второй визит: прошлый ЭЭГ 4 дня назад (окно 3–5) — чип «Второй визит», 20 000; строка «второй» 20 000; счёт 20 000', { skip: TZ_SPLIT }, async () => {
  seed();
  pastLine(25, 4);
  await openWizard([25]);
  const chip = tierChip();
  assert.ok(chip, 'нет чипа «Второй визит»: ' + textOf(overlay()).slice(0, 400));
  assert.equal(textOf(chip).trim(), 'Второй визит');
  assert.match(String(chip.attrs.title || ''), /4 дн\. назад/);
  assert.ok(textOf(overlay()).includes('20 000'), 'в смете нет 20 000');
  await pressUntilCreate();
  const line = newLine(25);
  assert.ok(line, 'строка не записана: ' + JSON.stringify(TOASTS));
  assert.deepEqual([line.price_tier, line.unit_price], ['secondary', 20000]);
  const inv = DB.prepare('SELECT ii.unit_price FROM invoice_items ii WHERE ii.service_id = 25').get();
  assert.ok(inv, 'счёт не выставлен: ' + JSON.stringify(TOASTS));
  assert.equal(inv.unit_price, 20000, 'счёт — не цена строки');
});

test('прошлый визит 2 дня назад (раньше окна 3–5): первичный — 80 000, без чипа', { skip: TZ_SPLIT }, async () => {
  seed();
  pastLine(25, 2);
  await openWizard([25]);
  assert.equal(tierChip(), undefined, 'чип яруса на первичном визите');
  await pressUntilCreate();
  assert.deepEqual(Object.values(newLine(25)).slice(0, 2), ['primary', 80000]);
});

test('та же запись (снимок 68): пациент записан завтра к неврологу, услуга уже в записи — добавленная «в запись» строка первичная, 80 000, без чипа', { skip: TZ_SPLIT }, async () => {
  seed({ todayOff: true });
  const d = dayOffset(1); d.setHours(9, 0, 0, 0);
  const vid = Number(DB.prepare("INSERT INTO visits (patient_id, visit_date, doctor_id, status, duration_minutes, booked_at, created_by) VALUES (3, ?, 7, 'scheduled', 30, ?, 1)").run(d.toISOString(), new Date().toISOString()).lastInsertRowid);
  DB.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier, scheduled_at, created_by) VALUES (?, 24, 7, 1, 80000, 80000, 'added', 'primary', ?, 1)").run(vid, d.toISOString());
  await openWizard([24]);
  const nearest = byAttr(overlay(), 'data-pick-nearest', 24);
  if (nearest) { nearest.click(); await flush(20); await wait(120); await flush(20); }
  const join = byAttr(overlay(), 'data-join-booked', 24);
  assert.ok(join && textOf(join).includes('в запись · 09:00'), 'строка не «в запись · 09:00»: ' + textOf(overlay()).slice(0, 400));
  const q = quotes().filter((b) => (b.service_ids || []).map(Number).includes(24));
  assert.ok(q.length, 'котировка не спрошена');
  assert.equal(q[q.length - 1].date, isoOf(dayOffset(1)), 'котировка не на день записи');
  assert.equal(tierChip(), undefined, 'строка в той же записи названа «вторым визитом»');
  const quoted = getRpc('service_price_quote')(DB, { patient_id: 3, service_ids: [24], date: isoOf(dayOffset(1)) }, USER).quotes[24];
  assert.deepEqual([quoted.tier, quoted.price, quoted.reason, quoted.days_since], ['primary', 80000, 'too_soon', 0]);
});

test('строка на завтра («Ближайшее»): прошлый приём 2 дня назад — к завтрашнему дню 3 дня: «Второй визит» 20 000, котировка на день строки; строка «второй»', { skip: TZ_SPLIT }, async () => {
  seed({ todayOff: true });
  pastLine(24, 2);
  await openWizard([24]);
  const nearest = byAttr(overlay(), 'data-pick-nearest', 24);
  assert.ok(nearest, 'нет «Ближайшее»');
  nearest.click();
  await flush(20); await wait(150); await flush(20);
  assert.ok(quotes().some((b) => b.date === isoOf(dayOffset(1))), 'котировка не на день строки: ' + JSON.stringify(quotes()));
  const chip = tierChip();
  assert.ok(chip && textOf(chip).trim() === 'Второй визит', 'нет «Второй визит» на завтра: ' + textOf(overlay()).slice(0, 300));
  await pressUntilCreate();
  const line = newLine(24);
  assert.ok(line, 'строка не записана: ' + JSON.stringify(TOASTS));
  assert.deepEqual([line.price_tier, line.unit_price], ['secondary', 20000]);
});

test.after(() => { if (DB) DB.close(); DB = null; });
