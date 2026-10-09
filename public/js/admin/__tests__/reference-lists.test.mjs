// REFERENCE_LISTS_V1 (2026-10-06) — Настройки → «Справочники»: города, районы и
// специальности с кодами, ТОЛЬКО ПРОСМОТР.
//
// Владелец согласовал макет «Справочники» (план «API клиники, шаги 1–2»,
// задача 13): вкладки «Города и районы» и «Специальности»; слева регионы
// Узбекистана (ru, под ним uz · en, число районов), справа районы выбранного
// региона — код, RU, UZ, EN; специальности — код, RU, UZ, EN. Партнёры по API
// получают КОДЫ, и этот экран — место, где клиника видит, какой код у какого
// названия. Ничего не редактируется: списки встроены в программу.
// Вкладка «Страны» (дизайн API клиники, «Шаг 2»: «страны / регионы / районы с
// кодами и ru / uz / en») — 7 стран миграции 132: код, RU, UZ, EN.
//
// Данные экрана здесь — НАСТОЯЩИЕ: база в памяти после всех миграций
// (миграция 132 — коды и названия ru/uz/en), а каждый запрос экрана к /api/db
// проходит через настоящий server/db/query-compiler.js от имени регистратора.
// Колонка, которой нет в списке чтения реестра, — это 400 от компилятора, то
// есть пустой экран и упавший тест, а не «данных пока нет».
//
// Fake-DOM harness — из __tests__/settings-hub-groups.test.mjs, с тем же
// закреплением 'admin.lang'='ru' ДО импорта видов (I18N_LOCALE_PIN_V1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){document.activeElement=this;} blur(){} scrollTo(){} remove(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.CustomEvent=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
localStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта видов
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener(){}, dispatchEvent() { return true; },
  easymed: { state: { user: { id: 7, full_name: 'Регистратор', role: 'registrar' } } },
  CLINIC: { id: 1 }, confirm: () => true,
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };
const toastEl = mk('div');
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byClass = (root, cls) => walk(root).filter((n) => String(n.className).split(/\s+/).includes(cls));
const cellsOf = (tr) => tr.children.filter((c) => c.tagName === 'TD').map((td) => textOf(td).trim());
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// --- настоящая база и настоящий компилятор ----------------------------------
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { REGISTRY } = await import('../../../../server/db/schema-registry.js');
const db = openDb(':memory:');
migrate(db);

// Регистратор, а не администратор: справочник читает любой сотрудник.
const REGISTRAR = { id: 7, role: 'registrar', extra_roles: [] };
let sent = [];          // каждый запрос экрана к /api/db
let refused = [];       // то, что компилятор отверг
let failDb = false;     // сервер не ответил
const failTables = new Set();   // REFERENCE_LISTS_V1 (ревью итога) — не ответил запрос к одной таблице
let gate = null;        // REFERENCE_LISTS_V1 (ревью M5) — придержать ответы одной отрисовки
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    sent.push(body);
    if (gate) await gate;
    if (failDb || failTables.has(body.table)) return { ok: false, status: 500, json: async () => ({ error: { message: 'server down' } }) };
    let rows;
    try {
      const c = compile(body, REGISTRAR, { db });
      rows = db.prepare(c.sql).all(...c.params);
    } catch (e) {
      refused.push(body.table + ': ' + e.message);
      return { ok: false, status: e.status || 400, json: async () => ({ error: { message: e.message } }) };
    }
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  if (u.startsWith('/api/rpc/')) return { ok: true, json: async () => ({ data: {} }) };
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderReferenceLists } = await import('../views/reference-lists.js');
const { SPECIALTY_ROWS } = await import('../../shared/specialty-list.js');
const { STRINGS } = await import('../i18n-strings.js');
const perms = await import('../permissions.js');

// Что лежит в базе — тем же SQL, мимо экрана.
const UZ_REGIONS = db.prepare(`SELECT r.code, r.name, r.name_uz, r.name_en FROM regions r
  JOIN countries c ON c.id = r.country_id WHERE c.code = 'UZ' AND r.active = 1`).all();
