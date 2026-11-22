// SETTINGS_SUBNAV_V1 (2026-11-21) заменил гармошку: группы — в боковой колонке,
// здесь — одна выбранная (тесты ниже). Описание прежней гармошки оставлено как
// история.
//
// SETTINGS_HUB_LIST_V1 (2026-10-16, owner: «make groups as a list and foldable,
// default view is folded») — хаб «Настройки» показывает группы списком, одну
// под другой, и каждая сворачивается щелчком по своей шапке.
//
// Что здесь закреплено:
//   * при открытии страницы ВСЕ группы свёрнуты, а идут они в порядке
//     объявления GROUPS — сортировка по числу разделов служила только сетке
//     (карточки в одной строке должны были быть одной высоты) и ушла с ней;
//   * шапка — кнопка с aria-expanded; щелчок раскрывает только свою группу,
//     повторный — сворачивает;
//   * открытая группа переживает повторное монтирование хаба: человек зашёл
//     в справочник и вернулся — группа, из которой он ушёл, всё ещё открыта;
//   * поиск раскрывает каждую группу с совпадениями (свёрнутый результат
//     поиска бесполезен), а пустой запрос возвращает прежний свёрнутый вид;
//   * одна кнопка «Развернуть все» / «Свернуть все» рядом с поиском.
//
// Строки свёрнутой группы остаются в DOM (скрыты `hidden`): по ним читают
// хаб settings-hub-groups.test.mjs и его соседи, в них же пишет статус
// обновления (UPDATE_STATUS_ROW_V1). Поэтому «свёрнута» здесь — это
// aria-expanded="false" у шапки И hidden у тела, а не отсутствие строк.
//
// Fake-DOM harness — copied from __tests__/settings-hub-groups.test.mjs,
// including the localStorage 'admin.lang'='ru' pin BEFORE the view imports.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.hidden=false;}
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
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){},
  easymed: { state: { user: { id: 'u-1', full_name: 'Администратор', role: 'admin', is_super_admin: true } } },
  CLINIC: { id: 1 },
  confirm: () => true,
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byClass = (root, cls) => walk(root).filter((n) => String(n.className).split(/\s+/).includes(cls));

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// Поисковые поля запускают поиск после паузы (SEARCH_DEBOUNCE_V1, 500 мс).
const SEARCH_SETTLE_MS = 600;

// --- fake server: the hub only asks update_status for the «Система» row ------
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length).split('?')[0];
    const data = {
      update_status: { current_version: '0.1.3', offer: null, approved: false, last_result: null },
    }[name] ?? {};
    return { ok: true, json: async () => ({ data }) };
  }
  return { ok: true, json: async () => ({ data: [] }) };
};

const { renderSettingsHub, GROUPS } = await import('../views/settings-hub.js');
const { setFullAccess } = await import('../permissions.js');

// --- hub readers ------------------------------------------------------------
const cards   = (root) => byClass(root, 'set-card');
const headOf  = (card) => byClass(card, 'set-card-head')[0];
const bodyOf  = (card) => byClass(card, 'set-card-body')[0];
const titleOf = (card) => textOf(byClass(card, 'set-card-title')[0] || mk('div')).trim();
const isOpen   = (card) => headOf(card).attrs['aria-expanded'] === 'true'  && bodyOf(card).hidden === false;
const isFolded = (card) => headOf(card).attrs['aria-expanded'] === 'false' && bodyOf(card).hidden === true;
const openTitles = (root) => cards(root).filter(isOpen).map(titleOf);
const foldAllBtn = (root) => byClass(root, 'set-fold-all')[0];

async function mountHub() {
  const root = mk('div');
  await renderSettingsHub(root, { onNavigate: () => {} });
  await tick();
  return root;
}

test('группы идут в порядке объявления GROUPS, а не по числу разделов', async () => {
  setFullAccess('Администратор');
  const root = await mountHub();
  const shown = cards(root).map(titleOf);
  const declared = GROUPS.map((g) => g.title).filter((t) => shown.includes(t));
  assert.deepStrictEqual(shown, declared, 'порядок на экране должен совпадать с порядком GROUPS');
});

// SETTINGS_SUBNAV_V1 (2026-11-21, владелец со снимком хаба: «all block of
// setting should be seen in right navigation and drop down items in main
// block») — ГАРМОШКИ БОЛЬШЕ НЕТ. Группы — функции раздела «Настройки» в
// боковой колонке, хаб показывает одну выбранную группу (#settings/<key>)
// раскрытой и без кнопки-шапки. Строки остальных групп остаются в разметке
// под hidden — статус обновления и соседние тесты читают их, как и раньше.
const shownCards = (root) => cards(root).filter((c) => c.hidden !== true);
async function mountHubAt(sub, extra = {}) {
  const root = mk('div');
  await renderSettingsHub(root, { onNavigate: () => {}, payload: sub ? { sub } : null, ...extra });
  await tick();
  return root;
}

test('на экране одна группа — выбранная, раскрытая, с заголовком вместо кнопки', async () => {
  setFullAccess('Администратор');
  const root = await mountHubAt('system');
  const shown = shownCards(root);
  assert.deepStrictEqual(shown.map(titleOf), ['Системные настройки']);
  const c = shown[0];
  assert.ok(String(c.className).includes('set-card--fixed'), 'выбранная группа — .set-card--fixed');
  assert.notStrictEqual(headOf(c).tagName, 'BUTTON', 'шапка выбранной группы — не кнопка: сворачивать нечего');
  assert.strictEqual(bodyOf(c).hidden, false, 'строки выбранной группы видны');
  assert.ok(cards(root).length >= 5, 'строки остальных групп остались в разметке: ' + cards(root).length);
});

