// REFERENCE_LISTS_V1 (2026-10-06) — Настройки → «Справочники»: города, районы и
// специальности с кодами, ТОЛЬКО ПРОСМОТР.
//
// Владелец согласовал макет «Справочники» (план «API клиники, шаги 1–2»,
// задача 13): вкладки «Города и районы» и «Специальности»; слева регионы
// Узбекистана (ru, под ним uz · en, число районов), справа районы выбранного
// региона — код, RU, UZ, EN; специальности — код, RU, UZ, EN. Партнёры по API
// получают КОДЫ, и этот экран — место, где клиника видит, какой код у какого
// названия. Ничего не редактируется: списки встроены в программу.
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
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
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
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    sent.push(body);
    if (failDb) return { ok: false, status: 500, json: async () => ({ error: { message: 'server down' } }) };
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
const districtsOf = (regionCode) => db.prepare(`SELECT d.code, d.name, d.name_uz, d.name_en FROM districts d
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
const specRows = (root) => byClass(root, 'ref-spec');

test('стенд: в базе после миграций 14 регионов Узбекистана и 12 районов города Ташкента, у всех код и uz/en', () => {
  assert.equal(UZ_REGIONS.length, 14);
  assert.ok(UZ_REGIONS.every((r) => r.code && r.name_uz && r.name_en), 'миграция 132 не дала кодов и названий регионам');
  const tash = districtsOf('tashkent-city');
  assert.equal(tash.length, 12);
  assert.ok(tash.every((d) => d.code && d.name_uz && d.name_en));
  assert.equal(SPECIALTY_ROWS.length, 120);
});

test('экран строит две вкладки — «Города и районы» и «Специальности» — со счётчиками; открыта первая', async () => {
  const root = await mount();
  assert.deepEqual(refused, [], 'компилятор отверг запрос экрана');
  const names = tabs(root).map((t) => textOf(t).trim());
  assert.equal(names.length, 2, 'вкладок: ' + names.join(' | '));
  const geo = tabNamed(root, 'Города и районы');
  const spec = tabNamed(root, 'Специальности');
  assert.ok(geo && spec, 'вкладки: ' + names.join(' | '));
  assert.ok(geo.className.split(/\s+/).includes('on'), '«Города и районы» не открыта по умолчанию');
  assert.equal(geo.attrs['aria-selected'], 'true');
  assert.equal(spec.attrs['aria-selected'], 'false');
  assert.equal(textOf(byClass(geo, 'tab-count')[0] || mk('i')).trim(), '14', 'счётчик регионов');
  assert.equal(textOf(byClass(spec, 'tab-count')[0] || mk('i')).trim(), String(SPECIALTY_ROWS.length), 'счётчик специальностей');
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
  const sel = regionRows(root).filter((r) => r.attrs['aria-selected'] === 'true');
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
  assert.deepEqual(regionRows(root).filter((r) => r.attrs['aria-selected'] === 'true').map((r) => r.attrs['data-code']), ['tashkent']);

  const sam = regionRows(root).find((r) => r.attrs['data-code'] === 'samarkand');
  sam.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
  await tick();
  assert.deepEqual(districtRows(root).map((r) => cellsOf(r)[0]).sort(), districtsOf('samarkand').map((d) => d.code).sort(),
    'Enter на строке региона не открыл его районы');
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
    tabs(root)[1].click();
    await tick();
    assert.deepEqual(cellsOf(specRows(root)[0]), [s.slug, s.ru, s.uz, s.en], 'колонку RU перевели — tr() добрался до данных');
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
  assert.ok(sent.some((d) => d.table === 'countries' && d.filters.some((f) => f.col === 'code' && f.val === 'UZ')),
    'страна выбирается не по коду UZ');
});

test('сервер не ответил: экран говорит об этом словами, а специальности открываются', async () => {
  failDb = true;
  try {
    const root = await mount();
    assert.ok(textOf(root).includes('Не удалось загрузить города и районы — обновите страницу.'), textOf(root).slice(0, 300));
    assert.equal(regionRows(root).length, 0);
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
