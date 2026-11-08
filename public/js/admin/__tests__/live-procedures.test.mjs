// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — очередь процедур обновляется сама:
// касса отпустила процедуру, назначили палатную — без «Обновить»; изменение не для
// процедурной — нет; под окном «Выполнить процедуру» — ждёт. Настоящий procedures.js в
// фальшивом DOM, поток — настоящий клиент live.js на подделках.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, FakeES } from './live-fakes.mjs';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={setProperty(k,v){this[k]=v;},getPropertyValue(k){return this[k];}};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.id='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){} closest(){return null;}
 contains(n){const all=[];const w=(e)=>{for(const c of e.children||[]){all.push(c);w(c);}};w(this);return all.includes(n);}
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
const TOASTS = [];
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
let modalOpen = false;
globalThis.document = {
  hidden: false, activeElement: null,
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return id === 'toast' ? toastEl : null; },
  querySelector(sel) { return modalOpen && /\.modal/.test(sel) ? mk('div') : null; },
};
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage,
  addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: { id: 2, role: 'nurse', full_name: 'Сестра', extra_roles: [] } } },
  confirm: () => false,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };

const row = (kind, id, status, service, patient) => ({ kind, id, status, service, patient, phone: '', mrn: '', dob: null, sex: null,
  performer_id: null, performer: '', performer_role: '', performer_is_doctor: false, unassigned: true, done: status === 'completed',
  done_at: null, done_by: '', notes: '', when: '2026-11-08T09:00:00Z', visit_id: kind === 'outpatient' ? 500 + id : null,
  patient_id: 900 + id, admission_id: kind === 'inpatient' ? 1 : null, ward: kind === 'inpatient' ? 'Терапия' : '', bed: '' });
let ROWS = [row('outpatient', 1, 'added', 'Перевязка', 'Процедурный-Первый')];
let lists = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u === '/api/rpc/procedures_list') { lists++; return { ok: true, json: async () => ({ data: { scope: 'own', me: 2, rows: JSON.parse(JSON.stringify(ROWS)) } }) }; }
  if (u === '/api/rpc/refunded_lines') return { ok: true, json: async () => ({ data: { line_ids: [] } }) };
  return { ok: true, json: async () => ({ data: null }) };
};

const clock = fakeClock();
const live = await import('../live.js');
const client = live.createLiveClient({
  EventSource: FakeES, fetch: async () => ({ ok: true, status: 200, json: async () => ({ v: 1, tables: [], rpc: [] }) }),
  document: globalThis.document, window: globalThis.window,
  setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, random: () => 0.5,
});
live.__setLiveClientForTests(client);
const { renderProcedures } = await import('../views/procedures.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let version = 1;
const emit = (tables) => FakeES.live()[0].emit('change', { v: ++version, tables, rpc: [] });
async function settle(ms) { await clock.advance(ms); await tick(40); }

const root = mk('div');
await renderProcedures(root);
FakeES.live()[0].open();
FakeES.live()[0].emit('hello', { v: version });

test('касса отпустила процедуру и назначили палатную — очередь перечиталась сама', async () => {
  assert.match(textOf(root), /Ожидает кассу/);
  const before = lists;
  ROWS = [row('outpatient', 1, 'queued', 'Перевязка', 'Процедурный-Первый'), row('inpatient', 7, 'queued', 'Укол в палате', 'Палатный-Второй')];
  emit(['visit_services', 'admission_services']);
  await settle(live.DEBOUNCE_MS + 10);
  assert.equal(lists, before + 1);
  assert.match(textOf(root), /Палатный-Второй/);
  assert.doesNotMatch(textOf(root), /Ожидает кассу/, 'касса отпустила — «Выполнить» вместо «Ожидает кассу»');
  assert.equal(TOASTS.length, 0);
});

test('изменение не для процедурной (счёт) — не перечитывается', async () => {
  const before = lists;
  emit(['invoices', 'cash_shifts']);
  await settle(live.DEBOUNCE_MS + live.RECHECK_MS);
  assert.equal(lists, before);
});

test('открыто окно «Выполнить процедуру» — ждёт; закрыли — перечиталась', async () => {
  const before = lists;
  modalOpen = true;
  ROWS = [...ROWS, row('outpatient', 9, 'queued', 'Массаж', 'Процедурный-Третий')];
  emit(['visit_services']);
  await settle(live.DEBOUNCE_MS + live.RECHECK_MS * 2);
  assert.equal(lists, before);
  modalOpen = false;
  await settle(live.RECHECK_MS + 10);
  assert.equal(lists, before + 1);
  assert.match(textOf(root), /Процедурный-Третий/);
});