const COUNTRIES = db.prepare('SELECT code, name, name_uz, name_en FROM countries WHERE active = 1').all();
const districtsOf = (regionCode) => db.prepare(`SELECT d.code, d.name, d.name_uz, d.name_en, d.kind FROM districts d
  JOIN regions r ON r.id = d.region_id WHERE r.code = ? AND d.active = 1`).all(regionCode);

async function mount() {
  sent = []; refused = [];
  const root = mk('div');
  await renderReferenceLists(root, {});
  await tick();
  return root;
}
const tabs = (root) => byClass(root, 'tab');
const tabNamed = (root, label) => tabs(root).find((t) => textOf(t).includes(label));
const regionRows = (root) => byClass(root, 'ref-region');
const districtRows = (root) => byClass(root, 'ref-district');
const countryRows = (root) => byClass(root, 'ref-country');
const specRows = (root) => byClass(root, 'ref-spec');

test('стенд: в базе после миграций 14 регионов Узбекистана и 12 районов города Ташкента, у всех код и uz/en', () => {
  assert.equal(UZ_REGIONS.length, 14);
  assert.ok(UZ_REGIONS.every((r) => r.code && r.name_uz && r.name_en), 'миграция 132 не дала кодов и названий регионам');
  const tash = districtsOf('tashkent-city');
  assert.equal(tash.length, 12);
  assert.ok(tash.every((d) => d.code && d.name_uz && d.name_en));
  assert.equal(SPECIALTY_ROWS.length, 120);
  assert.equal(COUNTRIES.length, 7, 'стенд: миграция 132 — 7 стран');
  assert.ok(COUNTRIES.every((c) => c.code && c.name_uz && c.name_en), 'миграция 132 не дала кодов и названий странам');
});

test('экран строит три вкладки — «Города и районы», «Страны» и «Специальности» — со счётчиками; открыта первая', async () => {
  const root = await mount();
  assert.deepEqual(refused, [], 'компилятор отверг запрос экрана');
  const names = tabs(root).map((t) => textOf(t).trim());
  assert.equal(names.length, 3, 'вкладок: ' + names.join(' | '));
  const geo = tabNamed(root, 'Города и районы');
  const countries = tabNamed(root, 'Страны');
  const spec = tabNamed(root, 'Специальности');
  assert.ok(geo && countries && spec, 'вкладки: ' + names.join(' | '));
  assert.ok(geo.className.split(/\s+/).includes('on'), '«Города и районы» не открыта по умолчанию');
  assert.equal(geo.attrs['aria-selected'], 'true');
  assert.equal(countries.attrs['aria-selected'], 'false');
  assert.equal(spec.attrs['aria-selected'], 'false');
  assert.equal(textOf(byClass(geo, 'tab-count')[0] || mk('i')).trim(), '14', 'счётчик регионов');
  assert.equal(textOf(byClass(countries, 'tab-count')[0] || mk('i')).trim(), '7', 'счётчик стран');
  assert.equal(textOf(byClass(spec, 'tab-count')[0] || mk('i')).trim(), String(SPECIALTY_ROWS.length), 'счётчик специальностей');
});

// REFERENCE_LISTS_V1 (ревью итога) — дизайн API клиники, «Шаг 2»: экран
// показывает и страны с кодами и ru / uz / en, а не только регионы и районы.
test('«Страны»: 7 стран из countries — код, RU, UZ, EN; Узбекистан первым, дальше по алфавиту', async () => {
  const root = await mount();
  assert.equal(countryRows(root).length, 0, 'страны видны до открытия своей вкладки');
  tabNamed(root, 'Страны').click();
  await tick();
  assert.ok(tabNamed(root, 'Страны').className.split(/\s+/).includes('on'), 'вкладка не переключилась');
  const rows = countryRows(root);
  assert.equal(rows.length, 7, 'стран на экране: ' + rows.length);
  const got = rows.map(cellsOf);
  for (const c of COUNTRIES) {
    assert.ok(got.some((r) => r[0] === c.code && r[1] === c.name && r[2] === c.name_uz && r[3] === c.name_en),
      'нет строки страны ' + c.code + ' / ' + c.name + ' / ' + c.name_uz + ' / ' + c.name_en);
  }
  assert.equal(got[0][0], 'UZ', 'Узбекистан — первым');
  const rest = got.slice(1).map((r) => r[1]);
  assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b, 'ru')), 'остальные страны не по алфавиту: ' + rest.join(', '));
  assert.equal(regionRows(root).length, 0, 'на вкладке стран остались регионы');
  assert.equal(specRows(root).length, 0, 'на вкладке стран остались специальности');
  // Шапка — та же таблица «Код · RU · UZ · EN», что у районов и специальностей.
  const ths = walk(root).filter((n) => n.tagName === 'TH').map((n) => textOf(n).trim());
  assert.deepEqual(ths, ['Код', 'RU', 'UZ', 'EN']);
});

