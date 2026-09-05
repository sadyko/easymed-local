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

const { becomeSecondary } = await import('../../../../server/services/branch-sync/identity.js');
const { exportCatalogue, applyCatalogue } = await import('../../../../server/services/branch-sync/catalogue.js');

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

function seed({ doctorOff = false, cross = false, stale = false, nodoc = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const day = nextWeekday();
  const wh = {};
  for (const k of WD) wh[k] = { enabled: true, from: '09:00', to: '18:00' };
  if (doctorOff) wh[WD[day.getDay()]] = { enabled: false, from: '09:00', to: '18:00' };

  // ЭТА УСТАНОВКА — ФИЛИАЛ B, и буква берётся ДО первого пациента: установке,
  // уже выдавшей номера под своей буквой, becomeSecondary отказывает
  // (миграция 080). Раньше здесь стоял главный филиал, и это прятало ошибку:
  // у ГЛАВНОЙ клиники приписку врачей ставит местный администратор, поэтому у
  // неё межфилиальный календарь работал и на сломанном справочнике. Ломалось
  // у филиала — вот филиал и стоит.
  if (cross) becomeSecondary(db, { letter: 'B', name: 'Второй корпус' });

  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours) VALUES (1,'adm','x','Админ','admin',0,'','')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours) VALUES (7,'doc','x','Петров Пётр','doctor',1,'терапевт',?)").run(JSON.stringify(wh));
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (3,'Иванов Иван','+998901112233')").run();
  db.prepare("INSERT INTO floors (id, name, level) VALUES (1,'2-й этаж',2)").run();
  db.prepare("INSERT INTO rooms (id, name, code, room_type, floor_id) VALUES (11,'Кабинет 201','201','consultation',1)").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (21,'Консультация терапевта',100000,30)").run();

  const start = new Date(day); start.setHours(10, 0, 0, 0);
  db.prepare(`INSERT INTO visits (id, patient_id, doctor_id, room_id, service_id, visit_date, duration_minutes, status)
              VALUES (55, 3, 7, 11, 21, ?, 30, 'confirmed')`).run(start.toISOString());

  // CROSS_BRANCH_CALENDAR_V1 — сеть из двух зданий и случаи, ради которых экран
  // переписывался: чужая запись, наша неподтверждённая запись в чужое здание,
  // настоящее столкновение внутри часа между обменами, застоявшееся ожидание и
  // приехавшая запись без врача.
  //
  // СЕТЬ СТРОИТСЯ НАСТОЯЩИМ СПРАВОЧНИКОМ. Раньше здесь стояло
  // `INSERT INTO users (… branch_id) VALUES (9, …, 77)` — приписка ставилась
  // рукой, а справочник её не вёз, и тест был зелёным на состоянии, которого в
  // жизни не бывает: у настоящего филиала врач соседнего здания приезжал без
  // приписки, и экран считал его своим. Теперь врач соседнего здания ПРИЕЗЖАЕТ
  // — со зданием и графиком, — и если это сломается, тесты покраснеют сами.
  if (cross) {
    const main = openDb(':memory:');
    migrate(main);
    main.prepare("UPDATE branches SET name = 'Главный корпус' WHERE letter = 'A'").run();
    main.prepare("INSERT INTO branches (name, letter) VALUES ('Второй корпус','B')").run();
    const aId = main.prepare("SELECT id FROM branches WHERE letter = 'A'").get().id;
    const bId = main.prepare("SELECT id FROM branches WHERE letter = 'B'").get().id;
    main.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor, specialty, working_hours, branch_id) VALUES ('doc','x','Петров Пётр','doctor',1,'терапевт',?,?)")
      .run(JSON.stringify(wh), bId);
    main.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor, specialty, working_hours, branch_id) VALUES ('karimov','x','Каримов Рустам','doctor',1,'хирург',?,?)")
      .run(JSON.stringify(wh), aId);
    db.transaction(() => applyCatalogue(db, exportCatalogue(main)))();
    main.close();

    // Врача соседнего здания завёл СПРАВОЧНИК — его id выдала эта база.
    const karimov = db.prepare("SELECT id FROM users WHERE username = 'karimov'").get().id;

    // Возраст картинки соседа — ровно то, что читает «данные на HH:MM».
    const asOf = new Date(day); asOf.setHours(8, 40, 0, 0);
    db.prepare("INSERT INTO control_state (key, value) VALUES ('branch_sync_peer_snapshot', ?)")
      .run(JSON.stringify({ A: { at: asOf.toISOString(), generated_at: asOf.toISOString() } }));

    const far = new Date(day); far.setHours(11, 0, 0, 0);
    db.prepare(`INSERT INTO visits (id, uid, sync_origin, patient_id, doctor_id, service_id, visit_date, duration_minutes, status, booked_at)
                VALUES (56, 'uid-far', 'A', 3, ?, 21, ?, 30, 'scheduled', '2026-09-01T08:00:00.000Z')`)
      .run(karimov, far.toISOString());
    const wait = new Date(day); wait.setHours(13, 0, 0, 0);
    // Наша запись в чужое здание. booked_at — начало ожидания: свежая или
    // застоявшаяся, смотря что проверяем.
    const booked = stale
      ? new Date(Date.now() - 200 * 60000).toISOString()
      : new Date(Date.now() - 12 * 60000).toISOString();
    db.prepare(`INSERT INTO visits (id, patient_id, doctor_id, service_id, visit_date, duration_minutes, status, cross_branch, cross_branch_seq, booked_at)
                VALUES (57, 3, ?, 21, ?, 30, 'scheduled', 'A', 999999, ?)`)
      .run(karimov, wait.toISOString(), booked);
    // Столкновение: то же время, что у чужой записи 56, но занято позже нами.
    // booked_at у неё — то же ожидание, что у 57: она тоже наша и тоже ждёт
    // квитанции. Спор с приехавшей 56 она всё равно проигрывает — та записана
    // 1 сентября, то есть заведомо раньше.
    db.prepare(`INSERT INTO visits (id, patient_id, doctor_id, service_id, visit_date, duration_minutes, status, cross_branch, cross_branch_seq, booked_at)
                VALUES (58, 3, ?, 21, ?, 30, 'scheduled', 'A', 999999, ?)`)
      .run(karimov, far.toISOString(), booked);
    // ПРИЕХАВШАЯ ЗАПИСЬ БЕЗ ВРАЧА: логин её врача нам ещё не привезли
    // (сотрудники едут своим тактом), поэтому doctor_id пуст — ровно так её и
    // приземляет branch-sync/records.js.
    if (nodoc) {
      const nd = new Date(day); nd.setHours(15, 0, 0, 0);
      db.prepare(`INSERT INTO visits (id, uid, sync_origin, patient_id, service_id, visit_date, duration_minutes, status, booked_at)
                  VALUES (59, 'uid-nodoc', 'A', 3, 21, ?, 30, 'scheduled', '2026-09-01T07:00:00.000Z')`)
        .run(nd.toISOString());
    }
  }
  return { db, dayIso: isoOf(day) };
}

