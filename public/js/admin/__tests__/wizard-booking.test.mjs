// WIZARD_ONE_ENGINE_V1 — МАСТЕР ЗАПИСИ ИДЁТ ПО ТОМУ ЖЕ ПРАВИЛУ, ЧТО КАЛЕНДАРЬ.
//
// Что здесь чинится. Запрет «один пациент на врача на слот» жил в RPC
// calendar_book и работал ровно для одного экрана — календаря. Мастер записи
// (service-picker-modal.js) вставлял строку в visits напрямую через /api/db,
// то есть мимо проверки: два регистратора, один в календаре и один в мастере,
// занимали одно и то же время, и ни один об этом не узнавал.
//
// Второе: «когда врач свободен» мастера считали САМИ, каждый по-своему. Три
// расхождения были не теоретическими:
//   • форма графика — мастер визита читал только {on,…}, а карточка сотрудника
//     пишет {enabled,…}: у такого врача мастер графика НЕ ВИДЕЛ и предлагал
//     09:00–18:00 всем подряд;
//   • обед — его вводят в карточке, и не вычитал никто;
//   • окно по умолчанию — 09:00–18:00 у мастера против 08:00–20:00 у календаря.
//
// Поэтому стенд здесь НЕ ЗАГЛУШКА: фальшивый fetch пропускает вызовы экрана
// через настоящий реестр RPC и настоящую SQLite в памяти, прошедшую миграции.
// Заглушённые ответы дали бы зелёный тест и на старом коде — он ломался именно
// на границе «экран — сервер», и подменять эту границу нельзя.
//
// Проверяется:
//   • запись мастера на занятое время ОТКЛОНЯЕТСЯ сообщением СЕРВЕРА, и не
//     создаётся НИЧЕГО;
//   • соседний слот записывается;
//   • экстренная запись ТРЕБУЕТ ПРИЧИНУ и СОХРАНЯЕТ ЕЁ в самой записи;
//   • врач, заведённый карточкой сотрудника ({enabled,…}), получает СВОИ часы;
//   • обед из карточки вычитается;
//   • мастер и календарь предлагают ОДИН И ТОТ ЖЕ список свободного — ради
//     этого равенства задача и делалась;
//   • ни один из двух файлов мастеров не завёл собственный расчёт слотов
//     заново (разбор графика, зашитые 09:00/18:00, перебор дня шагом).

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
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

function walk(e, o = []) { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; }
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');

// ─── настоящая база + настоящий реестр RPC за фальшивым fetch ───────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { calendarSlots, calendarWindows } = await import('../../../../server/services/rpc/calendar.js');

const USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    const handler = getRpc(name);
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'no rpc ' + name } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    const rows = DB.prepare(compiled.sql).all(...compiled.params);
    if (compiled.meta.single === 'single') return ok(rows[0]);
    if (compiled.meta.single === 'maybe') return ok(rows[0] ?? null);
    return ok(rows);
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

// Клиент слотов и записи — ТОТ ЖЕ модуль, который зовут оба мастера.
const SPM = await import('../views/service-picker-modal.js');
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

// ═══════════════════════════════════════════════════════════════════════════
// ЗАПИСЬ: мастер идёт через calendar_book
// ═══════════════════════════════════════════════════════════════════════════

test('ЗАНЯТОЕ ВРЕМЯ: запись мастера отклонена сообщением СЕРВЕРА, и не создано НИЧЕГО', async () => {
  const { day } = seed();
  // Календарь уже записал сюда пациента — то самое «второй регистратор».
  DB.prepare("INSERT INTO visits (id, patient_id, doctor_id, service_id, visit_date, duration_minutes, status) VALUES (55,3,7,21,?,30,'scheduled')")
    .run(at(day, 11, 0));
  const before = countVisits();

  let shown = null;
  const out = await calendarBookOrAsk(
    { patient_id: 4, doctor_id: 7, service_id: 21, start: at(day, 11, 0), status: 'scheduled' },
    { askReason: async (text) => { shown = text; return null; } },   // «передумали»
  );

  assert.equal(out, null, 'мастер обязан вернуть «не записали», а не молча создать вторую запись');
  assert.equal(countVisits(), before, 'отказ обязан не оставлять после себя ни одной строки visits');

  // Отказ НАЗЫВАЕТ ВРАЧА И ЗАНЯТОЕ ВРЕМЯ — регистратура стоит перед человеком,
  // и «занято» без времени заставляет её тыкать в сетку наугад.
  assert.ok(shown, 'регистратору не показали ничего — прежний мастер молчал точно так же');
  assert.match(shown, /Петров Пётр/, 'в отказе нет врача: ' + shown);
  assert.match(shown, /11:00–11:30/, 'в отказе нет занятого времени: ' + shown);
});

