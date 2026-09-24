// PASSWORD_CHANGE_V2 (2026-09-23) — смена пароля с экранов.
//
// Владелец: «check for admin password changing — we cannot change» и «give
// permission to 1 or 2 character passwords». Сервер пароль из одного символа
// принимал давно; не пускали экраны:
//   * «Сменить пароль» в меню аватара звал supabase.auth.updateUser — офлайн
//     его нет, отказ был у ВСЕХ, и окно ещё требовало 8 символов;
//   * карточка сотрудника меняла пароль только вместе со всей карточкой, а та
//     требует ФИО, телефон и категорию — у `admin` первого запуска их нет.
//
// Проверяется то, что человек увидит:
//   * окно аватара шлёт текущий + новый в /api/auth/change-password, и пароль
//     из одного символа проходит;
//   * несовпадение, пустой новый и неверный текущий — сказаны словами, а не
//     кодом, и в первых двух случаях запрос не уходит вовсе;
//   * ни один клиентский файл не меняет пароль через updateUser;
//   * «Сменить пароль» в карточке сотрудника шлёт РОВНО { password } — даже
//     сотруднику без ФИО и телефона.
//
// Fake-DOM харнесс — тот же, что в employees-managed.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_JS = path.join(HERE, '..', '..');

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.children.push(c);}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,target:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} select(){}
 remove(){this.removed=true;}
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

// Учётная запись первого запуска — ровно как у владельца: ни ФИО, ни
// телефона, ни категории.
const FIRST_RUN_ADMIN = {
  id: 1, username: 'admin', full_name: '', role: 'admin', is_active: true, is_local: true,
  extra_roles: [], phone: '', last_name: '', first_name: '', staff_type: '',
  is_doctor: false, service_rates: [], referral_rates: [],
};

const calls = [];
let nextAnswer = null;   // { status, json } — ответ на ближайший запрос смены пароля
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u === '/api/users') return { ok: true, status: 200, json: async () => ({ users: [FIRST_RUN_ADMIN] }) };
  if (u === '/api/auth/change-password' || u.startsWith('/api/users/')) {
    calls.push({ u, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
    const a = nextAnswer || { status: 200, json: { ok: true } };
    nextAnswer = null;
    return { ok: a.status < 400, status: a.status, json: async () => a.json };
  }
  if (u === '/api/db') return { ok: true, status: 200, json: async () => ({ data: [] }) };
  return { ok: true, status: 200, json: async () => ({ data: [] }) };
};

const { openChangeOwnPasswordModal, passwordProblem } = await import('../password-change.js');
const { renderEmployees } = await import('../views/employees.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }
const top = () => document.body.children.filter((c) => c.className === 'modal').at(-1);

function fill(modal, values) {
  const inputs = tags(modal, 'input');
  assert.equal(inputs.length, values.length, 'полей в окне: ' + values.length);
  inputs.forEach((inp, i) => { inp.value = values[i]; });
}

function reset() { document.body.children.length = 0; calls.length = 0; nextAnswer = null; }

test('окно аватара: текущий + новый уходят в /api/auth/change-password, пароль «1» принимается', async () => {
  reset();
  openChangeOwnPasswordModal();
  const modal = top();
  const inputs = tags(modal, 'input');
  assert.equal(inputs.length, 3, 'текущий, новый, повтор');
  assert.ok(inputs.every((i) => i.getAttribute('type') === 'password'));
  fill(modal, ['admin123', '1', '1']);
  buttonWith(modal, 'Сохранить').click();
  await flush();

  assert.deepEqual(calls, [{ u: '/api/auth/change-password', method: 'POST',
    body: { current_password: 'admin123', new_password: '1' } }]);
  assert.ok(modal.removed, 'после успеха окно закрывается');
  // Текст тоста фальшивый DOM не удержит (ui.js toast кладёт таймер в el._t),
  // поэтому проверяется сам тост успеха.
  assert.ok(document.body.children.some((c) => c.attrs.id === 'toast' && c.dataset.kind === 'ok'), 'и говорит об успехе');
});

test('окно аватара: несовпадение и пустой новый — словами, запрос не уходит', async () => {
  reset();
  openChangeOwnPasswordModal();
  const modal = top();
  fill(modal, ['admin123', '1', '2']);
  buttonWith(modal, 'Сохранить').click();
  await flush();
  assert.ok(textOf(modal).includes('Пароль не совпадает.'));

  fill(modal, ['admin123', '', '']);
  buttonWith(modal, 'Сохранить').click();
  await flush();
  assert.ok(textOf(modal).includes('Введите новый пароль.'));
  assert.equal(calls.length, 0, 'ни одного запроса');
  assert.ok(!modal.removed);
});

test('окно аватара: неверный текущий пароль — сказано словами, окно остаётся открытым', async () => {
  reset();
  openChangeOwnPasswordModal();
  const modal = top();
  fill(modal, ['не тот', '1', '1']);
  nextAnswer = { status: 401, json: { error: { code: 'invalid_credentials', message: 'Current password is wrong.' } } };
  buttonWith(modal, 'Сохранить').click();
  await flush();
  assert.equal(calls.length, 1);
  assert.ok(textOf(modal).includes('Текущий пароль неверный.'));
  assert.ok(!textOf(modal).includes('Current password is wrong'), 'английское сообщение сервера человеку не показывается');
  assert.ok(!modal.removed);
});

test('окно аватара: учётная запись главной клиники (409) — объяснено, где менять', async () => {
  reset();
  openChangeOwnPasswordModal();
  const modal = top();
  fill(modal, ['x', '1', '1']);
  nextAnswer = { status: 409, json: { error: { code: 'conflict', message: 'managed' } } };
  buttonWith(modal, 'Сохранить').click();
  await flush();
  assert.ok(textOf(modal).includes('главная клиника'));
});

test('правило длины: достаточно одного символа', () => {
  assert.equal(passwordProblem('1', '1'), null);
  assert.equal(passwordProblem('', ''), 'Введите новый пароль.');
  assert.equal(passwordProblem('1', '1', { askCurrent: true, current: '' }), 'Введите текущий пароль.');
});

test('ни один клиентский файл не меняет пароль через updateUser', () => {
  const offenders = [];
  const walkDir = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== '__tests__') walkDir(p); continue; }
      if (!/\.m?js$/.test(ent.name) || /\.test\.m?js$/.test(ent.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/\.updateUser\s*\(/.test(src)) offenders.push(path.relative(PUBLIC_JS, p));
    }
  };
  walkDir(PUBLIC_JS);
  assert.deepEqual(offenders, [], 'офлайн updateUser отвергается всегда (db-auth.js) — смена пароля через него не работает ни у кого');

  const shell = fs.readFileSync(path.join(PUBLIC_JS, 'admin.js'), 'utf8');
  assert.match(shell, /openChangeOwnPasswordModal/, 'меню аватара открывает общее окно');
  assert.doesNotMatch(shell, /completeFirstLoginReset|showFirstLoginReset/, 'мёртвый облачный сброс удалён');
});

