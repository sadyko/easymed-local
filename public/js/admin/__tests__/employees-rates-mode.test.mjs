// RATES_MODE_TYPED_V1 (2026-09-29) — переключатель «% / сум» в карточке врача
// больше не превращает введённую сумму в 100 %.
//
// Аудит на живом экране доказал две дыры, обе — деньги врача:
//   C1. «Ставка для всех»: 50 000, затем щелчок «сум». Поле применялось на
//       blur ещё в режиме «%», прижималось к 100 — и каждая отмеченная услуга
//       сохранялась как pct: 100 под тостом «Сотрудник сохранён».
//   M2. Строка: 25 000 в режиме «%», затем «сум». Процент прижимался к 100,
//       а сумма становилась 0: врачу платилось 0, обратный щелчок давал 100 %.
// Теперь:
//   * «Ставка для всех» применяется ТОЛЬКО по Enter или «Применить», смена
//     режима ничего не применяет; «%» больше 100 не применяется, а говорит тостом;
//   * строка переносит набранное число: %→сум — сумма = число в поле, процент
//     строки — каким он был при отрисовке (не было — «по умолчанию»); сум→% —
//     число переносится, только если оно не больше 100;
//   * тихого зажима в 100 нет: сохранение ОТКАЗЫВАЕТ и открывает нужную вкладку;
//   * то же во вкладке «Стационар».
//
// Fake-DOM харнесс — тот же, что в employees-referral-tab.test.mjs, плюс
// перехват тоста (сам тост пишет свой таймер в поле, где харнесс держит текст).

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
// Каждый тост — в список: ui.js toast() ищет #toast и пишет в него textContent.
const toasts = [];
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { get() { return toasts[toasts.length - 1] || ''; }, set(v) { toasts.push(String(v)); } });
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById: (id) => (id === 'toast' ? toastEl : null),
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
    { service_id: 1, pct: 40, branches: [1] },                  // процент
    { service_id: 2, branches: [1] },                           // «по умолчанию» — ключа pct нет
    { service_id: 3, pct: 30, fix: 15000, branches: [1] },      // сумма; процент лежит рядом
  ],
  referral_rates: [],
  inpatient_rates: [{ service_id: 1, pct: 20 }, { service_id: 3, fix: 70000 }],
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
const segButton = (root, label) => tags(byClass(root, 'rt-seg')[0], 'button').find((b) => textOf(b).trim() === label);
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }

async function openCard() {
  document.body.children.length = 0;
  patches.length = 0;
  toasts.length = 0;
  const container = mk('div');
  await renderEmployees(container);
  await flush();
  const row = tags(container, 'tr').find((r) => textOf(r).includes('@surgeon'));
  row.dispatchEvent({ type: 'click', currentTarget: null, preventDefault() {}, stopPropagation() {} });
  await flush();
  return document.body.children[document.body.children.length - 1];
}
async function goTo(card, label) {
  // Пункт левой рейки — div с обработчиком клика, внутри которого подпись раздела.
  const item = walk(card).filter((n) => n._l && n._l.click && textOf(n).includes(label)).pop();
  assert.ok(item, 'нет раздела «' + label + '» в рейке');
  item.click();
  await flush();
}
async function openTab(label) { const card = await openCard(); await goTo(card, label); return card; }

const rowOf = (card, name) => byClass(card, 'rt-item').find((r) => textOf(r).includes(name));
const rateOf = (row) => byClass(row, 'rt-num').find((n) => !String(n.className).includes('rt-num--price'));
const inpRateOf = (row) => byClass(row, 'rt-num--inp')[0];
const bulkBox = (card) => byClass(card, 'rt-bulk')[0];
const bulkInput = (card) => tags(bulkBox(card), 'input')[0];
const type = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input' }); };
const enter = (el) => el.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
// Щелчок мышью по кнопке рядом с полем в браузере сначала снимает фокус с поля.
const blur = (el) => el.dispatchEvent({ type: 'blur' });
async function save(card) {
  buttonWith(card, 'Сохранить сотрудника').click();
  await flush();
}
async function savedBody(card) {
  await save(card);
  assert.equal(patches.length, 1, 'карточка ушла на сервер одним PATCH; тосты: ' + toasts.join(' | '));
  return patches[0].body;
}
const PCT_TOAST = 'Процент не больше 100 — для суммы выберите «сум».';

