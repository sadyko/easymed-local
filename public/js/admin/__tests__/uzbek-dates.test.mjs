// MONTH_WORDS_V1 (2026-09-05) — узбекская дата пишется месяцем, а не «M11».
//
// Владелец прислал снимок узбекского интерфейса, где на месте даты рождения
// стояло «1994 M11 15», и спросил: «why in uzbek month are not written? or
// written as 5M? can you fix that too across the platform».
//
// «M11» — не сырая дата из базы. Так Intl отвечает за КОРНЕВУЮ локаль, когда в
// сборке браузера нет данных запрошенного языка: сам факт «есть ли на этом
// компьютере данные для uz» решал, прочитает регистратор дату или нет. Поэтому
// лечение не в том, чтобы ловить машинную форму (так и было сделано на одной
// карточке, и остальные шестьдесят экранов продолжали писать «M11»), а в том,
// чтобы Intl не спрашивать вовсе: месяцы лежат в словаре, порядок слов задан
// таблицей шаблонов, и ответ одинаков на любой машине.
//
// Тесты ниже проверяют ровно это, и в таком порядке:
//   1. что именно написано — побуквенно, на трёх языках, включая первый и
//      последний день года;
//   2. что русский и английский вид НЕ изменились: он сверяется с Intl на
//      машине, где данные есть (там же проверяется, что узбекский совпал с
//      CLDR — то есть никакая транслитерация не выдумана);
//   3. что на машине БЕЗ данных для uz (её подделываем) ответ тот же и Intl не
//      спрашивают ни разу;
//   4. что четыре экрана — лабораторная карточка, реестр пациентов, очередь
//      выписки и порционник — печатают узбекский месяц словом; экраны
//      монтируются целиком, а не проверяются «по формату»;
//   5. что ни один экран больше не носит собственную таблицу месяцев.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Поддельный DOM ─────────────────────────────────────────────────────────
// Тот же стенд, что в lab-card.test.mjs / kitchen-sheet.test.mjs: экраны
// монтируются целиком, тесты читают текст узлов.
class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) if (c != null) this.children.push(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} scrollTo() {} scrollIntoView() {} remove() {} select() {}
  closest() { return null; } querySelector() { return null; } querySelectorAll() { return []; }
  get textContent() { return this._t; }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
function mk(t) {
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.CustomEvent = globalThis.Event;
const fakeBody = mk('body');
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: fakeBody, documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById: () => null,
};

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
// I18N_LOCALE_PIN_V1 — язык выбирается ОДИН раз при загрузке i18n.js, поэтому
// пин стоит ДО импорта видов: иначе английская локаль сборочной машины сломала
// бы русские утверждения.
globalThis.localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage,
  addEventListener() {}, dispatchEvent() { return true; }, open: () => null,
  easymed: { state: { user: { id: 'u-1', full_name: 'Регистратор' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => false,
};
globalThis.confirm = () => false;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { clipboard: { writeText: async () => {} }, languages: ['ru-RU'], language: 'ru-RU' },
});

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ─── Что отвечает сервер ────────────────────────────────────────────────────
// Одна пациентка со снимка владельца: 15 ноября 1994 года. Её же дата рождения
// стоит в реестре и на лабораторной карточке, её же месяц ищут утверждения.
const DOB = '1994-11-15';
const PATIENT = {
  id: 'p-1', mrn: 'P-26-70126', full_name: 'Каримова Азиза Рустамовна',
  last_name: 'Каримова', first_name: 'Азиза', middle_name: 'Рустамовна',
  date_of_birth: DOB, gender: 'female', phone: '+998901234567', city: 'Ташкент',
  created_at: '2026-09-01T08:00:00Z',
};
const SVC = { name: 'Общий анализ крови', is_lab: true, type: 'lab', specimen: 'Кровь', tube_color: 'lavender', department_id: 'd-1' };
const VISIT_SERVICES = [{
  id: 805, visit_id: 'v-1', service_id: 's-805', status: 'resulted',
  sample_collected_at: '2026-09-05T08:20:00Z', sync_origin: null, services: SVC,
}];
const VISITS = [{ id: 'v-1', visit_date: '2026-09-05', patients: PATIENT }];
const LAB_RESULTS = [{ id: 1, visit_service_id: 805, parameter: 'Гемоглобин', value: '138', unit: 'г/л', flag: 'normal', notes: null, entered_at: '2026-09-05T09:00:00Z' }];