test('СОСЕДНИЙ СЛОТ записывается — стык не считается пересечением', async () => {
  const { day } = seed();
  DB.prepare("INSERT INTO visits (id, patient_id, doctor_id, service_id, visit_date, duration_minutes, status) VALUES (55,3,7,21,?,30,'scheduled')")
    .run(at(day, 11, 0));

  const out = await calendarBookOrAsk(
    { patient_id: 4, doctor_id: 7, service_id: 21, start: at(day, 11, 30), status: 'scheduled' },
    { askReason: async () => { throw new Error('свободное время не должно спрашивать причину'); } },
  );

  assert.ok(out && out.created, 'запись на 11:30 обязана пройти');
  assert.equal(out.visit.patient_id, 4);
  assert.equal(out.visit.duration_minutes, 30, 'длительность обязана прийти из услуги');
  assert.equal(countVisits(), 2);
});

test('ЭКСТРЕННАЯ ЗАПИСЬ: причина обязательна и УХОДИТ В САМУ ЗАПИСЬ', async () => {
  const { day } = seed();
  DB.prepare("INSERT INTO visits (id, patient_id, doctor_id, service_id, visit_date, duration_minutes, status) VALUES (55,3,7,21,?,30,'scheduled')")
    .run(at(day, 11, 0));

  const out = await calendarBookOrAsk(
    { patient_id: 4, doctor_id: 7, service_id: 21, start: at(day, 11, 0), status: 'scheduled' },
    { askReason: async () => 'острая боль, направлен из приёмного' },
  );

  assert.ok(out && out.created, 'с причиной запись поверх занятого обязана пройти');
  assert.equal(out.emergency, true, 'запись обязана быть помечена экстренной');
  const row = DB.prepare('SELECT notes FROM visits WHERE id = ?').get(out.visit.id);
  assert.match(row.notes, /острая боль, направлен из приёмного/, 'причина не осталась в записи: ' + row.notes);
  assert.match(row.notes, /11:00–11:30/, 'в записи не названо время, поверх которого записали: ' + row.notes);

  // Галочка без причины — это отсутствие проверки. Сервер её и не принимает.
  const { supabase } = await import('../../supabase.js');
  const bad = await supabase.rpc('calendar_book',
    { patient_id: 3, doctor_id: 7, service_id: 21, start: at(day, 11, 0), emergency: true, emergency_reason: 'x' });
  assert.equal(bad.error && bad.error.code, 'emergency_reason_required');
});

test('диалог экстренной записи НЕ ОТПУСКАЕТ без причины', async () => {
  seed();
  const p = askEmergencyReason('Это время занято: у врача Петров Пётр уже есть приём 11:00–11:30.');
  const overlay = document.body.children[document.body.children.length - 1];
  const btn = walk(overlay).find((n) => n.tagName === 'BUTTON' && /Записать экстренно/.test(textOf(n)));
  const area = walk(overlay).find((n) => n.tagName === 'TEXTAREA');
  assert.ok(btn && area, 'в диалоге нет поля причины или кнопки');

  let settled = false;
  p.then(() => { settled = true; });
  btn.click();                                  // пусто — не должно сработать
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(settled, false, 'пустая причина не должна записывать');

  area.value = 'острая боль';
  btn.click();
  assert.equal(await p, 'острая боль');
});

test('ВРЕМЯ БЕЗ ВЫБОРА ЧЕЛОВЕКА сдвигается на конец занятого, а не отказывает', async () => {
  // Пациент без слота приходит «сейчас»: прежний мастер ставил запасное время и
  // толкал её вперёд сам. Сдвиг остался, но конец занятого приёма называет
  // сервер в самом отказе — браузер его больше не угадывает.
  const { day } = seed();
  DB.prepare("INSERT INTO visits (id, patient_id, doctor_id, service_id, visit_date, duration_minutes, status) VALUES (55,3,7,21,?,30,'scheduled')")
    .run(at(day, 10, 0));

  const out = await calendarBookOrAsk(
    { patient_id: 4, doctor_id: 7, service_id: 21, start: at(day, 10, 0), status: 'scheduled' },
    { autoTime: true, askReason: async () => { throw new Error('автоматическое время не должно спрашивать причину'); } },
  );
  assert.ok(out && out.created);
  assert.equal(new Date(out.visit.visit_date).getHours(), 10);
  assert.equal(new Date(out.visit.visit_date).getMinutes(), 30, 'запись обязана встать на 10:30 — конец занятого');
});

