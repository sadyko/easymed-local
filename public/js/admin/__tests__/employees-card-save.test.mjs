// EMPLOYEE_CARD_SAVE_V1 (2026-10-02) — «Сохранить сотрудника» у врача, чьё имя
// лежит одной строкой full_name, и у сотрудника без телефона.
//
// Владелец: «in the doctors, the actual name and surname and other information
// not saving, also the shares to the services, referrals, and also the
// stationary services are not saving when edited». Повторено в браузере на
// копии базы: карточка читала только last_name / first_name, у демо-врачей и
// `admin` первого запуска они пусты, а save() отказывал ВСЕЙ карточке, пока не
// заполнены Фамилия, Имя И Телефон, — даже когда менялись одни ставки. Тост
// «Заполните личные данные.» гас через 2,4 с, и ни один запрос не уходил.
//
// Проверяется:
//   * фамилия и имя разбираются из full_name и видны в «Личных данных» и шапке;
//   * без телефона уходят «Услуги и ставки», «Стационар» и «Вознаграждение»;
//   * одно слово в full_name — Имя пусто, другие вкладки сохраняются, ФИО не
//     отправляется (сервер оставит full_name как был);
//   * новый сотрудник — Фамилия, Имя и Телефон по-прежнему обязательны;
//   * отказ называет поля и стоит в разделе, а не только в тосте.
//
// Fake-DOM харнесс — тот же, что в employees-referral-tab.test.mjs.

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
 focus(){ globalThis.__focused = this; } blur(){} scrollTo(){} remove(){} select(){}
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

// Демо-врач (scripts/seed-demo-hospital.mjs): одна строка full_name, без
// частей имени, без телефона и без категории — врачом его делает is_doctor.
const DEMO = {
  id: 49, username: 'demo_abdullaev', full_name: 'Абдуллаев Шерзод',
  last_name: null, first_name: null, middle_name: null, phone: null,
  role: 'doctor', is_active: true, is_local: true, extra_roles: [],
  staff_type: null, is_doctor: true, specialty: 'Терапевт',
  service_rates: [], referral_rates: [], inpatient_rates: [],
};
// Врач, заведённый одним словом.
const ONEWORD = {
  id: 52, username: 'madina', full_name: 'Мадина',
  last_name: null, first_name: null, middle_name: null, phone: '',
  role: 'doctor', is_active: true, is_local: true, extra_roles: [],
  staff_type: 'doctor', is_doctor: true, specialty: 'Педиатр',
  service_rates: [{ service_id: 2, pct: 30, branches: [] }], referral_rates: [], inpatient_rates: [],
};
// `admin` первого запуска (services/auth.js bootstrapAdmin): full_name «Administrator»,
// ни телефона, ни категории.
const FIRST_ADMIN = {
  id: 1, username: 'admin', full_name: 'Administrator',
  last_name: null, first_name: null, middle_name: null, phone: null,
  role: 'admin', is_active: true, is_local: true, extra_roles: [],
  staff_type: null, is_doctor: false, service_rates: [], referral_rates: [],
};
const SERVICES = [
  { id: 1, name: 'Консультация терапевта', price: 150000, type: 'consultation', type_id: null, category_id: null },
  { id: 2, name: 'Перевязка', price: 100000, type: 'procedure', type_id: null, category_id: null },
];

