// ROLE_REPORTS_SETTINGS_V1 (2026-09-25) — отчёты по группам и настройки по
// плиткам глазами оболочки: какие плитки видит роль, что открывается только
// для чтения, и что роль, которую ещё не настраивали, видит ровно то же, что
// видела до обновления.
//
// Сервер отвечает второй раз тем же ключом — это закреплено отдельно:
// server/services/report-access.test.js (отчёты) и server/db/write-grant.test.js
// (запись в таблицы настроек).
//
// Fake-DOM harness — из __tests__/settings-hub-groups.test.mjs.
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

const perms = await import('../permissions.js');
const { REPORT_DEFS, reportVisible } = await import('../views/reports-hub.js');
const { GROUPS, tileVisible, sectionLevel, renderSettingsHub } = await import('../views/settings-hub.js');
const { grantsFromLegacy, legacyFromGrants, collectGrants, paintCatalog } = await import('../roles-matrix.js');
const { CATALOG, catalogRows } = await import('../../shared/permission-catalog.js');

// Роль так, как её сохраняет экран «Роли»: матрица целиком + выведенные старые поля.
function savedRole(name, legacyPerms, overrides) {
  const grants = { ...grantsFromLegacy(legacyPerms), ...overrides };
  const legacy = legacyFromGrants(grants, legacyPerms);
  return { name, permissions: { ...legacy, grants } };
}
const REGISTRAR = { sections: ['patients', 'dashboard', 'patient-documents', 'registration', 'crm', 'queue', 'beds'],
  levels: { patients: 'editor', dashboard: 'viewer', 'patient-documents': 'editor', registration: 'editor', crm: 'editor', queue: 'viewer', beds: 'editor' } };
const CASHIER = { sections: ['cashier', 'patients', 'dashboard', 'reports-hub', 'queue'],
  levels: { cashier: 'admin', patients: 'editor', dashboard: 'viewer', 'reports-hub': 'viewer', queue: 'viewer' } };
const ONLY_CASHIER = { reports: 'view', 'reports.revenue': 'none', 'reports.cashier': 'view', 'reports.doctor_pay': 'none',
  'reports.referrals': 'none', 'reports.services': 'none', 'reports.stock': 'none', 'reports.callcenter': 'none' };

const visibleReports = () => REPORT_DEFS.filter(reportVisible).map((r) => r.kind);
const visibleTiles = () => GROUPS.flatMap((g) => g.items).filter(tileVisible).map((i) => i.label);
const ALWAYS = ['Система', 'Подписка', 'Данные клиники'];   // ALWAYS_ALLOWED — у каждой роли, как и было

// --- Отчёты -----------------------------------------------------------------

test('роль только с «Кассой» видит одну плитку — отчёт кассира', () => {
  perms.setEffectiveFromRole(savedRole('Касса', CASHIER, ONLY_CASHIER));
  try {
    assert.deepStrictEqual(visibleReports(), ['cashier']);
    assert.equal(perms.isModuleAllowed('reports-hub'), true);
    assert.equal(perms.isRouteAllowed('reports'), false, '«Обзор владельца» — это выручка');
    assert.equal(perms.isRouteAllowed('report:orders_salary_report'), false);
  } finally { perms.setFullAccess('Admin'); }
});

test('ненастроенная роль: «Отчёты» выданы — все плитки (кроме Telegram), не выданы — ни одной и нет пункта меню', () => {
  perms.setEffectiveFromRole({ name: 'Кассир', permissions: CASHIER });
  try {
    assert.deepStrictEqual(visibleReports(), REPORT_DEFS.map((r) => r.kind).filter((k) => k !== 'telegram'));
    assert.equal(perms.isRouteAllowed('reports'), true);
    assert.equal(perms.isRouteAllowed('report:orders_salary_report'), true);
  } finally { perms.setFullAccess('Admin'); }
  perms.setEffectiveFromRole({ name: 'Регистратор', permissions: REGISTRAR });
  try {
    assert.deepStrictEqual(visibleReports(), []);
    assert.equal(perms.isModuleAllowed('reports-hub'), false);
  } finally { perms.setFullAccess('Admin'); }
  assert.ok(visibleReports().includes('telegram'), 'администратор потерял Telegram-бота');
});

test('каждая плитка хаба — одна группа: все её виды ведут в ту же группу, что и основной', async () => {
  const { REPORT_GROUP } = await import('../../shared/permission-catalog.js');
  for (const rep of REPORT_DEFS) {
    if (rep.kind === 'telegram') { assert.ok(!(rep.kind in REPORT_GROUP)); continue; }
    const key = REPORT_GROUP[rep.kind];
    assert.ok(key, rep.kind + ': плитки нет в карте «вид → группа»');
    for (const v of rep.views || []) assert.equal(REPORT_GROUP[v.kind], key, rep.kind + ' / ' + v.kind + ': вид другой группы');
  }
});

