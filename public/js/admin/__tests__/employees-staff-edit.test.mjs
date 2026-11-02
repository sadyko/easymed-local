// STAFF_EDIT_V1 (2026-11-02) — КАРТОЧКА СОТРУДНИКА: ЛОГИН, ТОЛЬКО ИЗМЕНЁННОЕ, ПАРОЛЬ.
//
// Спецификация — docs/specs/2026-11-02-3210-batch-design.md, U4. Проверяется:
//   • новые фразы — на трёх языках (uz и en без кириллицы);
//   • у существующего сотрудника уходят только изменённые поля: старое неверное
//     значение (дата «15.01.2020», категория «Высшая», процент 150) не уходит и
//     не держит сохранение; новый сотрудник — вся карточка, как прежде;
//   • логин правит администратор: уходит изменённый (без пробелов, нижним
//     регистром), другой регистр — не смена; отказ сервера — под полем;
//     не-администратору и «от имени сотрудника» поле закрыто;
//   • своя карточка — без поля «Новый пароль»; autocomplete="new-password";
//   • «Врачи» на карточке администратора не снимают роль администратора;
//   • пароль отключённому — предупреждение «включите «Активен»».
//
// Поддельный DOM — тот же, что в employees-card-save.test.mjs; тосты
// перехватываются, как в act-as-employees.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS } from '../i18n-strings.js';

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
 focus(){} blur(){} scrollTo(){} select(){}
 remove(){ this.removed = true; const i = document.body.children.indexOf(this); if (i > -1) document.body.children.splice(i, 1); }
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
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
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
const ADMIN_ME = { id: 2, role: 'admin', is_admin: true };
globalThis.window = {
  location: { hostname: 'localhost', reload() {} }, localStorage, addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: ADMIN_ME } },
  CLINIC: { id: 1 },
  confirm: () => true,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const NEW_STRINGS = [
  'Логин меняет только администратор.',
  'Логин нельзя менять, пока подключены филиалы: филиалы узнают сотрудника по логину.',
  'Пароль изменён, но сотрудник отключён — включите «Активен», иначе он не войдёт.',
  'Новый логин действует со следующего входа; открытые входы сотрудника не закрываются.',
  'Администратор остаётся администратором: «Врачи» добавляет ему приём пациентов, права администратора не снимаются.',
];
const [, BRANCH_MSG, INACTIVE_MSG, LOGIN_HINT, ADMIN_DOCTOR_HINT] = NEW_STRINGS;

const base = { is_active: true, is_local: true, extra_roles: [], middle_name: '', email: '', branch_id: 1,
  service_rates: [], referral_rates: [], inpatient_rates: [], scheduling_mode: 'schedulable' };
// Врач со значениями, записанными до нынешних правил: каждое из них сервер
// отверг бы, если бы карточка прислала его снова.
// Ревью 1 — со ставками: нетронутые списки не уходят (их могли переписать
// окно услуги или «Зарплата врачей», пока карточка была открыта).
const OLD_DOC = { ...base, id: 80, username: 'old.doc', full_name: 'Каримов Анвар', last_name: 'Каримов', first_name: 'Анвар',
  phone: '+998901112233', role: 'doctor', staff_type: 'doctor', is_doctor: true, specialty: 'Терапевт',
  hire_date: '15.01.2020', doctor_category: 'Высшая', employment_type: 'штат', salary_percent: 150,
  service_rates: [{ service_id: 2, pct: 30, branches: [] }], referral_rates: [{ service_id: 2, pct: 5, branches: [] }],
  inpatient_rates: [{ service_id: 2, pct: 10 }] };
const ME = { ...base, id: 2, username: 'boss', full_name: 'Петров Пётр', last_name: 'Петров', first_name: 'Пётр',
  phone: '+998901110000', role: 'admin', staff_type: 'admin_staff', is_doctor: false };
