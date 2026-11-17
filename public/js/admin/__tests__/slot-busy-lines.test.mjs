// SLOT_BUSY_LINES_V1 (3.25.0) — СТРОКА ВИЗИТА К ДРУГОМУ ВРАЧУ ЗАНИМАЕТ ЕГО ВРЕМЯ И НА ЭКРАНАХ.
//
// Пациент записан на 09:00 к врачу А, «Добавить в этот визит» положило в тот же визит
// строку врача Б на 15:00. Сервер теперь считает это время занятым (rpc/calendar.js,
// SLOT_BUSY_LINES_V1); здесь — что это видят экраны записи:
//   • «Бронирование» врача Б: 15:00 — строка «записан» с пациентом, а не «Свободно»;
//     корзины «Отменить запись» у неё нет — она отменила бы ВЕСЬ визит пациента у врача А;
//   • календарь «Записи»: в колонке врача Б — блок строки на 15:00–15:30 с пациентом и
//     услугой; щелчок по клетке 15:00 врача Б говорит «занято», а не открывает запись.
//
// Стенд НАСТОЯЩИЙ (как booking-day-join.test.mjs): фальшивый fetch пропускает вызовы
// экрана через настоящий реестр RPC, компилятор /api/db и SQLite в памяти после
// миграций. День — ближайший будний через два дня.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM ──────────────────────────────────────────────────────────
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
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
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
  querySelectorAll(sel) { const cls = String(sel).replace(/^\./, ''); return walk(this).filter((n) => String(n.className).split(/\s+/).includes(cls)); }
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
const mk = (t) => {
  const e = new F(t);
  if (e.tagName === 'TEMPLATE') {
    e.content = { firstChild: null };
    Object.defineProperty(e, 'innerHTML', { set() { const s = new F('svg'); e.content.firstChild = s; }, get() { return ''; } });
  }
  return e;
};
const TOASTS = [];
const TOAST_EL = { set textContent(v) { TOASTS.push(String(v)); }, get textContent() { return ''; }, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {} };
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
};
const LS = new Map();
globalThis.localStorage = {
  getItem: (k) => (k === 'admin.lang' ? 'ru' : (LS.has(k) ? LS.get(k) : null)),
  setItem: (k, v) => { LS.set(k, String(v)); }, removeItem: (k) => { LS.delete(k); }, clear: () => LS.clear(),
};
globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, open: () => null, confirm: () => true,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  easymed: { state: { user: { id: 1, full_name: 'Админ', role: 'admin' } } },
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

function walk(e, o = []) { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; }
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');
const byData = (root, attr) => walk(root).filter((n) => n.attrs && n.attrs[attr] != null);
const byClass = (root, cls) => walk(root).filter((n) => String(n.className).split(/\s+/).includes(cls));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── настоящая база + настоящий реестр RPC + настоящий /api/db ──────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');

const USER = { id: 1, role: 'admin', extra_roles: [] };
let DB = null;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
  if (u.startsWith('/api/rpc/')) {
    const handler = getRpc(decodeURIComponent(u.slice('/api/rpc/'.length)));
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'no rpc' } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    try {
      if (compiled.meta.op !== 'select') { DB.prepare(compiled.sql).run(...compiled.params); return ok(null); }
      // Вложенные выборки («services(name)») сервер отдаёт объектами (respondRows) — так же здесь.
      const rows = DB.prepare(compiled.sql).all(...compiled.params).map((r) => {
        const o = {};
        for (const [k, v] of Object.entries(r)) {
          const dot = k.indexOf('.');
          if (dot < 0) { o[k] = v; continue; }
          const rel = k.slice(0, dot);
          o[rel] = o[rel] && typeof o[rel] === 'object' ? o[rel] : {};
          o[rel][k.slice(dot + 1)] = v;
        }
        return o;
      });
      if (compiled.meta.single === 'single') return ok(rows[0]);
      if (compiled.meta.single === 'maybe') return ok(rows[0] ?? null);
      return ok(rows);
    } catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'db', message: e.message } }) }; }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const { setFullAccess } = await import('../permissions.js');
const SPM = await import('../views/service-picker-modal.js?v=ownrep4');
const { renderBookingDay } = await import('../views/booking-day.js');
const { renderRoomCalendar } = await import('../views/room-calendar.js');

// ─── посев ──────────────────────────────────────────────────────────────────
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function nextWeekday(offset = 2) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}
const at = (day, hh, mm = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0).toISOString();
const DOC_A = 7, DOC_B = 8, DOC_C = 9;
const P = 3, R = 5;