test('карточка сотрудника: «Сменить пароль» шлёт только { password } — даже без ФИО и телефона', async () => {
  reset();
  // Карточку открывает ДРУГОЙ администратор: своя карточка — отдельный случай ниже.
  const me = window.easymed.state.user;
  window.easymed.state.user = { id: 2, role: 'admin', is_admin: true };
  try {
  const container = mk('div');
  await renderEmployees(container);
  await flush();
  const row = tags(container, 'tr').find((r) => textOf(r).includes('@admin'));
  row.dispatchEvent({ type: 'click', currentTarget: null, preventDefault() {}, stopPropagation() {} });
  await flush();
  const card = document.body.children.at(-1);
  const btn = buttonWith(card, 'Сменить пароль');
  assert.ok(btn, 'у существующего сотрудника есть отдельное действие');
  btn.click();
  await flush();

  const modal = top();
  assert.notEqual(modal, card, 'открылось своё окно поверх карточки');
  assert.equal(tags(modal, 'input').length, 2, 'администратор меняет чужой пароль без текущего: новый и повтор');
  fill(modal, ['1', '1']);
  buttonWith(modal, 'Сохранить').click();
  await flush();

  assert.deepEqual(calls, [{ u: '/api/users/1', method: 'PATCH', body: { password: '1' } }]);
  assert.ok(modal.removed);
  assert.ok(!textOf(document.body).includes('Заполните личные данные.'), 'проверка всей карточки здесь не участвует');
  } finally { window.easymed.state.user = me; }
});

// Ревью W1-M1 — своя карточка: пароль меняется ТЕМ ЖЕ окном, что в меню
// аватара, с текущим паролем. PATCH /api/users без текущего пароля — это право
// администратора на ЧУЖУЮ учётную запись; на своей он обходил бы проверку
// «докажи, что это ты» (оставленный без присмотра открытый компьютер).
test('своя карточка: «Сменить пароль» спрашивает текущий и идёт в /api/auth/change-password', async () => {
  reset();
  window.easymed.state.user = { id: 1, role: 'admin', is_admin: true };
  const container = mk('div');
  await renderEmployees(container);
  await flush();
  const row = tags(container, 'tr').find((r) => textOf(r).includes('@admin'));
  row.dispatchEvent({ type: 'click', currentTarget: null, preventDefault() {}, stopPropagation() {} });
  await flush();
  const card = document.body.children.at(-1);
  buttonWith(card, 'Сменить пароль').click();
  await flush();
  const modal = top();
  assert.equal(tags(modal, 'input').length, 3, 'на своей карточке не спросили текущий пароль');
  fill(modal, ['old', '1', '1']);
  buttonWith(modal, 'Сохранить').click();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].u, '/api/auth/change-password');
  assert.ok(!calls.some((c) => c.method === 'PATCH'), 'свой пароль ушёл PATCH-ем без текущего');
});
