// INPATIENT_SHARE_V1 → INPATIENT_BONUS_V1 (мигр. 155) — вкладка «Стационар»
// карточки сотрудника.
//
// Владелец (26.09): «Employees: stationary bonuses separately». Ставки за
// услуги в стационаре (% или фикс за единицу) живут ОТДЕЛЬНО от «Услуг и
// ставок» (users.inpatient_rates), рядом — вознаграждение за направление в
// стационар (% и/или фикс). Проверяется то, из-за чего настройка может тихо
// не работать:
//   * колонки «Стационар, %» в «Услугах и ставках» больше нет;
//   * вкладка показывает сохранённое (и %, и сум) и бонус;
//   * правки уходят своими полями, а амбулаторный список не меняется —
//     прежде стационарная ставка заводила амбулаторную запись {pct: 0};
//   * своя «Ставка для всех»;
//   * значения переживают открытие карточки без правок.
//
// Fake-DOM харнесс — тот же, что в employees-managed.test.mjs.

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
    { service_id: 2, pct: 40, branches: [1] },
  ],
  referral_rates: [],
  // INPATIENT_BONUS_V1 — стационарные ставки отдельным списком.
  inpatient_rates: [{ service_id: 1, pct: 20 }, { service_id: 3, fix: 70000 }],
  inpatient_referral_pct: 5, inpatient_referral_fixed: 0,
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

test('«Услуги и ставки» больше не несут колонку «Стационар, %»', async () => {
  const card = await openTab('Услуги и ставки');
  const head = byClass(card, 'rt-head')[0];
  assert.ok(!textOf(head).includes('Стационар'), 'колонка осталась: ' + textOf(head));
  assert.equal(byClass(card, 'rt-num--inp').length, 0);
});

test('вкладка «Стационар»: сохранённые ставки (% и сум) и бонус за направление', async () => {
  const card = await openTab('Стационар');
  assert.equal(rateInput(rowOf(card, 'Аппендэктомия')).value, '20');
  assert.equal(rateInput(rowOf(card, 'Холецистэктомия')).value, '70000');
  const off = rateInput(rowOf(card, 'Перевязка'));
  assert.equal(off.value, '', 'нет стационарной ставки — пустое поле, а не 0');
  assert.ok(off.disabled === true || 'disabled' in off.attrs, 'у неотмеченной услуги поле закрыто');
  const [pct, fixed] = bonusInputs(card);
  assert.equal(pct.value, '5');
  assert.equal(fixed.value, '', '0 — «не платится», пустое поле');
});

test('правки вкладки уходят своими полями; амбулаторные ставки не меняются', async () => {
  const card = await openTab('Стационар');
  type(rateInput(rowOf(card, 'Аппендэктомия')), '35');
  // Отметить «Перевязку» и перевести её на фиксированную сумму.
  tags(rowOf(card, 'Перевязка'), 'input').find((i) => i.attrs.type === 'checkbox' || i.type === 'checkbox')
    .dispatchEvent({ type: 'change' });
  await flush();
  buttonWith(rowOf(card, 'Перевязка'), 'сум').click();
  await flush();
  type(rateInput(rowOf(card, 'Перевязка')), '15000');
  const [pct, fixed] = bonusInputs(card);
  type(pct, '');
  type(fixed, '200000');
  const body = await save(card);
  assert.deepEqual(body.inpatient_rates, [
    { service_id: 1, pct: 35 }, { service_id: 3, fix: 70000 }, { service_id: 2, fix: 15000 },
  ]);
  assert.equal(body.inpatient_referral_pct, 0);
  assert.equal(body.inpatient_referral_fixed, 200000);
  // Сцепки нет: амбулаторный список тот же, без записи {pct: 0} ради стационара.
  assert.deepEqual(body.service_rates.map((r) => r.service_id), [2]);
  assert.ok(body.service_rates.every((r) => !('inpatient_pct' in r)));
});

test('«Ставка для всех» во вкладке пишет только стационарные ставки отмеченных услуг', async () => {
  const card = await openTab('Стационар');
  const bulk = byClass(card, 'rt-num--inp-bulk')[0];
  bulk.value = '12';
  bulk.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
  await flush();
  const body = await save(card);
  assert.deepEqual(body.inpatient_rates, [{ service_id: 1, pct: 12 }, { service_id: 3, pct: 12 }]);
  assert.deepEqual(body.service_rates, [{ service_id: 2, pct: 40, branches: [1] }]);
});

test('ставки переживают открытие и сохранение карточки без правок', async () => {
  const card = await openTab('Стационар');
  const body = await save(card);
  assert.deepEqual(body.inpatient_rates, DOC.inpatient_rates);
  assert.equal(body.inpatient_referral_pct, 5);
});
