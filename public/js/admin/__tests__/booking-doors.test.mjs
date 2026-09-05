// VISITS_ONE_DOOR_V1 — ЗАПРЕТ ДВОЙНОЙ ЗАПИСИ ЗАКРЫВАЕТ ВСЕ ДВЕРИ, А НЕ ОДНУ.
//
// ─── ЧТО ЗДЕСЬ ЧИНИТСЯ ──────────────────────────────────────────────────────
//
// Правило владельца — «один пациент на врача на слот, жёстко» — жило в
// calendar_book и было там настоящим. Но реестр таблиц (schema-registry.js)
// ПРОДОЛЖАЛ раздавать insert/update на visits.visit_date, doctor_id,
// duration_minutes и status, и через эту вторую дверь писали четыре шипнутых
// экрана: журнал визитов (обычный datetime-local, ни у кого ничего не
// спрашивал), кабинет врача («Начать приём»), повторный визит и окно визита.
// В базе владельца нашлись ДВА живых scheduled-визита одного врача на 10:00.
//
// Отдельно ходили ещё две дыры:
//   • ВОЗВРАТ ОТМЕНЁННОЙ ЗАПИСИ. Пациент отменяет 10:00 → слот продают заново
//     → регистратор открывает ту же заявку обратно одним UPDATE, и на 10:00
//     стоят двое. Это же был и двухкликовый обход НАРОЧНО: записать поверх
//     занятого «отменённым», а потом переключить статус.
//   • СИРОТА ПОСЛЕ МАСТЕРА. Мастер визита звал ensure_visit (вставка без
//     проверки) и только ПОТОМ calendar_book. Отказ второго оставлял в базе
//     созданный scheduled-визит: пациента никто не ждёт, а слот он держит.
//
// ─── ПОЧЕМУ СТЕНД НАСТОЯЩИЙ ─────────────────────────────────────────────────
//
// Тот же приём, что в wizard-booking.test.mjs: фальшивый fetch пропускает
// вызовы экрана через НАСТОЯЩИЙ реестр RPC, НАСТОЯЩИЙ компилятор /api/db и
// НАСТОЯЩУЮ SQLite в памяти, прошедшую миграции. Заглушённые ответы дали бы
// зелёный тест и на старом коде — ломалось всё именно на границе «экран —
// сервер», и подменять эту границу нельзя.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── крошечный DOM (тот же, что у wizard-booking / room-calendar) ───────────
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
/** Дать промисам экрана прокрутиться: нажатие обработчика ничего не await'ит. */
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

// ─── настоящая база + настоящий реестр RPC + настоящий /api/db ──────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');

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
    catch (e) { return { ok: false, status: e.status || 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    try {
      // UPDATE/DELETE ничего не возвращают — better-sqlite3 требует run().
      if (compiled.meta.op !== 'select') { DB.prepare(compiled.sql).run(...compiled.params); return ok(null); }
      const rows = DB.prepare(compiled.sql).all(...compiled.params);
      if (compiled.meta.single === 'single') return ok(rows[0]);
      if (compiled.meta.single === 'maybe') return ok(rows[0] ?? null);
      return ok(rows);
    } catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'db', message: e.message } }) }; }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const SPM = await import('../views/service-picker-modal.js');
const DOOR = await import('../views/visit-booking.js');
const { bookVisit, setVisitStatus } = DOOR;
const { supabase } = await import('../../supabase.js');

// ─── посев ──────────────────────────────────────────────────────────────────
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function nextWeekday(offset = 2) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const wh = {};
  for (const k of WD) wh[k] = { enabled: true, from: '08:00', to: '19:00' };
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours) VALUES (7,'doc','x','Петров Пётр','doctor',1,'терапевт',?)").run(JSON.stringify(wh));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (4,'Сидорова Мария')").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (21,'Консультация терапевта',100000,30)").run();
  if (DB) DB.close();
  DB = db;
  SPM.forgetSlots();
  const day = nextWeekday();
  return { db, day, dayIso: isoOf(day) };
}

