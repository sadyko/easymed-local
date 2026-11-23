// CRM_BOOKINGS_TAB_V1 (3.25.0, 2026-11-17) — ВКЛАДКА «ЗАПИСИ CRM» (views/registrar-waiting.js): ФИЛЬТРЫ.
//
// Решение владельца (с макета): регистратор видит записи, не выбирая врача, кабинет или услугу.
// Проверяется экран (сервер — server/routes/registrar-waiting-filters.test.js):
//   • фильтры по умолчанию — сегодня, «CRM / колл-центр», «Ждут», все врачи, без поиска; первый запрос
//     — ровно { sources: ['crm'] } (день и «Ждут» — умолчания сервера);
//   • смена фильтра перечитывает список с нужными аргументами: завтра, 7 дней (от дня сервера), дата
//     (прошлая — сразу «Не пришли»), источник, статус, врач, поиск; «Сбросить фильтры» возвращает всё;
//   • «Оформить по записи» — только у строк «сегодня + Ждёт»; у остальных — «Открыть карту»;
//   • счётчик вкладки — по фильтру по умолчанию, а не по текущему;
//   • клавиатура и подписи: группы с именем, кнопки с aria-pressed, поля с подписью;
//   • ru / uz / en: подписи фильтров на языке экрана.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class F {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {};
    this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
    this.value = ''; this.checked = false; this.disabled = false;
  }
  appendChild(c) { this.children.push(c); c.parentElement = this; c.parentNode = this; return c; }
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
  closest() { return null; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
  getClientRects() { return [1]; }
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
      toggle(c, on) { const has = String(s.className).split(/\s+/).includes(c); const want = on === undefined ? !has : !!on; if (want && !has) this.add(c); if (!want && has) this.remove(c); },
    };
  }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => {
  const e = new F(t);
  if (String(t).toLowerCase() === 'template') {
    e.content = { firstChild: null };
    Object.defineProperty(e, 'innerHTML', { set() { const s = new F('svg'); s._t = ''; e.content.firstChild = s; }, get() { return ''; } });
  }
  if (String(t).toLowerCase() === 'select') Object.defineProperty(e, 'options', { get() { return e.children.filter((c) => c.tagName === 'OPTION'); } });
  return e;
};
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
};
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear() {} };
globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, open: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {} }), scrollTo() {}, scrollY: 0,
  easymed: { state: { user: { id: 2, full_name: 'Регистратура', role: 'registrar' } } },
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.cancelAnimationFrame = () => {};
globalThis.history = { state: null, replaceState() {}, pushState() {} };
const RPC = [];
let RPC_REPLY = null;   // CRM_BOOKINGS_TAB_V1 (направления до оплаты) — ответ registrar_waiting для patientWaitsToday
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/')) RPC.push([decodeURIComponent(u.slice('/api/rpc/'.length)), body]);
  return { ok: true, status: 200, json: async () => ({ data: RPC_REPLY ? JSON.parse(JSON.stringify(RPC_REPLY)) : { today: '2026-11-17', count: 0, rows: [] } }) };
};

const { renderRegistrarWaiting, loadRegistrarWaiting, filterArgs, DEFAULT_FILTER, BADGE_ARGS, canRegisterRow, patientWaitsToday } = await import('../views/registrar-waiting.js');
const { setLang } = await import('../i18n.js');

const TODAY = '2026-11-17';
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
function walk(e, o = []) { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; }
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');
const byAttr = (host, k, v) => walk(host).find((n) => n.attrs && n.attrs[k] === (v === undefined ? n.attrs[k] : String(v)) && k in n.attrs);
const allByAttr = (host, k) => walk(host).filter((n) => n.attrs && k in n.attrs);

/** Подмена сервера: запоминает аргументы, отвечает строками `rows`. */
function fakeLoad(rows = [], { today = TODAY, doctors = [], count = null } = {}) {
  const calls = [];
  const load = async (opts = {}) => {
    calls.push({ args: { ...(opts.args || {}) }, countOnly: !!opts.countOnly });
    if (opts.countOnly) return { today, count: count == null ? rows.length : count, rows: [] };
    return { today, from: today, to: today, count: rows.length, rows: JSON.parse(JSON.stringify(rows)), doctors };
  };
  return { load, calls, lists: () => calls.filter((c) => !c.countOnly).map((c) => c.args) };
}

