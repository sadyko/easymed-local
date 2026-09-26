// ADMIN_ROWS_GRANTABLE_V1 (2026-09-26) — бывшие строки «Только администратор»
// глазами оболочки: ненастроенная роль видит ровно то же, что вчера; выданный
// уровень открывает плитку, экран и его режим (просмотр / правка / удаление);
// «Цены и проценты» открывают деньги плитки; ключ API не создаётся не
// администратором; экран на «Просмотре» ничего не меняет.
//
// Сервер отвечает второй раз тем же ключом — server/services/admin-rows-grantable.test.js.
//
// Fake-DOM harness — из __tests__/role-reports-settings.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.hidden=false;this.disabled=false;}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(c){if(!this.contains(c))s.className=(s.className+' '+c).trim();},remove(c){s.className=String(s.className).split(/\s+/).filter(x=>x!==c).join(' ');},toggle(c,on){const has=this.contains(c);const want=on===undefined?!has:!!on;if(want&&!has)this.add(c);if(!want&&has)this.remove(c);}};}
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
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
localStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта видов
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener(){}, dispatchEvent() { return true; },
  easymed: { state: { user: { id: 7, full_name: 'Регистратор', role: 'registrar' } } },
  CLINIC: { id: 1 }, confirm: () => true,
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };
const toastEl = mk('div');
document.getElementById = (id) => (id === 'toast' ? toastEl : null);
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    const rows = { patient_categories: [{ id: 1, name: 'VIP', tier: '', discount_percent: 5, active: 1 }] }[body && body.table] || [];
    return { ok: true, json: async () => ({ data: rows }) };
  }
  return { ok: true, json: async () => ({ data: {} }) };
};

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byClass = (root, cls) => walk(root).filter((n) => String(n.className).split(/\s+/).includes(cls));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const { h } = await import('../ui.js');

// Свой фейковый сервер поверх общего: список сотрудников и ключи API.
const USERS = [
  { id: 1, username: 'boss', full_name: 'Boss', role: 'admin', is_active: true, extra_roles: [], is_local: true },
  { id: 61, username: 'plain', full_name: 'Plain Nurse', role: 'nurse', is_active: true, extra_roles: [], is_local: true },
];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/users')) return { ok: true, json: async () => ({ users: USERS }) };
  if (u.startsWith('/api/db')) {
    const rows = {
      api_tokens: [{ id: 1, name: 'Symptex', token: '••••••••', active: 1 }],
      patient_categories: [{ id: 1, name: 'VIP', tier: '', discount_percent: 5, active: 1 }],
    }[body && body.table] || [];
    return { ok: true, json: async () => ({ data: rows }) };
  }
  return { ok: true, json: async () => ({ data: {} }) };
};

const perms = await import('../permissions.js');
const { GROUPS, tileVisible, sectionLevel, renderSettingsHub } = await import('../views/settings-hub.js');
const { REPORT_DEFS, reportVisible } = await import('../views/reports-hub.js');
const { grantsFromLegacy, legacyFromGrants } = await import('../roles-matrix.js');
const { renderWithViewOnly } = await import('../view-only.js');
const { renderEmployees } = await import('../views/employees.js');

function savedRole(name, legacyPerms, overrides) {
  const grants = { ...grantsFromLegacy(legacyPerms), ...overrides };
  const legacy = legacyFromGrants(grants, legacyPerms);
  return { name, permissions: { ...legacy, grants } };
}
const REGISTRAR = { sections: ['patients', 'dashboard', 'patient-documents', 'registration', 'crm', 'queue', 'beds'],
  levels: { patients: 'editor', dashboard: 'viewer', 'patient-documents': 'editor', registration: 'editor', crm: 'editor', queue: 'viewer', beds: 'editor' } };
const CASHIER = { sections: ['cashier', 'patients', 'dashboard', 'reports-hub', 'queue'],
  levels: { cashier: 'admin', patients: 'editor', dashboard: 'viewer', 'reports-hub': 'viewer', queue: 'viewer' } };
const visibleTiles = () => GROUPS.flatMap((g) => g.items).filter(tileVisible).map((i) => i.label);
const visibleReports = () => REPORT_DEFS.filter(reportVisible).map((r) => r.kind);
const ADMIN_ONLY_TILES = ['Сотрудники', 'Роли', 'CRM-канбан', 'Телефония', 'Telegram-бот', 'API', 'Скидки пациентов', 'Страховые полисы', 'Провайдеры онлайн-платежей', 'Кэшбэк', 'Ставки врачей'];
const ADMIN_ONLY_ROUTES = ['employees', 'crm-settings', 'telephony-settings', 'telegram-settings', 'api-settings'];

