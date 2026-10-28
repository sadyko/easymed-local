// ADMIN_ACT_AS_V1 (2026-10-28) — «СОТРУДНИКИ»: ВОЙТИ КАК СОТРУДНИК И «ВХОДЫ ОТ ИМЕНИ».
//
// Спецификация — docs/specs/2026-10-28-admin-act-as-design.md, «Интерфейс»:
//   • в строке и в карточке сотрудника — «Войти как сотрудник», только
//     администратору из своей учётной записи и только для сотрудников,
//     разрешённых R2 (активный, уже входивший, не сам и не администратор —
//     основной, дополнительной или своей ролью на основе администратора);
//   • подтверждение словами спецификации, затем вход и перезагрузка;
//   • карточка сотрудника (для администратора) — «Входы от имени»: список
//     сеансов и, по нажатию, действия словами;
//   • работая от имени, «Сменить пароль» своей (то есть сотрудника) карточки
//     не показывается (R6).
//
// Поддельный DOM — тот же, что в __tests__/employees-managed.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.children.push(c);}
 insertBefore(c){this.children.unshift(c);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){ const p = document.body; const i = p.children.indexOf(this); if (i > -1) p.children.splice(i, 1); } select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s.attrs.html = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const toasts = [];
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return ''; }, set(v) { toasts.push(String(v)); } });
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
let RELOADS = 0;
const CONFIRMS = [];
let confirmAnswer = () => true;
const ADMIN = { id: 1, full_name: 'Петров П.', role: 'admin', is_admin: true, extra_roles: [], acting_admin: null };
globalThis.window = {
  location: { hostname: 'localhost', reload: () => { RELOADS += 1; } },
  localStorage, addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: ADMIN } },
  CLINIC: { id: 1 },
  confirm: (m) => { CONFIRMS.push(String(m)); return confirmAnswer(String(m)); },
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };

const U =(id, username, full_name, role, extra = {}) => ({
  id, username, full_name, role, is_active: true, must_change_password: false, is_local: true, extra_roles: [],
  phone: '+99890111' + String(id).padStart(4, '0'), staff_type: role === 'doctor' ? 'doctor' : 'admin_staff',
  is_doctor: role === 'doctor', service_rates: [], referral_rates: [], ...extra,
});
const USERS = [
  U(1, 'boss', 'Петров П.', 'admin'),
  U(3, 'doc', 'Иванова А.', 'doctor'),
  U(4, 'nurse', 'Медсестра Н.', 'registrar', { custom_role_code: 'senior_reg' }),
  U(6, 'fresh', 'Новичок Н.', 'registrar', { must_change_password: true }),
  U(7, 'gone', 'Уволенный У.', 'registrar', { is_active: false }),
  U(8, 'admx', 'Админ-врач А.', 'doctor', { extra_roles: ['admin'] }),
  U(9, 'regadm', 'Старший рег. С.', 'registrar', { custom_role_code: 'reg_to_admin' }),
];
const SESSIONS = [
  { id: 12, admin_id: 1, admin_name: 'Петров П.', target_id: 3, target_name: 'Иванова А.', started_at: '2026-10-28T09:00:00Z', ended_at: '2026-10-28T10:35:00Z', end_reason: 'Вернулся', action_count: 5, write_count: 4 },
  { id: 11, admin_id: 2, admin_name: 'Сидоров С.', target_id: 3, target_name: 'Иванова А.', started_at: '2026-10-27T08:00:00Z', ended_at: '2026-10-27T10:00:00Z', end_reason: 'Истекло', action_count: 0, write_count: 0 },
];
const ACTIONS = [
  { at: '2026-10-28T09:01:00Z', kind: 'db', name: 'visit_services.update', status: 200, read_only: false },
  { at: '2026-10-28T09:02:00Z', kind: 'rpc', name: 'procedure_complete', status: 403, read_only: false },
  { at: '2026-10-28T09:03:00Z', kind: 'rpc', name: 'procedures_list', status: 200, read_only: true },
  { at: '2026-10-28T09:04:00Z', kind: 'storage', name: 'POST /storage/clinic-docs', status: 200, read_only: false },
  { at: '2026-10-28T09:05:00Z', kind: 'users', name: 'PATCH /users/3', status: 200, read_only: false },
];