test('страна, выключенная в «Географии», в списке стран не показана', async () => {
  db.prepare("UPDATE countries SET active = 0 WHERE code = 'AF'").run();
  try {
    const root = await mount();
    tabNamed(root, 'Страны').click();
    await tick();
    const codes = countryRows(root).map((r) => cellsOf(r)[0]);
    assert.equal(codes.length, 6);
    assert.ok(!codes.includes('AF'), 'выключенная страна на экране');
    assert.equal(textOf(byClass(tabNamed(root, 'Страны'), 'tab-count')[0] || mk('i')).trim(), '6', 'счётчик стран');
  } finally {
    db.prepare("UPDATE countries SET active = 1 WHERE code = 'AF'").run();
  }
});

test('«Города и районы»: 14 регионов Узбекистана — ru, под ним uz · en, код из regions.code и число районов', async () => {
  const root = await mount();
  const rows = regionRows(root);
  assert.equal(rows.length, 14, 'регионов на экране: ' + rows.length);
  assert.deepEqual(rows.map((r) => r.attrs['data-code']).sort(), UZ_REGIONS.map((r) => r.code).sort(),
    'коды регионов на экране не те, что в regions.code');
  for (const row of rows) {
    const code = row.attrs['data-code'];
    const want = UZ_REGIONS.find((r) => r.code === code);
    const [nameCell, codeCell, countCell] = cellsOf(row);
    assert.ok(nameCell.startsWith(want.name), code + ': первым идёт русское название — ' + nameCell);
    assert.ok(nameCell.includes(want.name_uz + ' · ' + want.name_en), code + ': под названием нет «uz · en» — ' + nameCell);
    assert.equal(codeCell, want.code, code + ': код региона не показан');
    assert.equal(countCell, String(districtsOf(code).length), code + ': число районов');
  }
  assert.equal(rows[0].attrs['data-code'], 'tashkent-city', 'город Ташкент — первым: он открыт сразу');
});

test('по умолчанию выбран «город Ташкент»: 12 районов — код, RU, UZ, EN из districts', async () => {
  const root = await mount();
  const sel = regionRows(root).filter((r) => r.attrs['aria-current'] === 'true');
  assert.deepEqual(sel.map((r) => r.attrs['data-code']), ['tashkent-city'], 'выбран не город Ташкент');
  const rows = districtRows(root);
  assert.equal(rows.length, 12, 'районов на экране: ' + rows.length);
  const want = districtsOf('tashkent-city');
  const got = rows.map(cellsOf);
  for (const d of want) {
    assert.ok(got.some((c) => c[0] === d.code && c[1] === d.name && c[2] === d.name_uz && c[3] === d.name_en),
      'нет строки района ' + d.code + ' / ' + d.name + ' / ' + d.name_uz + ' / ' + d.name_en);
  }
  const text = textOf(root);
  assert.ok(text.includes('город Ташкент') && text.includes('tashkent-city'), 'над районами не назван выбранный регион и его код');
});

