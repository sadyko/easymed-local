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
globalThis.window={location:{hostname:'localhost'},localStorage:globalThis.localStorage,addEventListener(){},open:()=>null};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');

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

const rpcCalls = [];
const dbCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/')) {
    rpcCalls.push({ name: u.slice('/api/rpc/'.length), args: JSON.parse((opts && opts.body) || '{}') });
    return { ok: true, json: async () => ({ data: SHEET }) };
  }
  dbCalls.push(u);
  return { ok: true, json: async () => ({ data: [{ id: 1, name: 'Терапия' }, { id: 2, name: 'Хирургия' }] }) };
};

const {
  renderKitchenSheet, kitchenSheetHtml, groupByWard, portionLine,
  wardTitle, dietTitle, mealsTitle, canSeeKitchenSheet, KITCHEN_SHEET_ROLES,
} = await import('../views/kitchen-sheet.js');

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
  assert.ok(html.includes('Порционник на 2026-09-04'), 'заголовок с датой');
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
