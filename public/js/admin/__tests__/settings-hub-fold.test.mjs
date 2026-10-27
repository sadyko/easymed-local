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

test('при открытии все группы свёрнуты', async () => {
  setFullAccess('Администратор');
  const root = await mountHub();
  const cs = cards(root);
  assert.ok(cs.length >= 5, 'группы на экране: ' + cs.length);
  for (const c of cs) {
    assert.ok(headOf(c), `у группы «${titleOf(c)}» есть шапка .set-card-head`);
    assert.ok(bodyOf(c), `у группы «${titleOf(c)}» есть тело .set-card-body`);
    assert.ok(isFolded(c), `группа «${titleOf(c)}» должна быть свёрнута: aria-expanded=`
      + headOf(c).attrs['aria-expanded'] + ', hidden=' + bodyOf(c).hidden);
  }
});

test('группы идут в порядке объявления GROUPS, а не по числу разделов', async () => {
  setFullAccess('Администратор');
  const root = await mountHub();
  const shown = cards(root).map(titleOf);
  const declared = GROUPS.map((g) => g.title).filter((t) => shown.includes(t));
  assert.deepStrictEqual(shown, declared, 'порядок на экране должен совпадать с порядком GROUPS');
});

test('щелчок по шапке раскрывает только эту группу, повторный — сворачивает', async () => {
  setFullAccess('Администратор');
  const root = await mountHub();
  const [a, b] = cards(root);
  const ta = titleOf(a), tb = titleOf(b);
  headOf(a).click();
  assert.deepStrictEqual(openTitles(root), [ta], `открыта только «${ta}», «${tb}» осталась свёрнутой`);
  headOf(a).click();
  assert.deepStrictEqual(openTitles(root), [], 'повторный щелчок свернул группу');
});

test('открытая группа остаётся открытой при повторном монтировании хаба', async () => {
  setFullAccess('Администратор');
  const root1 = await mountHub();
  const first = cards(root1)[0];
  const t = titleOf(first);
  headOf(first).click();
  const root2 = await mountHub();
  assert.deepStrictEqual(openTitles(root2), [t], 'вернулись из справочника — группа всё ещё открыта');
  // Прибираем за собой: модульное состояние переживает тесты этого файла.
  headOf(cards(root2).find((c) => titleOf(c) === t)).click();
  assert.deepStrictEqual(openTitles(root2), []);
});

test('поиск раскрывает группы с совпадениями, пустой запрос возвращает свёрнутый вид', async () => {
  setFullAccess('Администратор');
  const root = await mountHub();
  const inp = byClass(root, 'set-search')[0];
  assert.ok(inp, 'поле поиска на месте');
  inp.value = 'Telegram';
  inp.dispatchEvent({ type: 'input' });
  await tick(SEARCH_SETTLE_MS);
  const found = cards(root);
  assert.ok(found.some((c) => titleOf(c) === 'Системные настройки'), 'найдена группа с Telegram-ботом');
  for (const c of found) assert.ok(isOpen(c), `найденная группа «${titleOf(c)}» показана раскрытой`);
  inp.value = '';
  inp.dispatchEvent({ type: 'input' });
  await tick(SEARCH_SETTLE_MS);
  assert.ok(cards(root).length >= 5, 'все группы вернулись');
  assert.deepStrictEqual(openTitles(root), [], 'без запроса — снова всё свёрнуто');
});

test('«Развернуть все» раскрывает все группы и становится «Свернуть все»', async () => {
  setFullAccess('Администратор');
  const root = await mountHub();
  const btn = foldAllBtn(root);
  assert.ok(btn, 'кнопка .set-fold-all рядом с поиском');
  assert.strictEqual(textOf(btn).trim(), 'Развернуть все');
  btn.click();
  assert.ok(cards(root).every(isOpen), 'все группы раскрыты');
  assert.strictEqual(textOf(btn).trim(), 'Свернуть все');
  btn.click();
  assert.ok(cards(root).every(isFolded), 'все группы снова свёрнуты');
  assert.strictEqual(textOf(btn).trim(), 'Развернуть все');
});