test('выбор другого региона показывает его районы — и клавиатурой тоже', async () => {
  const root = await mount();
  regionRows(root).find((r) => r.attrs['data-code'] === 'tashkent').click();
  await tick();
  const want = districtsOf('tashkent');
  assert.ok(want.length > 12, 'стенд: у Ташкентской области районов больше, чем у города');
  assert.deepEqual(districtRows(root).map((r) => cellsOf(r)[0]).sort(), want.map((d) => d.code).sort());
  assert.deepEqual(regionRows(root).filter((r) => r.attrs['aria-current'] === 'true').map((r) => r.attrs['data-code']), ['tashkent']);
  // REFERENCE_LISTS_V1 (ревью M4) — внутри региона сначала районы, потом города.
  const kinds = districtRows(root).map((r) => want.find((d) => d.code === cellsOf(r)[0]).kind);
  assert.ok(kinds.includes('город') && kinds.includes('район'), 'стенд: в Ташкентской области есть и районы, и города');
  assert.ok(kinds.lastIndexOf('район') < kinds.indexOf('город'), 'город стоит среди районов: ' + kinds.join(', '));

  const sam = regionRows(root).find((r) => r.attrs['data-code'] === 'samarkand');
  sam.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
  await tick();
  assert.deepEqual(districtRows(root).map((r) => cellsOf(r)[0]).sort(), districtsOf('samarkand').map((d) => d.code).sort(),
    'Enter на строке региона не открыл его районы');
});

// REFERENCE_LISTS_V1 (ревью M1) — выбор перерисовывает карточку; фокус не
// должен пропадать в никуда: человек с клавиатурой остаётся на своей строке.
test('фокус после выбора: на выбранной строке региона и на открытой вкладке, а не потерян', async () => {
  const root = await mount();
  document.activeElement = null;
  const sam = regionRows(root).find((r) => r.attrs['data-code'] === 'samarkand');
  sam.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
  await tick();
  const a = document.activeElement;
  assert.ok(a && walk(root).includes(a), 'фокус ушёл на строку, которой больше нет на экране');
  assert.equal(a.attrs['data-code'], 'samarkand', 'фокус не на выбранной строке региона');

  regionRows(root).find((r) => r.attrs['data-code'] === 'bukhara').click();
  await tick();
  assert.equal(document.activeElement.attrs['data-code'], 'bukhara');
  assert.ok(walk(root).includes(document.activeElement));

  tabNamed(root, 'Специальности').click();
  await tick();
  const t = document.activeElement;
  assert.ok(t && walk(root).includes(t), 'фокус ушёл на вкладку, которой больше нет на экране');
  assert.equal(t.attrs.role, 'tab');
  assert.ok(t.className.split(/\s+/).includes('on') && textOf(t).includes('Специальности'), 'фокус не на открытой вкладке');
});

// REFERENCE_LISTS_V1 (ревью M2) — подписи для экранного чтения.
test('экранное чтение: выбранный регион — aria-current, вкладки связаны с панелью', async () => {
  const root = await mount();
  const rows = regionRows(root);
  assert.deepEqual(rows.filter((r) => r.attrs['aria-current'] === 'true').length, 1, 'выбранный регион не отмечен aria-current');
  assert.ok(rows.every((r) => !('aria-selected' in r.attrs)), 'aria-selected на строке таблицы — не то свойство');
  const panel = walk(root).find((n) => n.attrs && n.attrs.role === 'tabpanel');
  assert.ok(panel && panel.attrs.id, 'у панели нет id');
  const ts = tabs(root);
  for (const t of ts) {
    assert.ok(t.attrs.id, 'у вкладки нет id');
    assert.equal(t.attrs['aria-controls'], panel.attrs.id, 'вкладка не указывает на свою панель');
  }
  assert.equal(panel.attrs['aria-labelledby'], ts.find((t) => t.attrs['aria-selected'] === 'true').attrs.id);
  ts.find((t) => textOf(t).includes('Специальности')).click();
  await tick();
  const panel2 = walk(root).find((n) => n.attrs && n.attrs.role === 'tabpanel');
  assert.equal(panel2.attrs['aria-labelledby'], tabNamed(root, 'Специальности').attrs.id, 'панель подписана прежней вкладкой');
});