// --- Настройки --------------------------------------------------------------

test('регистратура с «Категории пациентов: Изменение» видит одну плитку настроек и может её править', () => {
  const role = savedRole('Регистратор', REGISTRAR, { settings: 'view', 'settings.patient_categories': 'edit' });
  perms.setEffectiveFromRole(role);
  try {
    assert.equal(perms.isModuleAllowed('settings'), true);
    assert.deepStrictEqual(visibleTiles().filter((l) => !ALWAYS.includes(l)), ['Категории пациентов']);
    assert.equal(sectionLevel('patient_categories'), 'edit');
    assert.equal(sectionLevel('payers'), 'none');
    assert.equal(sectionLevel('api_tokens'), 'none');
    assert.equal(perms.isRouteAllowed('documents-settings'), false, 'закрытая плитка «Компания» открылась маршрутом');
  } finally { perms.setFullAccess('Admin'); }
});

test('ненастроенная роль с голым «Настройки»: те же экраны, что до обновления, справочники — только чтение', () => {
  perms.setEffectiveFromRole({ name: 'Старая роль', permissions: { sections: ['settings'], levels: { settings: 'viewer' } } });
  try {
    const tiles = visibleTiles();
    // Маршрутные плитки — по прежним строкам isRouteAllowed.
    for (const l of ['Документы', 'Компания', 'Помещения', 'Отделы']) assert.ok(tiles.includes(l), l + ' пропала');
    for (const l of ['Пациенты', 'Список услуг', 'Товары и препараты', 'Сотрудники', 'CRM-канбан', 'Телефония', 'Telegram-бот']) {
      assert.ok(!tiles.includes(l), l + ' видна, хотя её маршрут этой роли закрыт и раньше');
    }
    // Справочники хаба — видны (их открывал любой, кто дошёл до хаба), но
    // сохранить их не мог никто, кроме администратора, — поэтому только чтение.
    for (const k of ['patient_categories', 'payers', 'referral_sources', 'branches']) assert.equal(sectionLevel(k), 'view', k);
    // Ревью I2 — справочники-деньги (ставки врачей, скидки, полисы, провайдеры,
    // кэшбэк) — закрытые строки: только администратор.
    for (const k of ['doctor_rates', 'patient_discounts', 'payer_policies', 'payment_providers', 'cashback_rules']) assert.equal(sectionLevel(k), 'none', k);
    // Закрытые строки владельца — только администратор.
    assert.ok(!tiles.includes('Роли') && !tiles.includes('API'));
    assert.equal(perms.isRouteAllowed('api-settings'), false);
  } finally { perms.setFullAccess('Admin'); }
  // Администратор видит всё и правит всё.
  assert.equal(visibleTiles().length, GROUPS.flatMap((g) => g.items).length);
  assert.equal(sectionLevel('patient_categories'), 'edit');
});

test('справочник ниже «Изменения» открывается только для чтения: без «Добавить» и без окна правки', async () => {
  const root = mk('div');
  perms.setEffectiveFromRole(savedRole('Регистратор', REGISTRAR, { settings: 'view', 'settings.patient_categories': 'view' }));
  try {
    await renderSettingsHub(root, {});
    const tile = byClass(root, 'set-row-link').find((n) => textOf(n).includes('Категории пациентов'));
    assert.ok(tile, 'плитки нет');
    tile.click();
    await tick();
    const t = textOf(root);
    assert.ok(t.includes('Только просмотр'), 'справочник не сказал, что он только для чтения');
    assert.ok(!walk(root).some((n) => n.tagName === 'BUTTON' && String(n.className).includes('btn-primary')), 'кнопка «Добавить» у роли с «Просмотром»');
    assert.ok(t.includes('VIP'), 'строки справочника не показаны');
  } finally { perms.setFullAccess('Admin'); }
});

// --- Экран «Роли» -----------------------------------------------------------

test('роль из старых полей: плитки настроек — не выше «Просмотра», закрытые строки не выводятся', () => {
  const g = grantsFromLegacy({ sections: ['settings', 'documents'], levels: { settings: 'admin' } });
  for (const r of catalogRows().filter((x) => x.parent === 'settings')) {
    if (r.locked) { assert.ok(!(r.key in g), 'закрытая строка выведена: ' + r.key); continue; }
    if (r.key === 'settings.departments') continue;   // прежнее правило DEPARTMENTS_V1
    assert.notEqual(g[r.key], 'edit', r.key + ': «Изменение» выведено из галочки «Настройки» — запись раздана при сохранении');
  }
  assert.equal(g['settings.patient_categories'], 'view');
  assert.equal(g['settings.company'], 'view');
  assert.equal(g['settings.patients'], 'none', '«Пациенты» открывал только свой ключ settings:patients');
  // Отчёты: «Отчёты» выданы — видны все группы, как и было.
  const r = grantsFromLegacy(CASHIER);
  for (const w of CATALOG.find((s) => s.key === 'reports').windows) {
    if (w.locked) assert.ok(!(w.key in r)); else assert.equal(r[w.key], 'view', w.key);
  }
});

