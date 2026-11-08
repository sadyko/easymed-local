// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — очередь лаборатории обновляется сама:
// новый заказ и результат анализатора — без «Обновить» и без «Загрузка…»; изменение не
// для лаборатории — нет; под окном ввода результатов — ждёт; раскрытые карточки на месте.
// Настоящий laboratory.js в фальшивом DOM (как у refund-any-lab-list.test.mjs), поток —
// настоящий клиент live.js на подделках.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, FakeES } from './live-fakes.mjs';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){} closest(){return null;}
 contains(){return false;}
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
const TOASTS = [];
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return ''; }, set(v) { TOASTS.push(String(v)); } });
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
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } }, CLINIC: { id: 'c-1' }, confirm: () => false,
};
globalThis.confirm = () => false;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };

const SVC = { name: 'Анализ', is_lab: true, type: 'lab', specimen: 'Кровь', tube_color: 'lavender', department_id: 'd-1' };
const vs = (id, visit, status, name) => ({ id, visit_id: visit, service_id: 's-' + id, status, sample_collected_at: null, sync_origin: null, services: { ...SVC, name } });
const VISITS = [
  { id: 'v-1', visit_date: '2026-11-08', patients: { id: 'p-1', full_name: 'Лаб-Пациент-Первый', mrn: 'P-1', gender: 'female', date_of_birth: '1994-11-15' } },
  { id: 'v-2', visit_date: '2026-11-08', patients: { id: 'p-2', full_name: 'Лаб-Пациент-Второй', mrn: 'P-2', gender: 'male', date_of_birth: '1990-01-01' } },
];
let VISIT_SERVICES = [vs(801, 'v-1', 'queued', 'ОАК')];
let vsReads = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    if (table === 'visit_services') vsReads++;
    let rows = {
      visit_services: VISIT_SERVICES, visits: VISITS, lab_results: [], admissions: [], lab_panels: [], lab_panel_analytes: [], services: [],
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }], service_types: [], doc_settings: [],
    }[table] || [];
    if (table === 'visit_services') {
      const f = ((body && body.filters) || []).find((x) => x && x.col === 'status');
      if (f && f.op === 'in') rows = rows.filter((r) => f.val.includes(r.status));
      else if (f && f.op === 'eq') rows = rows.filter((r) => r.status === f.val);
    }
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
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
const { renderLaboratory } = await import('../views/laboratory.js');
const { setFullAccess } = await import('../permissions.js');
setFullAccess(true);

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let version = 1;
const emit = (tables) => FakeES.live()[0].emit('change', { v: ++version, tables, rpc: [] });
async function settle(ms) { await clock.advance(ms); await tick(60); }

const root = mk('div');
await renderLaboratory(root, { tabId: 't-1' });
await tick(60);
FakeES.live()[0].open();
FakeES.live()[0].emit('hello', { v: version });

test('новый заказ в лабораторию — очередь перечиталась сама, без «Загрузка…» и уведомлений', async () => {
  assert.match(textOf(root), /Лаб-Пациент-Первый/);
  const before = vsReads;
  VISIT_SERVICES = [vs(802, 'v-2', 'queued', 'Глюкоза'), ...VISIT_SERVICES];
  emit(['visit_services', 'invoices']);
  await clock.advance(live.DEBOUNCE_MS + 10);
  assert.doesNotMatch(textOf(root), /Загрузка…/, 'тихо: очередь не заменялась «Загрузкой…»');
  await tick(60);
  assert.ok(vsReads > before, 'очередь перечитана');
  assert.match(textOf(root), /Лаб-Пациент-Второй/);
  assert.equal(TOASTS.length, 0);
});

test('изменение не для лаборатории (смена кассы) — не перечитывается', async () => {
  const before = vsReads;
  emit(['cash_shifts', 'cash_movements']);
  await settle(live.DEBOUNCE_MS + live.RECHECK_MS);
  assert.equal(vsReads, before);
});

test('открыто окно ввода результатов — ждёт; закрыли — перечиталась (результат анализатора)', async () => {
  const before = vsReads;
  modalOpen = true;
  emit(['lab_results']);
  await settle(live.DEBOUNCE_MS + live.RECHECK_MS * 2);
  assert.equal(vsReads, before, 'под окном не перечитывается');
  modalOpen = false;
  await settle(live.RECHECK_MS + 10);
  assert.ok(vsReads > before);
});
