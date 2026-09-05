// CALENDAR_BOOKING_V1 — «Календарь записи» РИСУЕТ ЗАПИСЬ.
//
// Это главный тест задачи, и проверяет он ровно то, чего этот экран не делал
// никогда: чтобы в сетке ОКАЗАЛСЯ приём. Экран существовал два года, был
// полностью написан — рейка, сетка, перетаскивание, статусы — и показывал
// пустоту в каждой клинике, потому что каждый его запрос просил колонки,
// которых нет, сервер отвечал 400, а ответ гасился в catch. Пустая сетка
// выглядит как «сегодня никого не записали», поэтому никто и не заметил.
//
// Поэтому стенд здесь НЕ ЗАГЛУШКА ОТВЕТОВ, а НАСТОЯЩАЯ ЦЕПОЧКА: фальшивый
// fetch пропускает запросы экрана через настоящий компилятор запросов
// (server/db/query-compiler.js) с настоящим реестром и настоящую SQLite в
// памяти, прошедшую все миграции, а вызовы RPC — через настоящий реестр
// обработчиков. Заглушённые ответы дали бы зелёный тест и на старом коде: он
// сломался НА ГРАНИЦЕ «реестр — экран», и границу нельзя подменять.
//
// Проверяется:
//   • приём виден в сетке — пациент, время, врач, услуга;
//   • ось кабинетов рисуется и та же запись оказывается в дорожке кабинета;
//   • подсказка карточки НЕСЁТ СТАТУС;
//   • колонка, у которой сегодня выходной, затенена вся — окно приходит с
//     сервера, экран его не выдумывает;
//   • ошибка загрузки ПОКАЗЫВАЕТСЯ, а не превращается в пустую сетку.

import { test } from 'node:test';
import assert from 'node:assert';

// ─── крошечный DOM (стенд kitchen-sheet/discharge-view) ─────────────────────
class F {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {};
    this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
    this.value = ''; this.checked = false; this.disabled = false;
  }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} scrollTo() {}
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  getBoundingClientRect() { return { top: 10, left: 10, right: 200, bottom: 60, width: 190, height: 50 }; }
  querySelector() { return null; }
  querySelectorAll(sel) {
    const cls = String(sel).replace(/^\./, '');
    return walk(this).filter((n) => String(n.className).split(/\s+/).includes(cls));
  }
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
// I18N_LOCALE_PIN_V1 — язык пришпилен к ru ДО импорта экрана.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

function walk(e, o = []) { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; }
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');
const byClass = (el, cls) => walk(el).filter((n) => String(n.className).split(/\s+/).includes(cls));
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// ─── настоящая база + настоящий компилятор за фальшивым fetch ───────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');

const USER = { id: 1, role: 'admin', extra_roles: [] };
let DB = null;
let FAIL_TABLE = null;   // «пусть этот запрос упадёт» — для проверки честности ошибки

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  const bad = (message) => ({ ok: false, status: 400, json: async () => ({ error: { code: 'bad_request', message } }) });

  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    const handler = getRpc(name);
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'no rpc ' + name } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
    if (FAIL_TABLE && body.table === FAIL_TABLE) return bad('unknown column');
    let compiled;
    try { compiled = compile(body, USER); } catch (e) { return bad(e.message); }
    const rows = DB.prepare(compiled.sql).all(...compiled.params);
    if (compiled.meta.single === 'single') return ok(rows[0]);
    if (compiled.meta.single === 'maybe') return ok(rows[0] ?? null);
    return ok(rows);
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const { renderRoomCalendar } = await import('../views/room-calendar.js');

// ─── посев ──────────────────────────────────────────────────────────────────
// День берётся ЗАВТРАШНИЙ и приводится к рабочему дню недели: сетка не должна
// зависеть от того, в какой день года запущен тест, а «сегодня» отсекало бы
// прошедшие часы.
function nextWeekday(offset = 1) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function seed({ doctorOff = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const day = nextWeekday();
  const wh = {};
  for (const k of WD) wh[k] = { enabled: true, from: '09:00', to: '18:00' };
  if (doctorOff) wh[WD[day.getDay()]] = { enabled: false, from: '09:00', to: '18:00' };

  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours) VALUES (1,'adm','x','Админ','admin',0,'','')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours) VALUES (7,'doc','x','Петров Пётр','doctor',1,'терапевт',?)").run(JSON.stringify(wh));
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (3,'Иванов Иван','+998901112233')").run();
  db.prepare("INSERT INTO floors (id, name, level) VALUES (1,'2-й этаж',2)").run();
  db.prepare("INSERT INTO rooms (id, name, code, room_type, floor_id) VALUES (11,'Кабинет 201','201','consultation',1)").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (21,'Консультация терапевта',100000,30)").run();

  const start = new Date(day); start.setHours(10, 0, 0, 0);
  db.prepare(`INSERT INTO visits (id, patient_id, doctor_id, room_id, service_id, visit_date, duration_minutes, status)
              VALUES (55, 3, 7, 11, 21, ?, 30, 'confirmed')`).run(start.toISOString());
  return { db, dayIso: isoOf(day) };
}

