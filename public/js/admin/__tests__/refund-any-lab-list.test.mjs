// REFUND_ANY_V1 (ревью B4) — ЛИСТ ЛАБОРАТОРИИ: «УСЛУГА ВОЗВРАЩЕНА».
//
// Касса вернула пациенту деньги за анализ (refunded_lines). Лист прячет
// возвращённую строку без результата (lab-scope.js withoutRefundedIdle), а
// строку с результатом оставляет. Ревью B4:
//   1. возвращённая строка с результатом несёт метку «Услуга возвращена»
//      (tag-crit, Icon('Warning')) — лаборант видит её до «Проверить и выдать»;
//   2. вопрос refunded_lines уходит ВМЕСТЕ с остальными чтениями листа, а не
//      после них (не удлиняет загрузку);
//   3. результаты не прочитались (партия упала) — строку без результата не
//      прятать: показать с меткой (лучше лишняя строка с пометкой, чем
//      спрятанная работа, о результате которой лист просто не знает).
//
// Поддельный DOM и /api/db — те же, что у lab-card.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';
import { REFUNDED_LINE_MARK } from '../../shared/refunded-line.js';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
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
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
const fakeBody = mk('body');
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return ''; }, set() {} });
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:fakeBody,documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(id){return id === 'toast' ? toastEl : null;}};
const store = new Map();
const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта вида
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener(){}, dispatchEvent(){ return true; },
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => false,
};
globalThis.confirm = () => false;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let VISIT_SERVICES = [];
let LAB_RESULTS = [];
let REFUNDED = new Set();
let RESULTS_FAIL = false;
const LOG = [];   // порядок чтений листа: имя таблицы или 'rpc:<имя>'
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    LOG.push(table);
    if (table === 'lab_results' && RESULTS_FAIL) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
    let rows = {
      visit_services: VISIT_SERVICES,
      visits: [{ id: 'v-1', visit_date: '2026-10-30', patients: { id: 'p-1', full_name: 'Каримова Азиза', mrn: 'P-1', gender: 'female', date_of_birth: '1994-11-15' } }],
      lab_results: LAB_RESULTS,
      admissions: [], lab_panels: [], lab_panel_analytes: [], services: [],
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }],
      service_types: [], doc_settings: [],
    }[table] || [];
    if (table === 'visit_services') {
      const f = ((body && body.filters) || []).find((x) => x && x.col === 'status');
      if (f && f.op === 'in') rows = rows.filter((r) => f.val.includes(r.status));
      else if (f && f.op === 'eq') rows = rows.filter((r) => r.status === f.val);
    }
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length);
    LOG.push('rpc:' + name);
    if (name === 'refunded_lines') return { ok: true, json: async () => ({ data: { line_ids: (body.line_ids || []).filter((id) => REFUNDED.has(Number(id))) } }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderLaboratory } = await import('../views/laboratory.js');
const { setFullAccess } = await import('../permissions.js');
setFullAccess(true);

const SVC = { name: 'Анализ', is_lab: true, type: 'lab', specimen: 'Кровь', tube_color: 'lavender', department_id: 'd-1' };
const vs = (id, status, name) => ({ id, visit_id: 'v-1', service_id: 's-' + id, status, sample_collected_at: status === 'queued' ? null : '2026-10-30T08:00:00Z',
  sync_origin: null, services: { ...SVC, name } });
const ROWS = [vs(801, 'resulted', 'ОАК'), vs(802, 'collected', 'Глюкоза'), vs(803, 'queued', 'Ферритин')];
const RESULT_801 = [{ id: 1, visit_service_id: 801, parameter: 'Hb', value: '120', unit: 'г/л', flag: 'normal', notes: null, entered_at: '2026-10-30T09:00:00Z' }];

async function openList() {
  VISIT_SERVICES = ROWS;
  LAB_RESULTS = RESULT_801;
  LOG.length = 0;
  fakeBody.children.length = 0;
  const root = mk('div');
  await renderLaboratory(root, { tabId: 't-1' });
  await tick();
  const items = byClass(root, 'lq-item');
  const byName = (n) => items.find((it) => textOf(it).includes(n)) || null;
  const tagged = (it) => !!it && walk(it).some((n) => hasClass(n, 'tag-crit') && textOf(n).includes(REFUNDED_LINE_MARK));
  return { root, items, byName, tagged };
}

test('возвращённая с результатом — в листе с меткой «Услуга возвращена»; без результата — спрятана; обычная — без метки', async (t) => {
  REFUNDED = new Set([801, 802]);
  t.after(() => { REFUNDED = new Set(); });
  const { items, byName, tagged } = await openList();
  assert.strictEqual(items.length, 2, 'в листе ' + items.length + ' строк(и)');
  assert.ok(tagged(byName('ОАК')), 'возвращённая строка с результатом — без метки «Услуга возвращена»');
  assert.strictEqual(byName('Глюкоза'), null, 'возвращённая строка без результата осталась в листе');
  assert.ok(!tagged(byName('Ферритин')), 'метка у обычной строки');
});

test('refunded_lines спрашивается вместе с прочими чтениями листа — до visits и lab_results', async () => {
  REFUNDED = new Set();
  await openList();
  const at = (k) => LOG.indexOf(k);
  assert.ok(at('rpc:refunded_lines') >= 0, 'лист не спросил refunded_lines: ' + LOG.join(', '));
  assert.ok(at('rpc:refunded_lines') < at('visits'), 'refunded_lines спрошен после visits: ' + LOG.join(', '));
  assert.ok(at('rpc:refunded_lines') < at('lab_results'), 'refunded_lines спрошен после lab_results: ' + LOG.join(', '));
});

test('результаты не прочитались — возвращённую строку не прятать: она в листе с меткой', async (t) => {
  REFUNDED = new Set([801, 802]);
  RESULTS_FAIL = true;
  t.after(() => { REFUNDED = new Set(); RESULTS_FAIL = false; });
  const { items, byName, tagged } = await openList();
  assert.strictEqual(items.length, 3, 'при сбое чтения результатов лист спрятал строки');
  assert.ok(tagged(byName('Глюкоза')), 'возвращённая строка без прочитанного результата — без метки');
  assert.ok(tagged(byName('ОАК')));
  assert.ok(!tagged(byName('Ферритин')));
});
