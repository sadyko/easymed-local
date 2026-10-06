// CLINIC_API_FIX_V1 (2026-10-06) — карточка сотрудника шлёт специальности,
// только когда их правили.
//
// Было: save() клал в тело PATCH `specialty` и весь список `specialties` при
// КАЖДОМ сохранении — правили оклад или телефон, а сервер всё равно стирал и
// заново писал user_specialties (теряя узбекские названия и коды, которых
// карточка не знает). Теперь список уходит, только если он не такой, каким
// карточка его открыла (порядок важен: первая — основная).
//
// Fake-DOM харнесс — тот же, что в employees-card-save.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.children.push(c);}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);
   if (k === 'checked') this.checked = true;
   if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);}
 getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 querySelectorAll(sel){const m=String(sel).match(/^(\w+)\[([\w-]+)(?:="([^"]*)")?\]$/);if(!m)return [];const out=[];
   const go=(e)=>{for(const c of e.children||[]){if(c.tagName===m[1].toUpperCase()&&(m[3]===undefined?(m[2] in (c.attrs||{})):(c.attrs||{})[m[2]]===m[3]))out.push(c);go(c);}};go(this);return out;}
 querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
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
  easymed: { state: { user: { id: 2, role: 'admin', is_admin: true } } },
  CLINIC: { id: 1 },
  confirm: () => true,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const person = (id, username, extra = {}) => ({
  id, username, full_name: 'Каримов Алишер', last_name: 'Каримов', first_name: 'Алишер', middle_name: '',
  phone: '+998901112233', role: 'doctor', is_active: true, is_local: true, extra_roles: [],
  staff_type: 'doctor', is_doctor: true, service_rates: [], referral_rates: [], inpatient_rates: [], ...extra,
});
// Кардиолог со списком от сервера (MULTI_SPECIALTY_V1) — две специальности.
const CARDIO = person(80, 'dr.cardio', { specialty: 'Кардиолог',
  specialties: [{ slug: 'kardiolog', name: 'Кардиолог' }, { slug: 'terapevt', name: 'Терапевт' }] });
// Врач, сохранённый до списка: одна колонка и старое написание.
const LEGACY = person(81, 'dr.uzd', { specialty: 'Врач УЗД', specialties: [] });
// Медсестра: специальностей нет вовсе.
const NURSE = person(82, 'nurse.k', { role: 'nurse', staff_type: 'mid_low', is_doctor: false, specialty: '', specialties: [] });

const writes = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  if (u === '/api/users' && method === 'GET') return { ok: true, json: async () => ({ users: [CARDIO, LEGACY, NURSE] }) };
  if (u.startsWith('/api/users')) { writes.push({ u, method, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ user: {} }) }; }
  if (u === '/api/db') {
    const desc = opts.body ? JSON.parse(opts.body) : {};
    let rows = [];
    if (desc.table === 'branches') rows = [{ id: 1, name: 'Чиланзар' }];
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
const type = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input' }); };

let container;
async function openCard(username) {
  document.body.children.length = 0;
  writes.length = 0;
  container = mk('div');
  await renderEmployees(container);
  await flush();
  const row = tags(container, 'tr').find((r) => textOf(r).includes('@' + username));
  assert.ok(row, 'нет строки @' + username);
  row.dispatchEvent({ type: 'click', currentTarget: null, preventDefault() {}, stopPropagation() {} });
  await flush();
  return document.body.children.find((c) => c.className === 'modal');
}
async function tab(card, label) {
  const item = walk(card).filter((n) => n._l && n._l.click && textOf(n).includes(label)).pop();
  assert.ok(item, 'нет раздела «' + label + '» в рейке');
  item.click();
  await flush();
}
async function save(card) {
  buttonWith(card, 'Сохранить сотрудника').click();
  await flush();
}
const specSelects = (card) => tags(byClass(card, 'spec-list')[0], 'select');
const pick = (sel, v) => { sel.value = v; sel.dispatchEvent({ type: 'change' }); };
async function changeSalary(card) {
  await tab(card, 'Занятость и зарплата');
  const salary = tags(card, 'input').find((i) => i.attrs.type === 'number' && i.attrs.placeholder === '0');
  type(salary, '3000000');
}
const onlyWrite = () => { assert.equal(writes.length, 1, 'карточка не ушла на сервер'); return writes[0].body; };
const noSpecialties = (body) => {
  assert.ok(!('specialties' in body), 'specialties ушли, хотя их не правили: ' + JSON.stringify(body.specialties));
  assert.ok(!('specialty' in body), 'specialty ушла, хотя её не правили: ' + JSON.stringify(body.specialty));
};

test('правили только оклад — ни specialties, ни specialty в PATCH нет', async () => {
  const card = await openCard('dr.cardio');
  await changeSalary(card);
  await save(card);
  const body = onlyWrite();
  assert.equal(body.salary_fixed, 3000000);
  noSpecialties(body);
});

test('открыли «Должность» и ничего в специальностях не меняли — список не уходит', async () => {
  const card = await openCard('dr.cardio');
  await tab(card, 'Должность');
  assert.equal(specSelects(card).length, 2, 'обе специальности на экране');
  await changeSalary(card);
  await save(card);
  noSpecialties(onlyWrite());
});

test('врач со старым «Врач УЗД» в одной колонке: правка телефона не переписывает специальность', async () => {
  const card = await openCard('dr.uzd');
  const ph = byClass(card, 'ph-wrap')[0];
  ph.input.value = '+998 90 111 22 44';
  ph.input.dispatchEvent({ type: 'input' });
  ph.dispatchEvent({ type: 'input' });
  await save(card);
  const body = onlyWrite();
  assert.ok(body.phone.replace(/\D/g, '').endsWith('901112244'), body.phone);
  noSpecialties(body);
});

test('у медсестры без специальностей правка оклада не шлёт пустой список', async () => {
  const card = await openCard('nurse.k');
  await tab(card, 'Должность');
  await changeSalary(card);
  await save(card);
  noSpecialties(onlyWrite());
});

test('сменили основную специальность — уходят и specialties, и specialty', async () => {
  const card = await openCard('dr.cardio');
  await tab(card, 'Должность');
  pick(specSelects(card)[0], 'Невролог');
  await save(card);
  const body = onlyWrite();
  assert.deepEqual(body.specialties, [{ name: 'Невролог', slug: 'nevrolog' }, { name: 'Терапевт', slug: 'terapevt' }]);
  assert.equal(body.specialty, 'Невролог');
});

// Список правится на месте: вторая правка того же выпадающего списка и
// «Добавить специальность» после правки не теряются (прежде commit() заменял
// emp.specialties новым массивом, а строки на экране держали старый).
test('сменили одну и ту же специальность дважды — уходит последняя; после правки «Добавить» работает', async () => {
  let card = await openCard('dr.cardio');
  await tab(card, 'Должность');
  pick(specSelects(card)[1], 'Диетолог');
  pick(specSelects(card)[1], 'Невролог');
  await save(card);
  assert.deepEqual(onlyWrite().specialties.map((s) => s.name), ['Кардиолог', 'Невролог'], 'вторая правка потерялась');

  card = await openCard('dr.cardio');
  await tab(card, 'Должность');
  pick(specSelects(card)[1], 'Диетолог');
  buttonWith(byClass(card, 'spec-list')[0], 'Добавить специальность').click();
  await flush();
  assert.equal(specSelects(card).length, 3, '«Добавить специальность» после правки не добавила строку');
  pick(specSelects(card)[2], 'Невролог');
  await save(card);
  assert.deepEqual(onlyWrite().specialties.map((s) => s.name), ['Кардиолог', 'Диетолог', 'Невролог']);
});

test('добавили третью — список уходит целиком; сменили и вернули как было — не уходит', async () => {
  let card = await openCard('dr.cardio');
  await tab(card, 'Должность');
  buttonWith(byClass(card, 'spec-list')[0], 'Добавить специальность').click();
  await flush();
  pick(specSelects(card)[2], 'Диетолог');
  await save(card);
  let body = onlyWrite();
  assert.deepEqual(body.specialties.map((s) => s.name), ['Кардиолог', 'Терапевт', 'Диетолог']);
  assert.equal(body.specialty, 'Кардиолог');

  card = await openCard('dr.cardio');
  await tab(card, 'Должность');
  pick(specSelects(card)[1], 'Диетолог');
  pick(specSelects(card)[1], 'Терапевт');
  await changeSalary(card);
  await save(card);
  noSpecialties(onlyWrite());
});