// ---------------------------------------------------------------------------
// «Услуги и ставки» — «Ставка для всех» (C1)
// ---------------------------------------------------------------------------

test('C1: 50 000 в «Ставке для всех», затем «сум» — ничего не применено; Enter — сумма = набранное', async () => {
  const card = await openTab('Услуги и ставки');
  const bulk = bulkInput(card);
  type(bulk, '50000');
  blur(bulk);
  segButton(bulkBox(card), 'сум').click();
  await flush();
  // До Enter строки не тронуты — ни 100 %, ни чего-либо ещё.
  assert.equal(rateOf(rowOf(card, 'Аппендэктомия')).value, '40', 'строку тронули до Enter');
  assert.equal(rateOf(rowOf(card, 'Перевязка')).value, '', 'строку «по умолчанию» тронули до Enter');
  assert.equal(bulk.value, '50000', 'набранное стёрлось до применения');
  enter(bulk);
  await flush();
  assert.equal(bulkInput(card).value, '', 'после применения поле очищается');
  const body = await savedBody(card);
  assert.deepEqual(body.service_rates, [
    { service_id: 1, pct: 40, fix: 50000, branches: [1] },
    { service_id: 2, fix: 50000, branches: [1] },
    { service_id: 3, pct: 30, fix: 50000, branches: [1] },
  ]);
});

test('C1: «Применить» рядом с полем применяет так же, как Enter; blur — не применяет', async () => {
  const card = await openTab('Услуги и ставки');
  const bulk = bulkInput(card);
  type(bulk, '12');
  blur(bulk);
  assert.equal(rateOf(rowOf(card, 'Аппендэктомия')).value, '40', 'blur снова применяет «Ставку для всех»');
  const apply = buttonWith(bulkBox(card), 'Применить');
  assert.ok(apply, 'нет кнопки «Применить» у «Ставки для всех»');
  apply.click();
  await flush();
  const body = await savedBody(card);
  assert.deepEqual(body.service_rates, [
    { service_id: 1, pct: 12, branches: [1] },
    { service_id: 2, pct: 12, branches: [1] },
    { service_id: 3, pct: 12, branches: [1] },
  ]);
});

test('«Ставка для всех» в % больше 100 не применяется и говорит тостом', async () => {
  const card = await openTab('Услуги и ставки');
  const bulk = bulkInput(card);
  type(bulk, '150');
  enter(bulk);
  await flush();
  assert.ok(toasts.includes(PCT_TOAST), 'нет тоста про 100 %: ' + toasts.join(' | '));
  assert.equal(rateOf(rowOf(card, 'Аппендэктомия')).value, '40', '150 % применилось');
  const body = await savedBody(card);
  assert.deepEqual(body.service_rates, DOC.service_rates, 'ставки изменились');
});

// ---------------------------------------------------------------------------
// «Услуги и ставки» — строка (M2)
// ---------------------------------------------------------------------------

test('M2: 25 000 в «%», затем «сум» — сумма = набранное, процент строки прежний; обратно — прежний процент', async () => {
  const card = await openTab('Услуги и ставки');
  type(rateOf(rowOf(card, 'Аппендэктомия')), '25000');
  segButton(rowOf(card, 'Аппендэктомия'), 'сум').click();
  await flush();
  assert.equal(rateOf(rowOf(card, 'Аппендэктомия')).value, '25000', 'сумма не перенеслась в поле');
  segButton(rowOf(card, 'Аппендэктомия'), '%').click();
  await flush();
  assert.equal(rateOf(rowOf(card, 'Аппендэктомия')).value, '40', '25 000 стало процентом (или 100 %)');
  segButton(rowOf(card, 'Аппендэктомия'), 'сум').click();
  await flush();
  const body = await savedBody(card);
  assert.deepEqual(body.service_rates[0], { service_id: 1, pct: 40, fix: 40, branches: [1] },
    'переключение %→сум переносит число из поля (40), процент — прежний');
});

