// KITCHEN_SHEET_V1 — порционник: экран и печатный лист.
//
// Порционник — единственный документ этой задачи, который уходит из программы
// НА БУМАГУ, на пищеблок, где ошибку уже никто не поправит. Поэтому здесь
// проверяется не «отрисовалось без исключения», а то, что на листе:
//   • итог по столам напечатан словами кухни («Стол №5 — 12 порций»);
//   • пациенты сгруппированы по палатам, и порядок сервера не переставлен;
//   • пациент без назначенного стола со листа НЕ ИСЧЕЗАЕТ;
//   • дата и фильтр по отделению уезжают в RPC, а не фильтруются в браузере;
//   • роли: медсестра, старшая, главный врач и админ — да; касса и врач — нет.
//
// Экран поднимается на том же крошечном DOM-стенде, что и другие view-тесты
// (locked-module.test.mjs): настоящего браузера здесь нет, а связку «что
// спросили у сервера → что оказалось на бумаге» проверять надо.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
// ui.js html() парсит svg иконки через <template>.content — стенду нужен и он.
// Содержимое остаётся пустым: иконка это украшение кнопки, и тесты ниже
// смотрят на текст, а не на картинку.
const mk=t=>{const e=new F(t); if(String(t).toLowerCase()==='template') e.content=new F('#fragment'); return e;};
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
// I18N_LOCALE_PIN_V1 — язык пришпилен к ru ДО импорта экрана: i18n.js выбирает
// его один раз, при загрузке модуля, и без этого тест шёл бы по-русски на этой
// машине и по-английски на чистом раннере (тот же приём, что в
// locked-module.test.mjs).
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window={location:{hostname:'localhost'},localStorage:globalThis.localStorage,addEventListener(){},dispatchEvent(){return true;},open:()=>null};
globalThis.CustomEvent=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const classesIn = (root) => {
  const out = new Set();
  for (const n of walk(root)) for (const c of String(n.className || '').split(/\s+/)) if (c) out.add(c);
  return out;
};

// ─── Что отвечает сервер ────────────────────────────────────────────────────

// Одно отделение из двух палат: два пятых стола, один девятый и один пациент
// без назначенного стола.
const SHEET = {
  date: '2026-09-04',
  ward_id: null,
  total_portions: 4,
  totals: [
    { diet_code: '5', diet_name: 'Стол №5', portions: 2 },
    { diet_code: '9', diet_name: 'Стол №9', portions: 1 },
    { diet_code: null, diet_name: null, portions: 1 },
  ],
  rows: [
    { admission_id: 1, patient_name: 'Иванов Иван', ward_id: 1, ward_name: 'Терапия', bed_code: 'K-1', diet_code: '5', diet_name: 'Стол №5', meals_per_day: 4, diet_note: '' },
    { admission_id: 2, patient_name: 'Петров Пётр', ward_id: 1, ward_name: 'Терапия', bed_code: 'K-2', diet_code: '5', diet_name: 'Стол №5', meals_per_day: 6, diet_note: 'без соли' },
    { admission_id: 3, patient_name: 'Сидорова Мария', ward_id: 2, ward_name: 'Хирургия', bed_code: 'X-1', diet_code: '9', diet_name: 'Стол №9', meals_per_day: 5, diet_note: '' },
    { admission_id: 4, patient_name: 'Юсупов Алишер', ward_id: 2, ward_name: 'Хирургия', bed_code: 'X-2', diet_code: null, diet_name: null, meals_per_day: null, diet_note: '' },
  ],
};

// Лист, который отдаёт сервер, подменяем по тесту: экран обязан выглядеть
// целым и в тот день, когда в отделении никого нет, и когда RPC не ответил.
const EMPTY_SHEET = { date: '2026-09-04', ward_id: null, total_portions: 0, totals: [], rows: [] };
let SHEET_REPLY = SHEET;      // что вернуть на kitchen_sheet
let SHEET_FAILS = false;      // сервер молчит