// Очередь выписки: заявка подана 15 ноября 2026 — тот же месяц, что и у даты
// рождения, чтобы одно утверждение читало один месяц на разных экранах.
const DISCHARGE_QUEUE = {
  ward_id: null, outcomes: ['home', 'transfer', 'refuse', 'death'],
  rows: [{
    admission_id: 1, admission_no: 'ADM-00001', patient_name: 'Каримова Азиза Рустамовна',
    ward_name: 'Терапия', bed_code: 'K-1', attending_name: 'Петров П.П.',
    requested_by_name: 'Петров П.П.', discharge_outcome: 'home', discharge_destination: '',
    discharge_recommendations: '', discharge_requested_at: '2026-11-15T09:00:00Z', active_orders: 0,
    balance: { balance: 0, unbilled: 0, unbilled_lines: 0, invoiced: 0, paid: 0, invoice_count: 0,
      excludes: { internal_lines: 0, internal_amount: 0, void_invoices: 0 } },
  }],
};
const KITCHEN_SHEET = {
  date: '2026-11-15', ward_id: null, total_portions: 1,
  totals: [{ diet_code: '5', diet_name: 'Стол №5', portions: 1 }],
  rows: [{ admission_id: 1, patient_name: 'Каримова Азиза', ward_id: 1, ward_name: 'Терапия', bed_code: 'K-1', diet_code: '5', diet_name: 'Стол №5', meals_per_day: 4, diet_note: '' }],
};

function statusFilter(body) {
  for (const f of (body && body.filters) || []) if (f && f.col === 'status') return f;
  return null;
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    if (name === 'kitchen_sheet') return ok({ data: KITCHEN_SHEET });
    if (name === 'inpatient_capabilities') return ok({ data: { roles: [], can: { discharge: true } } });
    if (name === 'admission_discharge_queue') return ok({ data: DISCHARGE_QUEUE });
    if (name === 'accommodation_state') return ok({ data: { stay_units: 1, invoiced: { units: 1, total: 0 }, current: null, billed: null, stale: false } });
    if (name === 'patient_base_aggregates') return { ok: false, status: 404, json: async () => ({ error: { message: 'Unknown RPC' } }) };
    return ok({ data: null });
  }
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    let rows = {
      patients: [PATIENT],
      visit_services: VISIT_SERVICES,
      visits: VISITS,
      lab_results: LAB_RESULTS,
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }],
    }[table] || [];
    if (table === 'visit_services') {
      const f = statusFilter(body);
      if (f && f.op === 'in') rows = rows.filter((r) => f.val.includes(r.status));
      else if (f && f.op === 'eq') rows = rows.filter((r) => r.status === f.val);
    }
    return ok({ data: JSON.parse(JSON.stringify(rows)), count: rows.length });
  }
  return ok({ data: null });
};

// ─── Модули ─────────────────────────────────────────────────────────────────
const { dateWords, dateNumeric, monthWord, MONTH_KEYS_FORMAT, MONTH_KEYS_STANDALONE } =
  await import('../../shared/date-words.js');
const { STRINGS } = await import('../i18n-strings.js');
const { setLang, getLang, monthName } = await import('../i18n.js');
const { fmtDate, fmtDateTime } = await import('../ui.js');
const { setFullAccess } = await import('../permissions.js');
setFullAccess(true);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(HERE, '..', 'views');

const withLang = async (lang, fn) => {
  const was = getLang();
  setLang(lang);
  try { return await fn(); } finally { setLang(was); }
};

// ═══ 1. ЧТО ИМЕННО НАПИСАНО ═════════════════════════════════════════════════