test('M2: сохранение после «сум» пишет набранную сумму, а не {pct: 100, fix: 0}', async () => {
  const card = await openTab('Услуги и ставки');
  type(rateOf(rowOf(card, 'Аппендэктомия')), '25000');
  segButton(rowOf(card, 'Аппендэктомия'), 'сум').click();
  await flush();
  const body = await savedBody(card);
  assert.deepEqual(body.service_rates[0], { service_id: 1, pct: 40, fix: 25000, branches: [1] });
});

test('M2: строка «по умолчанию» — 25 000 → «сум» → «%»: снова «по умолчанию», без ключа pct', async () => {
  let card = await openTab('Услуги и ставки');
  type(rateOf(rowOf(card, 'Перевязка')), '25000');
  segButton(rowOf(card, 'Перевязка'), 'сум').click();
  await flush();
  let body = await savedBody(card);
  assert.deepEqual(body.service_rates[1], { service_id: 2, fix: 25000, branches: [1] });

  card = await openTab('Услуги и ставки');
  type(rateOf(rowOf(card, 'Перевязка')), '25000');
  segButton(rowOf(card, 'Перевязка'), 'сум').click();
  await flush();
  segButton(rowOf(card, 'Перевязка'), '%').click();
  await flush();
  const inp = rateOf(rowOf(card, 'Перевязка'));
  assert.equal(inp.value, '', 'сумма стала процентом');
  assert.match(String(inp.attrs.placeholder || ''), /умолчанию/i);
  body = await savedBody(card);
  assert.deepEqual(body.service_rates[1], { service_id: 2, branches: [1] });
});

test('сум→%: число до 100 переносится процентом, больше 100 — процентом не становится', async () => {
  let card = await openTab('Услуги и ставки');
  type(rateOf(rowOf(card, 'Холецистэктомия')), '45');
  segButton(rowOf(card, 'Холецистэктомия'), '%').click();
  await flush();
  assert.equal(rateOf(rowOf(card, 'Холецистэктомия')).value, '45');
  let body = await savedBody(card);
  assert.deepEqual(body.service_rates[2], { service_id: 3, pct: 45, branches: [1] });

  card = await openTab('Услуги и ставки');
  segButton(rowOf(card, 'Холецистэктомия'), '%').click();   // в поле 15 000
  await flush();
  assert.equal(rateOf(rowOf(card, 'Холецистэктомия')).value, '30', 'сумма стала процентом');
  body = await savedBody(card);
  assert.deepEqual(body.service_rates[2], { service_id: 3, pct: 30, branches: [1] });
});

// ---------------------------------------------------------------------------
// Сохранение отказывает, а не прижимает к 100
// ---------------------------------------------------------------------------

test('процент больше 100 хранится как набран, сохранение отказывает и открывает «Услуги и ставки»', async () => {
  const card = await openTab('Услуги и ставки');
  type(rateOf(rowOf(card, 'Аппендэктомия')), '150');
  await goTo(card, 'Личные данные');
  assert.equal(byClass(card, 'rt-item').length, 0, 'тест не ушёл с вкладки');
  await save(card);
  assert.equal(patches.length, 0, 'карточка ушла на сервер с 150 %');
  assert.ok(toasts.includes('Ставка «Аппендэктомия» — 150%: процент не больше 100. Если это сумма, переключите на «сум».'),
    'нет тоста отказа: ' + toasts.join(' | '));
  assert.ok(!toasts.includes('Сотрудник сохранён'));
  const row = rowOf(card, 'Аппендэктомия');
  assert.ok(row, 'отказ не открыл «Услуги и ставки»');
  assert.equal(rateOf(row).value, '150', 'набранное тихо прижато к 100');
});

// ---------------------------------------------------------------------------
// «Стационар» — строка и «Ставка для всех»
// ---------------------------------------------------------------------------

