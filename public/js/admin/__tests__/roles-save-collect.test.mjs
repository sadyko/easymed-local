// ROLES_SAVE_TRUTH_V1 (2026-09-29) — СБОР МАТРИЦЫ: ПИШЕТСЯ ТОЛЬКО РЕШЁННОЕ.
//
// Чистая логика roles-matrix.js без экрана: collectGrants с `initial`
// (показанное при открытии) и legacyFromGrants с `initial`. Экран и сервер
// целиком — в roles-save-truth.test.mjs; здесь каждое правило отдельно, чтобы
// поломка называла себя.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Минимальная фальшивая DOM: roles-matrix.js тянет ui.js и i18n.js.
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;}
 addEventListener(){} removeEventListener(){} querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){return{contains:()=>false,add(){},remove(){},toggle(){}};}}
class TX extends F{constructor(t){super('#text');this._t=String(t);}}
function mk(t){const el=new F(t);if(el.tagName==='TEMPLATE'){el.content={firstChild:null};Object.defineProperty(el,'innerHTML',{set(v){const s=new F('svg');s._t=String(v);el.content.firstChild=s;},get(){return '';}});}return el;}
globalThis.Node=F;
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
const store=new Map();
globalThis.localStorage={getItem:(k)=>(store.has(k)?store.get(k):null),setItem:(k,v)=>store.set(k,String(v)),removeItem:(k)=>store.delete(k),clear:()=>store.clear()};
localStorage.setItem('admin.lang','ru');
globalThis.window={location:{hostname:'localhost'},localStorage:globalThis.localStorage,addEventListener(){},easymed:{state:{user:null}}};
globalThis.MutationObserver=class{observe(){}disconnect(){}};

const { collectGrants, legacyFromGrants, grantsFromLegacy } = await import('../roles-matrix.js');
const { catalogRows, CATALOG } = await import('../../shared/permission-catalog.js');

// То, что стоит на переключателях: вывод из старых полей, поверх — правда
// сервера, поверх — записанное; уровень, которого у строки нет, — «Нет».
function shownFor(perms, truth = {}) {
  const g = { ...grantsFromLegacy(perms), ...truth, ...(perms.grants || {}) };
  const out = {};
  for (const r of catalogRows()) {
    if (r.locked) continue;
    out[r.key] = (r.levels || ['none', 'view']).includes(g[r.key]) ? g[r.key] : 'none';
  }
  return out;
}
const controlsOf = (values) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: () => v }]));
const kidsOf = (key) => { const s = CATALOG.find((x) => x.key === key); return [...(s.windows || []), ...(s.actions || [])].map((r) => r.key); };

const REG = { sections: ['patients', 'crm', 'beds', 'dashboard'], levels: { patients: 'editor', crm: 'editor', beds: 'editor', dashboard: 'viewer' }, grants: { 'crm.dial': 'edit' } };
const TRUTH = { 'crm.all': 'none', 'inpatient.vitals': 'none', 'inpatient.marks': 'none', 'crm.calls': 'view' };

test('ничего не тронуто — пишется только записанное у роли', () => {
  const shown = shownFor(REG, TRUTH);
  assert.deepEqual(collectGrants(controlsOf(shown), { explicit: REG.grants, initial: shown }), { 'crm.dial': 'edit' });
});

test('тронутый ключ пишется, возвращённый назад — нет; записанный пишется всегда', () => {
  const shown = shownFor(REG, TRUTH);
  const cur = { ...shown, 'crm.all': 'edit' };
  assert.deepEqual(collectGrants(controlsOf(cur), { explicit: REG.grants, initial: shown }), { 'crm.dial': 'edit', 'crm.all': 'edit' });
  assert.deepEqual(collectGrants(controlsOf({ ...shown }), { explicit: REG.grants, initial: shown }), { 'crm.dial': 'edit' }, 'вернули как было — не пишется');
});