/** Отрисовать экран на нужный день. */
async function render({ doctorOff = false, failTable = null, cross = false, stale = false, nodoc = false } = {}) {
  const s = seed({ doctorOff, cross, stale, nodoc });
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

// ═══════════════════════════════════════════════════════════════════════════
// CROSS_BRANCH_CALENDAR_V1 — «видеть и записывать в любой филиал»
// ═══════════════════════════════════════════════════════════════════════════
//
// Экран обязан не просто ПОКАЗАТЬ чужие записи, а показать их так, чтобы
// человек за стойкой не принял картинку часовой давности за живую. Здесь
// проверяется именно это — подписи, а не наличие прямоугольников.

test('чужая запись видна, попадает в колонку СВОЕГО врача и несёт букву здания', async () => {
  const { box } = await render({ cross: true });

  const cards = byClass(box, 'rcal-appt');
  assert.ok(cards.length >= 3, 'чужие записи не нарисовались: ' + cards.length);

  // Колонка врача Каримова — та, в которую приехала чужая запись. Раньше её не
  // было бы вовсе: без врача запись падала в «Не назначено».
  const head = byClass(box, 'rcal-colhead').map(textOf).join(' | ');
  assert.ok(/Каримов Рустам/.test(head), 'колонка врача соседнего здания не нарисована: ' + head);

  const far = cards.find((c) => /11:00–11:30/.test(textOf(c)) && /Главный корпус|A/.test(textOf(c)));
  assert.ok(far, 'у чужой карточки нет буквы здания: ' + cards.map(textOf).join(' | '));
  assert.ok(/данные на 08:40/.test(textOf(far)),
    'у чужой карточки нет отметки возраста — час старая картинка неотличима от живой: ' + textOf(far));
});

test('наша запись в чужое здание помечена «подтверждается», пока квитанции нет', async () => {
  const { box } = await render({ cross: true });
  const card = byClass(box, 'rcal-appt').find((c) => /13:00–13:30/.test(textOf(c)));
  assert.ok(card, 'запись в чужое здание не нарисована');
  assert.ok(/подтверждается/.test(textOf(card)),
    'без этой метки оператор считает, что соседнее здание уже знает о записи: ' + textOf(card));
  assert.ok(String(card.className).includes('rcal-appt-wait'));
});

test('настоящее столкновение НЕ ПРЯЧЕТСЯ: обе записи видны, поздняя помечена', async () => {
  const { box } = await render({ cross: true });
  const eleven = byClass(box, 'rcal-appt').filter((c) => /11:00–11:30/.test(textOf(c)));
  assert.equal(eleven.length, 2, 'обе спорящие записи обязаны остаться видимыми: ' + eleven.length);

  const marked = eleven.filter((c) => /двойная запись/.test(textOf(c)));
  assert.equal(marked.length, 1, 'помечена обязана быть ровно одна — более поздняя');
  assert.ok(String(marked[0].className).includes('rcal-appt-clash'));

  // И рядом сказано, что вообще происходит: возраст данных и правило спора.
  const note = byClass(box, 'rcal-far-note');
  assert.equal(note.length, 1, 'полоса про чужое здание обязана быть над сеткой');
  const txt = textOf(note[0]);
  assert.ok(/данные на 08:40/.test(txt), 'полоса обязана называть возраст картинки: ' + txt);
  assert.ok(/раз в час/.test(txt), 'остаточный риск решения владельца обязан быть назван словами: ' + txt);
});

test('переключатель зданий есть и фильтрует сетку', async () => {
  const { box } = await render({ cross: true });
  const sel = walk(box).filter((n) => n.tagName === 'SELECT'
    && (n.children || []).some((o) => /Все здания/.test(o._t || textOf(o))));
  assert.equal(sel.length, 1, 'переключателя зданий нет — «видеть любой филиал» начинается с него');

  const opts = sel[0].children.map((o) => o._t || textOf(o)).join(' | ');
  assert.ok(/Главный корпус/.test(opts), 'соседнее здание обязано быть в списке: ' + opts);

  sel[0].value = 'A';
  sel[0].dispatchEvent({ type: 'change', target: sel[0] });
  await flush();

  const cards = byClass(box, 'rcal-appt').map(textOf);
  assert.ok(cards.length > 0, 'выбор здания не должен опустошать сетку');
  assert.ok(!cards.some((c) => /Петров Пётр/.test(c)),
    'в здании A не должно быть приёмов врача здания B: ' + cards.join(' | '));
});

// ═══════════════════════════════════════════════════════════════════════════
// ЧЕГО ЭКРАНУ НЕ ХВАТАЛО: ВОЗРАСТ ОЖИДАНИЯ, ЗАПИСЬ БЕЗ ВРАЧА, ПРЕДУПРЕЖДЕНИЕ
// ═══════════════════════════════════════════════════════════════════════════

test('«подтверждается» НЕСЁТ ВОЗРАСТ: свежая и застоявшаяся читаются по-разному', async () => {
  const fresh = await render({ cross: true });
  const freshCard = byClass(fresh.box, 'rcal-appt').find((c) => /13:00–13:30/.test(textOf(c)));
  assert.ok(/подтверждается/.test(textOf(freshCard)));
  assert.ok(/\d+ мин/.test(textOf(freshCard)),
    'без возраста запись пятиминутной давности неотличима от висящей вторые сутки: ' + textOf(freshCard));
  assert.equal(byClass(fresh.box, 'rcal-appt-late').length, 0, 'свежую запись тревогой объявлять нечестно');

  const old = await render({ cross: true, stale: true });
  const oldCard = byClass(old.box, 'rcal-appt').find((c) => /13:00–13:30/.test(textOf(c)));
  const txt = textOf(oldCard);
  assert.ok(/не подтверждено/.test(txt),
    'после порога слово обязано смениться: это уже не «идёт обмен», а повод звонить: ' + txt);
  assert.ok(/3 ч/.test(txt), 'и возраст обязан быть назван: ' + txt);
  // Наших неподтверждённых записей в посеве две, и стареют они вместе: порог
  // — свойство ожидания, а не отдельной карточки.
  assert.equal(byClass(old.box, 'rcal-appt-late').length, 2);

  // И полоса над сеткой поднимает это как ТРЕВОГУ, с действием.
  const alarm = byClass(old.box, 'rcal-far-alarm').map(textOf).join(' ');
  assert.ok(/не подтверждены дольше/.test(alarm), 'полоса обязана назвать застоявшееся ожидание: ' + alarm);
  assert.ok(/позвоните|Проверьте связь/i.test(alarm), 'и сказать, что делать: ' + alarm);
});

test('приехавшая запись БЕЗ ВРАЧА видна, названа и попадает в «Не назначено»', async () => {
  const { box } = await render({ cross: true, nodoc: true });

  const card = byClass(box, 'rcal-appt').find((c) => /15:00–15:30/.test(textOf(c)));
  assert.ok(card, 'запись без врача обязана быть видна: пациент едет, а сетка молчала');
  const txt = textOf(card);
  assert.ok(/врач не определён/.test(txt), 'сказано, ЧЕГО про неё не знают: ' + txt);
  assert.ok(/время не занято/.test(txt),
    'и главное — что её время у нас не занято ни у кого: ' + txt);
  assert.ok(/A|Главный корпус/.test(txt), 'здание берётся из автора строки: ' + txt);

  const alarm = byClass(box, 'rcal-far-alarm').map(textOf).join(' ');
  assert.ok(/без врача/.test(alarm), 'полоса обязана посчитать такие записи: ' + alarm);
});

test('ПЕРЕД записью в чужое здание на занятое там время оператора СПРАШИВАЮТ', async () => {
  const { box } = await render({ cross: true, nodoc: true });
  const karimov = DB.prepare("SELECT id FROM users WHERE username = 'karimov'").get().id;

  // Клетка 15:00 в дорожке врача соседнего здания — ровно та, на которую уже
  // едет приехавший пациент без врача.
  const lane = walk(box).find((n) => String(n.className).split(/\s+/).includes('rcal-lane')
    && String(n.dataset.res) === String(karimov));
  assert.ok(lane, 'дорожка врача соседнего здания не нарисована');
  const cell = lane.children.find((c) => c.attrs['data-min'] === String(15 * 60));
  assert.ok(cell, 'клетки 15:00 в дорожке нет');
  cell.click();
  await flush();

  const dlg = byClass(document.body, 'rcal-confirm')[0];
  assert.ok(dlg, 'предупреждение обязано достаться ТОМУ, КТО ЕЩЁ НЕ ЗАПИСАЛ, а не тому, кто уже записал');
  const txt = textOf(dlg);
  assert.ok(/уже ждут пациента/.test(txt), 'сказано, что именно не так: ' + txt);
  assert.ok(/врач у этой записи не определён/.test(txt), txt);
  assert.ok(/Всё равно записать/.test(txt), 'и остаётся возможность записать: отказ терял бы пациента при свободном времени');

  // Отмена закрывает и НЕ открывает мастер: спрашивают всерьёз.
  const cancel = walk(dlg).find((n) => n.tagName === 'BUTTON' && /Отмена/.test(textOf(n)));
  cancel.click();
  await flush();
  assert.equal(byClass(document.body, 'rcal-confirm').length, 0);
});