// REFERENCE_LISTS_V1 (ревью M3) — редактор «География» супер-админа заводит
// регионы без кода; выбор держится за id, а не за код.
test('регионы без кода выбираются каждый своим: выбор по id, а не по коду', async () => {
  const uz = db.prepare("SELECT id FROM countries WHERE code = 'UZ'").get().id;
  const a = db.prepare("INSERT INTO regions (country_id, name) VALUES (?, 'Яя-первый без кода')").run(uz).lastInsertRowid;
  const b = db.prepare("INSERT INTO regions (country_id, name) VALUES (?, 'Яя-второй без кода')").run(uz).lastInsertRowid;
  db.prepare("INSERT INTO districts (region_id, name) VALUES (?, 'Район первого')").run(a);
  db.prepare("INSERT INTO districts (region_id, name) VALUES (?, 'Район второго')").run(b);
  try {
    const root = await mount();
    const second = regionRows(root).find((r) => textOf(r).includes('Яя-второй без кода'));
    assert.ok(second, 'регион без кода не показан');
    second.click();
    await tick();
    const sel = regionRows(root).filter((r) => r.attrs['aria-current'] === 'true');
    assert.equal(sel.length, 1);
    assert.ok(textOf(sel[0]).includes('Яя-второй без кода'), 'выбран не тот регион без кода: ' + textOf(sel[0]));
    assert.deepEqual(districtRows(root).map((r) => cellsOf(r)[1]), ['Район второго'], 'показаны районы чужого региона');
  } finally {
    db.prepare('DELETE FROM districts WHERE region_id IN (?, ?)').run(a, b);
    db.prepare('DELETE FROM regions WHERE id IN (?, ?)').run(a, b);
  }
});

// REFERENCE_LISTS_V1 (ревью M5) — состояние у каждой отрисовки своё: медленная
// прежняя отрисовка не переписывает новую и не рисует себя её состоянием.
test('две отрисовки не делят состояние: поздний ответ первой не трогает вторую', async () => {
  let release;
  gate = new Promise((r) => { release = r; });
  const rootA = mk('div');
  const doneA = renderReferenceLists(rootA, {});
  gate = null;
  const rootB = await mount();
  tabNamed(rootB, 'Специальности').click();
  await tick();
  release();
  await doneA;
  await tick();
  assert.ok(tabNamed(rootA, 'Города и районы').className.split(/\s+/).includes('on'), 'первая отрисовка открыла чужую вкладку');
  assert.equal(regionRows(rootA).length, 14, 'первая отрисовка не показала свои регионы');
  assert.ok(tabNamed(rootB, 'Специальности').className.split(/\s+/).includes('on'), 'вторая отрисовка потеряла свою вкладку');
  assert.equal(specRows(rootB).length, SPECIALTY_ROWS.length);
});

test('«Специальности»: SPECIALTY_ROWS.length (120) строк — код, RU, UZ, EN', async () => {
  const root = await mount();
  tabNamed(root, 'Специальности').click();
  await tick();
  assert.ok(tabNamed(root, 'Специальности').className.split(/\s+/).includes('on'), 'вкладка не переключилась');
  const rows = specRows(root);
  assert.equal(rows.length, SPECIALTY_ROWS.length);
  assert.equal(rows.length, 120);
  rows.forEach((r, i) => {
    const s = SPECIALTY_ROWS[i];
    assert.deepEqual(cellsOf(r), [s.slug, s.ru, s.uz, s.en], 'строка ' + (i + 1));
  });
  assert.equal(regionRows(root).length, 0, 'на вкладке специальностей остались регионы');
});

test('названия — данные, а не текст экрана: на узбекском интерфейсе колонка RU остаётся русской', async () => {
  const { setLang } = await import('../i18n.js');
  const s = SPECIALTY_ROWS[0];
  assert.ok(STRINGS[s.ru] && STRINGS[s.ru].uz && STRINGS[s.ru].uz !== s.ru, 'стенд: «' + s.ru + '» должна быть в словаре — иначе проверка ничего не ловит');
  setLang('uz');
  try {
    const root = await mount();
    assert.ok(textOf(root).includes(STRINGS['Города и районы'].uz), 'подписи экрана не перевелись на узбекский');
    const tash = regionRows(root).find((r) => r.attrs['data-code'] === 'tashkent-city');
    assert.ok(cellsOf(tash)[0].startsWith('город Ташкент'), 'русское название региона перевели: ' + cellsOf(tash)[0]);
    tabs(root).find((t) => textOf(t).includes(STRINGS['Специальности'].uz)).click();
    await tick();
    assert.deepEqual(cellsOf(specRows(root)[0]), [s.slug, s.ru, s.uz, s.en], 'колонку RU перевели — tr() добрался до данных');
    tabs(root).find((t) => textOf(t).includes(STRINGS['Страны'].uz)).click();
    await tick();
    const ru = countryRows(root).find((r) => cellsOf(r)[0] === 'RU');
    assert.ok(ru, 'на узбекском интерфейсе нет строки России');
    assert.equal(cellsOf(ru)[1], 'Россия', 'русское название страны перевели: ' + cellsOf(ru)[1]);
  } finally { setLang('ru'); }
});

