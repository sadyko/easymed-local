// CRM_CONFIG_V1 (docs/plans/2026-08-24-crm-kanban-settings.md) — the OTHER
// half of the change: views/crm.js no longer hardcodes the funnel. It asks
// crm_config_get for the columns and the sources, and falls back to
// yesterday's board when the answer does not arrive.
//
// The fallback is the point. A settings screen must never be able to blank the
// board, so a 501 from an unmerged server, a network failure or an empty reply
// all have to leave the clinic looking at exactly the eight columns migration
// 046 gave it.
//
// Fake-DOM harness copied from telephony-settings.test.mjs, with one addition:
// crm.js finds its own body with root.querySelector('[data-crm-body]'), so
// this fake implements the attribute-selector form of querySelector. Without
// it the board silently renders nothing and every assertion below would pass
// against an empty screen.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){} closest(){return null;}
 // Only the `[attr]` form crm.js actually uses — enough to let the board mount.
 querySelector(sel){
   const m = /^\[([^\]=]+)\]$/.exec(String(sel));
   if (!m) return null;
   const want = m[1];
   const stack = [...this.children];
   while (stack.length) {
     const n = stack.shift();
     if (n && n.attrs && want in n.attrs) return n;
     if (n && n.children) stack.push(...n.children);
   }
   return null;
 }
 querySelectorAll(){return [];}
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

const store = new Map();
const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — pinned BEFORE the view import, exactly as the other
// fake-DOM fixtures do: i18n.js reads 'admin.lang' once, at module load.
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.window = { location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){}, easymed: { state: { user: null } } };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
// The board marks each column with data-col=<stage key>; that attribute is
// also the drop target, so reading it is reading the real columns.
const columnKeys = (root) => walk(root).filter((n) => 'data-col' in n.attrs).map((n) => n.attrs['data-col']);

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const jsonErr = (error, status = 400) => ({ ok: false, status, json: async () => ({ error }) });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let configRespond, cfgCalls, lastCfgBody;
function resetServer() {
  cfgCalls = 0; lastCfgBody = null;
  configRespond = () => jsonOk({});
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/crm_config_get')) { cfgCalls++; lastCfgBody = body; return configRespond(); }
  return jsonOk([]);   // no leads: the columns still render, which is what is under test
};

const CONFIGURED = {
  stages: [
    { key: 'came', label: 'Клиент пришёл', color: 'ok', position: 2, is_active: 1, kind: 'won' },
    { key: 'lead_new', label: 'Новое обращение', color: 'warn', position: 1, is_active: 1, kind: 'open' },
    { key: 'archive', label: 'Архив', color: 'none', position: 3, is_active: 0, kind: 'lost' },
  ],
  sources: [{ key: 'call', label: 'Звонок', position: 1, is_active: 1 }],
  routing: [],
};

const { renderCrm } = await import('../views/crm.js');

async function render() {
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  return root;
}

// Тесты идут по порядку НАМЕРЕННО: SOURCES/STATUSES в crm.js — состояние
// модуля, живущее между отрисовками, и «запасная воронка» проверяется до
// первой успешной загрузки. Последний тест проверяет обратное свойство —
// после удачной загрузки неудачная НИЧЕГО не отменяет.

test('доска спрашивает воронку у сервера ровно одним crm_config_get {}', async () => {
  resetServer();
  await render();
  assert.strictEqual(cfgCalls, 1);
  assert.deepStrictEqual(lastCfgBody, {}, 'контракт: crm_config_get {}');
});

test('501 от несмерженного сервера — вчерашняя доска целиком, а не пустой экран', async () => {
  resetServer();
  configRespond = () => jsonErr({ code: 'rpc_not_implemented', message: 'RPC not implemented: crm_config_get' }, 501);
  const root = await render();
  assert.deepStrictEqual(columnKeys(root),
    ['in_process', 'recall', 'scheduled', 'approved', 'came', 'no_show', 'stopped', 'not_qualified'],
    'ровно те восемь колонок, что были до этой задачи (mig 046)');
});

test('пустой ответ и сетевой отказ — тот же запасной вариант, без единой ошибки на экране', async () => {
  for (const respond of [() => jsonOk({}), () => jsonOk(null), () => { throw new Error('network down'); }]) {
    resetServer();
    configRespond = respond;
    const root = await render();
    assert.strictEqual(columnKeys(root).length, 8, 'доска на месте');
    assert.ok(textOf(root).includes('В обработке'), 'запасная воронка');
    assert.ok(!textOf(root).includes('Не удалось'), 'и ни одной красной строки поверх работающих карточек');
  }
});

test('настроенная воронка становится колонками доски — ключи, названия и порядок из конфигурации', async () => {
  resetServer();
  configRespond = () => jsonOk(CONFIGURED);
  const root = await render();
  assert.deepStrictEqual(columnKeys(root), ['lead_new', 'came'],
    'по position, и скрытая колонка на доску не выходит');
  const text = textOf(root);
  assert.ok(text.includes('Новое обращение'), 'название колонки — из настроек');
  assert.ok(text.includes('Клиент пришёл'), 'переименованная колонка конверсии тоже');
  assert.ok(!text.includes('В обработке'), 'зашитый список больше не подмешивается');
});

test('после удачной загрузки неудачная НИЧЕГО не меняет — доска не откатывается к зашитой', async () => {
  resetServer();
  configRespond = () => jsonErr({ code: 'rpc_not_implemented' }, 501);
  const root = await render();
  assert.deepStrictEqual(columnKeys(root), ['lead_new', 'came'],
    'остаётся последняя известная рабочая воронка, а не восемь чужих колонок');
});
