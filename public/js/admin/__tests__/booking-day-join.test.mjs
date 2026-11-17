// BOOKING_DAY_JOIN_V1 (3.25.0) — «БРОНИРОВАНИЕ»: ВТОРОЙ ВРАЧ В ТОТ ЖЕ ДЕНЬ — В ТОТ ЖЕ ВИЗИТ.
//
// Пациент записан на 09:00 к врачу А. Регистратор в «Бронировании» записывает его
// к врачу Б на 15:00 того же дня. Сервер держит правило «один пациент — один день —
// один визит», а запись «Бронирования» (calendar_book со строкой — атомарная) на
// такой день получала отказ revisit_day_taken: записать нельзя было вовсе. Календарь
// «Записи» в том же случае предлагает «Добавить в этот визит» — теперь и
// «Бронирование»: тот же вопрос, та же дверь (calendar_book add_to_day_visit —
// визит дня как есть, booking_lines_add — строка услуги врача Б на 15:00, без счёта:
// счёт — когда пациент придёт).
//
// Здесь же — список врачей «Бронирования»: только те, кого сервер примет врачом
// строки записи (calendar_book с line: is_doctor = 1 или роль «Врач»). Сотрудник
// с одной лишь специальностью в списке был, а «Записать» к нему отказывало.
//
// Стенд НАСТОЯЩИЙ, как в booking-doors.test.mjs: фальшивый fetch пропускает вызовы
// экрана через настоящий реестр RPC, настоящий компилятор /api/db и настоящую
// SQLite в памяти после миграций. День записи — ближайший будний через два дня:
// время суток прогона роли не играет («сегодня» может не иметь свободного времени).
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
  querySelectorAll() { return []; }
  get textContent() { return this._t; }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() {
    const s = this;
    return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} };
  }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => {
  const e = new F(t);
  if (e.tagName === 'TEMPLATE') {
    e.content = { firstChild: null };
    Object.defineProperty(e, 'innerHTML', { set(v) { const s = new F('svg'); s._t = ''; e.content.firstChild = s; }, get() { return ''; } });
  }
  return e;
};
// Тост пишется в #toast (ui.js toast): читаем, что сказано человеку.
const TOASTS = [];
const TOAST_EL = { set textContent(v) { TOASTS.push(String(v)); }, get textContent() { return ''; }, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {} };
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, open: () => null, confirm: () => true,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  easymed: { state: { user: { id: 1, full_name: 'Регистратор', role: 'registrar' } } },
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, o = []) => { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; };
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');
const byData = (root, attr) => walk(root).filter((n) => n.attrs && n.attrs[attr] != null);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── настоящая база + настоящий реестр RPC + настоящий /api/db ──────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');

const USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
let RPCS = [];   // какие RPC и с чем звал экран

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    RPCS.push([name, body]);
    const handler = getRpc(name);
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'no rpc ' + name } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: e.status || 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    try {
      if (compiled.meta.op !== 'select') { DB.prepare(compiled.sql).run(...compiled.params); return ok(null); }
      const rows = DB.prepare(compiled.sql).all(...compiled.params);
      if (compiled.meta.single === 'single') return ok(rows[0]);
      if (compiled.meta.single === 'maybe') return ok(rows[0] ?? null);
      return ok(rows);
    } catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'db', message: e.message } }) }; }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const { setFullAccess } = await import('../permissions.js');
const SPM = await import('../views/service-picker-modal.js?v=ownrep4');
const { bookVisit } = await import('../views/visit-booking.js');
const { renderBookingDay, isDoctorLike } = await import('../views/booking-day.js');

// ─── посев ──────────────────────────────────────────────────────────────────
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function nextWeekday(offset = 2) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}
const at = (day, hh, mm = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0).toISOString();