const at = (day, hh, mm = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0).toISOString();
const localInput = (day, hh, mm = 0) =>
  `${isoOf(day)}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
const countVisits = () => DB.prepare('SELECT COUNT(*) c FROM visits').get().c;
/** Кто-то другой уже занял это время у врача 7. */
function occupy(day, hh, mm = 0, patientId = 3) {
  DB.prepare("INSERT INTO visits (patient_id, doctor_id, service_id, visit_date, duration_minutes, status) VALUES (?,7,21,?,30,'scheduled')")
    .run(patientId, at(day, hh, mm));
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. ОБЩАЯ ДВЕРЬ /api/db ЗАКРЫТА — какой бы экран в неё ни постучал
// ═══════════════════════════════════════════════════════════════════════════

test('/api/db: визит не вставляется НИ ОДНОЙ ролью — расписание пишет только RPC', async () => {
  const { day } = seed();
  for (const role of ['admin', 'registrar', 'doctor']) {
    const before = countVisits();
    assert.throws(
      () => compile({ table: 'visits', op: 'insert', values: { patient_id: 4, doctor_id: 7, visit_date: at(day, 10), status: 'scheduled' } }, { id: 1, role }),
      /not allowed/, role + ' всё ещё может вставить визит мимо проверки',
    );
    assert.equal(countVisits(), before);
  }
});

test('/api/db: время, врач, длительность и статус визита не правятся', async () => {
  const { day } = seed();
  occupy(day, 10);
  const id = DB.prepare('SELECT id FROM visits').get().id;
  for (const values of [{ visit_date: at(day, 11) }, { doctor_id: 7 }, { status: 'cancelled' }, { duration_minutes: 90 }, { room_id: 1 }]) {
    assert.throws(
      () => compile({ table: 'visits', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] }, USER),
      /no writable columns/, Object.keys(values)[0] + ' всё ещё пишется через /api/db',
    );
  }
  // Не-расписание остаётся: примечание и заключение врача.
  const okUpd = await supabase.from('visits').update({ notes: 'перезвонить', conclusion: 'ОРВИ' }).eq('id', id);
  assert.ok(!okUpd.error, JSON.stringify(okUpd.error));
  assert.equal(DB.prepare('SELECT notes FROM visits WHERE id=?').get(id).notes, 'перезвонить');
});

test('ДВУХКЛИКОВЫЙ ОБХОД МЁРТВ: «отменённым поверх занятого, потом переключить»', async () => {
  const { day } = seed();
  occupy(day, 10);
  // Шаг 1 — записать поверх занятого «отменённым». Раньше проходил: статус
  // cancelled времени не занимает, и calendar_book пропускал такую запись.
  const parked = await bookVisit({ patient_id: 4, doctor_id: 7, start: at(day, 10), duration_minutes: 30, status: 'cancelled' });
  assert.ok(parked && parked.visit, 'отменённая запись сама по себе законна — она слот не держит');
  // Шаг 2 — переключить в «записан». ЭТО И ЕСТЬ ЗАПИСЬ, и она отвергается.
  await assert.rejects(
    () => setVisitStatus(parked.visit, 'scheduled'),
    (e) => e.code === 'slot_taken' && /Петров/.test(e.message),
    'переключение статуса всё ещё продаёт занятый слот',
  );
  assert.equal(DB.prepare('SELECT status FROM visits WHERE id=?').get(parked.visit.id).status, 'cancelled',
    'запись обязана остаться отменённой');
  assert.equal(DB.prepare("SELECT COUNT(*) c FROM visits WHERE doctor_id=7 AND status='scheduled'").get().c, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. ВОЗВРАТ ОТМЕНЁННОЙ ЗАПИСИ И ОТМЕНА
// ═══════════════════════════════════════════════════════════════════════════

test('ОТМЕНИЛИ → СЛОТ ПРОДАЛИ → ОТКРЫТЬ ОБРАТНО НЕЛЬЗЯ, и сказано почему', async () => {
  const { day } = seed();
  // Пациент записан на 10:00 и отменяет.
  const mine = await bookVisit({ patient_id: 4, doctor_id: 7, service_id: 21, start: at(day, 10), status: 'scheduled' });
  await setVisitStatus(mine.visit, 'cancelled');
  assert.equal(DB.prepare('SELECT status FROM visits WHERE id=?').get(mine.visit.id).status, 'cancelled');

  // Слот немедленно продан другому — так и должно быть, время освободилось.
  const resold = await bookVisit({ patient_id: 3, doctor_id: 7, service_id: 21, start: at(day, 10), status: 'scheduled' });
  assert.ok(resold && resold.created);

  // Регистратор «передумал» и открывает отменённую заявку обратно.
  const row = DB.prepare('SELECT * FROM visits WHERE id=?').get(mine.visit.id);
  await assert.rejects(
    () => setVisitStatus(row, 'scheduled'),
    (e) => e.code === 'slot_taken' && /10:00–10:30/.test(e.message),
    'молчаливая перепродажа слота вернулась',
  );
  assert.equal(DB.prepare("SELECT COUNT(*) c FROM visits WHERE doctor_id=7 AND status IN ('scheduled','confirmed','arrived')").get().c, 1,
    'на 10:00 обязан остаться ОДИН живой визит');
});

test('ОТМЕНА И НЕЯВКА проверки не требуют — слот они освобождают, а не занимают', async () => {
  const { day } = seed();
  const a = await bookVisit({ patient_id: 4, doctor_id: 7, service_id: 21, start: at(day, 12), status: 'scheduled' });
  const row = DB.prepare('SELECT * FROM visits WHERE id=?').get(a.visit.id);
  await setVisitStatus(row, 'cancelled');
  assert.equal(DB.prepare('SELECT status FROM visits WHERE id=?').get(a.visit.id).status, 'cancelled');
  await setVisitStatus(DB.prepare('SELECT * FROM visits WHERE id=?').get(a.visit.id), 'no_show');
  assert.equal(DB.prepare('SELECT status FROM visits WHERE id=?').get(a.visit.id).status, 'no_show');
});

test('ПЕРЕХОД ВНУТРИ ЗАНЯТЫХ СТАТУСОВ (записан → подтверждён → пришёл) не спорит сам с собой', async () => {
  const { day } = seed();
  const a = await bookVisit({ patient_id: 4, doctor_id: 7, service_id: 21, start: at(day, 14), status: 'scheduled' });
  let row = DB.prepare('SELECT * FROM visits WHERE id=?').get(a.visit.id);
  await setVisitStatus(row, 'confirmed');
  row = DB.prepare('SELECT * FROM visits WHERE id=?').get(a.visit.id);
  await setVisitStatus(row, 'arrived');
  assert.equal(DB.prepare('SELECT status FROM visits WHERE id=?').get(a.visit.id).status, 'arrived');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ЭКРАНЫ. Журнал визитов проходится целиком — настоящей кнопкой.
// ═══════════════════════════════════════════════════════════════════════════

test('ЖУРНАЛ ВИЗИТОВ: «Записать визит» на занятое время отказывает и НЕ СОЗДАЁТ НИЧЕГО', async () => {
  const { day } = seed();
  occupy(day, 10);
  const before = countVisits();

  const { openBookVisitModal } = await import('../views/visits.js');
  openBookVisitModal(null, { id: 4, full_name: 'Сидорова Мария' });
  const modal = document.body.children[document.body.children.length - 1];
  const dt = walk(modal).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'datetime-local');
  assert.ok(dt, 'в окне записи нет поля даты и времени');
  dt.value = localInput(day, 10, 0);
  const doc = walk(modal).find((n) => n.tagName === 'SELECT');
  doc.value = '7';
  const save = walk(modal).find((n) => n.tagName === 'BUTTON' && /Book visit/.test(textOf(n)));
  assert.ok(save, 'кнопки записи нет');
  save.click();
  await flush();

  // Сервер отказал — экран показывает ЕГО отказ и предлагает экстренную
  // запись с причиной. Пока причины нет, в базе не появилось ничего.
  const ask = document.body.children[document.body.children.length - 1];
  assert.match(textOf(ask), /Это время занято/, 'экран не показал отказ сервера: ' + textOf(ask));
  assert.match(textOf(ask), /Петров Пётр/);
  assert.equal(countVisits(), before, 'визит всё-таки создан мимо проверки');

  // Передумали — не создано по-прежнему ничего.
  const no = walk(ask).find((n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Отмена');
  no.click();
  await flush();
  assert.equal(countVisits(), before);
});

test('ЖУРНАЛ ВИЗИТОВ: свободное время записывается, и тип приёма не теряется', async () => {
  const { day } = seed();
  const before = countVisits();

  const { openBookVisitModal } = await import('../views/visits.js');
  let saved = false;
  openBookVisitModal(() => { saved = true; }, { id: 4, full_name: 'Сидорова Мария' });
  const modal = document.body.children[document.body.children.length - 1];
  walk(modal).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'datetime-local').value = localInput(day, 15, 0);
  const selects = walk(modal).filter((n) => n.tagName === 'SELECT');
  selects[0].value = '7';           // врач
  selects[1].value = 'emergency';   // тип приёма
  walk(modal).find((n) => n.tagName === 'BUTTON' && /Book visit/.test(textOf(n))).click();
  await flush();

  assert.equal(countVisits(), before + 1, 'нормальная запись обязана проходить');
  assert.ok(saved, 'экран не обновился после записи');
  const row = DB.prepare('SELECT * FROM visits WHERE patient_id=4 ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.doctor_id, 7);
  assert.equal(row.status, 'scheduled');
  assert.equal(new Date(row.visit_date).getHours(), 15);
  assert.equal(row.visit_type, 'emergency', 'тип приёма потерян при переезде на calendar_book');
  assert.equal(row.created_by, 1, 'кто записал — ставит сервер из сессии');
});

test('ЭКСТРЕННАЯ ЗАПИСЬ поверх занятого времени жива — и требует причину', async () => {
  const { day } = seed();
  occupy(day, 10);
  // Без причины — отказ.
  const askNothing = async () => null;
  assert.equal(await bookVisit({ patient_id: 4, doctor_id: 7, start: at(day, 10), duration_minutes: 30 }, { askReason: askNothing }), null);
  assert.equal(countVisits(), 1, 'отказ от экстренной записи не должен ничего создавать');
  // С причиной — проходит, и причина уходит В САМУ ЗАПИСЬ.
  const out = await bookVisit({ patient_id: 4, doctor_id: 7, start: at(day, 10), duration_minutes: 30 },
    { askReason: async () => 'скорая привезла' });
  assert.ok(out && out.emergency);
  assert.match(DB.prepare('SELECT notes FROM visits WHERE id=?').get(out.visit.id).notes, /скорая привезла/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. МАСТЕР ВИЗИТА: атомарность — отказ не оставляет сироту
// ═══════════════════════════════════════════════════════════════════════════

test('МАСТЕР: отказ не оставляет НИ ОДНОГО визита — ни созданного, ни недописанного', async () => {
  const { day } = seed();
  occupy(day, 10);
  const before = countVisits();
  const res = await supabase.rpc('ensure_visit', {
    patient_id: 4, date: at(day, 10),
    book: { doctor_id: 7, service_id: 21, start: at(day, 10), duration_minutes: 30 },
  });
  assert.equal(res.error && res.error.code, 'slot_taken', JSON.stringify(res));
  assert.equal(countVisits(), before, 'после отказа остался визит-сирота');
  assert.equal(DB.prepare('SELECT COUNT(*) c FROM visits WHERE patient_id=4').get().c, 0);
});

test('МАСТЕР: свободное время — визит дня создан И записан одним вызовом', async () => {
  const { day } = seed();
  const res = await supabase.rpc('ensure_visit', {
    patient_id: 4, date: at(day, 11),
    book: { doctor_id: 7, service_id: 21, start: at(day, 11), duration_minutes: 30 },
  });
  assert.ok(!res.error, JSON.stringify(res.error));
  assert.equal(res.data.created, true);
  assert.equal(res.data.booked, true);
  const row = DB.prepare('SELECT * FROM visits WHERE id=?').get(res.data.visit.id);
  assert.equal(row.doctor_id, 7);
  assert.equal(row.service_id, 21);
  assert.equal(row.duration_minutes, 30, 'визит мастера обязан получить длительность услуги');
  assert.equal(new Date(row.visit_date).getHours(), 11);
});

test('МАСТЕР: ВИЗИТ ДНЯ УЖЕ ЕСТЬ — время его не двигают, но выбранный слот всё равно проверяют', async () => {
  const { day } = seed();
  // Пациент 4 уже приходил сегодня утром.
  const morning = await supabase.rpc('ensure_visit', {
    patient_id: 4, date: at(day, 9),
    book: { doctor_id: 7, service_id: 21, start: at(day, 9), duration_minutes: 30 },
  });
  assert.ok(!morning.error, JSON.stringify(morning.error));
  // Кто-то другой занял 16:00.
  occupy(day, 16);
  const before = countVisits();

  // Вторая услуга того же дня на 16:00 — раньше проверка ПРОПУСКАЛАСЬ вовсе
  // (calendar_book звался только для свежесозданного визита).
  const second = await supabase.rpc('ensure_visit', {
    patient_id: 4, date: at(day, 16),
    book: { doctor_id: 7, service_id: 21, start: at(day, 16), duration_minutes: 30 },
  });
  assert.equal(second.error && second.error.code, 'slot_taken', 'существующий визит дня всё ещё проходит мимо проверки');
  assert.equal(countVisits(), before);
  // Время утреннего визита не тронуто.
  assert.equal(new Date(DB.prepare('SELECT visit_date v FROM visits WHERE id=?').get(morning.data.visit.id).v).getHours(), 9);

  // Свободное время того же дня — визит переиспользуется, время прежнее.
  const third = await supabase.rpc('ensure_visit', {
    patient_id: 4, date: at(day, 17),
    book: { doctor_id: 7, service_id: 21, start: at(day, 17), duration_minutes: 30 },
  });
  assert.ok(!third.error, JSON.stringify(third.error));
  assert.equal(third.data.created, false);
  assert.equal(third.data.booked, false, 'визит дня двигать нельзя — это время первого прихода пациента');
  assert.equal(third.data.visit.id, morning.data.visit.id);
});

test('МАСТЕР: собственный визит пациента не закрывает ему же время', async () => {
  const { day } = seed();
  const first = await supabase.rpc('ensure_visit', {
    patient_id: 4, date: at(day, 13),
    book: { doctor_id: 7, service_id: 21, start: at(day, 13), duration_minutes: 30 },
  });
  assert.ok(!first.error, JSON.stringify(first.error));
  // Та же услуга, то же время, тот же пациент — это его собственный визит.
  const again = await supabase.rpc('ensure_visit', {
    patient_id: 4, date: at(day, 13),
    book: { doctor_id: 7, service_id: 21, start: at(day, 13), duration_minutes: 30 },
  });
  assert.ok(!again.error, 'собственный визит пациента отказал ему же: ' + JSON.stringify(again.error));
});

test('МАСТЕР: экстренная запись поверх занятого требует причину и сохраняет её', async () => {
  const { day } = seed();
  occupy(day, 10);
  const noReason = await supabase.rpc('ensure_visit', {
    patient_id: 4, date: at(day, 10),
    book: { doctor_id: 7, service_id: 21, start: at(day, 10), duration_minutes: 30, emergency: true, emergency_reason: '' },
  });
  assert.equal(noReason.error && noReason.error.code, 'emergency_reason_required');
  assert.equal(DB.prepare('SELECT COUNT(*) c FROM visits WHERE patient_id=4').get().c, 0);

  const ok = await supabase.rpc('ensure_visit', {
    patient_id: 4, date: at(day, 10),
    book: { doctor_id: 7, service_id: 21, start: at(day, 10), duration_minutes: 30, emergency: true, emergency_reason: 'острая боль' },
  });
  assert.ok(!ok.error, JSON.stringify(ok.error));
  assert.match(DB.prepare('SELECT notes FROM visits WHERE id=?').get(ok.data.visit.id).notes, /острая боль/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. ГВОЗДЬ: ни одна дверь не открывается заново
// ═══════════════════════════════════════════════════════════════════════════

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.join(HERE, '..', 'views');

/** Убрать комментарии, не тронув длину строк: разбор про КОД. */
function stripComments(src) {
  let out = '', i = 0; const n = src.length;
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

// Экраны, которые расписание ПИШУТ. Каждый обязан ходить общей дверью.
const BOOKING_VIEWS = ['visits.js', 'doctor-room.js', 'service-workspace.js', 'visit-modal.js', 'requests-inbox.js'];
const read = (f) => fs.readFileSync(path.join(VIEWS, f), 'utf8');

test('ни один экран не пишет расписание визита через /api/db', () => {
  const offences = [];
  for (const f of [...BOOKING_VIEWS, 'visit-wizard.js']) {
    const code = stripComments(read(f));
    if (/from\('visits'\)[\s\S]{0,200}\.insert\(/.test(code)) offences.push(f + ': снова вставляет визит через /api/db');
    // UPDATE по visits с колонкой расписания в полезной нагрузке.
    const re = /from\('visits'\)[\s\S]{0,80}\.update\(([\s\S]{0,400}?)\)\s*\.eq/g;
    let m;
    while ((m = re.exec(code))) {
      const payload = m[1];
      for (const col of ['visit_date', 'doctor_id', 'status', 'duration_minutes', 'room_id', 'service_id']) {
        if (new RegExp('\\b' + col + '\\s*:').test(payload)) offences.push(`${f}: правит ${col} через /api/db — ${payload.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offences, [], 'вторая дверь к расписанию открылась заново:\n' + offences.join('\n'));
});

