// STAFF_SYNC_V1 — экран «Сотрудники» в ФИЛИАЛЕ.
//
// Сотрудники едут из главной клиники (branch-sync/catalogue.js, миграция 086), и
// приехавшую строку филиал править не вправе: сервер отвечает на такую правку
// 409, а главное — правка, которая всё-таки прошла бы, дожила бы до ближайшей
// синхронизации и молча откатилась. Экран обязан сказать это ДО того, как
// человек за стойкой начнёт печатать.
//
// Проверяется ровно три вещи, и каждая — то, из-за чего экран может тихо
// соврать:
//   * в списке видно, кем управляется строка (иначе карточки открывают наугад);
//   * карточка главной клиники не предлагает «Сохранить» и не даёт печатать —
//     ВКЛЮЧАЯ поля вложенных секций, которые строятся своим кодом;
//   * своя, местная карточка не изменилась ничем: в клинике из одного здания и
//     в самой главной клинике этот экран обязан остаться прежним.
//
// Fake-DOM харнесс — тот же, что в __tests__/services-catalog.test.mjs, оттуда
// же и пин localStorage 'admin.lang'='ru' ДО импорта экрана.

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

// Филиал: свой регистратор (заведён здесь) и врач, приехавший из главной
// клиники — ровно то, что отдаёт GET /api/users после синхронизации.
const LOCAL = {
  id: 1, username: 'registratura', full_name: 'Своя Регистратура', role: 'registrar',
  is_active: true, is_local: true, extra_roles: [], phone: '+998901112233',
  staff_type: 'admin_staff', is_doctor: false, service_rates: [], referral_rates: [],
};
const MANAGED = {
  id: 2, username: 'ivanov', full_name: 'Иванов Иван', role: 'doctor',
  is_active: true, is_local: false, extra_roles: [], phone: '+998901112244',
  staff_type: 'doctor', is_doctor: true, specialty: 'Кардиолог',
  service_rates: [], referral_rates: [],
};

const patches = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u === '/api/users') return { ok: true, json: async () => ({ users: [LOCAL, MANAGED] }) };
  if (u.startsWith('/api/users/')) { patches.push({ u, opts }); return { ok: true, json: async () => ({ user: {} }) }; }
  if (u === '/api/db') {
    const desc = opts && opts.body ? JSON.parse(opts.body) : {};
    const rows = desc.table === 'departments' ? [{ id: 1, name: 'Терапия' }]
      : desc.table === 'branches' ? [{ id: 1, name: 'Чиланзар' }] : [];
    return { ok: true, json: async () => ({ data: rows }) };
  }
  return { ok: true, json: async () => ({ data: [] }) };
};

const { renderEmployees } = await import('../views/employees.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }

async function paintList() {
  document.body.children.length = 0;
  patches.length = 0;
  const container = mk('div');
  await renderEmployees(container);
  await flush();
  return container;
}

/** Строка списка по логину — по ней и открывается карточка. */
function rowFor(container, username) {
  return tags(container, 'tr').find((r) => textOf(r).includes('@' + username));
}

/** Открыть карточку кликом по строке; модалка уходит в document.body. */
async function openCard(container, username) {
  rowFor(container, username).dispatchEvent({ type: 'click', currentTarget: null, preventDefault() {}, stopPropagation() {} });
  await flush();
  return document.body.children[document.body.children.length - 1];
}

test('в списке видно, кем управляется строка', async () => {
  const c = await paintList();
  assert.ok(textOf(rowFor(c, 'ivanov')).includes('Главная клиника'),
    'иначе администратор филиала открывает карточки наугад, чтобы понять, какую он вправе править');
  assert.ok(!textOf(rowFor(c, 'registratura')).includes('Главная клиника'),
    'своего сотрудника метить нечем — он и есть обычный случай');
});

test('карточка сотрудника главной клиники: объяснение вместо «Сохранить»', async () => {
  const c = await paintList();
  const card = await openCard(c, 'ivanov');
  const text = textOf(card);

  assert.ok(text.includes('Этого сотрудника ведёт главная клиника'),
    'экран обязан сказать, почему поля не работают, и где их менять');
  assert.equal(buttonWith(card, 'Сохранить сотрудника'), undefined,
    'кнопки нет вовсе, а не отключённой: отключённая предлагает действие и молчит о причине');
  assert.equal(buttonWith(card, 'Удалить'), undefined,
    'удалить нельзя — человек приехал бы заново под новым id, а история здания указывала бы в никуда');

  const fields = [...tags(card, 'input'), ...tags(card, 'select')];
  assert.ok(fields.length > 0, 'поля в карточке всё-таки есть — её открывают, чтобы ПОСМОТРЕТЬ');
  assert.ok(fields.every((f) => f.disabled === true), 'ни одного поля, в которое можно печатать');
});

test('вложенные разделы карточки тоже не редактируются', async () => {
  const c = await paintList();
  const card = await openCard(c, 'ivanov');

  // «Рабочее время» и «Услуги и ставки» строят свои поля собственным кодом, мимо
  // любого перечня в редакторе, — и именно там дыра была бы незаметна.
  for (const section of ['Рабочее время', 'Услуги и ставки']) {
    const item = walk(card).find((n) => n._t === section && n.tagName !== 'BUTTON');
    assert.ok(item, 'раздел «' + section + '» обязан быть в карточке врача');
    item.dispatchEvent({ type: 'click', currentTarget: item, preventDefault() {}, stopPropagation() {} });
    await flush();
    const fields = [...tags(card, 'input'), ...tags(card, 'select'), ...tags(card, 'textarea')];
    assert.ok(fields.every((f) => f.disabled === true), 'раздел «' + section + '»: осталось поле, в которое можно печатать');
  }
});

test('своя карточка филиала не изменилась ничем', async () => {
  const c = await paintList();
  const card = await openCard(c, 'registratura');
  const text = textOf(card);

  assert.ok(!text.includes('Этого сотрудника ведёт главная клиника'));
  assert.ok(buttonWith(card, 'Сохранить сотрудника'), 'местного сотрудника филиал правит сам');
  const fields = tags(card, 'input');
  assert.ok(fields.some((f) => !f.disabled), 'поля обязаны работать');
});