test('«Стационар», строка: 25 000 в «%» → «сум» — сумма = набранное; обратно — прежний процент', async () => {
  let card = await openTab('Стационар');
  type(inpRateOf(rowOf(card, 'Аппендэктомия')), '25000');
  segButton(rowOf(card, 'Аппендэктомия'), 'сум').click();
  await flush();
  assert.equal(inpRateOf(rowOf(card, 'Аппендэктомия')).value, '25000');
  let body = await savedBody(card);
  assert.deepEqual(body.inpatient_rates[0], { service_id: 1, fix: 25000 });

  card = await openTab('Стационар');
  type(inpRateOf(rowOf(card, 'Аппендэктомия')), '25000');
  segButton(rowOf(card, 'Аппендэктомия'), 'сум').click();
  await flush();
  segButton(rowOf(card, 'Аппендэктомия'), '%').click();
  await flush();
  assert.equal(inpRateOf(rowOf(card, 'Аппендэктомия')).value, '20', 'сумма стала процентом (или 100 %, или 0)');
  body = await savedBody(card);
  assert.deepEqual(body.inpatient_rates[0], { service_id: 1, pct: 20 });
});

test('«Стационар», строка сум→%: до 100 переносится, больше 100 — нет', async () => {
  let card = await openTab('Стационар');
  type(inpRateOf(rowOf(card, 'Холецистэктомия')), '15');
  segButton(rowOf(card, 'Холецистэктомия'), '%').click();
  await flush();
  let body = await savedBody(card);
  assert.deepEqual(body.inpatient_rates[1], { service_id: 3, pct: 15 });

  card = await openTab('Стационар');
  segButton(rowOf(card, 'Холецистэктомия'), '%').click();   // в поле 70 000
  await flush();
  assert.notEqual(inpRateOf(rowOf(card, 'Холецистэктомия')).value, '100', '70 000 стало 100 %');
  body = await savedBody(card);
  assert.deepEqual(body.inpatient_rates[1], { service_id: 3, pct: 0 });
});

test('«Стационар», «Ставка для всех»: 50 000, «сум» — ничего; Enter — сумма = набранное', async () => {
  const card = await openTab('Стационар');
  const bulk = bulkInput(card);
  type(bulk, '50000');
  blur(bulk);
  segButton(bulkBox(card), 'сум').click();
  await flush();
  assert.equal(inpRateOf(rowOf(card, 'Аппендэктомия')).value, '20', 'строку тронули до Enter');
  enter(bulk);
  await flush();
  assert.equal(bulkInput(card).value, '');
  const body = await savedBody(card);
  assert.deepEqual(body.inpatient_rates, [{ service_id: 1, fix: 50000 }, { service_id: 3, fix: 50000 }]);
});

test('«Стационар», «Ставка для всех»: «Применить» есть; 150 % не применяется и говорит тостом', async () => {
  const card = await openTab('Стационар');
  const bulk = bulkInput(card);
  type(bulk, '150');
  const apply = buttonWith(bulkBox(card), 'Применить');
  assert.ok(apply, 'нет кнопки «Применить» у «Ставки для всех» стационара');
  apply.click();
  await flush();
  assert.ok(toasts.includes(PCT_TOAST), 'нет тоста про 100 %: ' + toasts.join(' | '));
  const body = await savedBody(card);
  assert.deepEqual(body.inpatient_rates, DOC.inpatient_rates);
});

test('«Стационар»: процент больше 100 — отказ сохранения и открытая вкладка «Стационар»', async () => {
  const card = await openTab('Стационар');
  type(inpRateOf(rowOf(card, 'Аппендэктомия')), '150');
  await goTo(card, 'Личные данные');
  await save(card);
  assert.equal(patches.length, 0, 'карточка ушла на сервер с 150 %');
  assert.ok(toasts.includes('Ставка «Аппендэктомия» — 150%: процент не больше 100. Если это сумма, переключите на «сум».'),
    'нет тоста отказа: ' + toasts.join(' | '));
  const inp = inpRateOf(rowOf(card, 'Аппендэктомия') || mk('div'));
  assert.ok(inp, 'отказ не открыл «Стационар»');
  assert.equal(inp.value, '150', 'набранное тихо прижато к 100');
});
