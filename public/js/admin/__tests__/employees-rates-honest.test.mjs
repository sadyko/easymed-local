// RATES_HONEST_V1 (2026-09-30) — «Услуги и ставки» карточки врача говорят правду.
//
// Решения владельца по денежному аудиту 29.09:
//   1. «Keep 0, label it honestly» — запись без процента платится
//      users.service_rate_default, а его не пишет ни один экран, то есть 0 %.
//      Подсказка пустого поля — «0 % — не задано», под мышью — что врач за
//      услугу получает 0 %. Расчёт не меняется.
//   2. «Remove the column» — расчёт доли и своей цены филиал не читает, а две
//      записи «по филиалам» на одну услугу молча сливались в последнюю.
//      Колонки «Филиалы» нет; над таблицей — одна строка «во всех филиалах».
//      Поле branches в записях не стирается и заново не пишется: старые записи
//      несут его как есть, новые пишутся с пустым списком.
//
// Fake-DOM харнесс — тот же, что в employees-default-rate.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    { service_id: 1, branches: [1] },                        // оказывает, процента нет — 0 %
    { service_id: 2, pct: 40, branches: [1, 2] },            // старая запись «по филиалам»
    { service_id: 3, pct: 10, price: 150000, branches: [] },
  ],
  referral_rates: [],
  inpatient_rates: [],
  inpatient_referral_pct: 0, inpatient_referral_fixed: 0,
};
const SERVICES = [
  { id: 1, name: 'Аппендэктомия', price: 1000000, type: 'procedure', type_id: null, category_id: null },
  { id: 2, name: 'Перевязка', price: 100000, type: 'procedure', type_id: null, category_id: null },
  { id: 3, name: 'Холецистэктомия', price: 2000000, type: 'other', type_id: null, category_id: null },
  { id: 4, name: 'УЗИ брюшной полости', price: 200000, type: 'imaging', type_id: null, category_id: null },
];

const patches = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u === '/api/users') return { ok: true, json: async () => ({ users: [DOC] }) };
  if (u.startsWith('/api/users/')) { patches.push({ u, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ user: {} }) }; }
  if (u === '/api/db') {
    const desc = opts && opts.body ? JSON.parse(opts.body) : {};
    // Один филиал: прежде новая запись привязывалась к нему (SOLE_BRANCH_V1).
    const rows = desc.table === 'services' ? SERVICES
      : desc.table === 'branches' ? [{ id: 1, name: 'Чиланзар' }] : [];
    return { ok: true, json: async () => ({ data: rows }) };
  }
  return { ok: true, json: async () => ({ data: [] }) };
};

const { renderEmployees } = await import('../views/employees.js');
const { STRINGS } = await import('../i18n-strings.js');

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
  const item = walk(card).filter((n) => n._l && n._l.click && textOf(n).includes(label)).pop();
  assert.ok(item, 'нет раздела «' + label + '» в рейке');
  item.click();
  await flush();
  return card;
}
const rowOf = (card, name) => byClass(card, 'rt-item').find((r) => textOf(r).includes(name));
const rateOf = (row) => byClass(row, 'rt-num').find((n) => !String(n.className).includes('rt-num--price'));
const attr = (el, k) => String((el.attrs && el.attrs[k]) || el[k] || '');
async function save(card) {
  buttonWith(card, 'Сохранить сотрудника').click();
  await flush();
  assert.equal(patches.length, 1, 'карточка ушла на сервер одним PATCH');
  return patches[0].body;
}

const PLACEHOLDER = '0 % — не задано';
const TOOLTIP = 'Ставка не задана — врач за эту услугу получает 0 %. Введите процент или сумму.';
const ALL_BRANCHES = 'Ставки и своя цена действуют во всех филиалах.';

// ─── 1. пустая ставка ────────────────────────────────────────────────────────
test('пустой процент: подсказка «0 % — не задано» и под мышью — врач получает 0 %', async () => {
  const card = await openTab('Услуги и ставки');
  const empty = rateOf(rowOf(card, 'Аппендэктомия'));
  assert.equal(empty.value, '', 'нет процента — пустое поле, а не записанный 0');
  assert.equal(attr(empty, 'placeholder'), PLACEHOLDER);
  assert.equal(attr(empty, 'title'), TOOLTIP);
  assert.ok(!/умолчанию/i.test(attr(empty, 'placeholder')), 'подсказка снова обещает «по умолчанию»');
  // У заданного процента подсказка прежняя — что это за процент.
  const set = rateOf(rowOf(card, 'Перевязка'));
  assert.equal(set.value, '40');
  assert.notEqual(attr(set, 'title'), TOOLTIP);
});