const writes = [];
const dbCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  if (u === '/api/users' && method === 'GET') return { ok: true, json: async () => ({ users: [DEMO, ONEWORD, FIRST_ADMIN] }) };
  if (u.startsWith('/api/users')) { writes.push({ u, method, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ user: {} }) }; }
  if (u === '/api/db') {
    const desc = opts.body ? JSON.parse(opts.body) : {};
    dbCalls.push(desc);
    let rows = [];
    if (desc.table === 'services') rows = SERVICES;
    else if (desc.table === 'branches') rows = [{ id: 1, name: 'Чиланзар' }];
    else if (desc.table === 'referral_sources' && desc.op === 'select') rows = [{ id: 55, reward_mode: 'category', own_percent: 0, own_rates: '', category_id: 3 }];
    else if (desc.table === 'referral_source_categories') rows = [{ id: 3, name: 'Внутренние врачи', standard_percent: 0 }];
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
const byPh = (card, ph) => tags(card, 'input').find((i) => i.attrs.placeholder === ph);
const lastName = (card) => byPh(card, 'Каюмов');
const firstName = (card) => byPh(card, 'Араббек');
const middleName = (card) => byPh(card, 'Акмалович');
const phoneWrap = (card) => byClass(card, 'ph-wrap')[0];
// Отказ в разделе — узел role=alert; его текст без значка (в харнессе svg несёт разметку текстом).
const alertText = (card) => { const a = walk(card).find((n) => n.attrs && n.attrs.role === 'alert'); return a ? walk(a).filter((n) => n.tagName === '#TEXT').map((n) => n._t).join('').trim() : null; };

let container;
async function openList() {
  document.body.children.length = 0;
  writes.length = 0;
  dbCalls.length = 0;
  container = mk('div');
  await renderEmployees(container);
  await flush();
}
async function openCard(username) {
  await openList();
  const row = tags(container, 'tr').find((r) => textOf(r).includes('@' + username));
  assert.ok(row, 'нет строки @' + username);
  row.dispatchEvent({ type: 'click', currentTarget: null, preventDefault() {}, stopPropagation() {} });
  await flush();
  return document.body.children.find((c) => c.className === 'modal');
}
async function openNew() {
  await openList();
  buttonWith(container, 'Новый сотрудник').click();
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
const rowOf = (card, name) => byClass(card, 'rt-item').find((r) => textOf(r).includes(name));
const tick = (row) => tags(row, 'input').find((i) => i.attrs.type === 'checkbox').dispatchEvent({ type: 'change' });

test('имя из full_name: «Личные данные» и шапка показывают фамилию и имя, а не логин', async () => {
  const card = await openCard('demo_abdullaev');
  assert.equal(lastName(card).value, 'Абдуллаев');
  assert.equal(firstName(card).value, 'Шерзод');
  assert.equal(middleName(card).value, '');
  const head = tags(card, 'strong')[0];
  assert.equal(textOf(head).trim(), 'Абдуллаев Шерзод', 'шапка показывает логин вместо имени');
  // Телефона нет — это подсказка в разделе, а не запрет.
  assert.ok(textOf(card).includes('Телефон не заполнен'), 'нет подсказки о пустом телефоне');
});

test('без телефона «Услуги и ставки» сохраняются: PATCH уходит, ФИО — разобранное из full_name', async () => {
  const card = await openCard('demo_abdullaev');
  await tab(card, 'Услуги и ставки');
  tick(rowOf(card, 'Перевязка'));
  await flush();
  type(byClass(rowOf(card, 'Перевязка'), 'rt-num').find((i) => !String(i.className).includes('rt-num--price')), '25');
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  const { u, method, body } = writes[0];
  assert.equal(u, '/api/users/49');
  assert.equal(method, 'PATCH');
  // Части имени те же, что в full_name: сервер соберёт его заново таким же.
  assert.equal(body.last_name, 'Абдуллаев');
  assert.equal(body.first_name, 'Шерзод');
  assert.equal(body.middle_name, '');
  assert.equal(body.phone, '');
  assert.equal(body.staff_type, 'doctor');
  assert.deepEqual(body.service_rates, [{ service_id: 2, pct: 25, branches: [] }]);
  assert.ok(!textOf(document.body).includes('Заполните личные данные.'), 'старый отказ всей карточке');
  assert.ok(!textOf(document.body).includes('Не заполнено'), 'отказ при правке одних ставок');
});

test('без телефона «Стационар» и «Вознаграждение за направления» сохраняются', async () => {
  const card = await openCard('demo_abdullaev');
  await tab(card, 'Стационар');
  const [pct, fixed] = byClass(card, 'rt-num--bonus');
  type(pct, '7');
  type(fixed, '50000');
  await tab(card, 'Вознаграждение за направления');
  const chkBox = byClass(card, 'checkbox').find((n) => textOf(n).includes('Вознаграждение по категории'));
  const modeChk = tags(chkBox, 'input')[0];
  modeChk.checked = false; modeChk.dispatchEvent({ type: 'change' });
  const own = tags(card, 'input').find((n) => n.attrs.type === 'number' && n.attrs.placeholder === '0');
  type(own, '12');
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  assert.equal(writes[0].body.inpatient_referral_pct, 7);
  assert.equal(writes[0].body.inpatient_referral_fixed, 50000);
  const upd = dbCalls.find((d) => d.table === 'referral_sources' && d.op === 'update');
  assert.ok(upd, 'ставка за направления не записана');
  assert.equal(upd.values.reward_mode, 'own');
  assert.equal(upd.values.own_percent, 12);
});

test('одно слово в full_name: Фамилия = слово, Имя пусто — ставки сохраняются, ФИО не отправляется', async () => {
  const card = await openCard('madina');
  assert.equal(lastName(card).value, 'Мадина');
  assert.equal(firstName(card).value, '');
  // Постоянная пометка в разделе: что не так и что будет при сохранении.
  assert.ok(textOf(card).includes('Фамилия или имя не заполнены. Остальные разделы карточки сохраняются, а ФИО останется прежним, пока не заполните оба поля.'),
    'нет пометки о неполном ФИО');
  await tab(card, 'Услуги и ставки');
  tick(rowOf(card, 'Консультация терапевта'));
  await flush();
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  const body = writes[0].body;
  for (const k of ['last_name', 'first_name', 'middle_name']) assert.ok(!(k in body), k + ' ушло на сервер — full_name пересобрался бы из неполных частей');
  assert.deepEqual(body.service_rates.map((r) => r.service_id), [2, 1]);
});

test('`admin` первого запуска: без имени, телефона и категории — «Занятость и зарплата» сохраняется', async () => {
  const card = await openCard('admin');
  assert.equal(lastName(card).value, 'Administrator');
  await tab(card, 'Должность');
  assert.ok(textOf(card).includes('Категория сотрудника не выбрана'), 'нет подсказки о пустой категории');
  await tab(card, 'Занятость и зарплата');
  const salary = tags(card, 'input').find((i) => i.attrs.type === 'number' && i.attrs.placeholder === '0');
  type(salary, '3000000');
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  const body = writes[0].body;
  assert.equal(body.salary_fixed, 3000000);
  assert.equal(body.staff_type, '');
  assert.ok(!('first_name' in body));
});

test('правят ФИО и оставляют Имя пустым — отказ называет поле, стоит в разделе и не гаснет', async () => {
  const card = await openCard('madina');
  type(middleName(card), 'Каримовна');
  await tab(card, 'Услуги и ставки');
  await save(card);
  assert.equal(writes.length, 0, 'неполное ФИО ушло на сервер');
  // Карточка вернулась в «Личные данные», и отказ — в самом разделе.
  assert.ok(lastName(card), 'карточка не перешла в «Личные данные»');
  assert.equal(alertText(card), 'Не заполнено: Имя', 'отказ только в тосте или не называет поле');
  assert.equal(firstName(card).getAttribute('aria-invalid'), 'true', 'пустое поле не отмечено');
  assert.equal(globalThis.__focused, firstName(card), 'фокус не на пустом поле');
  // Отказ не гаснет сам: он и после другой вкладки на месте.
  await tab(card, 'Должность');
  await tab(card, 'Личные данные');
  assert.ok(textOf(card).includes('Не заполнено: Имя'), 'отказ пропал после смены вкладки');
  // Имя вписали — отказ уходит сразу, без повторного сохранения.
  type(firstName(card), 'Алиева');
  assert.ok(!textOf(card).includes('Не заполнено: Имя'), 'отказ остался после заполнения');
  await save(card);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.last_name, 'Мадина');
  assert.equal(writes[0].body.first_name, 'Алиева');
  assert.equal(writes[0].body.middle_name, 'Каримовна');
});

test('стёрли фамилию существующему — «Не заполнено: Фамилия»', async () => {
  const card = await openCard('demo_abdullaev');
  type(lastName(card), '');
  await save(card);
  assert.equal(writes.length, 0);
  assert.equal(alertText(card), 'Не заполнено: Фамилия', 'нет отказа в разделе');
});

test('новый сотрудник: Фамилия, Имя и Телефон обязательны — отказ перечисляет пустые', async () => {
  const card = await openNew();
  await save(card);
  assert.equal(writes.length, 0, 'новый сотрудник без ФИО ушёл на сервер');
  assert.equal(alertText(card), 'Не заполнено: Фамилия, Имя, Телефон', 'отказ только в тосте или не называет поля');
  // Подсказки «Телефон не заполнен» у нового нет: телефон здесь обязателен, и это говорит отказ.
  assert.ok(!textOf(card).includes('Телефон не заполнен'));
  type(lastName(card), 'Каюмов');
  type(firstName(card), 'Араббек');
  assert.equal(alertText(card), 'Не заполнено: Телефон', 'отказ не следит за заполнением');
  await save(card);
  assert.equal(writes.length, 0, 'новый сотрудник без телефона ушёл на сервер');
  const ph = phoneWrap(card);
  ph.input.value = '+998 90 961 00 04';
  ph.input.dispatchEvent({ type: 'input' });
  ph.dispatchEvent({ type: 'input' });
  await save(card);
  assert.equal(writes.length, 0);
  assert.equal(alertText(card), 'Не заполнено: Категория сотрудника', 'следующий отказ — категория в «Должности»');
});