const ROW = (pid, extra = {}) => ({ patient_id: pid, patient_name: 'Пациент ' + pid, mrn: 'EM-' + pid, phone: '+998 90 000 00 ' + pid, time: '10:00',
  day: TODAY, status: 'waiting', sources: [{ kind: 'crm', name: '' }], doctors: ['Иванов'], services: ['Консультация терапевта'], booked_by: ['Оператор А'],
  lines: [{ kind: 'booked', visit_service_id: pid * 10, visit_id: pid, service_id: 30, doctor_id: 10, name: 'Консультация терапевта' }], reasons: [], ...extra });

test('CRM_BOOKINGS_TAB_V1: фильтры по умолчанию — сегодня, CRM, «Ждут», все врачи, без поиска; первый запрос — { sources: [crm] }', async () => {
  assert.deepEqual({ ...DEFAULT_FILTER }, { day: 'today', date: '', source: 'crm', status: 'waiting', doctorId: '', q: '' });
  assert.deepEqual(filterArgs(DEFAULT_FILTER, TODAY), { sources: ['crm'] });
  assert.deepEqual({ ...BADGE_ARGS }, { sources: ['crm'] }, 'счётчик вкладки — не по фильтру по умолчанию');
  const f = fakeLoad([ROW(1)], { doctors: [{ id: 10, name: 'Иванов' }, { id: 11, name: 'Петрова' }] });
  const host = mk('div');
  await renderRegistrarWaiting(host, {}, { load: f.load });
  assert.deepEqual(f.lists(), [{ sources: ['crm'] }]);
  const pressed = (attr) => allByAttr(host, attr).filter((b) => b.attrs['aria-pressed'] === 'true').map((b) => b.attrs[attr]);
  assert.deepEqual(pressed('data-rwait-day'), ['today']);
  assert.deepEqual(pressed('data-rwait-src'), ['crm']);
  assert.deepEqual(pressed('data-rwait-status'), ['waiting']);
  const sel = byAttr(host, 'data-rwait-doctor');
  assert.equal(sel.tagName, 'SELECT');
  assert.equal(String(sel.value), '');
  assert.deepEqual(sel.children.map((o) => [o.attrs.value, textOf(o).trim()]), [['', 'Все врачи'], ['10', 'Иванов'], ['11', 'Петрова']]);
  assert.equal(byAttr(host, 'data-rwait-q').value, '');
  assert.equal('disabled' in byAttr(host, 'data-rwait-reset').attrs, true, '«Сбросить фильтры» активна при фильтрах по умолчанию');
  assert.match(textOf(host), /Записи CRM/);
});