const DOC_A = 7;   // врач (роль «Врач»), к нему пациент записан на 09:00
const DOC_B = 8;   // администратор-врач (is_doctor = 1): к нему пишем на 15:00
const NURSE = 9;   // медсестра со специальностью — не врач строки записи
const ROLE_DOC = 10;   // роль «Врач» без флага и без специальности — сервер его принимает
const PATIENT = 3;

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const wh = {};
  for (const k of WD) wh[k] = { enabled: true, from: '08:00', to: '19:00' };
  const W = JSON.stringify(wh);
  const add = db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours, service_rates)
                          VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?)`);
  add.run(1, 'reg', 'Регистратор', 'registrar', 0, '', '', '[]');
  add.run(DOC_A, 'doca', 'Алиева Нигора', 'doctor', 1, 'Терапевт', W, JSON.stringify([{ service_id: 21, pct: 20 }]));
  add.run(DOC_B, 'docb', 'Каримов Бахтиёр', 'admin', 1, 'Кардиолог', W, JSON.stringify([{ service_id: 22, pct: 20 }]));
  add.run(NURSE, 'nurse', 'Медсестра Зухра', 'nurse', 0, 'Процедурная медсестра', W, JSON.stringify([{ service_id: 22, pct: 10 }]));
  add.run(ROLE_DOC, 'docc', 'Рахимов Олим', 'doctor', 0, '', W, JSON.stringify([{ service_id: 21, pct: 20 }]));
  db.prepare("INSERT INTO patients (id, full_name, last_name, first_name) VALUES (?, 'Иванов Иван', 'Иванов', 'Иван')").run(PATIENT);
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (21, 'Консультация терапевта', 100000, 30)").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (22, 'Консультация кардиолога', 150000, 30)").run();
  if (DB) DB.close();
  DB = db;
  SPM.forgetSlots();
  RPCS = []; TOASTS.length = 0;
  document.body.children.length = 0;
  setFullAccess('Admin');
  const day = nextWeekday();
  return { day, dayIso: isoOf(day) };
}

// Визит дня ищется по МЕСТНОМУ дню SQLite (localtime), день записи — часами JS. В
// клинике пояс у них один; предзагрузка tz-late двигает только пояс JS — тогда
// визит дня не находится вовсе (calendar.test.js TZ_SPLIT). Такой прогон пропускает тест.
const TZ_SPLIT = (() => {
  const db = openDb(':memory:');
  const iso = '2030-01-07T00:30:00Z';
  const sql = db.prepare("SELECT strftime('%Y-%m-%d %H:%M', ?, 'localtime') AS v").get(iso).v;
  db.close();
  const d = new Date(iso);
  const js = `${isoOf(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sql === js ? false : 'пояс JS не совпадает с поясом SQLite (предзагрузка tz-late) — визит дня по местному дню не найти';
})();

/** Записать пациента к врачу «Бронированием»: врач, свободная строка, поиск пациента, выбор. */
async function bookViaScreen(host, api, { doctorId, time, query = 'Иван' }) {
  api.pickDoctor(api.state.doctors.find((d) => d.id === doctorId));
  await wait(150);
  const row = byData(host, 'data-bkd-book').find((n) => n.attrs['data-bkd-book'] === time);
  assert.ok(row, 'нет свободной строки ' + time + ': ' + byData(host, 'data-bkd-free').map((n) => n.attrs['data-bkd-free']).join(' '));
  row.click();
  await wait(20);
  const search = byData(host, 'data-bkd-book-search')[0];
  assert.ok(search, 'у свободной строки не открылся поиск пациента');
  search.value = query;
  search.dispatchEvent({ type: 'input' });
  await wait(450);
  const hit = walk(host).find((n) => n.tagName === 'BUTTON' && String(n.className).includes('mg-search-opt'));
  assert.ok(hit, 'пациент не найден в строке записи');
  hit.click();
  await wait(200);
}
const dialog = () => walk(document.body).find((n) => String(n.className).split(/\s+/).includes('modal-card'));
const dialogButton = (re) => walk(document.body).find((n) => n.tagName === 'BUTTON' && re.test(textOf(n)));
const liveVisits = () => DB.prepare("SELECT * FROM visits WHERE patient_id = ? AND status NOT IN ('cancelled','no_show') ORDER BY id").all(PATIENT);
const linesOf = (vid) => DB.prepare('SELECT * FROM visit_services WHERE visit_id = ? ORDER BY id').all(vid);
const invoices = () => DB.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;

/** Пациент записан на 09:00 к врачу А — так, как пишет «Бронирование» (визит и строка одним вызовом). */
async function bookedAtNine(day) {
  const first = await bookVisit({ patient_id: PATIENT, doctor_id: DOC_A, service_id: 21, line: { service_id: 21 },
    start: at(day, 9), duration_minutes: 30, status: 'scheduled' });
  assert.ok(first && first.visit && first.created, 'стенд: запись на 09:00 не создана');
  return first.visit;
}