const rpcCalls = [];
const dbCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/')) {
    rpcCalls.push({ name: u.slice('/api/rpc/'.length), args: JSON.parse((opts && opts.body) || '{}') });
    if (SHEET_FAILS) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    return { ok: true, json: async () => ({ data: SHEET_REPLY }) };
  }
  dbCalls.push(u);
  return { ok: true, json: async () => ({ data: [{ id: 1, name: 'Терапия' }, { id: 2, name: 'Хирургия' }] }) };
};

// ─── Настоящий CSS ──────────────────────────────────────────────────────────
//
// «Схлопнутые поля и рамки» родились ровно из ОТСУТСТВИЯ правила: экран ставил
// класс .table, .card-title, .field-label, .input — и ни одного из них в CSS
// не было. Тесты ниже поэтому читают НАСТОЯЩИЕ таблицы стилей и проверяют, что
// у каждого класса, который экран вешает на узел, правило есть, а у коробок
// есть размер. Разбор тот же, что в lab-card.test.mjs.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSSDIR = path.resolve(HERE, '..', '..', '..', 'css');
const CSS = ['admin.css', 'admin-views.css']
  .map((f) => fs.readFileSync(path.join(CSSDIR, f), 'utf8'))
  .join('\n').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const BLOCKS = (() => {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(CSS))) {
    const sels = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const decls = {};
    for (const part of m[2].split(';')) {
      const j = part.indexOf(':');
      if (j === -1) continue;
      decls[part.slice(0, j).trim()] = part.slice(j + 1).trim();
    }
    out.push({ sels, decls });
  }
  return out;
})();
/** Объявления правила по точному селектору (все блоки слиты). */
function rule(sel) {
  const norm = sel.trim().replace(/\s+/g, ' ');
  const hits = BLOCKS.filter((b) => b.sels.includes(norm));
  assert.ok(hits.length, 'правило «' + sel + '» пропало из таблиц стилей');
  return Object.assign({}, ...hits.map((b) => b.decls));
}
/** Есть ли ХОТЬ ОДНО правило, которое красит этот класс. */
function classIsStyled(cls) {
  const re = new RegExp('\\.' + cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
  return BLOCKS.some((b) => b.sels.some((s) => re.test(s)));
}

const {
  renderKitchenSheet, kitchenSheetHtml, groupByWard, portionLine,
  wardTitle, dietTitle, mealsTitle, canSeeKitchenSheet, KITCHEN_SHEET_ROLES,
} = await import('../views/kitchen-sheet.js');
const { setLang } = await import('../i18n.js');

// ─── 1. Группировка и подписи ───────────────────────────────────────────────

test('строки группируются по палатам в порядке, присланном сервером', () => {
  const groups = groupByWard(SHEET.rows);
  assert.deepEqual(groups.map((g) => g.ward_name), ['Терапия', 'Хирургия']);
  assert.deepEqual(groups[0].rows.map((r) => r.bed_code), ['K-1', 'K-2']);
  assert.equal(groups[1].rows.length, 2);
});

test('пациент без палаты не выпадает из порционника', () => {
  const groups = groupByWard([{ patient_name: 'Ничей', ward_id: null, ward_name: null }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ward_id, null);
  assert.equal(wardTitle(groups[0]), 'Без палаты');
});

test('итог по столам напечатан словами кухни', () => {
  assert.equal(portionLine(SHEET.totals[0]), 'Стол №5 — 2 порц.');
  assert.equal(portionLine(SHEET.totals[1]), 'Стол №9 — 1 порц.');
});

test('пациент без стола назван, а не пропущен: кухня всё равно его кормит', () => {
  assert.equal(dietTitle(SHEET.rows[3]), 'Стол не назначен');
  assert.equal(portionLine(SHEET.totals[2]), 'Стол не назначен — 1 порц.');
});

test('разовость питания читается словами, а пустая — прочерком', () => {
  assert.equal(mealsTitle(4), '4-разовое');
  assert.equal(mealsTitle(6), '6-разовое');
  assert.equal(mealsTitle(null), '—');
});

// ─── 2. Печатный лист ───────────────────────────────────────────────────────

test('на печатном листе есть дата, итог по столам и каждый пациент', () => {
  const html = kitchenSheetHtml({
    date: SHEET.date, wardName: null, totals: SHEET.totals,
    rows: SHEET.rows, totalPortions: SHEET.total_portions,
  });
  // DATE_FMT_V1 — дата на бумаге написана словом: лист читает человек.
  assert.ok(html.includes('Порционник на 4 сентября 2026'),
    'дата на листе снова машинная: ' + html.slice(html.indexOf('<h1>'), html.indexOf('</h1>') + 5));
  assert.ok(!html.includes('2026-09-04'), 'ISO-дата всё ещё печатается где-то на листе');
  assert.ok(html.includes('Стол №5 — 2 порц.'), 'итог кухни');
  assert.ok(html.includes('Всего порций: 4'));
  for (const r of SHEET.rows) assert.ok(html.includes(r.patient_name), r.patient_name);
  assert.ok(html.includes('Терапия') && html.includes('Хирургия'), 'обе палаты озаглавлены');
  assert.ok(html.includes('Стол не назначен'), 'пациент без стола на листе есть');
});

test('лист печатает сам себя и не тащит внешних ресурсов', () => {
  const html = kitchenSheetHtml({ date: '2026-09-04', totals: [], rows: [], totalPortions: 0 });
  assert.match(html, /window\.print\(\)/, 'окно печатается само — как остальные печатные формы');
  assert.ok(!/<link[^>]+href=/i.test(html), 'ни одной внешней ссылки: пищеблок печатает офлайн');
  assert.ok(html.includes('В отделении никто не лежит'), 'пустой лист говорит, что он пуст');
});

test('печатный лист безопасен к кавычкам и скобкам в имени пациента', () => {
  const html = kitchenSheetHtml({
    date: '2026-09-04', totals: [], totalPortions: 1,
    rows: [{ patient_name: 'Ким <script>alert("x")</script>', ward_id: 1, ward_name: 'Терапия', bed_code: 'K-1' }],
  });
  assert.ok(!html.includes('<script>alert'), 'имя пациента экранировано');
  assert.ok(html.includes('&lt;script&gt;'));
});

// ─── 3. Экран ───────────────────────────────────────────────────────────────

test('экран спрашивает порционник у сервера и показывает итог и палаты', async () => {
  rpcCalls.length = 0;
  const root = mk('div');
  await renderKitchenSheet(root, {});

  const sheetCalls = rpcCalls.filter((c) => c.name === 'kitchen_sheet');
  assert.equal(sheetCalls.length, 1, 'один запрос порционника при открытии');
  assert.match(sheetCalls[0].args.date, /^\d{4}-\d{2}-\d{2}$/, 'дата уезжает на сервер');
  assert.equal('ward_id' in sheetCalls[0].args, false, 'без фильтра отделение не передаётся');

  const text = textOf(root);
  assert.ok(text.includes('Порционник'));
  assert.ok(text.includes('Стол №5 — 2 порц.'), 'итог кухни на экране');
  assert.ok(text.includes('Терапия') && text.includes('Хирургия'));
  assert.ok(text.includes('Юсупов Алишер'), 'пациент без стола показан');
});

test('фильтр по отделению уходит В RPC, а не режет строки в браузере', async () => {
  rpcCalls.length = 0;
  const root = mk('div');
  await renderKitchenSheet(root, {});
  const selects = walk(root).filter((n) => n.tagName === 'SELECT');
  assert.equal(selects.length, 1, 'одна выборка отделения');
  // Палаты подставлены из справочника, «Все отделения» — первым.
  assert.deepEqual(selects[0].children.map((o) => textOf(o).trim()), ['Все отделения', 'Терапия', 'Хирургия']);

  selects[0].value = '2';
  selects[0].dispatchEvent({ type: 'change' });
  await new Promise((r) => setTimeout(r, 0));

  const last = rpcCalls.filter((c) => c.name === 'kitchen_sheet').pop();
  assert.equal(last.args.ward_id, 2, 'отделение считает сервер: он же знает, кто лежит');
});

test('смена даты перезапрашивает лист на ту дату', async () => {
  rpcCalls.length = 0;
  const root = mk('div');
  await renderKitchenSheet(root, {});
  const input = walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'date');
  assert.ok(input, 'дата выбирается календарём, а не набирается строкой');
  input.value = '2026-09-01';
  input.dispatchEvent({ type: 'change' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rpcCalls.filter((c) => c.name === 'kitchen_sheet').pop().args.date, '2026-09-01');
});

// ─── 4. Роли ────────────────────────────────────────────────────────────────

test('порционник открывают медсестра, старшая, главный врач и админ', () => {
  assert.deepEqual(KITCHEN_SHEET_ROLES, ['nurse', 'senior_nurse', 'head_doctor', 'admin']);
  assert.equal(canSeeKitchenSheet({ role: 'nurse' }), true);
  assert.equal(canSeeKitchenSheet({ role: 'admin' }), true);
  // Надстроечные роли живут в extra_roles: старшая остаётся медсестрой,
  // главный врач — врачом (roles.js EXTRA_ONLY_ROLES).
  assert.equal(canSeeKitchenSheet({ role: 'doctor', extra_roles: ['head_doctor'] }), true);
  assert.equal(canSeeKitchenSheet({ role: 'nurse', extra_roles: ['senior_nurse'] }), true);
});

test('касса, регистратура и обычный врач порционник не открывают', () => {
  assert.equal(canSeeKitchenSheet({ role: 'doctor' }), false, 'свой стол врач видит в карте пациента');
  assert.equal(canSeeKitchenSheet({ role: 'cashier' }), false);
  assert.equal(canSeeKitchenSheet({ role: 'registrar' }), false);
  assert.equal(canSeeKitchenSheet(null), false);
  assert.equal(canSeeKitchenSheet({}), false);
});

// ═══ 5. ЯЗЫК ИНТЕРФЕЙСА: НИ ОДНОЙ СХЛОПНУТОЙ КОРОБКИ ════════════════════════
//
// Владелец: «fields and frames are collapsed». Причина оказалась не в
// оформлении: экран ставил четыре класса, которых в таблицах стилей НЕТ —
// .table (таблица палаты рисовалась голым <table>), .card-title, .field-label
// и .input, — а `.card` он брал без `.card-pad`, у которой и живут отступы.
// Тесты ниже стерегут не «класс проставлен», а следствие: у каждого класса,
// который экран вешает на узел, есть правило, и у каждой коробки есть размер.

/** Монтирует экран в заданном состоянии сервера и отдаёт корень и окно. */
async function screen({ reply = SHEET, fails = false } = {}) {
  SHEET_REPLY = reply; SHEET_FAILS = fails;
  const root = mk('div');
  const view = await renderKitchenSheet(root, {});
  await new Promise((r) => setTimeout(r, 0));
  const wins = byClass(root, 'card');
  assert.equal(wins.length, 1, 'рабочее окно должно быть ровно одно, а их ' + wins.length);
  return { root, win: wins[0], view };
}
const STATES = {
  sheet: () => screen({}),
  empty: () => screen({ reply: EMPTY_SHEET }),
  error: () => screen({ fails: true }),
};

// Классы без собственного правила — их ровно два, и оба это МЕТКИ экрана
// (корень .ks и вход .fade-in красится анимацией по имени), а не оформление.
const UNSTYLED_OK = new Set(['ks']);

test('ни один класс экрана не остался без правила — именно этим и были «схлопнутые рамки»', async () => {
  for (const [name, mount] of Object.entries(STATES)) {
    const { root } = await mount();
    for (const cls of classesIn(root)) {
      if (UNSTYLED_OK.has(cls)) continue;
      assert.ok(classIsStyled(cls),
        name + ': класс «' + cls + '» экран вешает, а правила для него нет ни в одной таблице стилей');
    }
  }
});

test('в каждом состоянии есть коробка настоящего размера, а не полоска у рамки', async () => {
  // Пусто / грузится / не загрузилось — блок с высотой и отступами.
  for (const name of ['empty', 'error']) {
    const { root } = await STATES[name]();
    const notes = byClass(root, 'ks-note');
    assert.equal(notes.length, 1, name + ': состояние нарисовано без блока-заглушки');
    assert.ok(textOf(notes[0]).trim().length > 10, name + ': заглушка молчит о том, что случилось');
  }
  const note = rule('.ks-note');
  assert.ok(parseFloat(note['min-height']) >= 120, 'заглушка снова схлопнулась по высоте: ' + note['min-height']);
  assert.ok(/\d/.test(String(note.padding || '')), 'у заглушки нет отступов');

  // Полоса фильтров: у `.field` внутри строки-контейнера ШИРИНА задана явно —
  // без этого поле даты ужималось до собственного содержимого.
  const f = rule('.ks-bar .field');
  assert.ok(/\d/.test(String(f.flex || '')), 'поле фильтра снова без ширины: flex=' + f.flex);
  assert.ok(parseFloat(f['min-width']) >= 120, 'поле фильтра может сжаться в ничто: ' + f['min-width']);
  assert.ok(/\d/.test(String(rule('.ks-bar').padding || '')), 'полоса фильтров прижата к рамке окна');

  // Таблица палаты — общая таблица продукта (table.list), у неё есть отбивки.
  const td = rule('table.list tbody td');
  assert.ok(parseFloat(td.padding) > 0, 'ячейка таблицы снова без отбивки');
  assert.ok(parseFloat(rule('.ks-tbl')['min-width']) >= 400, 'таблица палаты может схлопнуться по ширине');
  assert.equal(rule('.ks-ward')['overflow-x'], 'auto', 'узкая таблица режется вместо прокрутки');
});

test('таблица палаты — та самая table.list, а не несуществующий .table', async () => {
  const { root } = await STATES.sheet();
  const tables = walk(root).filter((n) => n.tagName === 'TABLE');
  assert.equal(tables.length, 2, 'две палаты — две таблицы');
  for (const t of tables) {
    assert.ok(hasClass(t, 'list'), 'таблица снова без класса list: className=' + t.className);
    assert.ok(!hasClass(t, 'table'), 'вернулся класс .table, которого в CSS нет');
    assert.equal(walk(t).filter((n) => n.tagName === 'TH').length, 5, 'шапка таблицы потеряла колонки');
  }
});

test('окно ОДНО: карточки в карточке нет ни в одном состоянии', async () => {
  for (const [name, mount] of Object.entries(STATES)) {
    const { win } = await mount();
    assert.equal(byClass(win, 'card').length, 1,
      name + ': внутри рабочего окна снова окно — вторая рамка и вторая тень');
  }
  // И у самого окна рамка с тенью — это оно и есть.
  const card = rule('.card');
  assert.ok(/window-line/.test(String(card.border || '')), 'рабочее окно потеряло свою линию');
  assert.ok(/shadow-window/.test(String(card['box-shadow'] || '')), 'рабочее окно потеряло тень');
});

// ═══ 6. ОДНО ГЛАВНОЕ ДЕЙСТВИЕ НА СОСТОЯНИЕ ══════════════════════════════════

test('главная кнопка на экране одна — «Печать», и она гаснет, когда печатать нечего', async () => {
  const want = { sheet: false, empty: true, error: true };   // true = кнопка погашена
  for (const [name, off] of Object.entries(want)) {
    const { root, win } = await STATES[name]();
    assert.equal(win.getAttribute('data-state'), name, name + ': окно считает себя в другом состоянии');
    const primaries = byClass(root, 'btn-primary');
    assert.equal(primaries.length, 1, name + ': главных кнопок ' + primaries.length + ', а должна быть одна');
    assert.ok(textOf(primaries[0]).includes('Печать'), name + ': главная кнопка не «Печать»');
    assert.equal(!!primaries[0].disabled, off,
      name + (off ? ': кнопка печати предлагает напечатать пустой лист' : ': печатать есть что, а кнопка погашена'));
  }
});

// ═══ 7. ДАТА — СЛОВОМ, И НА ТРЁХ ЯЗЫКАХ ═════════════════════════════════════

test('дата листа написана словом на экране и на бумаге — во всех трёх языках', async () => {
  const want = { ru: /сентября/, uz: /sentabr/, en: /September/ };
  try {
    for (const [lang, re] of Object.entries(want)) {
      setLang(lang);
      const { root } = await STATES.sheet();
      const d = byClass(root, 'ks-date');
      assert.equal(d.length, 1, lang + ': дата листа пропала с экрана');
      assert.ok(re.test(textOf(d[0])), lang + ': месяц не написан словом — ' + textOf(d[0]));
      assert.ok(!/^\s*\d{4}-\d{2}-\d{2}\s*$/.test(textOf(d[0])), lang + ': на экране снова ISO');

      const html = kitchenSheetHtml({
        date: SHEET.date, wardName: null, totals: SHEET.totals,
        rows: SHEET.rows, totalPortions: SHEET.total_portions,
      });
      assert.ok(re.test(html), lang + ': на печатном листе дата снова машинная');
      assert.ok(!html.includes('2026-09-04'), lang + ': ISO-дата всё ещё на листе');
    }
  } finally { setLang('ru'); }
});

// ═══ 8. БУМАГА — ГЛАВНОЕ. ЛИСТ ПЕЧАТАЕТСЯ ЦЕЛИКОМ ═══════════════════════════

test('на листе A4 остались палата, дата, пациент, стол и итог по каждому столу', () => {
  const html = kitchenSheetHtml({
    date: SHEET.date, wardName: 'Терапия', totals: SHEET.totals,
    rows: SHEET.rows, totalPortions: SHEET.total_portions,
  });
  assert.ok(html.includes('4 сентября 2026'), 'дата');
  assert.ok(html.includes('>Терапия<') && html.includes('>Хирургия<'), 'палаты озаглавлены');
  for (const r of SHEET.rows) assert.ok(html.includes(r.patient_name), 'пациент ' + r.patient_name);
  assert.ok(html.includes('Стол №5') && html.includes('Стол №9') && html.includes('Стол не назначен'), 'столы');
  // Итог ПО КАЖДОМУ столу, а не только общий: кухня варит по столам.
  for (const t of SHEET.totals) assert.ok(html.includes(portionLine(t)), 'итог «' + portionLine(t) + '» пропал');
  assert.ok(html.includes('Всего порций: 4'), 'общий итог');
  assert.ok(html.includes('Старшая медсестра'), 'подпись, ради которой лист и печатают');
  // A4 и то, от чего лист рвётся не в том месте.
  assert.match(html, /@page\s*\{\s*size:\s*A4/, 'лист перестал быть A4');
  assert.match(html, /tr\s*\{[^}]*page-break-inside:\s*avoid/, 'строка снова может разорваться между листами');
  assert.match(html, /thead\s*\{[^}]*table-header-group/, 'шапка таблицы не повторяется на второй странице');
  assert.match(html, /\.p-ward\s*\{[^}]*page-break-after:\s*avoid/, 'имя палаты может остаться внизу страницы одно');
  assert.match(html, /table-layout:\s*fixed/, 'колонки листа снова пляшут по содержимому');
});

test('колонка «Палата» с листа убрана — палата стоит заголовком над своей таблицей', () => {
  const html = kitchenSheetHtml({
    date: SHEET.date, wardName: null, totals: [], rows: SHEET.rows, totalPortions: 4,
  });
  const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
  assert.ok(!head.includes('Палата'), 'колонка «Палата» вернулась и снова ест пятую часть ширины A4');
  assert.ok(html.includes('Койка') && html.includes('Пациент') && html.includes('Стол'), 'колонки на месте');
  // Но сама палата на листе есть — заголовком.
  assert.ok(html.includes('p-ward">Терапия'), 'палата пропала с листа совсем');
});

// ═══ 9. ШКАЛА ═══════════════════════════════════════════════════════════════

test('все размеры экрана — со шкалы восьми ступеней (пол 12.5px)', () => {
  const STEPS = new Set([12.5, 13.5, 15, 17, 20, 24, 30, 40]);
  for (const sel of ['.ks-date', '.ks-where', '.ks-count', '.ks-chip', '.ks-ward-name',
                     '.ks-ward-n', '.ks-diet', '.ks-note-t']) {
    const v = parseFloat(rule(sel)['font-size']);
    assert.ok(STEPS.has(v), sel + ': ' + v + 'px — не ступень шкалы');
  }
});