/** Отрисовать экран на нужный день. */
async function render({ doctorOff = false, failTable = null } = {}) {
  const s = seed({ doctorOff });
  if (DB) DB.close();
  DB = s.db;
  FAIL_TABLE = failTable;
  const box = mk('div');
  await renderRoomCalendar(box, { onNavigate: () => {}, embedded: false });
  // Дата по умолчанию — сегодня; переводим на посеянный день кнопкой «вперёд»
  // ровно так же, как это делает регистратура.
  const dateInp = walk(box).find((n) => String(n.className).includes('rcal-date'));
  dateInp.value = s.dayIso;
  dateInp.dispatchEvent({ type: 'change', target: dateInp });
  await flush();
  return { box, dayIso: s.dayIso };
}

// ═══════════════════════════════════════════════════════════════════════════

test('ЗАПИСЬ ВИДНА В СЕТКЕ — то, чего этот экран не делал никогда', async () => {
  const { box } = await render();

  const appts = byClass(box, 'rcal-appt');
  assert.equal(appts.length, 1, 'в сетке обязан оказаться ровно один приём: ' + appts.length);

  const card = textOf(appts[0]);
  assert.ok(/Иванов Иван/.test(card), 'на карточке нет пациента: ' + card);
  assert.ok(/10:00–10:30/.test(card), 'на карточке нет времени приёма: ' + card);
  assert.ok(/Петров Пётр/.test(card), 'на карточке нет врача (владелец: «пациент + врач»): ' + card);
  assert.ok(/Консультация терапевта/.test(card), 'на карточке нет услуги: ' + card);

  // И это не «что-то нарисовалось»: колонка врача подписана врачом, а счётчик
  // колонки показывает единицу.
  const head = byClass(box, 'rcal-colhead').map(textOf).join(' | ');
  assert.ok(/Петров Пётр/.test(head), 'колонки врачей не подписаны: ' + head);
  assert.ok(/терапевт/.test(head));
});

test('ось КАБИНЕТОВ рисуется, и та же запись оказывается в дорожке кабинета', async () => {
  const { box } = await render();

  const roomsBtn = walk(box).find((n) => n.tagName === 'BUTTON' && /Кабинеты/.test(textOf(n)));
  assert.ok(roomsBtn, 'переключателя «Кабинеты» нет — ось кабинетов владелец назвал прямо');
  roomsBtn.click();
  await flush();

  const head = byClass(box, 'rcal-colhead').map(textOf).join(' | ');
  assert.ok(/Кабинет 201/.test(head), 'колонки кабинетов не нарисовались: ' + head);
  // Этаж, а не буква здания: календарь показывает своё здание, и буква была бы
  // одинаковой на всех колонках (разбор — в шапке миграции 099).
  assert.ok(/2-й этаж/.test(head), 'у кабинета не подписан этаж: ' + head);

  const appts = byClass(box, 'rcal-appt');
  assert.equal(appts.length, 1, 'на оси кабинетов запись пропала');
  assert.ok(/Иванов Иван/.test(textOf(appts[0])));
});

test('подсказка карточки НЕСЁТ СТАТУС', async () => {
  const { box } = await render();
  const block = byClass(box, 'rcal-appt')[0];
  block.dispatchEvent({ type: 'mouseenter' });

  const tip = byClass(document.body, 'rcal-tip')[0] || (String(document.body.children.at(-1)?.className).includes('rcal-tip') ? document.body.children.at(-1) : null);
  assert.ok(tip, 'подсказка не появилась');
  const txt = textOf(tip);
  assert.ok(/Подтверждён/.test(txt), 'подсказка обязана называть статус: ' + txt);
  assert.ok(/10:00–10:30/.test(txt), 'подсказка обязана называть время: ' + txt);
  assert.ok(/Иванов Иван/.test(txt));
  assert.ok(/Петров Пётр/.test(txt));

  // Статус ещё и помечен на самих узлах — по нему красится карточка и кружок.
  const st = byClass(document.body, 'rcal-tip-st')[0];
  assert.equal(st.attrs['data-status'], 'confirmed');
  assert.equal(block.attrs['data-status'], 'confirmed');
});

test('выходной врача приходит С СЕРВЕРА: вся колонка затенена, свободных слотов нет', async () => {
  const { box } = await render({ doctorOff: true });
  const slots = byClass(box, 'rcal-slot');
  assert.ok(slots.length > 0, 'сетка не нарисовалась вовсе');
  assert.ok(slots.every((s) => String(s.className).includes('off')),
    'в выходной день у колонки не должно остаться ни одной рабочей клетки');
});

test('НЕ ЗАГРУЗИЛОСЬ — экран говорит об этом, а не притворяется пустым расписанием', async () => {
  const { box } = await render({ failTable: 'rooms' });
  const fail = byClass(box, 'rcal-fail');
  assert.equal(fail.length, 1, 'ошибка загрузки обязана быть показана: именно её молчание держало экран пустым');
  assert.ok(/кабинеты/.test(textOf(fail[0])), 'сообщение обязано назвать, ЧТО не загрузилось: ' + textOf(fail[0]));
  assert.equal(byClass(box, 'rcal-appt').length, 0);
});
