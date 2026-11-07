// PROC_SCOPE_V1 (3.22.0, решение владельца 2026-11-07, п. 12) — экран «Процедуры»:
// фильтр «Исполнитель» у того, кто видит всё (администратор, старшая медсестра), и его нет у
// медсестры. Фильтр читает сервер: смена выбора — новое чтение procedures_list { performer }.
import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={setProperty(k,v){this[k]=v;},getPropertyValue(k){return this[k];}};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.id='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){} closest(){return null;}
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
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { get() { return ''; }, set() {}, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return id === 'toast' ? toastEl : null; },
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage,
  addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: { id: 7, role: 'nurse', full_name: 'Старшая', extra_roles: ['senior_nurse'] } } },
  confirm: () => false,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let SCOPE = 'all';
const ASKED = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u === '/api/rpc/procedures_list') {
    ASKED.push(body);
    return { ok: true, json: async () => ({ data: { scope: SCOPE, me: 7, rows: [],
      performers: SCOPE === 'all' ? [{ id: 2, full_name: 'Сестрина А.А.' }, { id: 3, full_name: 'Петрова В.В.' }] : [] } }) };
  }
  if (u === '/api/rpc/refunded_lines') return { ok: true, json: async () => ({ data: { line_ids: [] } }) };
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderProcedures } = await import('../views/procedures.js');
const perfSel = (root) => walk(root).find((n) => n.attrs && 'data-proc-performer' in n.attrs) || null;

test('PROC_SCOPE_V1: у видящего всё — фильтр «Исполнитель»: все / не назначен / сотрудники; смена — новое чтение с фильтром', async () => {
  SCOPE = 'all'; ASKED.length = 0;
  const root = mk('div');
  await renderProcedures(root);
  await tick();
  assert.deepStrictEqual(ASKED[0], { limit: 300 }, 'первое чтение — без фильтра');
  const sel = perfSel(root);
  assert.ok(sel, 'фильтра нет');
  const opts = sel.children.map((o) => [o.attrs.value, textOf(o).trim()]);
  assert.deepStrictEqual(opts, [['', 'Все исполнители'], ['none', 'Исполнитель не назначен'], ['2', 'Сестрина А.А.'], ['3', 'Петрова В.В.']]);
  sel.dispatchEvent({ type: 'change', target: { value: '3' } });
  await tick();
  assert.deepStrictEqual(ASKED.at(-1), { limit: 300, performer: '3' });
  assert.strictEqual(perfSel(root).value, '3', 'выбор держится после перерисовки');
});

test('PROC_SCOPE_V1: медсестре (своё и ничьё) фильтра нет и фильтр не уходит на сервер', async () => {
  SCOPE = 'own'; ASKED.length = 0;
  const root = mk('div');
  await renderProcedures(root);
  await tick();
  assert.strictEqual(perfSel(root), null);
  assert.deepStrictEqual(ASKED, [{ limit: 300 }], 'новое открытие раздела — без прежнего фильтра');
});