// --- Ненастроенные роли: ровно как вчера -----------------------------------------

test('ненастроенная роль — всё, что было «только администратор», по-прежнему закрыто', () => {
  // Старая роль с голыми «Настройки», с прежним ключом «employees» и с «Отчётами».
  perms.setEffectiveFromRole({ name: 'Старая роль', permissions: { sections: ['settings', 'employees', 'reports-hub'], levels: { settings: 'admin', 'reports-hub': 'viewer' } } });
  try {
    const tiles = visibleTiles();
    for (const l of ADMIN_ONLY_TILES) assert.ok(!tiles.includes(l), l + ' открылась ненастроенной роли');
    for (const r of ADMIN_ONLY_ROUTES) assert.equal(perms.isRouteAllowed(r), false, r + ' открылся ненастроенной роли');
    assert.ok(!visibleReports().includes('telegram'), 'Telegram-отчёт открылся всем, кому выданы «Отчёты»');
    assert.ok(visibleReports().includes('cashier'), 'стенд не тот: «Отчёты» не выданы');
    for (const k of ['roles', 'api_tokens', 'doctor_rates', 'patient_discounts']) assert.equal(sectionLevel(k), 'none', k);
    assert.equal(perms.settingsMoneyAllowed('settings.patient_categories'), false);
  } finally { perms.setFullAccess('Admin'); }
  // Администратор — всё, как и было.
  const all = visibleTiles();
  for (const l of ADMIN_ONLY_TILES) assert.ok(all.includes(l), l + ' пропала у администратора');
});

// --- Настроенные уровни ------------------------------------------------------------

test('выданные уровни открывают плитки и экраны: «Просмотр» — только чтение, «Изменение» — правка, «Удаление» — удаление', () => {
  const role = savedRole('Регистратор', REGISTRAR, {
    settings: 'view', 'settings.employees': 'view', 'settings.roles': 'edit', 'settings.api': 'view',
    'settings.telephony': 'view', 'settings.telegram': 'edit', 'settings.crm': 'delete', 'settings.doctor_rates': 'edit',
  });
  perms.setEffectiveFromRole(role);
  try {
    for (const r of ['employees', 'telephony-settings', 'telegram-settings', 'crm-settings']) assert.equal(perms.isRouteAllowed(r), true, r);
    assert.equal(perms.settingsTileLevel('settings.employees'), 'view');
    assert.equal(sectionLevel('roles'), 'edit');
    assert.equal(sectionLevel('api_tokens'), 'view');
    assert.equal(sectionLevel('doctor_rates'), 'edit');
    assert.equal(perms.settingsTileAllows('settings.crm', 'delete'), true);
    assert.equal(perms.settingsTileAllows('settings.telephony', 'edit'), false);
    for (const l of ['Сотрудники', 'Роли', 'API', 'Телефония', 'Telegram-бот', 'CRM-канбан', 'Ставки врачей']) assert.ok(visibleTiles().includes(l), l);
    assert.ok(!visibleTiles().includes('Кэшбэк'), 'невыданная плитка-деньги видна');
    // Отчёт Telegram — своя группа.
  } finally { perms.setFullAccess('Admin'); }
  perms.setEffectiveFromRole(savedRole('Кассир', CASHIER, { 'reports.telegram': 'view' }));
  try { assert.ok(visibleReports().includes('telegram'), 'выданный Telegram-отчёт не виден'); }
  finally { perms.setFullAccess('Admin'); }
});

test('«Цены и проценты»: форма показывает деньги плитки, только если они выданы вместе с «Изменением»', () => {
  perms.setEffectiveFromRole(savedRole('Регистратор', REGISTRAR, { settings: 'view', 'settings.patient_categories': 'edit', 'settings.rooms': 'edit' }));
  try {
    assert.deepStrictEqual(perms.settingsGrantColumns('patient_categories'), ['name', 'tier', 'active']);
  } finally { perms.setFullAccess('Admin'); }
  perms.setEffectiveFromRole(savedRole('Регистратор', REGISTRAR, { settings: 'view', 'settings.patient_categories': 'edit', 'settings.patient_categories.money': 'edit', 'settings.rooms': 'edit', 'settings.rooms.money': 'edit' }));
  try {
    assert.ok(perms.settingsGrantColumns('patient_categories').includes('discount_percent'));
    assert.deepStrictEqual(perms.stripToGrant('wards', { name: 'П1', price_per_day: 5, department_id: 1 }), { name: 'П1', price_per_day: 5 }, 'отдел помещения — не деньги');
  } finally { perms.setFullAccess('Admin'); }
  perms.setEffectiveFromRole(savedRole('Регистратор', REGISTRAR, { settings: 'view', 'settings.patient_categories': 'view', 'settings.patient_categories.money': 'edit' }));
  try { assert.equal(perms.settingsMoneyAllowed('settings.patient_categories'), false, 'деньги без «Изменения» плитки'); }
  finally { perms.setFullAccess('Admin'); }
});