test('МАСТЕР ВИЗИТА: визит и слот — ОДИН вызов, окна для сироты больше нет', () => {
  const code = stripComments(read('visit-wizard.js'));
  assert.match(code, /rpc\('ensure_visit'/, 'мастер обязан заводить визит дня через ensure_visit');
  assert.match(code, /\.book\s*=\s*\{|book:\s*\{/, 'мастер обязан просить слот ТЕМ ЖЕ вызовом');
  assert.ok(!/rpc\('calendar_book'/.test(code),
    'мастер снова записывает вторым вызовом — между ним и ensure_visit живёт визит-сирота');
});

test('каждый пишущий экран ходит ОБЩЕЙ дверью visit-booking.js', () => {
  for (const f of BOOKING_VIEWS) {
    assert.match(read(f), /from '\.\/visit-booking\.js'/, f + ' не берёт общую дверь записи');
  }
  // А сама дверь ничего не проверяет сама — она зовёт сервер.
  const door = stripComments(read('visit-booking.js'));
  assert.match(door, /rpc\('calendar_book'/, 'общая дверь обязана писать через calendar_book');
  assert.ok(!/from\('visits'\)/.test(door), 'общая дверь пишет в visits напрямую — тогда это не дверь');
});

test('ОДНА реализация «когда врач свободен» на весь продукт', () => {
  // Всё, что спрашивает занятость врача, обязано делать это через
  // calendar_slots (общий клиент — service-picker-modal.js). Своих выборок из
  // visits «кто занят» в экранах быть не должно.
  const offences = [];
  for (const f of [...BOOKING_VIEWS, 'visit-wizard.js']) {
    const code = stripComments(read(f));
    const lines = code.split(/\r?\n/);
    lines.forEach((L, i) => {
      if (/\bworking_?[Hh]ours\b/.test(L)) offences.push(`${f}:${i + 1} разбирает график врача сам: ${L.trim()}`);
      if (/\bloadBookedSlots\b/.test(L)) offences.push(`${f}:${i + 1} четвёртый движок слотов вернулся: ${L.trim()}`);
    });
  }
  assert.deepEqual(offences, [], 'вторая реализация расписания вернулась:\n' + offences.join('\n'));

  // И ГЛАВНОЕ: спрашивать сервер о свободном времени умеет РОВНО ОДИН файл —
  // общий клиент слотов. Пять экранов, каждый со своим вызовом и своим кэшем,
  // разошлись бы ровно так же, как расходились четыре расчёта до него.
  const callers = fs.readdirSync(VIEWS)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /rpc\('calendar_slots'/.test(stripComments(fs.readFileSync(path.join(VIEWS, f), 'utf8'))));
  assert.deepEqual(callers, ['service-picker-modal.js'],
    'calendar_slots спрашивают из нескольких мест — это снова две реализации доступности');

  // И «Повторный визит» действительно спрашивает сервер через этот клиент.
  assert.match(read('service-workspace.js'), /loadSlotDay|freeStartMinutes/, 'повторный визит не спрашивает слоты у сервера');
});