async function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const wh = {};
  for (const k of WD) wh[k] = { enabled: true, from: '08:00', to: '19:00' };
  const W = JSON.stringify(wh);
  const add = db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours, service_rates)
                          VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?)`);
  add.run(1, 'adm', 'Админ', 'admin', 0, '', '', '[]');
  add.run(DOC_A, 'doca', 'Алиева Нигора', 'doctor', 1, 'Терапевт', W, JSON.stringify([{ service_id: 21, pct: 20 }]));
  add.run(DOC_B, 'docb', 'Каримов Бахтиёр', 'doctor', 1, 'Кардиолог', W, JSON.stringify([{ service_id: 22, pct: 20 }]));
  add.run(DOC_C, 'docc', 'Рахимов Олим', 'doctor', 1, 'Невролог', W, JSON.stringify([{ service_id: 21, pct: 20 }]));
  db.prepare("INSERT INTO patients (id, full_name, last_name, first_name) VALUES (?, 'Иванов Иван', 'Иванов', 'Иван')").run(P);
  db.prepare("INSERT INTO patients (id, full_name, last_name, first_name) VALUES (?, 'Третий Пациент', 'Третий', 'Пациент')").run(R);
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (21, 'Консультация терапевта', 100000, 30)").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (22, 'Консультация кардиолога', 150000, 30)").run();
  if (DB) DB.close();
  DB = db;
  SPM.forgetSlots();
  TOASTS.length = 0;
  LS.clear();
  document.body.children.length = 0;
  setFullAccess('Admin');
  const day = nextWeekday();
  // Пациент P: врач А 09:00 (визит и строка одним вызовом), затем «Добавить в этот визит» — строка врача Б на 15:00.
  const book = getRpc('calendar_book');
  const nine = await book(db, { patient_id: P, doctor_id: DOC_A, service_id: 21, line: { service_id: 21 }, start: at(day, 9), status: 'scheduled' }, USER);
  await getRpc('booking_lines_add')(db, { visit_id: nine.visit.id, patient_id: P, lines: [{ service_id: 22, doctor_id: DOC_B, scheduled_at: at(day, 15) }] }, USER);
  // Обычная запись врача Б на 11:00 — для сравнения (у неё корзина есть).
  await book(db, { patient_id: R, doctor_id: DOC_B, service_id: 22, start: at(day, 11), status: 'scheduled' }, USER);
  return { day, dayIso: isoOf(day), visitId: nine.visit.id };
}

// ═══════════════════════════════════════════════════════════════════════════
test('SLOT_BUSY_LINES_V1: «Бронирование» врача Б — 15:00 занято строкой визита пациента, не «Свободно»; корзины у неё нет', async () => {
  const { dayIso } = await seed();
  const host = mk('div');
  const api = await renderBookingDay(host, { onNavigate() {} }, { today: dayIso });
  api.pickDoctor(api.state.doctors.find((d) => d.id === DOC_B));
  await wait(200);
  const free = byData(host, 'data-bkd-free').map((n) => n.attrs['data-bkd-free']);
  assert.ok(!free.includes('15:00'), '15:00 врача Б — «Свободно», хотя её держит строка визита: ' + free.join(' '));
  assert.ok(free.includes('14:30') && free.includes('15:30'), 'стыки 14:30 и 15:30 пропали: ' + free.join(' '));
  const row = byData(host, 'data-bkd-busy').find((n) => n.attrs['data-bkd-busy'] === '15:00');
  assert.ok(row, 'строки «записан» на 15:00 нет');
  assert.ok(textOf(row).includes('Иванов Иван'), 'строка 15:00 не называет пациента: ' + textOf(row));
  // Услуга строки — её, а не все услуги визита у врача А.
  assert.ok(textOf(row).includes('Консультация кардиолога') && !textOf(row).includes('Консультация терапевта'),
    'строка 15:00 называет не свою услугу: ' + textOf(row));
  assert.equal(byData(row, 'data-bkd-cancel').length, 0, 'у строки визита к другому врачу есть «Отменить запись» — она отменила бы весь визит');
  const eleven = byData(host, 'data-bkd-busy').find((n) => n.attrs['data-bkd-busy'] === '11:00');
  assert.ok(eleven && byData(eleven, 'data-bkd-cancel').length === 1, 'у обычной записи 11:00 пропала корзина');
});

test('SLOT_BUSY_LINES_V1: «Добавить в этот визит» в «Бронировании» — время врача Б заняли между проверкой и строкой: сервер отказывает, строки нет, сказано «занято»', async () => {
  const { day, dayIso } = await seed();
  const S = 6, T = 7;
  DB.prepare("INSERT INTO patients (id, full_name, last_name, first_name) VALUES (?, 'Сидорова Мария', 'Сидорова', 'Мария')").run(S);
  DB.prepare("INSERT INTO patients (id, full_name, last_name, first_name) VALUES (?, 'Пятый Пациент', 'Пятый', 'Пациент')").run(T);
  const book = getRpc('calendar_book');
  const sVisit = (await book(DB, { patient_id: S, doctor_id: DOC_C, service_id: 21, line: { service_id: 21 }, start: at(day, 10), status: 'scheduled' }, USER)).visit;
  const { bookVisit } = await import('../views/visit-booking.js');
  // Гонка: другой регистратор записал к врачу Б на 16:00, пока «Бронирование» брало визит дня.
  const racing = async (args) => {
    if (args && args.add_to_day_visit) await book(DB, { patient_id: T, doctor_id: DOC_B, service_id: 22, start: at(day, 16), status: 'scheduled' }, USER);
    return bookVisit(args);
  };
  const host = mk('div');
  const api = await renderBookingDay(host, { onNavigate() {} }, { today: dayIso, bookVisit: racing, askAddToDayVisit: async () => true });
  api.pickDoctor(api.state.doctors.find((d) => d.id === DOC_B));
  await wait(200);
  const row = byData(host, 'data-bkd-book').find((n) => n.attrs['data-bkd-book'] === '16:00');
  assert.ok(row, 'нет свободной строки 16:00');
  row.click();
  await wait(20);
  const search = byData(host, 'data-bkd-book-search')[0];
  search.value = 'Сидор';
  search.dispatchEvent({ type: 'input' });
  await wait(450);
  const hit = walk(host).find((n) => n.tagName === 'BUTTON' && String(n.className).includes('mg-search-opt'));
  assert.ok(hit, 'пациент не найден в строке записи');
  TOASTS.length = 0;
  hit.click();
  await wait(400);
  const lines = DB.prepare('SELECT doctor_id, scheduled_at FROM visit_services WHERE visit_id = ? ORDER BY id').all(sVisit.id);
  assert.deepEqual(lines.map((l) => l.doctor_id), [DOC_C], 'строка врача Б легла на занятое время 16:00: ' + JSON.stringify(lines));
  assert.ok(TOASTS.some((x) => x === 'Это время занято: у врача Каримов Бахтиёр уже есть приём 16:00–16:30. Выберите другое время.'),
    'отказ не сказан шаблоном «занято»: ' + JSON.stringify(TOASTS));
});

test('SLOT_BUSY_LINES_V1: календарь «Записи» — в колонке врача Б блок строки 15:00–15:30 с пациентом; клетка 15:00 — «занято»', async () => {
  const { dayIso, visitId } = await seed();
  const box = mk('div');
  await renderRoomCalendar(box, { onNavigate: () => {}, embedded: false });
  const dateInp = walk(box).find((n) => String(n.className).includes('rcal-date'));
  dateInp.value = dayIso;
  dateInp.dispatchEvent({ type: 'change', target: dateInp });
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  await wait(50);
  const lanes = byClass(box, 'rcal-lane');
  const laneOf = (id) => lanes.find((l) => String(l.dataset.res) === String(id) && l.dataset.day === dayIso);
  const laneB = laneOf(DOC_B);
  assert.ok(laneB, 'колонки врача Б нет');
  const blocks = byClass(laneB, 'rcal-appt-line');
  assert.equal(blocks.length, 1, 'блока строки в колонке врача Б нет');
  const t = textOf(blocks[0]);
  assert.ok(t.includes('15:00–15:30') && t.includes('Иванов Иван') && t.includes('Консультация кардиолога'), 'блок не называет время, пациента и услугу: ' + t);
  assert.equal(blocks[0].attrs['data-line-busy'], String(visitId));
  assert.equal(byClass(laneOf(DOC_A), 'rcal-appt-line').length, 0, 'строка записи врача А нарисована второй раз');
  assert.equal(byClass(laneOf(DOC_C), 'rcal-appt-line').length, 0, 'строка врача Б в колонке врача В');
  // Обычных карточек столько же, сколько записей: блок строки — не запись.
  assert.equal(byClass(box, 'rcal-appt').filter((n) => !String(n.className).includes('rcal-appt-line')).length, 2);
  // Клетка 15:00 врача Б — «занято», мастер записи не открывается.
  TOASTS.length = 0;
  const cell = walk(laneB).find((n) => n.attrs && n.attrs['data-min'] === String(15 * 60));
  assert.ok(cell, 'клетки 15:00 нет');
  cell.click();
  await wait(20);
  assert.ok(TOASTS.some((x) => /занято/.test(x) && x.includes('15:00–15:30')), 'щелчок по занятой строкой клетке не сказал «занято»: ' + JSON.stringify(TOASTS));
});