// Ревью 1 — подсказка называет то, что заплатит расчёт:
// COALESCE(dr.percent, doc.service_rate_default, 0). Ставку по умолчанию экраны
// не пишут, но PATCH /api/users её принимает — если она есть, пустое поле
// говорит «{N} % — по умолчанию».
test('пустой процент при ставке по умолчанию 25 %: «25 % — по умолчанию», под мышью — ставка по умолчанию', async () => {
  DOC.service_rate_default = 25;
  try {
    const card = await openTab('Услуги и ставки');
    const empty = rateOf(rowOf(card, 'Аппендэктомия'));
    assert.equal(empty.value, '');
    assert.equal(attr(empty, 'placeholder'), '25 % — по умолчанию');
    assert.equal(attr(empty, 'title'), 'Ставка не задана — врач получает ставку по умолчанию 25 %. Введите процент или сумму.');
    // Подсказка не уходит в сохранение: ставку по умолчанию карточка не пишет.
    const body = await save(card);
    assert.equal('service_rate_default' in body, false);
  } finally { delete DOC.service_rate_default; }
  // 0 / нет — снова «0 % — не задано».
  DOC.service_rate_default = 0;
  try {
    const card = await openTab('Услуги и ставки');
    assert.equal(attr(rateOf(rowOf(card, 'Аппендэктомия')), 'placeholder'), PLACEHOLDER);
    assert.equal(attr(rateOf(rowOf(card, 'Аппендэктомия')), 'title'), TOOLTIP);
  } finally { delete DOC.service_rate_default; }
});

// ─── 2. колонки «Филиалы» нет ────────────────────────────────────────────────
test('колонки «Филиалы» нет: ни заголовка, ни выбора в строке; над таблицей — «во всех филиалах»', async () => {
  const card = await openTab('Услуги и ставки');
  const head = byClass(card, 'rt-head')[0];
  assert.ok(head, 'нет шапки таблицы ставок');
  assert.ok(!textOf(head).includes('Филиалы'), 'в шапке снова «Филиалы»');
  for (const r of byClass(card, 'rt-item')) {
    assert.equal(tags(r, 'select').length, 0, 'в строке ставки снова выбор филиала: ' + textOf(r));
  }
  assert.ok(textOf(card).includes(ALL_BRANCHES), 'нет строки «Ставки и своя цена действуют во всех филиалах.»');
  // Сетка одна на шапку и строки: ячеек столько же, сколько колонок в CSS.
  const cells = head.children.length;
  for (const r of byClass(card, 'rt-item')) assert.equal(r.children.length, cells, 'строка разошлась с шапкой');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const css = fs.readFileSync(path.join(HERE, '..', '..', '..', 'css', 'admin-views.css'), 'utf8');
  const cols = (sel) => [...css.matchAll(new RegExp('\\' + sel + '\\s*\\{[^}]*grid-template-columns:\\s*([^;]+);', 'g'))]
    .map((m) => m[1].trim().split(/\s+(?![^(]*\))/).length);
  const main = cols('.rt-row ');
  assert.ok(main.length >= 2, 'не нашёл .rt-row в CSS (обычная ширина и узкий экран)');
  for (const n of main) assert.equal(n, cells, '.rt-row: колонок в CSS ' + n + ', ячеек ' + cells);
  for (const n of cols('.rt-row--noprice')) assert.equal(n, cells, '.rt-row--noprice: колонок в CSS ' + n + ', ячеек ' + cells);
});

test('сохранение: branches прежних записей — как были; новая запись — пустой список', async () => {
  const card = await openTab('Услуги и ставки');
  // Отметить новую услугу — в клинике один филиал, и прежде запись
  // привязывалась к нему ([1]).
  const chk = tags(rowOf(card, 'УЗИ брюшной полости'), 'input').find((n) => n.attrs.type === 'checkbox');
  chk.checked = true;
  chk.dispatchEvent({ type: 'change' });
  await flush();
  const body = await save(card);
  const of = (sid) => body.service_rates.find((r) => Number(r.service_id) === sid);
  assert.deepEqual(of(1), { service_id: 1, branches: [1] }, 'запись без процента: pct не дописан, branches как были');
  assert.deepEqual(of(2), { service_id: 2, pct: 40, branches: [1, 2] }, 'branches старой записи тронуты');
  assert.deepEqual(of(3), { service_id: 3, pct: 10, price: 150000, branches: [] });
  assert.deepEqual(of(4).branches, [], 'новая запись — с пустым списком филиалов');
});

// ─── переводы ────────────────────────────────────────────────────────────────
test('новые фразы — на трёх языках', () => {
  for (const key of [PLACEHOLDER, TOOLTIP, ALL_BRANCHES, '{n} % — по умолчанию',
    'Ставка не задана — врач получает ставку по умолчанию {n} %. Введите процент или сумму.']) {
    const e = STRINGS[key];
    assert.ok(e, 'нет в словаре: ' + key);
    for (const lang of ['ru', 'uz', 'en']) assert.ok(e[lang], key + ': нет ' + lang);
    assert.ok(!/[А-Яа-яЁё]/.test(e.en), key + ': кириллица в en');
  }
});

// ─── окно услуги: «Доля исполнителя по умолчанию» ────────────────────────────
test('окно услуги: «Доля исполнителя по умолчанию» говорит, что она подставляется новому исполнителю и не меняет отмеченных', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'views', 'service-editor.js'), 'utf8');
  const HINT = 'Подставляется врачу, когда его отмечают исполнителем этой услуги; у уже отмеченных врачей ставку не меняет.';
  assert.ok(src.includes(HINT), 'нет подсказки у доли исполнителя по умолчанию');
  const e = STRINGS[HINT];
  assert.ok(e && e.ru && e.uz && e.en, 'подсказка не переведена');
  assert.ok(!/[А-Яа-яЁё]/.test(e.en));
  // Окно услуги ставкам филиал не задаёт — и не должно.
  assert.ok(!/Филиал/.test(src), 'в окне услуги появился выбор филиала для ставки');
});