// Побуквенно, не «месяц не пустой». Первое и последнее число года стоят здесь
// потому, что именно на них ломаются самодельные форматтеры: 1 января любит
// уехать на 31 декабря прошлого года в любом часовом поясе восточнее Гринвича
// (то есть в Ташкенте всегда), а 31 декабря — вперёд.
const EXPECT = [
  ['1994-11-15', { ru: '15 ноября 1994 г.', uz: '15-noyabr, 1994', en: '15 November 1994' }],
  ['2026-01-01', { ru: '1 января 2026 г.',  uz: '1-yanvar, 2026',  en: '1 January 2026' }],
  ['2026-12-31', { ru: '31 декабря 2026 г.', uz: '31-dekabr, 2026', en: '31 December 2026' }],
  ['2026-05-02', { ru: '2 мая 2026 г.',     uz: '2-may, 2026',     en: '2 May 2026' }],
  ['2026-09-05', { ru: '5 сентября 2026 г.', uz: '5-sentabr, 2026', en: '5 September 2026' }],
];

test('дата написана словом на всех трёх языках — побуквенно', async () => {
  for (const [iso, want] of EXPECT) {
    for (const lang of ['ru', 'uz', 'en']) {
      assert.strictEqual(dateWords(iso, { lang }), want[lang], iso + ' / ' + lang);
      // fmtDate — то, чем пользуются экраны; он обязан отдавать ровно это же.
      await withLang(lang, () => {
        assert.strictEqual(fmtDate(iso), want[lang], 'fmtDate ' + iso + ' / ' + lang);
      });
    }
  }
});

test('дата со временем — по правилам каждого языка', async () => {
  const iso = '2026-11-15T09:05:00';
  assert.strictEqual(dateWords(iso, { lang: 'ru', withTime: true }), '15 ноября 2026 г. в 09:05');
  assert.strictEqual(dateWords(iso, { lang: 'uz', withTime: true }), '15-noyabr, 2026, 09:05');
  assert.strictEqual(dateWords(iso, { lang: 'en', withTime: true }), '15 November 2026 at 09:05');
  await withLang('uz', () => assert.strictEqual(fmtDateTime(iso), '15-noyabr, 2026, 09:05'));
});

test('пустое значение остаётся прочерком, а не «Invalid Date»', async () => {
  for (const bad of [null, undefined, '', 'не дата', {}]) {
    assert.strictEqual(dateWords(bad), null, JSON.stringify(bad));
    await withLang('uz', () => assert.strictEqual(fmtDate(bad), '—', JSON.stringify(bad)));
  }
  assert.strictEqual(monthWord(12), '');
  assert.strictEqual(monthWord(-1), '');
  assert.strictEqual(monthWord('ноябрь'), '');
});

test('дата без времени читается как МЕСТНАЯ полночь: 1 января не уезжает во вчера', () => {
  // Тот же разбор, что был в ui.js: 'YYYY-MM-DD' через new Date() — это UTC,
  // и в Ташкенте (UTC+5) он даёт 31 декабря прошлого года.
  assert.strictEqual(dateWords('2026-01-01', { lang: 'ru' }), '1 января 2026 г.');
  assert.strictEqual(dateWords('2026-12-31', { lang: 'ru' }), '31 декабря 2026 г.');
});

// ═══ 2. РУССКИЙ И АНГЛИЙСКИЙ НЕ ИЗМЕНИЛИСЬ ══════════════════════════════════

// Форма собрана здесь вручную — значит, обязана совпасть с тем, что даёт Intl
// на машине, где данные локали ЕСТЬ. Это утверждение работает сразу в две
// стороны: русский и английский вид не мог измениться, а узбекский совпадает с
// CLDR буква в букву — то есть транслитерация не выдумана.
const LOCALE = { ru: 'ru-RU', uz: 'uz-UZ', en: 'en-GB' };
const hasICU = (lang) => {
  try { return Intl.DateTimeFormat.supportedLocalesOf([LOCALE[lang]]).length > 0; }
  catch { return false; }
};

