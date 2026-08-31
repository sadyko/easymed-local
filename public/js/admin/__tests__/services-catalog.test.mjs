// SERVICES_ONE_EDITOR_V1 — страница «Услуги» (каталог, views/services.js)
// открывает ЕДИНЫЙ редактор услуги (views/service-editor.js), а не собственную
// модалку. Своя модалка пережила SERVICE_EDITOR_V1, потому что services.js
// никогда не ссылался на section-crud и его никто не тронул: старые поля,
// голая галочка «Is lab test» и английские подписи на узбекском экране.
// Этот файл — регрессионный гвоздь: «Добавить услугу» и клик по строке обязаны
// открывать НОВЫЙ редактор, а единственный в клиенте путь ЖЁСТКОГО удаления
// (rpc service_delete_check → delete_service, SERVICE_DELETE_V1) обязан
// остаться достижимым с этой страницы — у нового редактора удаления нет,
// а generic-список секций умеет только деактивировать (DELETE на services
// закрыт для всех, см. server/db/schema-registry.js).
//
// Fake-DOM harness — тот же, что в __tests__/branch-sync-view.test.mjs
// (оттуда же и пин localStorage 'admin.lang'='ru' ДО импорта экрана: i18n.js
// выбирает язык один раз, при загрузке модуля).

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
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
  easymed: { state: { user: null } },
  CLINIC: { id: 1 },
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

// ---------------------------------------------------------------------------
// Сервер: /api/db отвечает по имени таблицы, /api/rpc — по имени процедуры.
// Каждый дескриптор записывается — утверждения ниже читают именно их.
// ---------------------------------------------------------------------------
const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const SVC = { id: 7, name: 'УЗИ печени', code: 'US-01', price: 50000, tax_rate: 12,
  duration_minutes: 20, requires_doctor: 1, active: 1, is_lab: 0, type: 'imaging' };
let services = [SVC];
let deleteCheck = { deletable: true, name: SVC.name, blocking: [] };
const dbCalls = [];
const rpcCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u === '/api/db') {
    const desc = opts && opts.body ? JSON.parse(opts.body) : {};
    dbCalls.push(desc);
    if (desc.op === 'select') return jsonOk(desc.table === 'services' ? services : []);
    return jsonOk({});
  }
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, args: opts && opts.body ? JSON.parse(opts.body) : {} });
    if (name === 'service_delete_check') return jsonOk(deleteCheck);
    if (name === 'delete_service') return jsonOk({ ok: true });
    return jsonOk({});
  }
  return jsonOk({});
};
let confirms = [];
let confirmAnswer = true;
globalThis.window.confirm = (text) => { confirms.push(String(text)); return confirmAnswer; };

const { renderServices } = await import('../views/services.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));
const deleteButtons = (root) => tags(root, 'button').filter((b) => b.attrs.title === 'Удалить');

/** Редактор открывается без await из onclick — даём микрозадачам дойти. */
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }

const ADMIN = { id: 1, full_name: 'Администратор', role: 'admin', is_admin: true };
const NURSE = { id: 2, full_name: 'Медсестра', role: 'nurse' };

async function paint(user = ADMIN) {
  window.easymed.state.user = user;
  document.body.children.length = 0;
  dbCalls.length = 0; rpcCalls.length = 0; confirms = []; confirmAnswer = true;
  services = [SVC];
  deleteCheck = { deletable: true, name: SVC.name, blocking: [] };
  const container = mk('div');
  await renderServices(container, {});
  await flush();
  return container;
}

// Справочники, которые грузит ТОЛЬКО единый редактор (views/service-editor.js):
// их появление в dbCalls — доказательство, что открылся именно он.
const EDITOR_LOOKUPS = ['service_types', 'service_categories', 'departments', 'rooms', 'users'];