test('CRM_BOOKINGS_TAB_V1: смена фильтра перечитывает список с нужными аргументами; «Сбросить фильтры» возвращает умолчания', async () => {
  const f = fakeLoad([], { doctors: [{ id: 10, name: 'Иванов' }] });
  const host = mk('div');
  const tab = await renderRegistrarWaiting(host, {}, { load: f.load });
  const press = async (attr, v) => { byAttr(host, attr, v).click(); await tick(); };
  await press('data-rwait-day', 'tomorrow');
  assert.deepEqual(f.lists().at(-1), { day: '2026-11-18', sources: ['crm'] }, 'завтра — от дня сервера');
  await press('data-rwait-day', 'week');
  assert.deepEqual(f.lists().at(-1), { from: TODAY, to: '2026-11-23', sources: ['crm'] }, '7 дней — сегодня … +6');
  const date = byAttr(host, 'data-rwait-date');
  date.value = '2026-11-20';
  date.dispatchEvent({ type: 'change', target: date, currentTarget: date });
  await tick();
  assert.deepEqual(f.lists().at(-1), { day: '2026-11-20', sources: ['crm'] });
  // Прошлый день — сразу «Не пришли» (кто не пришёл), иначе «Ждут» прошлого дня пусты.
  date.value = '2026-11-15';
  date.dispatchEvent({ type: 'change', target: date, currentTarget: date });
  await tick();
  assert.deepEqual(f.lists().at(-1), { day: '2026-11-15', sources: ['crm'], status: 'no_show' });
  assert.equal(byAttr(host, 'data-rwait-status', 'no_show').attrs['aria-pressed'], 'true');
  await press('data-rwait-day', 'today');
  await press('data-rwait-src', 'all');
  assert.deepEqual(f.lists().at(-1), { status: 'no_show' }, '«Все» источники — без sources');
  await press('data-rwait-src', 'calendar');
  await press('data-rwait-status', 'registered');
  assert.deepEqual(f.lists().at(-1), { sources: ['calendar'], status: 'registered' });
  await press('data-rwait-status', 'all');
  const sel = byAttr(host, 'data-rwait-doctor');
  sel.value = '10';
  sel.dispatchEvent({ type: 'change', target: sel, currentTarget: sel });
  await tick();
  assert.deepEqual(f.lists().at(-1), { sources: ['calendar'], status: 'all', doctor_id: 10 });
  const q = byAttr(host, 'data-rwait-q');
  q.value = ' 90 123 ';
  q.dispatchEvent({ type: 'keydown', key: 'Enter', target: q, currentTarget: q, preventDefault() {} });
  await tick();
  assert.deepEqual(f.lists().at(-1), { sources: ['calendar'], status: 'all', doctor_id: 10, q: '90 123' });
  // Перечитывание (живое обновление, минутный опрос, возврат на вкладку) — с теми же фильтрами.
  await tab.reload();
  assert.deepEqual(f.lists().at(-1), { sources: ['calendar'], status: 'all', doctor_id: 10, q: '90 123' }, 'перечитывание потеряло фильтры');
  assert.equal('disabled' in byAttr(host, 'data-rwait-reset').attrs, false);
  await press('data-rwait-reset');
  assert.deepEqual(f.lists().at(-1), { sources: ['crm'] });
  assert.equal(byAttr(host, 'data-rwait-q').value, '');
  assert.equal(String(byAttr(host, 'data-rwait-doctor').value), '');
  assert.equal(byAttr(host, 'data-rwait-day', 'today').attrs['aria-pressed'], 'true');
});

test('CRM_BOOKINGS_TAB_V1: «Оформить по записи» — только у строк «сегодня + Ждёт»; у остальных — «Открыть карту»; статус словами, причина отмены', async () => {
  const rows = [
    ROW(1),
    ROW(2, { status: 'registered' }),
    ROW(3, { day: '2026-11-18' }),
    ROW(4, { day: '2026-11-16', status: 'no_show' }),
    ROW(5, { status: 'cancelled', services: [], lines: [{ kind: 'booking', visit_id: 5, doctor_id: 10 }], no_service: true, reasons: ['Пациент отказался'] }),
  ];
  assert.equal(canRegisterRow(rows[0], TODAY), true);
  assert.equal(canRegisterRow(rows[1], TODAY), false);
  assert.equal(canRegisterRow(rows[2], TODAY), false);
  assert.equal(canRegisterRow({ patient_id: 9 }, TODAY), true, 'строка прежнего вида (без дня и статуса) — сегодняшняя «ждёт»');
  const f = fakeLoad(rows);
  const opened = [];
  const host = mk('div');
  await renderRegistrarWaiting(host, {}, { load: f.load, openWizard: async (_s, patient) => { opened.push(patient.id); } });
  const reg = allByAttr(host, 'data-rwait-register').map((b) => b.attrs['data-rwait-register']);
  assert.deepEqual(reg, ['1'], '«Оформить по записи» не только у сегодняшней «ждёт»');
  assert.deepEqual(allByAttr(host, 'data-rwait-card').map((b) => b.attrs['data-rwait-card']).sort(), ['2', '3', '4', '5']);
  const chip = (pid) => { const row = byAttr(host, 'data-rwait-row', pid); return walk(row).find((n) => n.attrs && 'data-rwait-status-chip' in n.attrs); };
  assert.deepEqual([1, 2, 3, 4, 5].map((p) => chip(p).attrs['data-rwait-status-chip']), ['waiting', 'registered', 'waiting', 'no_show', 'cancelled']);
  assert.match(textOf(chip(2)), /Оформлен/);
  assert.match(textOf(chip(4)), /Не пришёл/);
  assert.match(textOf(byAttr(host, 'data-rwait-row', 5)), /услуга не выбрана/);
  assert.match(textOf(byAttr(host, 'data-rwait-row', 5)), /Причина: Пациент отказался/);
  byAttr(host, 'data-rwait-register', 1).click();
  await tick(30);
  assert.deepEqual(opened, [1]);
});