test('без подмаршрута — первая видимая группа, и адрес её называет', async () => {
  setFullAccess('Администратор');
  const calls = [];
  const prevHash = globalThis.location;
  globalThis.location = { hash: '#settings' };
  globalThis.history = { state: { view: 'settings', payload: null }, replaceState(st, _t, url) { calls.push([st, url]); }, pushState() {} };
  window.easymedSetTabSub = (tab, sub) => calls.push(['tab', tab, sub]);
  try {
    const root = await mountHubAt(null, { tabId: 'settings' });
    assert.deepStrictEqual(shownCards(root).map(titleOf), [GROUPS[0].title]);
    assert.ok(calls.some((c) => c[0] === 'tab' && c[2] === GROUPS[0].key), 'панель запомнила группу (easymedSetTabSub)');
    assert.ok(calls.some((c) => c[1] === '#settings/' + GROUPS[0].key), 'адрес переписан на #settings/' + GROUPS[0].key);
  } finally {
    globalThis.location = prevHash;
    globalThis.history = { state: null, replaceState(){}, pushState(){} };
    delete window.easymedSetTabSub;
  }
});

test('неизвестная группа в адресе — первая видимая, а не пустой экран', async () => {
  setFullAccess('Администратор');
  const root = await mountHubAt('no-such-group');
  assert.deepStrictEqual(shownCards(root).map(titleOf), [GROUPS[0].title]);
});

test('у каждой группы есть свой ключ для адреса, и ключи не повторяются', () => {
  const keys = GROUPS.map((g) => g.key);
  assert.ok(keys.every((k) => typeof k === 'string' && /^[a-z-]+$/.test(k)), 'ключи: ' + keys.join(', '));
  assert.strictEqual(new Set(keys).size, keys.length, 'ключи групп повторяются');
});

test('поиск ищет по ВСЕМ группам, пустой запрос возвращает выбранную', async () => {
  setFullAccess('Администратор');
  const root = await mountHubAt('staff');
  const inp = byClass(root, 'set-search')[0];
  assert.ok(inp, 'поле поиска на месте');
  inp.value = 'Telegram';
  inp.dispatchEvent({ type: 'input' });
  await tick(SEARCH_SETTLE_MS);
  assert.ok(shownCards(root).some((c) => titleOf(c) === 'Системные настройки'), 'найдено вне выбранной группы');
  for (const c of shownCards(root)) assert.strictEqual(bodyOf(c).hidden, false, `найденная группа «${titleOf(c)}» раскрыта`);
  assert.strictEqual(foldAllBtn(root).hidden, true, 'кнопке «Развернуть все» нечего сворачивать');
  inp.value = '';
  inp.dispatchEvent({ type: 'input' });
  await tick(SEARCH_SETTLE_MS);
  assert.deepStrictEqual(shownCards(root).map(titleOf), ['Управление пользователями и сотрудниками']);
});

// FIX_318_V1 (B5) — плитка, ведущая в раздел, который скрыт в «Видимости
// разделов» («Товары и препараты» → «Закупки»), открывала «Раздел скрыт».
// Теперь она неактивна и говорит почему; вернули раздел — снова ссылка.
test('FIX_318_V1: плитка скрытого раздела неактивна и объясняет, где его вернуть', async () => {
  setFullAccess('Администратор');
  const went = [];
  const rowOf = (root, label) => byClass(root, 'set-row').find((r) => textOf(byClass(r, 'set-row-name')[0] || mk('div')).includes(label));
  const easymed = globalThis.window.easymed;
  try {
    easymed.isNavHidden = (v) => v === 'inventory';
    const root = mk('div');
    await renderSettingsHub(root, { onNavigate: (r) => went.push(r) });
    await tick();
    const row = rowOf(root, 'Товары и препараты');
    assert.ok(row, 'плитка «Товары и препараты» пропала — её надо показать неактивной, а не убрать молча');
    assert.ok(!String(row.className).split(/\s+/).includes('set-row-link'), 'плитка скрытого раздела осталась ссылкой');
    assert.equal(row.attrs['aria-disabled'], 'true');
    assert.ok(textOf(row).includes('Видимость разделов'), 'не сказано, где вернуть раздел: ' + textOf(row));
    row.click();
    assert.deepStrictEqual(went, [], 'щелчок по неактивной плитке увёл в «Раздел скрыт»');
    // Соседние плитки не тронуты.
    assert.ok(String(rowOf(root, 'Список услуг').className).includes('set-row-link'));

    easymed.isNavHidden = () => false;
    const root2 = mk('div');
    await renderSettingsHub(root2, { onNavigate: (r) => went.push(r) });
    await tick();
    const row2 = rowOf(root2, 'Товары и препараты');
    assert.ok(String(row2.className).includes('set-row-link'), 'раздел вернули — плитка всё ещё неактивна');
    row2.click();
    assert.deepStrictEqual(went, ['inventory']);
  } finally { delete easymed.isNavHidden; }
});