// ═══════════════════════════════════════════════════════════════════════════
test('BOOKING_DAY_JOIN_V1: 09:00 у врача А, «Бронирование» к врачу Б на 15:00 — «Добавить в этот визит»: та же запись, строка врача Б на 15:00, без счёта', { skip: TZ_SPLIT }, async () => {
  const { day, dayIso } = seed();
  const nine = await bookedAtNine(day);
  const host = mk('div');
  const api = await renderBookingDay(host, { onNavigate() {} }, { today: dayIso });
  RPCS = [];
  await bookViaScreen(host, api, { doctorId: DOC_B, time: '15:00' });

  // Вопрос календаря: визит дня уже есть — добавить в него или отменить.
  const card = dialog();
  assert.ok(card, 'вопрос «Добавить в этот визит» не задан; тосты: ' + JSON.stringify(TOASTS));
  const q = textOf(card);
  assert.ok(q.includes('09:00') && q.includes('Алиева Нигора'), 'вопрос не называет визит дня (время и врача): ' + q);
  assert.ok(q.includes('15:00') && q.includes('Каримов Бахтиёр'), 'вопрос не называет новую запись (время и врача): ' + q);
  assert.ok(dialogButton(/Отмена/), 'нет «Отмена»');
  dialogButton(/Добавить в этот визит/).click();
  await wait(300);

  // Второго визита нет — та же запись, её время и врач не тронуты.
  const visits = liveVisits();
  assert.equal(visits.length, 1, 'заведён второй визит на день');
  assert.equal(visits[0].id, nine.id);
  assert.equal(Date.parse(visits[0].visit_date), Date.parse(at(day, 9)), 'запись на 09:00 сдвинута');
  assert.equal(visits[0].doctor_id, DOC_A, 'у записи сменился врач');
  // Строка врача Б на 15:00 — в этом визите, «в смете», без счёта.
  const lines = linesOf(nine.id);
  assert.equal(lines.length, 2, 'строк визита: ' + JSON.stringify(lines));
  const added = lines.find((l) => l.service_id === 22);
  assert.ok(added, 'строки услуги врача Б в визите нет');
  assert.equal(added.doctor_id, DOC_B, 'строка не у врача Б');
  assert.equal(Date.parse(added.scheduled_at), Date.parse(at(day, 15)), 'строка не на 15:00');
  assert.equal(added.status, 'added', 'строка не «в смете»');
  assert.equal(added.invoice_item_id, null, 'строка уже в счёте');
  assert.equal(Number(added.unit_price), 150000, 'цену строки поставил не сервер');
  assert.equal(invoices(), 0, 'счёт выставлен при записи — он выставляется, когда пациент придёт');
  // Та же дверь, что у календаря: calendar_book (визит дня как есть) и booking_lines_add.
  const names = RPCS.map(([n]) => n);
  const join = RPCS.find(([n, b]) => n === 'calendar_book' && b.add_to_day_visit === true);
  assert.ok(join, 'визит дня взят не дверью календаря (calendar_book add_to_day_visit): ' + names.join(','));
  assert.equal(join[1].line, undefined, 'присоединение несёт строку атомарной записи');
  const lineCall = RPCS.find(([n]) => n === 'booking_lines_add');
  assert.ok(lineCall, 'строка не через booking_lines_add: ' + names.join(','));
  assert.deepEqual(lineCall[1].lines, [{ service_id: 22, doctor_id: DOC_B, scheduled_at: at(day, 15) }]);
  assert.ok(TOASTS.some((t) => t.includes('15:00') && t.includes('Иванов Иван')), 'не сказано, что добавлено: ' + JSON.stringify(TOASTS));
});

test('BOOKING_DAY_JOIN_V1: «Отмена» — ничего не добавлено и второго визита нет', { skip: TZ_SPLIT }, async () => {
  const { day, dayIso } = seed();
  const nine = await bookedAtNine(day);
  const host = mk('div');
  const api = await renderBookingDay(host, { onNavigate() {} }, { today: dayIso });
  await bookViaScreen(host, api, { doctorId: DOC_B, time: '15:00' });
  assert.ok(dialog(), 'вопрос не задан');
  dialogButton(/Отмена/).click();
  await wait(200);
  assert.equal(liveVisits().length, 1);
  assert.equal(linesOf(nine.id).length, 1, 'после «Отмены» строка всё же добавлена');
  assert.ok(!RPCS.some(([n]) => n === 'booking_lines_add'), 'после «Отмены» звали booking_lines_add');
});

test('BOOKING_DAY_JOIN_V1: пока решали, 15:00 у врача Б заняли — строка не добавляется, сказано почему', { skip: TZ_SPLIT }, async () => {
  const { day, dayIso } = seed();
  const nine = await bookedAtNine(day);
  DB.prepare("INSERT INTO patients (id, full_name) VALUES (4, 'Сидорова Мария')").run();
  const host = mk('div');
  const api = await renderBookingDay(host, { onNavigate() {} }, { today: dayIso });
  await bookViaScreen(host, api, { doctorId: DOC_B, time: '15:00' });
  assert.ok(dialog(), 'вопрос не задан');
  // Другой регистратор в это время записал к врачу Б на 15:00 другого пациента.
  await bookVisit({ patient_id: 4, doctor_id: DOC_B, service_id: 22, line: { service_id: 22 }, start: at(day, 15), duration_minutes: 30, status: 'scheduled' });
  TOASTS.length = 0;
  dialogButton(/Добавить в этот визит/).click();
  await wait(300);
  assert.equal(linesOf(nine.id).length, 1, 'строка легла на занятое время врача Б');
  assert.equal(liveVisits().length, 1);
  assert.ok(TOASTS.some((t) => /занято/.test(t)), 'не сказано, что время заняли: ' + JSON.stringify(TOASTS));
});