test('CRM_BOOKINGS_TAB_V1: счётчик вкладки — по фильтру по умолчанию: свой список при умолчаниях, отдельное число при других фильтрах', async () => {
  const counts = [];
  const f = fakeLoad([ROW(1), ROW(2)], { count: 7 });
  const host = mk('div');
  await renderRegistrarWaiting(host, { onCount: (n) => counts.push(n) }, { load: f.load });
  assert.deepEqual(counts, [2], 'при умолчаниях счётчик — не число строк списка');
  assert.equal(f.calls.filter((c) => c.countOnly).length, 0, 'при умолчаниях лишний запрос числа');
  byAttr(host, 'data-rwait-status', 'all').click();
  await tick();
  const cnt = f.calls.filter((c) => c.countOnly);
  assert.deepEqual(cnt.map((c) => c.args), [{ sources: ['crm'] }], 'число спрошено не с фильтром по умолчанию');
  assert.deepEqual(counts, [2, 7], 'счётчик пошёл за текущим фильтром');
});

test('CRM_BOOKINGS_TAB_V1: клавиатура и подписи — группы с именем, кнопки с aria-pressed, поля с подписью, Enter в поиске', async () => {
  const f = fakeLoad([]);
  const host = mk('div');
  await renderRegistrarWaiting(host, {}, { load: f.load });
  const bar = byAttr(host, 'data-rwait-filters');
  assert.ok(bar && bar.attrs['aria-label'], 'у полосы фильтров нет имени');
  const groups = walk(bar).filter((n) => n.attrs && n.attrs.role === 'group').map((g) => g.attrs['aria-label']);
  assert.deepEqual(groups, ['День', 'Источник', 'Статус']);
  for (const attr of ['data-rwait-day', 'data-rwait-src', 'data-rwait-status']) {
    for (const b of allByAttr(host, attr)) {
      assert.equal(b.tagName, 'BUTTON');
      assert.equal(b.attrs.type, 'button');
      assert.ok(['true', 'false'].includes(b.attrs['aria-pressed']), attr + ': нет aria-pressed');
    }
  }
  assert.deepEqual(allByAttr(host, 'data-rwait-src').map((b) => textOf(b).trim()), ['Все', 'CRM / колл-центр', 'Календарь', 'Сайт / партнёр', 'Направил врач']);
  assert.deepEqual(allByAttr(host, 'data-rwait-status').map((b) => textOf(b).trim()), ['Ждут', 'Оформлены', 'Не пришли', 'Отменены', 'Все']);
  assert.deepEqual(allByAttr(host, 'data-rwait-day').map((b) => textOf(b).trim()), ['Сегодня', 'Завтра', '7 дней']);
  for (const attr of ['data-rwait-date', 'data-rwait-doctor', 'data-rwait-q']) {
    const el = byAttr(host, attr);
    assert.ok(el.attrs['aria-label'], attr + ': поле без подписи');
  }
  assert.equal(byAttr(host, 'data-rwait-date').attrs.type, 'date');
  assert.equal(byAttr(host, 'data-rwait-q').attrs.type, 'search');
  assert.equal(byAttr(host, 'data-rwait-reset').tagName, 'BUTTON');
});

test('CRM_BOOKINGS_TAB_V1: ru / uz / en — вкладка и фильтры на языке экрана', async () => {
  try {
    for (const [lang, words] of [
      ['uz', ['CRM yozuvlari', 'Bugun', 'Ertaga', '7 kun', 'Hammasi', 'CRM / call-markaz', 'Kalendar', 'Kutmoqda', 'Rasmiylashtirilgan', 'Kelmadilar', 'Bekor qilingan', 'Barcha shifokorlar']],
      ['en', ['CRM bookings', 'Today', 'Tomorrow', '7 days', 'All', 'CRM / call centre', 'Calendar', 'Waiting', 'Registered', 'No-shows', 'Cancelled', 'All Doctors']],
    ]) {
      setLang(lang);
      const f = fakeLoad([]);
      const host = mk('div');
      await renderRegistrarWaiting(host, {}, { load: f.load });
      const txt = textOf(host);
      for (const w of words) assert.ok(txt.includes(w), lang + ': нет «' + w + '»');
      assert.equal(/[Ѐ-ӿ]/.test(txt), false, lang + ': на экране кириллица: ' + txt.match(/[^ ]*[Ѐ-ӿ][^ ]*/g));
      const attrs = walk(host).flatMap((n) => Object.entries(n.attrs || {}).filter(([k]) => ['aria-label', 'placeholder', 'title'].includes(k)).map(([, v]) => v));
      assert.equal(attrs.some((v) => /[Ѐ-ӿ]/.test(v)), false, lang + ': подписи полей по-русски: ' + attrs.filter((v) => /[Ѐ-ӿ]/.test(v)).join(' | '));
    }
  } finally { setLang('ru'); }
});