for (const lang of ['ru', 'en', 'uz']) {
  test(`«${LOCALE[lang]}»: весь год совпадает с Intl там, где данные локали есть`, (t) => {
    if (!hasICU(lang)) { t.skip('в этой сборке нет данных для ' + LOCALE[lang]); return; }
    const opts = { day: 'numeric', month: 'long', year: 'numeric' };
    const optsT = { ...opts, hour: '2-digit', minute: '2-digit' };
    for (let m = 0; m < 12; m++) {
      for (const d of [1, 15, 28]) {
        const dt = new Date(2026, m, d, 9, 5);
        assert.strictEqual(dateWords(dt, { lang }),
          new Intl.DateTimeFormat(LOCALE[lang], opts).format(dt),
          'дата ' + dt.toISOString() + ' разошлась с Intl');
        assert.strictEqual(dateWords(dt, { lang, withTime: true }),
          new Intl.DateTimeFormat(LOCALE[lang], optsT).format(dt),
          'дата со временем ' + dt.toISOString() + ' разошлась с Intl');
      }
    }
  });
}

// ═══ 3. МАШИНА БЕЗ ДАННЫХ ДЛЯ UZ ════════════════════════════════════════════

test('на машине без данных локали ответ тот же, и Intl не спрашивают ни разу', async () => {
  // Подделываем ровно тот рантайм, что был у владельца: Intl отдаёт корневую
  // форму «1994 M11 15» на любой запрос. Раньше это и печаталось на экране.
  const real = Intl.DateTimeFormat;
  let intlCalls = 0;
  function RootDTF() {
    intlCalls++;
    return { format: (d) => `${d.getFullYear()} M${d.getMonth() + 1} ${d.getDate()}` };
  }
  RootDTF.supportedLocalesOf = () => [];
  Intl.DateTimeFormat = RootDTF;
  try {
    assert.strictEqual(new Intl.DateTimeFormat('uz-UZ').format(new Date(1994, 10, 15)), '1994 M11 15',
      'подделка рантайма сама сломалась — тест ниже ничего не проверяет');
    intlCalls = 0;   // проверка подделки — не обращение форматтера
    for (const [iso, want] of EXPECT) {
      for (const lang of ['ru', 'uz', 'en']) {
        assert.strictEqual(dateWords(iso, { lang }), want[lang], iso + ' / ' + lang);
      }
    }
    await withLang('uz', () => {
      assert.strictEqual(fmtDate('1994-11-15'), '15-noyabr, 1994');
      assert.strictEqual(fmtDateTime('2026-11-15T09:05:00'), '15-noyabr, 2026, 09:05');
    });
    assert.strictEqual(intlCalls, 0,
      'форматтер всё ещё спрашивает Intl — значит, вид даты снова зависит от того, ' +
      'что установлено на компьютере клиники');
  } finally { Intl.DateTimeFormat = real; }
});

test('машинная форма «1994 M11 15» больше не может получиться ни в одном языке', () => {
  const MACHINE = /\d{4}\s+M\d{1,2}(\s|$)/;
  for (const lang of ['ru', 'uz', 'en']) {
    for (let m = 0; m < 12; m++) {
      for (const d of [1, 15, 31]) {
        const dt = new Date(1994, m, d, 23, 59);
        for (const s of [dateWords(dt, { lang }), dateWords(dt, { lang, withTime: true })]) {
          assert.ok(!MACHINE.test(s), lang + ': машинная форма вернулась — ' + s);
          // Месяц написан именно СЛОВОМ: хотя бы три буквы подряд.
          assert.match(s, /\p{L}{3}/u, lang + ': месяц не написан словом — ' + s);
        }
      }
    }
  }
});

// ═══ 4. СЛОВАРЬ ═════════════════════════════════════════════════════════════