test('матрица рисует окна «Настроек» группами хаба, закрытые — без переключателя и в базу не уходят', () => {
  const host = mk('div');
  const grants = grantsFromLegacy({ sections: ['settings'], levels: { settings: 'viewer' } });
  const controls = paintCatalog(host, grants, { openSections: new Set(['settings']) });
  const t = textOf(host);
  for (const g of ['Основное', 'Системные настройки', 'Управление плательщиками', 'Направления', 'Зарплата врача', 'Помещения']) {
    assert.ok(t.includes(g), 'нет подзаголовка группы «' + g + '»');
  }
  assert.ok(t.includes('Только администратор'));
  for (const k of ['settings.api', 'settings.roles', 'settings.telegram', 'settings.telephony', 'settings.crm', 'settings.employees', 'reports.telegram']) {
    assert.ok(!(k in controls), k + ': у закрытой строки есть переключатель');
  }
  const out = collectGrants(controls, { explicit: grants });
  assert.ok(!('settings.api' in out) && !('reports.telegram' in out), 'закрытая строка уехала в базу');
  assert.ok('settings.patient_categories' in out, 'выдаваемая плитка не уехала в базу');
});

test('предпросмотр роли возвращает права по справочнику на место', () => {
  perms.setEffectiveFromRole(savedRole('Касса', CASHIER, ONLY_CASHIER));
  try {
    const seen = perms.previewRole({ name: 'Кассир', permissions: CASHIER }, () => visibleReports());
    assert.ok(seen.includes('total_revenue'), 'предпросмотр читал права вошедшего, а не роли');
    assert.deepStrictEqual(visibleReports(), ['cashier'], 'после предпросмотра остались права чужой роли');
  } finally { perms.setFullAccess('Admin'); }
});

// --- Ревью C1: администратор-врач (основная `doctor`, `admin` дополнительной) --

const ADMIN_ROW = { sections: ['dashboard', 'reports-hub', 'patients', 'settings', 'cashier'], levels: { settings: 'admin', 'reports-hub': 'admin' } };
const DOCTOR_ROW = { sections: ['patients', 'consultation', 'labs', 'dashboard'], levels: {} };
function asAdminDoctor() {
  perms.setEffectiveFromRoles([{ name: 'doctor', permissions: DOCTOR_ROW }, { name: 'admin', permissions: ADMIN_ROW }]);
}

test('администратор-врач: плитки настроек на «Изменение», «Роли», «API», закрытые экраны и связь зданий — как у администратора', async () => {
  asAdminDoctor();
  try {
    assert.equal(perms.hasRestriction(), true, 'стенд не тот: администратор-врач живёт по объединению ролей');
    assert.equal(perms.actorIsAdmin(), true);
    for (const k of ['patient_categories', 'payers', 'doctor_rates', 'api_tokens', 'roles', 'branches']) assert.equal(sectionLevel(k), 'edit', k);
    for (const l of ['Роли', 'API', 'Ставки врачей', 'Сотрудники', 'Телефония', 'Telegram-бот', 'CRM-канбан']) assert.ok(visibleTiles().includes(l), l + ' спрятана от администратора-врача');
    for (const r of ['api-settings', 'telegram-settings', 'telephony-settings', 'crm-settings', 'employees', 'settings:patients', 'services']) {
      assert.equal(perms.isRouteAllowed(r), true, r + ' закрыт администратору-врачу');
    }
    assert.equal(perms.settingsGrantColumns('patient_categories'), null, 'администратору-врачу урезали колонки');
    const root = mk('div');
    await renderSettingsHub(root, {});
    byClass(root, 'set-row-link').find((n) => textOf(n).includes('Филиалы')).click();
    await tick();
    assert.ok(!textOf(root).includes('Только просмотр'), 'филиалы открылись только для чтения');
  } finally { perms.setFullAccess('Admin'); }
});

test('администратор-врач видит Telegram-отчёт и все группы отчётов', () => {
  asAdminDoctor();
  try {
    assert.deepStrictEqual(visibleReports(), REPORT_DEFS.map((r) => r.kind));
  } finally { perms.setFullAccess('Admin'); }
});