test('CRM_BOOKINGS_TAB_V1: loadRegistrarWaiting шлёт фильтры серверу как есть (и count_only)', async () => {
  RPC.length = 0;
  await loadRegistrarWaiting({ countOnly: true, args: BADGE_ARGS });
  await loadRegistrarWaiting({ args: { from: TODAY, to: '2026-11-23', status: 'all' } });
  await loadRegistrarWaiting({ patientId: 5 });
  assert.deepEqual(RPC.map(([n, b]) => [n, b]), [
    ['registrar_waiting', { sources: ['crm'], count_only: true }],
    ['registrar_waiting', { from: TODAY, to: '2026-11-23', status: 'all' }],
    ['registrar_waiting', { patient_id: 5 }],
  ]);
});

// CRM_BOOKINGS_TAB_V1 (вид, снимок владельца 18.11) — поле даты надевает календарь программы
// (ui-datefield.js): родное поле получает класс uidate-native и прячется. Перерисовка фильтров
// переписывала className целиком, класс пропадал, и родное «дд.мм.гггг» вылезало вторым полем
// под «Выберите дату». Отметка «выбрана дата» ставится классом, не затирая чужие классы.
test('CRM_BOOKINGS_TAB_V1 (вид): перерисовка фильтров не снимает чужие классы с поля даты', async () => {
  const f = fakeLoad([]);
  const host = mk('div');
  await renderRegistrarWaiting(host, {}, { load: f.load });
  const date = byAttr(host, 'data-rwait-date');
  date.classList.add('uidate-native');   // так делает enhanceDateField
  const has = (c) => String(date.className).split(/\s+/).includes(c);
  date.value = '2026-11-20';
  date.dispatchEvent({ type: 'change', target: date, currentTarget: date });
  await tick();
  assert.equal(has('uidate-native'), true, 'после выбора даты родное поле остаётся спрятанным');
  assert.equal(has('on'), true, 'выбранная дата отмечена');
  await (async () => { byAttr(host, 'data-rwait-day', 'today').click(); await tick(); })();
  assert.equal(has('uidate-native'), true, 'после «Сегодня» — тоже');
  assert.equal(has('on'), false);
  assert.ok(date.attrs.placeholder, 'у поля даты есть подпись (её показывает календарь программы)');
});

// ─── CRM_BOOKINGS_TAB_V1 (направления до оплаты) ─────────────────────────────
// Решение владельца: направленный врачом пациент ждёт, пока касса не примет оплату. Строка, где всё —
// направления врача в неоплаченном счёте (сервер: to_cashier), — «Ждёт» с подписью «Направил врач — счёт
// выставлен, к кассе» и действием «Открыть визит» (окно счёта визита, как «Открыть визит» кассы), а не
// «Оформить по записи». Строка с выставленным направлением И записью — подпись есть, «Оформить по записи» —
// тоже (запись ещё оформлять). Быстрая регистрация пациента «только к кассе» в «Оформить по записи» не уводит.
const BILLED = (pid, visitId, extra = {}) => ROW(pid, { sources: [{ kind: 'doctor', name: 'Иванов' }], services: ['Анализ крови'], visit_id: visitId,
  to_cashier: true, lines: [{ kind: 'doctor', visit_service_id: pid * 10, visit_id: visitId, service_id: 40, doctor_id: null, name: 'Анализ крови',
    to_cashier: true, invoice_id: 500 + pid, invoice_number: 'INV-' + pid }], ...extra });