test('BOOKING_DAY_JOIN_V1: визит дня уже в работе (пациент пришёл) — правило календаря: строка не добавляется, отказ словами сервера', { skip: TZ_SPLIT }, async () => {
  const { day, dayIso } = seed();
  const v = DB.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, duration_minutes, status) VALUES (?, ?, ?, 30, 'arrived')")
    .run(PATIENT, DOC_A, at(day, 9)).lastInsertRowid;
  const host = mk('div');
  const api = await renderBookingDay(host, { onNavigate() {} }, { today: dayIso });
  await bookViaScreen(host, api, { doctorId: DOC_B, time: '15:00' });
  assert.ok(dialog(), 'вопрос не задан');
  TOASTS.length = 0;
  dialogButton(/Добавить в этот визит/).click();
  await wait(300);
  assert.equal(liveVisits().length, 1, 'заведён второй визит');
  assert.equal(linesOf(v).length, 0, 'строка легла в визит пришедшего пациента мимо регистратуры');
  assert.equal(invoices(), 0);
  assert.ok(TOASTS.some((t) => t.includes('Пациент уже пришёл')), 'отказ сервера не показан: ' + JSON.stringify(TOASTS));
});

test('BOOKING_DAY_JOIN_V1: список врачей «Бронирования» — ровно те, кого сервер примет врачом строки записи', async () => {
  const { day, dayIso } = seed();
  const host = mk('div');
  const api = await renderBookingDay(host, { onNavigate() {} }, { today: dayIso });
  const listed = api.state.doctors.map((d) => d.id).sort((a, b) => a - b);
  // Правило сервера — спросим его самого: запись со строкой к каждому активному сотруднику.
  const accepted = [];
  let pid = 100;
  for (const u of DB.prepare("SELECT id FROM users WHERE id <> 1 ORDER BY id").all()) {
    DB.prepare("INSERT INTO patients (id, full_name) VALUES (?, 'Проба')").run(++pid);
    try {
      await bookVisit({ patient_id: pid, doctor_id: u.id, service_id: 21, line: { service_id: 21 }, start: at(day, 10), duration_minutes: 30, status: 'scheduled' });
      accepted.push(u.id);
    } catch (e) {
      assert.match(e.message, /не найден среди врачей/, 'стенд: отказ не о враче строки — ' + e.message);
    }
  }
  assert.deepEqual(accepted, [DOC_A, DOC_B, ROLE_DOC], 'стенд: сервер принял не тех');
  assert.deepEqual(listed, accepted, 'список «Бронирования» не совпал с правилом сервера (медсестра со специальностью в списке?)');
  // Правило — функцией, как и было: флаг из базы числом 1 или true, роль «Врач».
  assert.equal(isDoctorLike({ is_doctor: 1, role: 'admin' }), true);
  assert.equal(isDoctorLike({ is_doctor: true, role: 'admin' }), true);
  assert.equal(isDoctorLike({ is_doctor: 0, role: 'doctor' }), true);
  assert.equal(isDoctorLike({ is_doctor: 0, role: 'nurse', specialty: 'Процедурная медсестра' }), false);
});

test('BOOKING_DAY_JOIN_V1: день без другого визита — запись как прежде, одним вызовом со строкой, без вопроса', async () => {
  const { day, dayIso } = seed();
  const host = mk('div');
  const api = await renderBookingDay(host, { onNavigate() {} }, { today: dayIso });
  await bookViaScreen(host, api, { doctorId: DOC_B, time: '15:00' });
  assert.equal(dialog(), undefined, 'вопрос задан, хотя визита дня нет');
  const visits = liveVisits();
  assert.equal(visits.length, 1);
  assert.equal(visits[0].doctor_id, DOC_B);
  assert.equal(Date.parse(visits[0].visit_date), Date.parse(at(day, 15)));
  assert.equal(linesOf(visits[0].id).length, 1);
  assert.ok(!RPCS.some(([n]) => n === 'booking_lines_add'), 'обычная запись пошла второй дверью');
});