test('закрытый здесь раздел: «Нет» у него и у всех его строк', () => {
  const shown = shownFor(REG, TRUTH);
  const cur = { ...shown, crm: 'none' };
  for (const k of kidsOf('crm')) cur[k] = 'none';   // paintCatalog обнуляет строки закрытого раздела
  const out = collectGrants(controlsOf(cur), { explicit: REG.grants, closed: new Set(['crm']), initial: shown });
  assert.equal(out.crm, 'none');
  // Строки, что были открыты, записаны «Нет»; строка, что и была «Нет», может
  // остаться незаписанной — записанное «Нет» раздела закрывает её на сервере
  // (grants.js), а ворота по списку ролей семьёй не пишутся (ревью M1).
  for (const k of kidsOf('crm')) {
    if (shown[k] !== 'none') assert.equal(out[k], 'none', k + ': открытая строка закрытого раздела не записана «Нет»');
    else assert.ok(!(k in out) || out[k] === 'none', k);
  }
  assert.ok(!('patients' in out), 'закрытие задело соседний раздел');
});

test('унаследованное «раздел Нет, окно Просмотр» чинится при сохранении', () => {
  const perms = { sections: ['patients'], levels: { patients: 'editor' }, grants: { custdev: 'none', 'custdev.list': 'view', 'custdev.rate': 'edit' } };
  const shown = shownFor(perms);
  const out = collectGrants(controlsOf(shown), { explicit: perms.grants, initial: shown });
  assert.deepEqual(out, { custdev: 'none', 'custdev.list': 'none', 'custdev.rate': 'none' });
});

test('открытый раздел пишет свои строки такими, какими их видно, кроме строк «только администратор»', () => {
  // Лаборант без «Отчётов»: открыли раздел и отметили одну группу. Незаписанные
  // группы сервер вывел бы из нового «reports-hub» — все сразу.
  const lab = { sections: ['labs', 'patients', 'dashboard'], levels: { labs: 'editor', patients: 'viewer', dashboard: 'viewer' } };
  const truth = Object.fromEntries(kidsOf('reports').map((k) => [k, 'none']));
  const shown = shownFor(lab, truth);
  const cur = { ...shown, reports: 'view', 'reports.cashier': 'view' };
  const out = collectGrants(controlsOf(cur), { explicit: {}, initial: shown });
  assert.equal(out.reports, 'view');
  assert.equal(out['reports.cashier'], 'view');
  for (const k of kidsOf('reports')) {
    if (k === 'reports.cashier') continue;
    if (k === 'reports.telegram') { assert.ok(!(k in out), 'строка «только администратор» записана'); continue; }
    assert.equal(out[k], 'none', k + ': неотмеченная группа не записана «Нет» — сервер открыл бы её по «Отчётам»');
  }
  assert.ok(!('labs' in out), 'чужой раздел записан');
});

test('строка «только администратор»: нетронутая не пишется, тронутая — пишется', () => {
  const shown = shownFor(REG, { ...TRUTH, 'settings.api': 'none', 'cashier.lines': 'none' });
  assert.ok(!('settings.api' in collectGrants(controlsOf(shown), { explicit: {}, initial: shown })));
  const out = collectGrants(controlsOf({ ...shown, 'settings.api': 'view' }), { explicit: {}, initial: shown });
  assert.equal(out['settings.api'], 'view');
});

// ROLES_SAVE_TRUTH_V1 (ревью M1) — «семья» сдвинутого раздела не пишет строки,
// чьи ворота — список ролей в коде (roleListGate): по незаписанному такому
// ключу решают роли, а не старые поля, и старый ключ раздела им не указ.
// Показанный уровень у них — «все ворота уровня» (режим 'all'), и запись его
// только сужала бы: регистратура и касса проходят ворота «добавить услугу у
// койки», но не «отметить выполнение», — «Просмотр», записанный семьёй, отнял
// бы у них добавление услуги (admission_service_add 400 → 403).
const GATED_INPATIENT = kidsOf('inpatient');
test('семья сдвинутого раздела не пишет строки с воротами по списку ролей: регистратура опускает «Порционник» и «Выписки»', () => {
  const truth = { 'inpatient.services': 'view', 'inpatient.history': 'view', 'inpatient.requests': 'edit', 'inpatient.beds': 'edit',
    'inpatient.patients': 'none', 'inpatient.reviews': 'none', 'inpatient.discharge': 'none', 'inpatient.prescriptions': 'none', 'inpatient.marks': 'none', 'inpatient.vitals': 'none' };
  const shown = shownFor(REG, truth);
  const cur = { ...shown, kitchen: 'view', discharges: 'view' };   // старый ключ beds: editor → viewer
  const out = collectGrants(controlsOf(cur), { explicit: REG.grants, initial: shown });
  for (const k of GATED_INPATIENT) assert.ok(!(k in out), k + ' записан семьёй — ворота по списку ролей решают сами');
  assert.equal(out.kitchen, 'view');
  assert.equal(out.discharges, 'view');
  assert.equal(out['mar.outpatient'], shown['mar.outpatient'], 'окно-маршрут семьи не записано таким, как его видно');
  assert.equal(out.inpatient, shown.inpatient, 'раздел семьи не записан таким, как его видно');
});

