// Ревью I5 (мигр. 155) — запись «Услуг и ставок» БЕЗ процента.
//
// Запись без pct значит «врач оказывает услугу, платится ставкой по умолчанию»
// (service_rate_default): так её пишут окно услуги (mergeServiceRates) и
// перенос 155 у записей, живших только ради стационара. Карточка сотрудника
// обязана это показать и сохранить: прежде она читала отсутствие как 0,
// рисовала «0 %» и при сохранении писала pct: 0 — а записанный 0 перекрывает
// ставку по умолчанию, и врач переставал получать за услугу.
//
// Fake-DOM харнесс — тот же, что в employees-inpatient-rates.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.children.push(c);}
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
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage, addEventListener() {},
  easymed: { state: { user: { id: 1, role: 'admin', is_admin: true } } },
  CLINIC: { id: 1 },
  confirm: () => true,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();



const DOC = {
  id: 7, username: 'surgeon', full_name: 'Хирургов Хасан', last_name: 'Хирургов', first_name: 'Хасан',
  role: 'doctor', is_active: true, is_local: true, extra_roles: [], phone: '+998901112255',
  staff_type: 'doctor', is_doctor: true, specialty: 'Хирург',
  service_rates: [
    { service_id: 1, branches: [1] },            // оказывает, ставка по умолчанию
    { service_id: 2, pct: 40, branches: [1] },
  ],
  referral_rates: [],
  inpatient_rates: [],
  inpatient_referral_pct: 0, inpatient_referral_fixed: 0,
};
const SERVICES = [
  { id: 1, name: 'Аппендэктомия', price: 1000000, type: 'procedure', type_id: null, category_id: null },
  { id: 2, name: 'Перевязка', price: 100000, type: 'procedure', type_id: null, category_id: null },
  { id: 3, name: 'Холецистэктомия', price: 2000000, type: 'other', type_id: null, category_id: null },
];

const patches = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u === '/api/users') return { ok: true, json: async () => ({ users: [DOC] }) };
  if (u.startsWith('/api/users/')) { patches.push({ u, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ user: {} }) }; }
  if (u === '/api/db') {
    const desc = opts && opts.body ? JSON.parse(opts.body) : {};
    const rows = desc.table === 'services' ? SERVICES
      : desc.table === 'branches' ? [{ id: 1, name: 'Чиланзар' }] : [];
    return { ok: true, json: async () => ({ data: rows }) };
  }
  return { ok: true, json: async () => ({ data: [] }) };
};

const { renderEmployees } = await import('../views/employees.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const byClass = (root, c) => walk(root).filter((n) => String(n.className || '').split(/\s+/).includes(c));
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }

async function openTab(label) {
  document.body.children.length = 0;
  patches.length = 0;
  const container = mk('div');
  await renderEmployees(container);
  await flush();
  const row = tags(container, 'tr').find((r) => textOf(r).includes('@surgeon'));
  row.dispatchEvent({ type: 'click', currentTarget: null, preventDefault() {}, stopPropagation() {} });
  await flush();
  const card = document.body.children[document.body.children.length - 1];
  // Пункт левой рейки — div с обработчиком клика, внутри которого подпись раздела.
  const item = walk(card).filter((n) => n._l && n._l.click && textOf(n).includes(label)).pop();
  assert.ok(item, 'нет раздела «' + label + '» в рейке');
  item.click();
  await flush();
  return card;
}
const rowOf = (card, name) => byClass(card, 'rt-item').find((r) => textOf(r).includes(name));
const rateInput = (row) => byClass(row, 'rt-num--inp')[0];
const bonusInputs = (card) => byClass(card, 'rt-num--bonus');
const type = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input' }); };
async function save(card) {
  buttonWith(card, 'Сохранить сотрудника').click();
  await flush();
  assert.equal(patches.length, 1, 'карточка ушла на сервер одним PATCH');
  return patches[0].body;
}

const rateOf = (row) => byClass(row, 'rt-num').find((n) => !String(n.className).includes('rt-num--price'));

test('запись без процента: поле пустое с подсказкой «по умолчанию», а не «0»', async () => {
  const card = await openTab('Услуги и ставки');
  const dflt = rateOf(rowOf(card, 'Аппендэктомия'));
  assert.equal(dflt.value, '', 'нет процента — пустое поле');
  assert.match(String(dflt.attrs.placeholder || dflt.placeholder || ''), /умолчанию/i);
  assert.equal(rateOf(rowOf(card, 'Перевязка')).value, '40');
});

test('сохранение без правок не дописывает pct: 0', async () => {
  const card = await openTab('Услуги и ставки');
  const body = await save(card);
  assert.deepEqual(body.service_rates, [
    { service_id: 1, branches: [1] },
    { service_id: 2, pct: 40, branches: [1] },
  ]);
});

test('введённый процент пишется; стёртый — снова «по умолчанию»', async () => {
  let card = await openTab('Услуги и ставки');
  type(rateOf(rowOf(card, 'Аппендэктомия')), '25');
  let body = await save(card);
  assert.deepEqual(body.service_rates[0], { service_id: 1, pct: 25, branches: [1] });
  card = await openTab('Услуги и ставки');
  type(rateOf(rowOf(card, 'Перевязка')), '');
  body = await save(card);
  assert.deepEqual(body.service_rates[1], { service_id: 2, branches: [1] });
});