test('«Добавить услугу» открывает ЕДИНЫЙ редактор, а не свою модалку', async () => {
  const c = await paint(ADMIN);
  const add = buttonWith(c, 'Добавить услугу');
  assert.ok(add, 'кнопка «Добавить услугу» есть и переведена');

  dbCalls.length = 0;
  add.click();
  await flush();

  const body = textOf(document.body);
  assert.ok(body.includes('Новая услуга'), 'заголовок единого редактора (создание)');
  const asked = new Set(dbCalls.filter((d) => d.op === 'select').map((d) => d.table));
  for (const t of EDITOR_LOOKUPS) assert.ok(asked.has(t), 'редактор грузит справочник ' + t);
  // Старой модалки больше нет — вместе с её английскими подписями.
  for (const dead of ['Is lab test', 'Duration (minutes)', 'Requires doctor']) {
    assert.ok(!body.includes(dead), 'подпись старой модалки исчезла: ' + dead);
  }
});

test('клик по строке открывает тот же редактор на редактирование', async () => {
  const c = await paint(ADMIN);
  const row = tags(c, 'tr').find((r) => r.className.includes('row-click'));
  assert.ok(row, 'строка услуги кликабельна');

  dbCalls.length = 0;
  row.click();
  await flush();

  assert.ok(textOf(document.body).includes('Изменить услугу'), 'заголовок единого редактора (правка)');
  assert.ok(tags(document.body, 'input').some((i) => i.value === SVC.name),
    'редактор открыт именно на этой услуге (имя в поле)');
  const asked = new Set(dbCalls.filter((d) => d.op === 'select').map((d) => d.table));
  for (const t of EDITOR_LOOKUPS) assert.ok(asked.has(t), 'редактор грузит справочник ' + t);
});

test('не-админу — редактор на просмотр и никакого удаления', async () => {
  const c = await paint(NURSE);
  assert.equal(deleteButtons(c).length, 0, 'кнопка удаления — только админу (правило SERVICE_DELETE_V1)');
  const row = tags(c, 'tr').find((r) => r.className.includes('row-click'));
  row.click();
  await flush();
  assert.ok(textOf(document.body).includes('Просмотр услуги'), 'не-админ смотрит, но не редактирует');
});

test('удаление: неиспользуемая услуга — подтверждение и rpc delete_service', async () => {
  const c = await paint(ADMIN);
  const btn = deleteButtons(c)[0];
  assert.ok(btn, 'у админа в строке есть кнопка удаления');

  btn.click();
  await flush();

  assert.ok(rpcCalls.some((r) => r.name === 'service_delete_check' && r.args.p_service_id === SVC.id),
    'сначала спрашиваем сервер, что возможно');
  assert.equal(confirms.length, 1, 'одно подтверждение');
  assert.ok(confirms[0].includes('навсегда'), 'подтверждение говорит о безвозвратном удалении');
  assert.ok(rpcCalls.some((r) => r.name === 'delete_service' && r.args.p_service_id === SVC.id),
    'жёсткое удаление идёт через rpc delete_service — генерик-DELETE закрыт');
});

test('удаление: используемая услуга — предлагает отключить и пишет active=0', async () => {
  const c = await paint(ADMIN);
  deleteCheck = { deletable: false, name: SVC.name, blocking: [{ label: 'визиты', count: 3 }] };
  const btn = deleteButtons(c)[0];

  btn.click();
  await flush();

  assert.equal(confirms.length, 1);
  assert.ok(confirms[0].includes('уже используется'), 'диалог объясняет, почему удалить нельзя');
  assert.ok(!rpcCalls.some((r) => r.name === 'delete_service'), 'delete_service НЕ зовётся');
  const upd = dbCalls.find((d) => d.op === 'update' && d.table === 'services');
  assert.ok(upd, 'вместо удаления — деактивация');
  assert.equal(upd.values.active, 0);
  assert.ok(upd.filters.some((f) => f.col === 'id' && f.val === SVC.id), 'деактивируется именно эта услуга');
});