const CHIEF = { ...base, id: 3, username: 'chief', full_name: 'Алиев Бобур', last_name: 'Алиев', first_name: 'Бобур',
  phone: '+998901110001', role: 'admin', staff_type: 'admin_staff', is_doctor: false };
const NURSE = { ...base, id: 4, username: 'nurse.k', full_name: 'Каримова Дилноза', last_name: 'Каримова', first_name: 'Дилноза',
  phone: '+998901110002', role: 'nurse', staff_type: 'mid_low', is_doctor: false };

const writes = [];
let nextAnswer = null;   // { status, json } — ответ на ближайшую запись /api/users
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  if (u === '/api/users' && method === 'GET') return { ok: true, status: 200, json: async () => ({ users: [OLD_DOC, ME, CHIEF, NURSE] }) };
  if (u.startsWith('/api/users')) {
    writes.push({ u, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    const a = nextAnswer || { status: 200, json: { user: {} } };
    nextAnswer = null;
    return { ok: a.status < 400, status: a.status, json: async () => a.json };
  }
  if (u === '/api/db') {
    const desc = opts.body ? JSON.parse(opts.body) : {};
    const rows = desc.table === 'branches' ? [{ id: 1, name: 'Чиланзар' }] : [];
    return { ok: true, status: 200, json: async () => ({ data: rows }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: [] }) };
};

const { renderEmployees } = await import('../views/employees.js');
const { openEmployeePasswordModal } = await import('../password-change.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const byClass = (root, c) => walk(root).filter((n) => String(n.className || '').split(/\s+/).includes(c));
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }
const type = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input' }); };
const pick = (sel, v) => { sel.value = v; sel.dispatchEvent({ type: 'change' }); };
const byPh = (card, ph) => tags(card, 'input').find((i) => i.attrs.placeholder === ph);
const loginInput = (card) => byPh(card, 'login');
const passwordInputs = (card) => tags(card, 'input').filter((i) => i.attrs.type === 'password');
const isDisabled = (el) => el.hasAttribute('disabled') || el.disabled === true;
const categorySelect = (card) => tags(card, 'select').find((s) => s.children.some((o) => o.attrs && o.attrs.value === 'admin_staff'));
const setPhone = (card, v) => {
  const ph = byClass(card, 'ph-wrap')[0];
  ph.input.value = v; ph.input.dispatchEvent({ type: 'input' }); ph.dispatchEvent({ type: 'input' });
};
const textNodes = (el) => walk(el).filter((n) => n.tagName === '#TEXT').map((n) => n._t).join('').trim();
const loginErrorText = (card) => { const a = walk(card).find((n) => n.attrs && 'data-login-error' in n.attrs); return a ? textNodes(a) : null; };
const activeCheckbox = (card) => tags(byClass(card, 'checkbox').find((n) => textOf(n).includes('Активен')), 'input')[0];
const topModal = () => document.body.children.filter((c) => c.className === 'modal').at(-1);

let container;
async function openList() {
  document.body.children.length = 0;
  writes.length = 0;
  toasts.length = 0;
  nextAnswer = null;
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

test('STAFF_EDIT_V1: новые фразы — на трёх языках, в uz и en нет кириллицы', () => {
  for (const key of NEW_STRINGS) {
    const e = STRINGS[key];
    assert.ok(e, 'нет в словаре: ' + key);
    assert.equal(e.ru, key);
    for (const lang of ['uz', 'en']) {
      assert.ok(e[lang] && e[lang] !== key, lang + ' не переведено: ' + key);
      assert.doesNotMatch(e[lang], /[Ѐ-ӿ]/, lang + ' с кириллицей: ' + e[lang]);
    }
  }
});

test('уходят только изменённые поля: старая дата, категория и процент 150 не уходят и не держат сохранение', async () => {
  const card = await openCard('old.doc');
  setPhone(card, '+998 90 111 22 44');
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  const body = writes[0].body;
  assert.equal(writes[0].method, 'PATCH');
  assert.ok(body.phone.replace(/\D/g, '').endsWith('901112244'), body.phone);
  for (const k of ['hire_date', 'doctor_category', 'employment_type', 'salary_percent', 'salary_fixed', 'salary_type', 'staff_type',
    'role', 'custom_role_code', 'is_active', 'extra_roles', 'working_hours', 'branch_id', 'department_id', 'email',
    'scheduling_mode', 'pbx_extension', 'license_number', 'license_expiry_date', 'specialties', 'specialty',
    'inpatient_referral_pct', 'inpatient_referral_fixed',
    // Ревью 1 — списки ставок тоже: нетронутый, но устаревший список вернул бы
    // ставку, которую тем временем поменяли окно услуги или «Зарплата врачей».
    'service_rates', 'referral_rates', 'inpatient_rates']) {
    assert.ok(!(k in body), k + ' ушло, хотя его не трогали: ' + JSON.stringify(body[k]));
  }
  assert.equal(body.assign_extension, true, 'отметка новой карточки — всегда');
  assert.ok(!toasts.some((t) => /неверно|Неизвестн/.test(t)), 'посторонний отказ: ' + toasts.join(' | '));
});

// Ревью 1 — не-администратор с «Сотрудники: Изменение» и «Цены и проценты»
// правил телефон в СВОЕЙ карточке: карточка слала три списка ставок, и сервер
// отказывал всему сохранению «Свою зарплату и ставки меняет администратор.».
test('ревью 1: своя карточка не-администратора с «Цены и проценты» — телефон уходит, ставки и зарплата нет', async () => {
  const P = await import('../permissions.js');
  window.easymed.state.user = { id: 4, role: 'nurse', extra_roles: [] };
  P.setEffectiveFromRole({ name: 'nurse', permissions: { sections: ['settings'], levels: {},
    grants: { settings: 'view', 'settings.employees': 'edit', 'settings.employees.money': 'edit' } } });
  try {
    const card = await openCard('nurse.k');
    setPhone(card, '+998 90 111 00 09');
    await save(card);
    assert.equal(writes.length, 1, 'карточка не ушла на сервер');
    const body = writes[0].body;
    assert.equal(writes[0].u, '/api/users/4');
    assert.ok(body.phone.replace(/\D/g, '').endsWith('901110009'), body.phone);
    for (const k of ['service_rates', 'referral_rates', 'inpatient_rates', 'salary_type', 'salary_fixed', 'salary_percent',
      'inpatient_referral_pct', 'inpatient_referral_fixed']) {
      assert.ok(!(k in body), k + ' ушло — сервер откажет «Свою зарплату и ставки меняет администратор.»');
    }
  } finally {
    P.setFullAccess();
    window.easymed.state.user = ADMIN_ME;
  }
});

// Охрана: роль и своя роль клиники уходят вместе (сервер выводит роль из своей роли).
test('«Врачи» у медсестры: роль «Врач» уходит вместе со своей ролью клиники', async () => {
  const card = await openCard('nurse.k');
  await tab(card, 'Должность');
  pick(categorySelect(card), 'doctor');
  await flush();
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  const body = writes[0].body;
  assert.deepEqual([body.staff_type, body.role, body.custom_role_code], ['doctor', 'doctor', '']);
});

// Охрана: новому сотруднику уходит вся карточка (POST), как прежде.
test('новый сотрудник: уходит вся карточка', async () => {
  const card = await openNew();
  type(byPh(card, 'Каюмов'), 'Каюмов');
  type(byPh(card, 'Араббек'), 'Араббек');
  setPhone(card, '+998 90 961 00 04');
  await tab(card, 'Должность');
  pick(categorySelect(card), 'mid_low');
  await flush();
  await tab(card, 'Вход и доступ');
  type(loginInput(card), 'new.nurse');
  type(passwordInputs(card)[0], '1');
  await save(card);
  assert.equal(writes.length, 1, 'новый сотрудник не ушёл');
  assert.deepEqual([writes[0].u, writes[0].method], ['/api/users', 'POST']);
  const body = writes[0].body;
  assert.equal(body.username, 'new.nurse');
  for (const k of ['staff_type', 'role', 'is_active', 'extra_roles', 'hire_date', 'doctor_category', 'working_hours', 'service_rates']) {
    assert.ok(k in body, k + ' не ушло у нового сотрудника');
  }
});

test('логин: администратор правит — уходит изменённый, без пробелов и нижним регистром; другой регистр — не смена', async () => {
  let card = await openCard('nurse.k');
  await tab(card, 'Вход и доступ');
  const inp = loginInput(card);
  assert.ok(inp, 'нет поля «Логин»');
  assert.ok(!isDisabled(inp), 'администратору поле «Логин» закрыто');
  assert.equal(inp.getAttribute('autocomplete'), 'off');
  assert.ok(textOf(card).includes(LOGIN_HINT), 'не сказано, что будет с открытыми входами');
  type(inp, '  Nurse.Karimova ');
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  assert.equal(writes[0].method, 'PATCH');
  assert.equal(writes[0].body.username, 'nurse.karimova');

  card = await openCard('nurse.k');
  await tab(card, 'Вход и доступ');
  type(loginInput(card), 'NURSE.K');
  await save(card);
  assert.equal(writes.length, 1);
  assert.ok(!('username' in writes[0].body), 'тот же логин в другом регистре ушёл сменой');
});

test('логин: отказ сервера — под полем, карточка открыта, тоста нет; правка логина снимает отказ', async () => {
  const card = await openCard('nurse.k');
  await tab(card, 'Вход и доступ');
  type(loginInput(card), 'nurse2');
  nextAnswer = { status: 409, json: { error: { code: 'conflict', message: BRANCH_MSG, field: 'username' } } };
  await save(card);
  assert.equal(writes.length, 1);
  assert.ok(!card.removed, 'карточка закрылась после отказа');
  assert.equal(loginErrorText(card), BRANCH_MSG, 'отказ не под полем «Логин»');
  assert.ok(!toasts.includes(BRANCH_MSG), 'отказ показан тостом, а не под полем');
  type(loginInput(card), 'nurse3');
  assert.equal(loginErrorText(card), null, 'отказ остался после правки логина');
});

// Охрана: поле не открывается шире, чем решено.
test('логин: не-администратору с «Сотрудники: Изменение» и «от имени сотрудника» поле закрыто', async () => {
  const P = await import('../permissions.js');
  window.easymed.state.user = { id: 5, role: 'nurse', extra_roles: [] };
  P.setEffectiveFromRole({ name: 'nurse', permissions: { sections: ['settings'], levels: {}, grants: { settings: 'view', 'settings.employees': 'edit' } } });
  try {
    const card = await openCard('nurse.k');
    await tab(card, 'Вход и доступ');
    assert.ok(isDisabled(loginInput(card)), 'не-администратору логин открыт');
  } finally {
    P.setFullAccess();
    window.easymed.state.user = ADMIN_ME;
  }
  window.easymed.state.user = { ...ADMIN_ME, acting_admin: { id: 9, full_name: 'Петров П.' } };
  try {
    const card = await openCard('nurse.k');
    await tab(card, 'Вход и доступ');
    assert.ok(isDisabled(loginInput(card)), 'от имени сотрудника логин правится');
  } finally { window.easymed.state.user = ADMIN_ME; }
});

test('своя карточка: поля «Новый пароль» нет, «Сменить пароль» — есть; у чужой и у нового — autocomplete="new-password"', async () => {
  let card = await openCard('boss');
  await tab(card, 'Вход и доступ');
  assert.equal(passwordInputs(card).length, 0, 'своя карточка меняет пароль без текущего');
  assert.ok(buttonWith(card, 'Сменить пароль'), 'кнопка смены своего пароля пропала');
  card = await openCard('nurse.k');
  await tab(card, 'Вход и доступ');
  const [pw] = passwordInputs(card);
  assert.ok(pw, 'у чужой карточки поле пароля пропало');
  assert.equal(pw.getAttribute('autocomplete'), 'new-password', 'браузер подставит сюда сохранённый пароль');
  card = await openNew();
  await tab(card, 'Вход и доступ');
  assert.equal(passwordInputs(card)[0].getAttribute('autocomplete'), 'new-password');
});

test('«Врачи» на карточке администратора: роль остаётся «Администратор», уходит категория врача', async () => {
  const card = await openCard('chief');
  await tab(card, 'Должность');
  assert.ok(textOf(card).includes(ADMIN_DOCTOR_HINT), 'администратору не сказано, что роль останется');
  pick(categorySelect(card), 'doctor');
  await flush();
  await save(card);
  assert.equal(writes.length, 1, 'карточка не ушла на сервер');
  const body = writes[0].body;
  assert.equal(body.staff_type, 'doctor');
  assert.ok(!('role' in body), 'роль ушла — администратор перестал бы быть администратором: ' + body.role);
});

// Ревью 7 — над подсказкой администратору стояла общая «Врачи получают роль
// доступа «Врач»…» — две подсказки спорили: роль сменится или нет.
test('ревью 7: «Должность» администратора — без подсказки «Врачи получают роль доступа «Врач»», у медсестры она есть', async () => {
  const DOCTOR_ROLE_HINT = 'Врачи получают роль доступа «Врач»';
  let card = await openCard('chief');
  await tab(card, 'Должность');
  assert.ok(textOf(card).includes(ADMIN_DOCTOR_HINT), 'администратору не сказано, что роль останется');
  assert.ok(!textOf(card).includes(DOCTOR_ROLE_HINT), 'администратору обещана смена роли на «Врач»');
  card = await openCard('nurse.k');
  await tab(card, 'Должность');
  assert.ok(textOf(card).includes(DOCTOR_ROLE_HINT), 'у медсестры пропала подсказка про роль «Врач»');
  assert.ok(!textOf(card).includes(ADMIN_DOCTOR_HINT));
});

test('окно «Сменить пароль»: отключённому — предупреждение «включите «Активен»», включённому — как прежде', async () => {
  document.body.children.length = 0;
  writes.length = 0;
  toasts.length = 0;
  nextAnswer = { status: 200, json: { user: {}, password_inactive: true } };
  openEmployeePasswordModal({ id: 4 });
  let modal = topModal();
  for (const inp of tags(modal, 'input')) inp.value = '1';
  buttonWith(modal, 'Сохранить').click();
  await flush();
  assert.equal(writes.at(-1).u, '/api/users/4');
  assert.ok(toasts.includes(INACTIVE_MSG), 'нет предупреждения: ' + toasts.join(' | '));
  assert.equal(toastEl.dataset.kind, 'warn');

  openEmployeePasswordModal({ id: 4 });
  modal = topModal();
  for (const inp of tags(modal, 'input')) inp.value = '2';
  buttonWith(modal, 'Сохранить').click();
  await flush();
  assert.equal(toasts.at(-1), 'Пароль сотрудника изменён.');
  assert.equal(toastEl.dataset.kind, 'ok');
});

test('карточка: пароль и снятый «Активен» в одном сохранении — предупреждение вместо «сохранён»', async () => {
  const card = await openCard('nurse.k');
  await tab(card, 'Вход и доступ');
  type(passwordInputs(card)[0], '1');
  const active = activeCheckbox(card);
  active.checked = false;
  active.dispatchEvent({ type: 'change' });
  nextAnswer = { status: 200, json: { user: {}, password_inactive: true } };
  await save(card);
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].body.password, writes[0].body.is_active], ['1', false]);
  assert.ok(toasts.includes(INACTIVE_MSG), 'нет предупреждения: ' + toasts.join(' | '));
  assert.ok(!toasts.includes('Сотрудник сохранён'), 'сказали «сохранён» вместо предупреждения');
});