test('МАСТЕР ВИЗИТА: визит-контейнер дня получает слот через calendar_book — и отказ тот же', async () => {
  // Мастер визита (visit-wizard.js) заводит визит дня через ensure_visit —
  // так устроена модель «визит = один календарный день» (миграция 099), — а
  // время, длительность и услугу этому визиту ставит calendar_book. Значит и
  // запрет двойной записи у него ровно тот же.
  const { day } = seed();
  const { supabase } = await import('../../supabase.js');
  const start = at(day, 12, 0);

  DB.prepare("INSERT INTO visits (id, patient_id, doctor_id, service_id, visit_date, duration_minutes, status) VALUES (55,3,7,21,?,30,'scheduled')")
    .run(start);

  const ev = await supabase.rpc('ensure_visit', { patient_id: 4, date: start, doctor_id: 7 });
  assert.ok(ev.data && ev.data.created, 'визит дня обязан создаться');

  const clash = await supabase.rpc('calendar_book',
    { visit_id: ev.data.visit.id, doctor_id: 7, service_id: 21, start, duration_minutes: 30 });
  assert.equal(clash.error && clash.error.code, 'slot_taken', 'мастер визита обязан получить тот же отказ');
  assert.equal(clash.error.params.doctor, 'Петров Пётр');
  assert.equal(clash.error.params.from, '12:00');

  // С причиной — проходит, причина уходит в саму запись, длительность из услуги.
  const emg = await supabase.rpc('calendar_book',
    { visit_id: ev.data.visit.id, doctor_id: 7, service_id: 21, start, duration_minutes: 30,
      emergency: true, emergency_reason: 'скорая привезла' });
  assert.ok(!emg.error, JSON.stringify(emg.error));
  assert.equal(emg.data.visit.duration_minutes, 30, 'визит мастера обязан получить длительность услуги');
  assert.match(emg.data.visit.notes, /скорая привезла/);
});

// ═══════════════════════════════════════════════════════════════════════════
// СЛОТЫ: одна реализация на весь продукт
// ═══════════════════════════════════════════════════════════════════════════

test('ГРАФИК ИЗ КАРТОЧКИ СОТРУДНИКА ({enabled,…}) — врач получает СВОИ часы, а не 09:00–18:00', async () => {
  const { dayIso } = seed({ shape: 'card', from: '10:00', to: '16:00' });
  const day = await loadSlotDay(7, dayIso, 30);
  assert.ok(day, 'сервер не ответил про слоты');
  assert.equal(day.window.from, '10:00', 'окно обязано быть из карточки сотрудника, а не по умолчанию');
  assert.equal(day.window.to, '16:00');

  const free = freeStartMinutes(day);
  assert.equal(free[0], 10 * 60, 'первый слот обязан быть в 10:00 — прежний мастер предлагал 09:00');
  assert.equal(free[free.length - 1], 15 * 60 + 30, 'последний слот обязан кончаться в 16:00');
  assert.ok(!free.includes(9 * 60), 'девять утра врачу не назначено — это было окно по умолчанию');
  assert.ok(!free.includes(17 * 60), 'семнадцать часов врачу не назначено');
});

test('ГРАФИК ИЗ «СОТРУДНИКОВ» ({on,…}) понимается тем же движком', async () => {
  const { dayIso } = seed({ shape: 'list', from: '11:00', to: '15:00' });
  const day = await loadSlotDay(7, dayIso, 30);
  assert.equal(day.window.from, '11:00');
  assert.equal(day.window.to, '15:00');
});

test('ОБЕД из карточки ВЫЧИТАЕТСЯ — его не вычитал никто', async () => {
  const { dayIso } = seed({ shape: 'card', from: '10:00', to: '16:00', lunch: true });
  const day = await loadSlotDay(7, dayIso, 30);
  const free = freeStartMinutes(day);

  assert.deepEqual((day.window.breaks || []).map((b) => b.from + '–' + b.to), ['12:00–13:00'],
    'окно обязано нести обеденный перерыв');
  assert.ok(!free.includes(12 * 60), 'обед предлагается как свободное: ' + free.map((m) => m).join(','));
  assert.ok(!free.includes(12 * 60 + 30), 'обед предлагается как свободное');
  assert.ok(free.includes(11 * 60 + 30), 'до обеда слоты обязаны остаться');
  assert.ok(free.includes(13 * 60), 'после обеда слоты обязаны появиться снова');
});