const CALLS = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  CALLS.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  const ok = (payload) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) });
  if (u === '/api/users') return ok({ users: USERS });
  if (u === '/api/auth/act-as') return ok({ ok: true });
  if (u.startsWith('/api/auth/act-as/log')) {
    const q = new URLSearchParams(u.split('?')[1]);
    if (q.get('act_as_id')) return ok({ session: SESSIONS[0], actions: ACTIONS, truncated: false });
    return ok({ sessions: q.get('user_id') === '3' ? SESSIONS : [] });
  }
  if (u === '/api/db') {
    const desc = opts && opts.body ? JSON.parse(opts.body) : {};
    const rows = desc.table === 'custom_roles'
      ? [{ code: 'reg_to_admin', name: 'Старший регистратор', base_role: 'admin', active: 1 }, { code: 'senior_reg', name: 'Регистратор+', base_role: 'registrar', active: 1 }]
      : desc.table === 'departments' ? [{ id: 1, name: 'Терапия' }]
      : desc.table === 'branches' ? [{ id: 1, name: 'Чиланзар' }] : [];
    return ok({ data: rows });
  }
  return ok({ data: [] });
};

const { renderEmployees } = await import('../views/employees.js');
const { setLang } = await import('../i18n.js');
const { STRINGS } = await import('../i18n-strings.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }
const ACT = 'Войти как сотрудник';

async function paintList(user = ADMIN) {
  window.easymed.state.user = user;
  document.body.children.length = 0;
  CALLS.length = 0; CONFIRMS.length = 0; toasts.length = 0; RELOADS = 0;
  confirmAnswer = () => true;
  const container = mk('div');
  await renderEmployees(container);
  await flush();
  return container;
}
const rowFor = (container, username) => tags(container, 'tr').find((r) => textOf(r).includes('@' + username));
async function openCard(container, username) {
  rowFor(container, username).dispatchEvent({ type: 'click', currentTarget: null, preventDefault() {}, stopPropagation() {} });
  await flush();
  return document.body.children[document.body.children.length - 1];
}
const railItem = (card, label) => walk(card).find((n) => n.tagName === 'DIV' && (n._l.click || []).length && textOf(n).includes(label) && n.children.length <= 3);

test('строка: «Войти как сотрудник» — только у тех, от чьего имени можно войти (R2)', async () => {
  const c = await paintList();
  for (const u of ['doc', 'nurse']) assert.ok(buttonWith(rowFor(c, u), ACT), u + ': кнопка обязана быть');
  for (const u of ['boss', 'fresh', 'admx', 'regadm']) assert.equal(buttonWith(rowFor(c, u), ACT), undefined, u + ': кнопки быть не должно');
  assert.equal(rowFor(c, 'gone'), undefined, 'отключённый — в архиве, не в списке');
});

test('строка: кнопки нет, если смотрит не администратор или администратор уже работает от имени', async () => {
  let c = await paintList({ id: 4, full_name: 'Медсестра Н.', role: 'registrar', extra_roles: [], acting_admin: null });
  assert.equal(buttonWith(c, ACT), undefined, 'не администратор');
  c = await paintList({ id: 3, full_name: 'Иванова А.', role: 'doctor', extra_roles: [], acting_admin: { id: 1, full_name: 'Петров П.' } });
  assert.equal(buttonWith(c, ACT), undefined, 'уже от имени — сначала вернуться');
  c = await paintList({ id: 8, full_name: 'Админ-врач А.', role: 'doctor', extra_roles: ['admin'], acting_admin: null });
  assert.ok(buttonWith(rowFor(c, 'doc'), ACT), 'администратор дополнительной ролью — может');
});

test('строка: нажатие — подтверждение словами спецификации → POST {user_id} → перезагрузка; «Отмена» — ничего', async () => {
  const c = await paintList();
  confirmAnswer = () => false;
  buttonWith(rowFor(c, 'doc'), ACT).click();
  await flush();
  assert.equal(CONFIRMS.length, 1);
  assert.equal(CONFIRMS[0], 'Вы будете работать от имени Иванова А. Каждое действие запишется как «Администратор Петров П. от имени Иванова А.». Подписывать документы врача от его имени нельзя. Вернуться — кнопкой вверху экрана.');
  assert.ok(!CALLS.some((x) => x.url === '/api/auth/act-as'), '«Отмена» — запроса нет');
  assert.equal(RELOADS, 0);

  confirmAnswer = () => true;
  buttonWith(rowFor(c, 'doc'), ACT).click();
  await flush();
  assert.deepEqual(CALLS.filter((x) => x.url === '/api/auth/act-as').map((x) => [x.method, x.body]), [['POST', { user_id: 3 }]]);
  assert.equal(RELOADS, 1, 'после входа — перезагрузка под сотрудником');
});

test('карточка: «Войти как сотрудник» у разрешённого; с несохранённой правкой — сначала вопрос', async () => {
  const c = await paintList();
  let card = await openCard(c, 'fresh');
  assert.equal(buttonWith(card, ACT), undefined, 'не входивший — кнопки нет');
  document.body.children.length = 0;

  card = await openCard(c, 'doc');
  const btn = buttonWith(card, ACT);
  assert.ok(btn, 'в карточке кнопка есть');
  // Правка карточки, не сохранённая, — и «Отмена» на вопросе о ней.
  const input = tags(card, 'input').find((i) => i.attrs.type === 'text');
  input.value = 'Иванова-Петрова';
  input.dispatchEvent({ type: 'input', currentTarget: input, target: input });
  confirmAnswer = (m) => !/Несохранённые изменения/.test(m);
  btn.click();
  await flush();
  assert.match(CONFIRMS[0], /Несохранённые изменения карточки пропадут/);
  assert.ok(!CALLS.some((x) => x.url === '/api/auth/act-as'));
  // Согласие — вход.
  CONFIRMS.length = 0;
  confirmAnswer = () => true;
  btn.click();
  await flush();
  assert.equal(CONFIRMS.length, 2, 'вопрос о правке и подтверждение входа');
  assert.match(CONFIRMS[1], /Вы будете работать от имени Иванова А\./);
  assert.deepEqual(CALLS.filter((x) => x.url === '/api/auth/act-as').map((x) => x.body), [{ user_id: 3 }]);
  assert.equal(RELOADS, 1);
});

test('карточка: «Входы от имени» — сеансы (кто, когда, сколько, чем кончилось) и действия словами', async () => {
  const c = await paintList();
  const card = await openCard(c, 'doc');
  const item = railItem(card, 'Входы от имени');
  assert.ok(item, 'раздел в рейке карточки');
  item.dispatchEvent({ type: 'click', currentTarget: item, preventDefault() {}, stopPropagation() {} });
  await flush();
  assert.ok(CALLS.some((x) => x.url === '/api/auth/act-as/log?user_id=3'), 'журнал запрошен по номеру сотрудника');
  const text = textOf(card);
  assert.match(text, /Петров П\. от имени Иванова А\./);
  assert.match(text, /Сидоров С\. от имени Иванова А\./);
  assert.match(text, /1 ч 35 мин/);
  assert.match(text, /Вернулся/);
  assert.match(text, /Истекло/);
  assert.match(text, /Действий: 5 · записей: 4/);

  const toggles = walk(card).filter((n) => n.tagName === 'BUTTON' && 'data-act-as-toggle' in n.attrs);
  assert.equal(toggles.length, 2);
  toggles[0].click();
  await flush();
  assert.ok(CALLS.some((x) => x.url === '/api/auth/act-as/log?user_id=3&act_as_id=12'));
  const rows = walk(card).filter((n) => n.tagName === 'TR' && 'data-act-as-action' in n.attrs).map(textOf);
  assert.equal(rows.length, 5);
  assert.match(rows[0], /Услуги визита: изменение/);
  assert.match(rows[0], /Выполнено/);
  assert.match(rows[1], /Процедура выполнена/);
  assert.match(rows[1], /Отказ · 403/);
  assert.match(rows[2], /procedures_list/, 'незнакомое — именем как есть');
  assert.match(rows[2], /только чтение/);
  assert.match(rows[3], /Документы клиники: загрузка файла/);
  assert.match(rows[4], /Сотрудники: изменение/);
  assert.ok(toggles.every((t) => t.dataset.viewOk === '1'), 'раскрытие — не правка: рамка «только просмотр» его не запирает');
});

test('карточка: без сеансов — «Входов от имени не было.»; работая от имени — раздела нет', async () => {
  let c = await paintList();
  let card = await openCard(c, 'nurse');
  const item = railItem(card, 'Входы от имени');
  item.dispatchEvent({ type: 'click', currentTarget: item, preventDefault() {}, stopPropagation() {} });
  await flush();
  assert.match(textOf(card), /Входов от имени не было\./);

  c = await paintList({ id: 3, full_name: 'Иванова А.', role: 'doctor', extra_roles: [], acting_admin: { id: 1, full_name: 'Петров П.' } });
  card = await openCard(c, 'nurse');
  assert.equal(railItem(card, 'Входы от имени'), undefined, 'журнал открывает только администратор из своей учётной записи');
});

test('ревью MEDIUM 4: своя роль администратора с «Сотрудники: Просмотр» — ни кнопки в строке и карточке, ни «Входов от имени»', async () => {
  const P = await import('../permissions.js');
  P.setOwnCustomGrants({ 'settings.employees': 'view' });
  try {
    const c = await paintList();
    assert.equal(buttonWith(c, ACT), undefined, 'в строках кнопки нет');
    const card = await openCard(c, 'nurse');
    assert.equal(buttonWith(card, ACT), undefined, 'в карточке кнопки нет');
    assert.equal(railItem(card, 'Входы от имени'), undefined, 'журнала входов нет');
  } finally { P.setOwnCustomGrants(null); }
});

test('R6: работая от имени, своя карточка (сотрудника) не предлагает «Сменить пароль»; без входа от имени — предлагает', async () => {
  let c = await paintList({ id: 3, full_name: 'Иванова А.', role: 'doctor', extra_roles: [], acting_admin: { id: 1, full_name: 'Петров П.' } });
  let card = await openCard(c, 'doc');
  assert.equal(buttonWith(card, 'Сменить пароль'), undefined);
  c = await paintList({ id: 3, full_name: 'Иванова А.', role: 'doctor', extra_roles: [], acting_admin: null });
  card = await openCard(c, 'doc');
  assert.ok(buttonWith(card, 'Сменить пароль'));
});

test('uz/en: кнопка, раздел и подписи действий — без кириллицы', async () => {
  for (const lang of ['uz', 'en']) {
    setLang(lang);
    const c = await paintList();
    const btn = tags(rowFor(c, 'doc'), 'button').find((b) => 'data-act-as-start' in b.attrs);
    assert.ok(btn, lang);
    assert.doesNotMatch(textOf(btn), /[Ѐ-ӿ]/, lang + ': ' + textOf(btn));
  }
  setLang('ru');
  const { actAsActionLabel, actAsDuration, actAsStatusLabel } = await import('../views/act-as-history.js');
  for (const lang of ['uz', 'en']) {
    setLang(lang);
    for (const a of ACTIONS) assert.doesNotMatch(actAsActionLabel(a), /[Ѐ-ӿ]/, lang + ': ' + actAsActionLabel(a));
    assert.doesNotMatch(actAsDuration('2026-10-28T09:00:00Z', '2026-10-28T10:35:00Z'), /[Ѐ-ӿ]/);
    assert.doesNotMatch(actAsDuration('2026-10-28T09:00:00Z', '2026-10-28T09:00:20Z'), /[Ѐ-ӿ]/);
    assert.doesNotMatch(actAsStatusLabel(403), /[Ѐ-ӿ]/);
  }
  setLang('ru');
});

const HISTORY_STRINGS = [
  'Входы от имени',
  'Когда администратор работал от имени этого сотрудника и что делал. У администратора — и его входы от имени других.',
  'Несохранённые изменения карточки пропадут. Войти от имени сотрудника?',
  'Входов от имени не было.', '{admin} от имени {target}', 'Идёт сейчас', 'Действий: {n} · записей: {w}',
  'Показать действия', 'Скрыть действия', 'Действий не было.', 'Показаны первые {n} действий.', 'только чтение',
  'Отказ · {code}', 'Не удалось загрузить журнал: {msg}', 'меньше минуты', '{n} мин', '{h} ч {m} мин',
  'Время', 'Действие', 'Результат', 'Выполнено',
  '{what}: добавление', '{what}: изменение', '{what}: запись', '{what}: удаление', '{what}: загрузка файла', '{what}: удаление файла',
];

test('словарь: строки «Входов от имени» — ru/uz/en, uz/en без кириллицы', () => {
  const bad = [];
  for (const k of HISTORY_STRINGS) {
    const e = STRINGS[k];
    if (!e) { bad.push('нет: ' + k); continue; }
    for (const l of ['uz', 'en']) if (!e[l] || /[Ѐ-ӿ]/.test(e[l])) bad.push(l + ': ' + k + ' => ' + e[l]);
  }
  assert.deepEqual(bad, []);
});