test('администратор-врач: «Удаление» у строк, где оно есть, и деньги везде', () => {
  perms.setEffectiveFromRoles([{ name: 'doctor', permissions: { sections: ['patients'], levels: {} } }, { name: 'admin', permissions: { sections: ['settings'], levels: { settings: 'admin' } } }]);
  try {
    assert.equal(perms.actorIsAdmin(), true);
    for (const k of ['settings.employees', 'settings.crm', 'settings.telephony', 'settings.rooms']) assert.equal(perms.settingsTileLevel(k), 'delete', k);
    assert.equal(perms.settingsTileLevel('settings.roles'), 'edit');
    assert.equal(perms.settingsMoneyAllowed('settings.employees'), true);
    assert.equal(perms.settingsGrantColumns('patient_categories'), null);
  } finally { perms.setFullAccess('Admin'); }
});

// --- Экраны -----------------------------------------------------------------------

test('ключи API на «Изменении» у не-администратора: списка можно касаться, а «Добавить» нет — ключ создаёт администратор', async () => {
  const root = mk('div');
  perms.setEffectiveFromRole(savedRole('Регистратор', REGISTRAR, { settings: 'view', 'settings.api': 'edit' }));
  try {
    await renderSettingsHub(root, {});
    byClass(root, 'set-row-link').find((n) => textOf(n).includes('API')).click();
    await tick();
    const t = textOf(root);
    assert.ok(t.includes('Новый ключ создаёт администратор'), 'не сказано, кто создаёт ключ');
    assert.ok(!walk(root).some((n) => n.tagName === 'BUTTON' && String(n.className).includes('btn-primary')), 'кнопка «Добавить» ключ у не-администратора');
    assert.ok(t.includes('Symptex'));
  } finally { perms.setFullAccess('Admin'); }
});

test('экран настроек на «Просмотре» — в рамке «только просмотр», кнопки-действия не срабатывают', async () => {
  perms.setEffectiveFromRole(savedRole('Регистратор', REGISTRAR, { settings: 'view', 'settings.telephony': 'view' }));
  try {
    const root = mk('div');
    let clicked = 0;
    let inner = null;
    await renderWithViewOnly(root, 'settings.telephony', (r) => {
      inner = r;
      const btn = h('button', { class: 'btn btn-primary', onclick: () => { clicked++; } }, 'Сохранить');
      r.appendChild(btn);
    });
    const host = root.children[0];
    assert.ok(String(host.className).includes('is-view-only'), 'нет рамки');
    assert.ok(textOf(host).includes('Только просмотр'), 'нет строки «только просмотр»');
    const btn = inner.children[0];
    let stopped = false;
    const ev = { type: 'click', target: btn, currentTarget: host, preventDefault() {}, stopPropagation() { stopped = true; } };
    for (const fn of host._l.click || []) fn(ev);
    assert.equal(stopped, true, 'нажатие кнопки не перехвачено');
  } finally { perms.setFullAccess('Admin'); }
  // «Изменение» — экран как обычно.
  perms.setEffectiveFromRole(savedRole('Регистратор', REGISTRAR, { settings: 'view', 'settings.telephony': 'edit' }));
  try {
    const root = mk('div');
    await renderWithViewOnly(root, 'settings.telephony', (r) => { r.appendChild(h('span', null, 'x')); });
    assert.ok(!String(root.className).includes('is-view-only') && !textOf(root).includes('Только просмотр'));
  } finally { perms.setFullAccess('Admin'); }
});

test('«Сотрудники: Просмотр» — список без «Нового сотрудника» и без импорта', async () => {
  perms.setEffectiveFromRole(savedRole('Регистратор', REGISTRAR, { settings: 'view', 'settings.employees': 'view' }));
  try {
    const root = mk('div');
    await renderEmployees(root);
    await tick();
    assert.ok(textOf(root).includes('Plain Nurse'), 'список не показан');
    assert.ok(!textOf(root).includes('Новый сотрудник'), '«Новый сотрудник» на «Просмотре»');
  } finally { perms.setFullAccess('Admin'); }
  const root = mk('div');
  await renderEmployees(root);
  await tick();
  assert.ok(textOf(root).includes('Новый сотрудник'), 'у администратора пропал «Новый сотрудник»');
});