test('МАСТЕР И КАЛЕНДАРЬ ПРЕДЛАГАЮТ ОДИН И ТОТ ЖЕ СПИСОК — ради этого равенства задача и делалась', async () => {
  const { day, dayIso } = seed({ shape: 'card', from: '10:00', to: '16:00', lunch: true });
  DB.prepare("INSERT INTO visits (id, patient_id, doctor_id, service_id, visit_date, duration_minutes, status) VALUES (55,3,7,21,?,30,'scheduled')")
    .run(at(day, 14, 0));

  // Мастер: клиент слотов, который зовут ОБА мастера (этот модуль).
  const wizard = freeStartMinutes(await loadSlotDay(7, dayIso, 30)).map((m) => m);

  // Календарь: тот же обработчик, теми же аргументами, вызванный напрямую —
  // ровно так его зовёт room-calendar.js.
  const calendar = calendarSlots(DB, { doctor_id: 7, date: dayIso, service_id: 21, step_minutes: 30 }, USER)
    .slots.map((s) => hhmmToMin(s.start));

  assert.ok(wizard.length > 0, 'список свободного пуст — сравнивать нечего');
  assert.deepEqual(wizard, calendar, 'мастер и календарь предлагают РАЗНОЕ свободное время');
  assert.ok(!wizard.includes(14 * 60), 'занятое календарём время попало в предложения мастера');

  // И рабочее окно, которым календарь затеняет сетку (calendar_windows),
  // совпадает с тем, из которого мастер набирает слоты.
  const win = calendarWindows(DB, { doctor_ids: [7], date: dayIso, days: 1 }, USER).windows['doctor:7'][dayIso];
  const wizWin = (await loadSlotDay(7, dayIso, 30)).window;
  assert.deepEqual(win, wizWin, 'затенение календаря и окно мастера разошлись');
});

// ═══════════════════════════════════════════════════════════════════════════
// ГВОЗДЬ: вторая реализация не должна вернуться
// ═══════════════════════════════════════════════════════════════════════════

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.join(HERE, '..', 'views');
const WIZARD_FILES = ['service-picker-modal.js', 'visit-wizard.js'];

/** Убрать комментарии и не тронуть длину строк: разбор здесь про КОД. */
function stripComments(src) {
  let out = '', i = 0, n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && src[i + 1] === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += c; i++;
      while (i < n) { if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; } out += src[i]; if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

test('ни один мастер не завёл собственный расчёт слотов заново', () => {
  const offences = [];
  for (const f of WIZARD_FILES) {
    const code = stripComments(fs.readFileSync(path.join(VIEWS, f), 'utf8'));
    const lines = code.split(/\r?\n/);
    lines.forEach((L, idx) => {
      const at2 = `${f}:${idx + 1}`;
      // 1. Разбор графика врача. Он живёт в slot-engine.js, и только там —
      //    именно из-за двух форм одной колонки мастера и разошлись.
      if (/\bworking_?[Hh]ours\b/.test(L)) offences.push(`${at2} разбирает график врача: ${L.trim()}`);
      // 2. Своё окно по умолчанию. Ровно на нём мастер и календарь расходились
      //    на два часа с каждой стороны.
      if (/['"](?:0[89]|1[0-9]|2[0-3]):00['"]/.test(L) && !/name|label|placeholder/i.test(L)) {
        offences.push(`${at2} зашивает часы окна: ${L.trim()}`);
      }
      // 3. Форма дня недели. Ключи sun…sat означают, что файл сам решает,
      //    рабочий ли день.
      if (/['"]sun['"]\s*,\s*['"]mon['"]/.test(L)) offences.push(`${at2} раскладывает дни недели сам: ${L.trim()}`);
      // 4. Перебор дня шагом — тело функции вида slotsFor*.
      if (/for\s*\([^)]*\+=\s*(?:step|SNAP|30|15)\b/.test(L)) offences.push(`${at2} перебирает день шагом: ${L.trim()}`);
    });
  }
  assert.deepEqual(offences, [], 'в мастерах снова считают слоты сами:\n' + offences.join('\n'));
});

test('оба мастера СПРАШИВАЮТ сервер и НЕ ПИШУТ визит мимо него', () => {
  const spm = fs.readFileSync(path.join(VIEWS, 'service-picker-modal.js'), 'utf8');
  const viw = fs.readFileSync(path.join(VIEWS, 'visit-wizard.js'), 'utf8');

  assert.match(spm, /rpc\('calendar_slots'/, 'подбор услуг обязан спрашивать слоты у сервера');
  assert.match(spm, /rpc\('calendar_book'/, 'подбор услуг обязан записывать через calendar_book');
  assert.match(viw, /from '\.\/service-picker-modal\.js/, 'мастер визита обязан брать общий клиент слотов');

  // Прямая вставка визита мимо RPC — та самая дыра. Её быть не должно.
  for (const [name, src] of [['service-picker-modal.js', spm], ['visit-wizard.js', viw]]) {
    const code = stripComments(src);
    assert.ok(!/from\('visits'\)[\s\S]{0,120}\.insert\(/.test(code),
      name + ' снова вставляет визит через /api/db — запрет двойной записи так обходится');
  }
});