test('ничего не редактируется: ни полей, ни кнопок кроме вкладок; на экране «Только просмотр» и подсказка про коды', async () => {
  const root = await mount();
  for (const tag of ['INPUT', 'SELECT', 'TEXTAREA']) {
    assert.equal(walk(root).filter((n) => n.tagName === tag).length, 0, 'на экране есть ' + tag);
  }
  const buttons = walk(root).filter((n) => n.tagName === 'BUTTON');
  assert.ok(buttons.every((b) => b.className.split(/\s+/).includes('tab')), 'на экране кнопка, которая не вкладка');
  const text = textOf(root);
  assert.ok(text.includes('Только просмотр'));
  assert.ok(text.includes('Общие списки: одинаковые у всех клиник и партнёров; партнёры получают коды. Списки встроены в программу и обновляются вместе с ней.'),
    'нет подсказки про общие списки и коды');
  assert.ok(sent.every((d) => d.op === 'select'), 'экран что-то пишет: ' + sent.map((d) => d.table + ' ' + d.op).join(', '));
});

test('запросы к /api/db: только countries / regions / districts и только колонки из списка чтения реестра', async () => {
  await mount();
  assert.deepEqual(refused, []);
  assert.deepEqual([...new Set(sent.map((d) => d.table))].sort(), ['countries', 'districts', 'regions']);
  for (const d of sent) {
    const cols = String(d.columns).split(',').map((c) => c.trim());
    const readable = REGISTRY[d.table].read.columns;
    assert.deepEqual(cols.filter((c) => !readable.includes(c)), [], d.table + ': колонки вне реестра');
    assert.ok(REGISTRY[d.table].read.roles.includes('registrar'), d.table + ': регистратор не читает');
  }
  // Регионы — страны с кодом UZ (по коду, а не по названию или номеру).
  const uzId = db.prepare("SELECT id FROM countries WHERE code = 'UZ'").get().id;
  assert.ok(sent.some((d) => d.table === 'regions' && d.filters.some((f) => f.col === 'country_id' && f.val === uzId)),
    'регионы выбираются не по стране с кодом UZ');
  assert.equal(sent.filter((d) => d.table === 'countries').length, 1, 'страны читаются одним запросом');
});

test('сервер не ответил: экран говорит об этом словами, а специальности открываются', async () => {
  failDb = true;
  try {
    const root = await mount();
    assert.ok(textOf(root).includes('Не удалось загрузить города и районы — обновите страницу.'), textOf(root).slice(0, 300));
    assert.equal(regionRows(root).length, 0);
    tabNamed(root, 'Страны').click();
    await tick();
    assert.ok(textOf(root).includes('Не удалось загрузить страны — обновите страницу.'), textOf(root).slice(0, 300));
    assert.equal(countryRows(root).length, 0);
    tabNamed(root, 'Специальности').click();
    await tick();
    assert.equal(specRows(root).length, SPECIALTY_ROWS.length, 'специальности встроены в программу — им сервер не нужен');
  } finally { failDb = false; }
});

// --- Плитка и маршрут ---------------------------------------------------------