test('предпросмотр чужой роли администратором-врачом не наследует его права администратора', () => {
  asAdminDoctor();
  try {
    const seen = perms.previewRole({ name: 'registrar', permissions: REGISTRAR }, () => ({ adm: perms.actorIsAdmin(), roles: sectionLevel('roles') }));
    assert.deepStrictEqual(seen, { adm: false, roles: 'none' });
  } finally { perms.setFullAccess('Admin'); }
});

// --- Ревью I1: своя роль клиники на основе администратора ---------------------

test('своя роль на основе администратора: её «Нет» и «Просмотр» слушаются и в хабах', () => {
  perms.setFullAccess('Старший администратор');
  perms.setOwnCustomGrants({ settings: 'view', 'settings.patient_categories': 'view', 'settings.payers': 'none', 'reports.doctor_pay': 'none' });
  try {
    assert.equal(sectionLevel('patient_categories'), 'view', 'закрытое её ролью «Изменение» осталось');
    assert.equal(sectionLevel('payers'), 'none');
    assert.equal(sectionLevel('branches'), 'edit', 'не тронутое ею — как у администратора');
    assert.ok(!visibleTiles().includes('Компании-плательщики'));
    assert.ok(!visibleReports().includes('doctor_salaries') && !visibleReports().includes('by_doctors'), 'плитка открылась бы в 403');
    assert.ok(visibleReports().includes('cashier'));
    perms.setOwnCustomGrants({ settings: 'none', reports: 'none' });
    assert.equal(sectionLevel('branches'), 'none');
    assert.equal(perms.isRouteAllowed('documents-settings'), false);
    assert.deepStrictEqual(visibleReports(), []);
    assert.equal(perms.isModuleAllowed('reports-hub'), false);
  } finally { perms.setFullAccess('Admin'); }
  assert.equal(sectionLevel('payers'), 'edit', 'setFullAccess не сбросил записи своей роли');
});

// --- Ревью I2: деньги не показываются тому, кто не может их сохранить --------

test('регистратура с «Категории пациентов: Изменение»: в форме нет скидки группы', async () => {
  const root = mk('div');
  perms.setEffectiveFromRole(savedRole('Регистратор', REGISTRAR, { settings: 'view', 'settings.patient_categories': 'edit' }));
  try {
    assert.deepStrictEqual(perms.settingsGrantColumns('patient_categories'), ['name', 'tier', 'active']);
    assert.deepStrictEqual(perms.stripToGrant('wards', { name: 'П1', price_per_day: 5, department_id: 1 }), { name: 'П1' });
    await renderSettingsHub(root, {});
    byClass(root, 'set-row-link').find((n) => textOf(n).includes('Категории пациентов')).click();
    await tick();
    assert.ok(textOf(root).includes('Цены и проценты меняет только администратор.'));
    walk(root).find((n) => n.tagName === 'BUTTON' && String(n.className).includes('btn-primary')).click();
    const modal = document.body.children[document.body.children.length - 1];
    assert.ok(textOf(modal).includes('Название'), 'форма не открылась');
    assert.ok(!textOf(modal).includes('Скидка группы'), 'в форме поле скидки — сервер отказал бы всей записи');
  } finally { perms.setFullAccess('Admin'); }
});

// --- Колл-центр: одна группа открывает хаб с одной плиткой --------------------

test('оператор колл-центра с одной группой «Колл-центр» доходит до хаба и видит только её', () => {
  const CC = { sections: ['crm', 'dashboard', 'telegram-chat', 'custdev'], levels: { crm: 'admin' },
    grants: { 'crm.calls': 'view', 'crm.dial': 'edit', 'crm.recording': 'edit', 'crm.convert': 'edit', 'reports.callcenter': 'view' } };
  perms.setEffectiveFromRole({ name: 'callcenter', permissions: CC });
  try {
    assert.equal(perms.isModuleAllowed('reports-hub'), true);
    assert.equal(perms.isRouteAllowed('reports-hub'), true, 'пункт меню есть, а маршрут отказывает');
    assert.deepStrictEqual(visibleReports(), ['callcenter']);
  } finally { perms.setFullAccess('Admin'); }
});

// --- Ревью M1: сводка роли называет, что закрывает «Настройки: Нет» ------------

test('сводка роли: «Настройки: Нет» называет закрытые страницы внутри настроек', async () => {
  const { roleReach, reachSentences } = await import('../role-reach.js');
  const reach = roleReach(savedRole('registrar', REGISTRAR, { settings: 'none' }), ['patients', 'settings'], (id) => id);
  assert.equal(reach.settingsClosed, true);
  assert.ok(reachSentences(reach).some((x) => /Документы, Компания, Помещения, Список услуг, Консультации врачей/.test(x.template)));
  const open = roleReach(savedRole('registrar', REGISTRAR, { settings: 'view' }), ['patients'], (id) => id);
  assert.ok(!reachSentences(open).some((x) => /закрывает и страницы/.test(x.template)));
});