test('CRM_BOOKINGS_TAB_V1 (направления до оплаты): canRegisterRow — нет у строки «к кассе»; есть у строки с записью и выставленным направлением', () => {
  assert.equal(canRegisterRow(BILLED(6, 66), TODAY), false, '«Оформить по записи» у строки, которую ждёт касса');
  const mixed = ROW(7, { to_cashier: false, lines: [ROW(7).lines[0], { kind: 'doctor', visit_service_id: 71, visit_id: 7, to_cashier: true }] });
  assert.equal(canRegisterRow(mixed, TODAY), true, 'запись рядом с выставленным направлением осталась без «Оформить по записи»');
  assert.equal(canRegisterRow(ROW(1), TODAY), true);
});

test('CRM_BOOKINGS_TAB_V1 (направления до оплаты): строка «к кассе» — подпись, «Открыть визит» (окно счёта визита), без «Оформить по записи»; после правок окна — список перечитан', async () => {
  const rows = [
    ROW(1),
    BILLED(6, 66),
    ROW(7, { to_cashier: false, sources: [{ kind: 'crm', name: '' }, { kind: 'doctor', name: 'Иванов' }],
      lines: [ROW(7).lines[0], { kind: 'doctor', visit_service_id: 71, visit_id: 7, service_id: 40, name: 'Анализ крови', to_cashier: true, invoice_id: 9 }] }),
    BILLED(8, 88, { day: '2026-11-18' }),
  ];
  const f = fakeLoad(rows);
  const opened = [];
  const host = mk('div');
  await renderRegistrarWaiting(host, {}, { load: f.load, openVisit: async (visitId, onChanged) => { opened.push(visitId); await onChanged(); } });
  assert.deepEqual(allByAttr(host, 'data-rwait-register').map((b) => b.attrs['data-rwait-register']), ['1', '7']);
  const visitBtns = allByAttr(host, 'data-rwait-visit');
  assert.deepEqual(visitBtns.map((b) => b.attrs['data-rwait-visit']), ['6', '8'], '«Открыть визит» не у строк «к кассе»');
  for (const b of visitBtns) {
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.attrs.type, 'button');
    assert.match(textOf(b), /Открыть визит/);
  }
  assert.deepEqual(allByAttr(host, 'data-rwait-card').map((b) => b.attrs['data-rwait-card']), [], 'у строки «к кассе» — «Открыть карту» вместо «Открыть визит»');
  const note = (pid) => walk(byAttr(host, 'data-rwait-row', pid)).find((n) => n.attrs && 'data-rwait-to-cashier' in n.attrs) || null;
  assert.equal(note(1), null, 'подпись «к кассе» у записи без направления');
  for (const pid of [6, 7, 8]) assert.match(textOf(note(pid)), /Направил врач — счёт выставлен, к кассе/, pid + ': нет подписи');
  const chip = walk(byAttr(host, 'data-rwait-row', 6)).find((n) => n.attrs && 'data-rwait-status-chip' in n.attrs);
  assert.equal(chip.attrs['data-rwait-status-chip'], 'waiting');
  const before = f.lists().length;
  byAttr(host, 'data-rwait-visit', 6).click();
  await tick(30);
  assert.deepEqual(opened, [66], '«Открыть визит» открыл не визит строки');
  assert.equal(f.lists().length, before + 1, 'после окна визита список не перечитан');
});

test('CRM_BOOKINGS_TAB_V1 (направления до оплаты): подпись и «Открыть визит» — на языке экрана (uz / en)', async () => {
  try {
    for (const [lang, words] of [
      ['uz', ['Shifokor yo‘lladi — hisob chiqarildi, kassaga', 'Tashrifni ochish']],
      ['en', ['Sent by a doctor — invoice issued, to the cashier', 'Open visit']],
    ]) {
      setLang(lang);
      const f = fakeLoad([BILLED(6, 66)]);
      const host = mk('div');
      await renderRegistrarWaiting(host, {}, { load: f.load });
      const txt = textOf(host);
      for (const w of words) assert.ok(txt.includes(w), lang + ': нет «' + w + '»');
      assert.equal(/[Ѐ-ӿ]/.test(txt.replace(/Пациент 6|Иванов|Анализ крови|Оператор А/g, '')), false, lang + ': на экране кириллица: ' + txt.match(/[^ ]*[Ѐ-ӿ][^ ]*/g));
    }
  } finally { setLang('ru'); }
});