test('плитка «Справочники» в группе «Основное» ведёт на #reference-lists', async () => {
  perms.setFullAccess('Admin');
  const { GROUPS, renderSettingsHub } = await import('../views/settings-hub.js');
  const tile = GROUPS.find((g) => g.title === 'Основное').items.find((i) => i.label === 'Справочники');
  assert.ok(tile, 'плитки нет в «Основном»');
  assert.equal(tile.route, 'reference-lists');
  assert.ok(STRINGS[tile.desc] && STRINGS[tile.desc].uz && STRINGS[tile.desc].en, 'подпись плитки без перевода');
  const nav = [];
  const root = mk('div');
  await renderSettingsHub(root, { onNavigate: (r) => nav.push(r) });
  await tick();
  const row = byClass(root, 'set-row-link').find((n) => textOf(n).includes('Справочники'));
  assert.ok(row, 'плитка не нарисована');
  row.click();
  assert.deepEqual(nav, ['reference-lists']);
});

test('маршрут вшит в оболочку: ветка роутера, «назад» в Настройки, заголовок из CRUMBS', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const shell = fs.readFileSync(path.resolve(HERE, '..', '..', 'admin.js'), 'utf8');
  assert.match(shell, /import \{ renderReferenceLists \} from '\.\/admin\/views\/reference-lists\.js/);
  assert.match(shell, /case 'reference-lists':\s*return void await renderReferenceLists\(viewRoot, ctx\)/);
  const parents = shell.slice(shell.indexOf('const PARENT_OF = {'), shell.indexOf('\n};', shell.indexOf('const PARENT_OF = {')));
  assert.match(parents, /'reference-lists':\s*'settings'/, '«назад» с экрана не ведёт в Настройки');
  const crumbs = shell.slice(shell.indexOf('const CRUMBS = {'), shell.indexOf('\n};', shell.indexOf('const CRUMBS = {')));
  assert.match(crumbs, /'reference-lists':\s*\['Insights', 'Settings', 'Справочники'\]/);
});

test('доступ: экран открывает тот, кому открыты «Настройки»; роли без «Настроек» он закрыт', () => {
  try {
    perms.setEffectiveFromRole({ name: 'registrar', permissions: { sections: ['patients', 'registration'], levels: { patients: 'editor' } } });
    assert.equal(perms.isModuleAllowed('settings'), false, 'стенд: «Настройки» этой роли закрыты');
    assert.equal(perms.isRouteAllowed('reference-lists'), false, 'справочники открылись роли без «Настроек»');

    perms.setEffectiveFromRole({ name: 'registrar', permissions: { sections: ['patients', 'settings'], levels: { settings: 'viewer' } } });
    assert.equal(perms.isRouteAllowed('reference-lists'), true, 'роль с «Настройками» не открывает справочники');
  } finally { perms.setFullAccess('Admin'); }
  assert.equal(perms.isRouteAllowed('reference-lists'), true, 'полный доступ не открывает справочники');
});

// REFERENCE_LISTS_V1 (ревью итога) — у каждой вкладки своя причина. Отказ
// запроса регионов или районов писал и на вкладке «Страны» «Не удалось
// загрузить страны», хотя страны пришли.
test('не ответили регионы или районы — «Страны» показывают страны, «Города и районы» — свою причину', async () => {
  for (const table of ['regions', 'districts']) {
    failTables.clear(); failTables.add(table);
    try {
      const root = await mount();
      assert.ok(textOf(root).includes('Не удалось загрузить города и районы — обновите страницу.'), table + ': ' + textOf(root).slice(0, 300));
      assert.equal(regionRows(root).length, 0);
      tabNamed(root, 'Страны').click();
      await tick();
      assert.ok(!textOf(root).includes('Не удалось загрузить страны'), table + ': страны пришли, а вкладка говорит, что нет');
      assert.equal(countryRows(root).length, 7, table + ': стран на экране ' + countryRows(root).length);
      assert.equal(textOf(byClass(tabNamed(root, 'Страны'), 'tab-count')[0] || mk('i')).trim(), '7', table + ': счётчик стран');
    } finally { failTables.clear(); }
  }
});

test('не ответили страны — обе вкладки географии говорят о своём', async () => {
  failTables.add('countries');
  try {
    const root = await mount();
    assert.ok(textOf(root).includes('Не удалось загрузить города и районы — обновите страницу.'));
    tabNamed(root, 'Страны').click();
    await tick();
    assert.ok(textOf(root).includes('Не удалось загрузить страны — обновите страницу.'));
    assert.equal(countryRows(root).length, 0);
  } finally { failTables.clear(); }
});