test('все двенадцать месяцев лежат в словаре в трёх языках, в обеих формах', () => {
  for (const keys of [MONTH_KEYS_FORMAT, MONTH_KEYS_STANDALONE]) {
    assert.strictEqual(keys.length, 12);
    for (const key of keys) {
      const e = STRINGS[key];
      assert.ok(e, 'месяца «' + key + '» нет в словаре i18n-strings.js');
      for (const lang of ['ru', 'uz', 'en']) {
        assert.ok(e[lang] && String(e[lang]).trim(), 'месяц «' + key + '» без перевода на ' + lang);
      }
      assert.notStrictEqual(e.uz, e.ru, 'узбекский месяц «' + key + '» — побайтовая копия русского');
    }
  }
  // Узбекские написания взяты из словаря продукта, а не сочинены на месте.
  assert.deepStrictEqual(MONTH_KEYS_FORMAT.map((_, i) => monthWord(i, { lang: 'uz' })),
    ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr']);
  assert.deepStrictEqual(MONTH_KEYS_STANDALONE.map((_, i) => monthWord(i, { lang: 'uz', standalone: true })),
    ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr']);
});

test('monthName берёт язык интерфейса, а не спрашивает его у вызывающего', async () => {
  await withLang('uz', () => {
    assert.strictEqual(monthName(10), 'noyabr');
    assert.strictEqual(monthName(10, { standalone: true }), 'Noyabr');
  });
  await withLang('ru', () => assert.strictEqual(monthName(10), 'ноября'));
  await withLang('en', () => assert.strictEqual(monthName(10), 'November'));
});

// ═══ 5. ЧЕТЫРЕ ЭКРАНА ═══════════════════════════════════════════════════════

// Экраны монтируются целиком: «общий форматтер починен» и «на экране написан
// месяц» — разные утверждения, и владелец видел именно второе.
const UZ_MONTH = /noyabr/;
const NOT_MACHINE = (s, where) => {
  assert.ok(!/\d{4}\s+M\d{1,2}/.test(s), where + ': машинная форма на экране — ' + s.slice(0, 200));
  assert.ok(!/ноябр/.test(s), where + ': в узбекском интерфейсе русский месяц — ' + s.slice(0, 200));
};

test('лабораторная карточка: дата рождения по-узбекски', async () => {
  const { renderLaboratory } = await import('../views/laboratory.js');
  await withLang('uz', async () => {
    fakeBody.children.length = 0;
    const root = mk('div');
    await renderLaboratory(root, { tabId: 't-1' });
    await tick();
    const cards = byClass(root, 'lq-card');
    assert.strictEqual(cards.length, 1, 'карточка пробы не отрисовалась');
    const facts = textOf(byClass(cards[0], 'lq-facts')[0] || cards[0]);
    assert.match(facts, UZ_MONTH, 'на карточке нет узбекского месяца: ' + facts);
    assert.ok(facts.includes('1994'), 'год рождения пропал: ' + facts);
    NOT_MACHINE(facts, 'лабораторная карточка');
  });
});

test('реестр пациентов: дата рождения по-узбекски', async () => {
  await withLang('uz', async () => {
    const { renderPatients } = await import('../views/patients.js?uzdate=1');
    const box = mk('div');
    await renderPatients(box, { onNavigate: () => {}, embedded: true });
    await tick(60);
    const txt = textOf(box);
    assert.match(txt, UZ_MONTH, 'в реестре нет узбекского месяца: ' + txt.slice(0, 300));
    NOT_MACHINE(txt, 'реестр пациентов');
    // PATIENT_DOB_TAIL_V1 — в плотной таблице у даты снимается хвост: русское
    // « г.» и узбекская запятая перед годом. Порядок и язык остаются те же.
    assert.ok(txt.includes('15-noyabr 1994'), 'дата рождения в реестре: ' + txt.slice(0, 300));
  });
});

test('очередь выписки: время заявки по-узбекски', async () => {
  const { renderDischarge } = await import('../views/discharge.js');
  await withLang('uz', async () => {
    const root = mk('div');
    await renderDischarge(root, {});
    await tick(60);
    const txt = textOf(root);
    assert.match(txt, UZ_MONTH, 'в очереди выписки нет узбекского месяца: ' + txt.slice(0, 300));
    assert.ok(txt.includes('15-noyabr, 2026, '), 'дата заявки: ' + txt.slice(0, 300));
    NOT_MACHINE(txt, 'очередь выписки');
  });
});

test('порционник: дата на экране и на печатном листе по-узбекски', async () => {
  const { renderKitchenSheet, kitchenSheetHtml } = await import('../views/kitchen-sheet.js');
  await withLang('uz', async () => {
    const root = mk('div');
    await renderKitchenSheet(root, {});
    await tick(60);
    const screen = textOf(root);
    assert.match(screen, UZ_MONTH, 'на экране порционника нет узбекского месяца: ' + screen.slice(0, 300));
    NOT_MACHINE(screen, 'порционник (экран)');

    // Бумага: лист печатают и читают на пищеблоке — там дата тоже словом.
    const html = kitchenSheetHtml({
      date: KITCHEN_SHEET.date, wardName: null, totals: KITCHEN_SHEET.totals,
      rows: KITCHEN_SHEET.rows, totalPortions: KITCHEN_SHEET.total_portions,
    });
    assert.ok(html.includes('15-noyabr, 2026'), 'на печатном листе дата не по-узбекски');
    assert.ok(!html.includes('2026-11-15'), 'на листе всё ещё печатается ISO-дата');
    NOT_MACHINE(html, 'порционник (бумага)');
  });
});

// ═══ 6. ПЕЧАТНЫЕ БЛАНКИ ═════════════════════════════════════════════════════

test('печатный бланк: дата не зависит от языка компьютера', () => {
  // Раньше это был toLocaleDateString() БЕЗ локали: «05.09.2026» в одной
  // клинике и «05/09/2026» в другой, на одном и том же счёте.
  assert.strictEqual(dateNumeric('2026-09-05'), '05.09.2026');
  assert.strictEqual(dateNumeric('2026-11-15T09:05:00', { withTime: true }), '15.11.2026, 09:05');
  assert.strictEqual(dateNumeric(''), '');
  // Вид совпадает с прежним ru-RU побайтово — бланк не переехал.
  for (const m of [0, 4, 10, 11]) {
    const dt = new Date(2026, m, 5, 9, 5);
    assert.strictEqual(dateNumeric(dt), dt.toLocaleDateString('ru-RU'));
  }
  // Минуты больше не обрезаются: slice(0, 16) отрезал вторую цифру и на чеке
  // стояло «09:0».
  assert.strictEqual(dateNumeric(new Date(2026, 10, 15, 14, 3), { withTime: true }), '15.11.2026, 14:03');
});

test('печатные бланки не собирают дату сами', () => {
  for (const rel of ['../../shared/doc-render.js', 'doc-variants.js', 'receipt-print.js']) {
    const abs = rel.startsWith('..') ? path.resolve(VIEWS, rel) : path.join(VIEWS, rel);
    const src = fs.readFileSync(abs, 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');   // комментарии объясняют, чего там больше нет
    assert.ok(!/toLocaleDateString\(/.test(src), rel + ': бланк снова зовёт toLocaleDateString');
    assert.ok(!/new Date\(\)\.toLocaleString\(/.test(src), rel + ': бланк снова зовёт toLocaleString для даты');
    assert.ok(/dateNumeric\(/.test(src), rel + ': бланк не пользуется общим форматом даты');
  }
});

// ═══ 7. НИ ОДНОГО СОБСТВЕННОГО СПИСКА МЕСЯЦЕВ ═══════════════════════════════

// Полный месяц СЛОВОМ, выписанный в файле экрана, — это и есть та болезнь:
// такой список нельзя перевести, он всегда русский, и на узбекском экране
// стоит русский месяц. Ratchet: список ниже может только сокращаться.
const MONTH_WORD_RE = /['"](январ[ья]|Январь|феврал[ья]|Февраль)['"]/;
const PENDING = new Map([
  ['consultation.js', 'RU_MONTHS — трёхбуквенный ярлык дня в календаре кабинета; файл в этой сессии правит другой агент'],
  ['patient-card.js', 'RU_M_GEN — мёртвая константа (ни одной ссылки); файл в этой сессии правит другой агент'],
]);

test('ни один экран не носит собственную таблицу месяцев (кроме известных двух)', () => {
  const found = [];
  for (const name of fs.readdirSync(VIEWS)) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(VIEWS, name), 'utf8');
    for (const line of src.split(/\r?\n/)) {
      if (line.trim().startsWith('//')) continue;
      if (MONTH_WORD_RE.test(line)) { found.push(name); break; }
    }
  }
  assert.deepStrictEqual(found.sort(), [...PENDING.keys()].sort(),
    'список экранов с собственной таблицей месяцев изменился. Появился новый — уберите его ' +
    '(месяцы даёт i18n.js → monthName); исчез старый — уберите его из PENDING.\n' +
    'Известные: ' + [...PENDING].map(([f, why]) => f + ' — ' + why).join('; '));
  }
);