test('CRM_BOOKINGS_TAB_V1 (направления до оплаты): быстрая регистрация — пациент «только к кассе» не «ждёт» (patientWaitsToday), с записью — ждёт', async () => {
  try {
    RPC_REPLY = { today: TODAY, count: 1, rows: [BILLED(6, 66)] };
    assert.equal(await patientWaitsToday(6), false, 'пациента, которого ждёт только касса, увели в «Оформить по записи»');
    RPC_REPLY = { today: TODAY, count: 2, rows: [BILLED(6, 66), ROW(6, { lines: [ROW(6).lines[0]] })] };
    assert.equal(await patientWaitsToday(6), true);
    RPC_REPLY = { today: TODAY, count: 1, rows: [ROW(6)] };
    assert.equal(await patientWaitsToday(6), true);
    RPC_REPLY = { today: TODAY, count: 0, rows: [] };
    assert.equal(await patientWaitsToday(6), false);
  } finally { RPC_REPLY = null; }
});

test('CRM_BOOKINGS_TAB_V1 (направления до оплаты): «Открыть визит» по умолчанию — дверь кассы (cashier-desk.js openVisitWindow) тем же адресом, что у admin.js', async () => {
  const fs = await import('node:fs');
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const stamp = (read('../../admin.js').match(/views\/cashier-desk\.js\?v=([\w-]+)'/) || [])[1];
  assert.ok(stamp, 'admin.js грузит кассу без штампа — проверка смотрит не туда');
  const view = read('../views/registrar-waiting.js');
  const m = view.match(/import\('\.\/cashier-desk\.js(?:\?v=([\w-]+))?'\)/);
  assert.ok(m, '«Открыть визит» не подгружает кассу в момент действия');
  assert.equal(m[1], stamp, 'касса подгружается другим адресом — второй экземпляр модуля');
  assert.match(view, /openVisitWindow\(/, '«Открыть визит» — не дверь кассы');
  assert.match(read('../views/cashier-desk.js'), /export async function openVisitWindow\(/, 'касса не отдаёт свою дверь «Открыть визит»');
});

// CRM_BOOKING_LOG_V1 (2026-11-23, владелец: «add a log … which user sends, applied discount what service and
// what analyses should be performed») — строка называет оператора («Записал(а)»), оформившего, скидку
// (сумма, причина, кто дал) и анализы отдельной строкой; без скидки и без оформления — этих строк нет.
test('CRM_BOOKING_LOG_V1: «Записал(а)», «Оформил(а)», «Скидка … дал(а)» и «Анализы» отдельно от услуг', async () => {
  const rows = [
    ROW(1, { status: 'registered', services: ['Консультация терапевта', 'Анализ крови'], analyses: ['Анализ крови'],
      registered_by: ['Регистратура'], discount: { amount: 10000, base: 100000, notes: ['Группа «Ветераны» −10%'], by: ['Регистратура'] } }),
    ROW(2),
  ];
  const f = fakeLoad(rows);
  const host = mk('div');
  await renderRegistrarWaiting(host, {}, { load: f.load });
  const one = byAttr(host, 'data-rwait-row', 1);
  const t1 = textOf(one);
  assert.match(t1, /Записал\(а\): Оператор А/);
  assert.match(t1, /Оформил\(а\): Регистратура/);
  assert.match(textOf(walk(one).find((n) => n.attrs && 'data-rwait-discount' in n.attrs)), /Скидка: 10 000 сум — Группа «Ветераны» −10% · дал\(а\): Регистратура/);
  assert.match(textOf(walk(one).find((n) => n.attrs && 'data-rwait-analyses' in n.attrs)), /Анализы: Анализ крови/);
  const svc = walk(one).find((n) => n.attrs && n.className === 'rwait-svc' && !('data-rwait-analyses' in n.attrs));
  assert.ok(svc && textOf(svc).includes('Консультация терапевта') && !textOf(svc).includes('Анализ крови'), 'анализ повторён в строке услуг');
  const two = byAttr(host, 'data-rwait-row', 2);
  for (const k of ['data-rwait-discount', 'data-rwait-registered-by', 'data-rwait-analyses']) {
    assert.equal(walk(two).some((n) => n.attrs && k in n.attrs), false, 'у строки без скидки/оформления/анализов есть ' + k);
  }
});