test('семья сдвинутого раздела: касса открывает «Стационар» — окна-маршруты «Нет», строки с воротами по списку ролей не пишутся', () => {
  const cashier = { sections: ['cashier', 'patients', 'dashboard'], levels: { cashier: 'admin', patients: 'editor', dashboard: 'viewer' } };
  const truth = { 'inpatient.services': 'view', 'inpatient.history': 'view' };
  for (const k of GATED_INPATIENT) if (!(k in truth)) truth[k] = 'none';
  const shown = shownFor(cashier, truth);
  const out = collectGrants(controlsOf({ ...shown, inpatient: 'view' }), { explicit: {}, initial: shown });
  assert.deepEqual(out, { inpatient: 'view', 'mar.outpatient': 'none', 'mar.inpatient': 'none' });
});

test('без initial — прежнее правило: матрица целиком, без несвершённых «Нет» и нетронутых строк администратора', () => {
  const shown = shownFor(REG);
  const out = collectGrants(controlsOf(shown), { explicit: REG.grants });
  assert.equal(out.patients, 'edit');
  assert.equal(out['inpatient.vitals'], shown['inpatient.vitals'], 'прежний сбор писал всю матрицу');
  assert.ok(!('reports' in out), 'несвершённое «Нет» раздела записано');
  assert.ok(!('settings.api' in out), 'нетронутая строка «только администратор» записана');
});

// Вывод старых полей ТЕРЯЕТ сведения — так записано у врача свежей базы.
const DOCTOR = { sections: ['patients', 'consultation', 'labs', 'dashboard', 'patient-documents', 'queue', 'my-stock'],
  levels: { patients: 'editor', consultation: 'editor', labs: 'editor', dashboard: 'viewer', 'patient-documents': 'editor', queue: 'viewer', 'my-stock': 'viewer' } };

test('старые поля: без правок — ровно записанное, даже там, где вывод теряет сведения', () => {
  const shown = shownFor(DOCTOR);
  const plain = legacyFromGrants(shown, DOCTOR);
  assert.ok(plain.sections.includes('registration') && plain.levels.consultation === 'viewer',
    'вывод «как сейчас» больше не теряет — пересмотрите, нужен ли `initial`');
  const got = legacyFromGrants(shown, DOCTOR, shown);
  assert.deepEqual([...got.sections].sort(), [...DOCTOR.sections].sort());
  assert.deepEqual(got.levels, DOCTOR.levels);
});

test('старые поля: тронутый раздел меняет свой ключ; «Пациенты: Изменение» дописывает registration, queue — как был', () => {
  const lab = { sections: ['labs', 'patients', 'dashboard'], levels: { labs: 'editor', patients: 'viewer', dashboard: 'viewer' } };
  const shown = shownFor(lab);
  const got = legacyFromGrants({ ...shown, patients: 'edit' }, lab, shown);
  assert.equal(got.levels.patients, 'editor');
  assert.ok(got.sections.includes('registration'), '«Пациенты: Изменение» не открыли регистрацию');
  assert.equal(got.levels.registration, 'editor');
  assert.ok(!got.sections.includes('queue'), 'очередь дописана, хотя её вывод не сдвинулся');
  assert.equal(got.levels.labs, 'editor');
  const closed = legacyFromGrants({ ...shown, labs: 'none' }, lab, shown);
  assert.ok(!closed.sections.includes('labs') && !('labs' in closed.levels), 'закрытая лаборатория осталась в старых полях');
});
