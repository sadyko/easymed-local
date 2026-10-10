// CLINIC_API_STEP7_V1 — общий редактор справочников хаба: пустой список и заголовок
// окна — по-русски, без собранных английских фраз («No … yet», «Add …»). Владелец
// увидел их на прежнем экране «Ключи API»: «No ключи api yet — add the first one.»,
// «Add Ключи API». Тот же редактор рисует все справочники хаба.
//
// Поддельный DOM — из __tests__/admin-rows-grantable.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.hidden=false;this.disabled=false;}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(c){if(!this.contains(c))s.className=(s.className+' '+c).trim();},remove(c){s.className=String(s.className).split(/\s+/).filter(x=>x!==c).join(' ');},toggle(c,on){const has=this.contains(c);const want=on===undefined?!has:!!on;if(want&&!has)this.add(c);if(!want&&has)this.remove(c);}};}
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
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    const rows = [];   // справочник пуст
    return { ok: true, json: async () => ({ data: rows }) };
  }
  return { ok: true, json: async () => ({ data: {} }) };
};

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byClass = (root, cls) => walk(root).filter((n) => String(n.className).split(/\s+/).includes(cls));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const perms = await import('../permissions.js');
const { renderSettingsHub } = await import('../views/settings-hub.js');

test('пустой справочник и окно «Добавить» — по-русски', async () => {
  perms.setFullAccess('Admin');
  const root = mk('div');
  await renderSettingsHub(root, {});
  byClass(root, 'set-row-link').find((n) => textOf(n).includes('Категории пациентов')).click();
  await tick();
  const t = textOf(root);
  assert.ok(!/\bNo\b|\byet\b/.test(t), 'английский шаблон пустого списка: ' + t.slice(0, 200));
  assert.ok(t.includes('В разделе «Категории пациентов» пока пусто'));
  walk(root).find((n) => n.tagName === 'BUTTON' && String(n.className).includes('btn-primary')).click();
  await tick();
  const modalText = textOf(document.body);
  assert.ok(!/\bAdd\b/.test(modalText), 'заголовок окна по-английски');
  assert.ok(modalText.includes('Добавить: Категории пациентов'));
});
