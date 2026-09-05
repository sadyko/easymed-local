// HEAD_DOCTOR_WARD_VIEW_V1 (2026-09-05) — ГЛАВНЫЙ ВРАЧ ВИДИТ СТАЦИОНАР В СВОЁМ
// КАБИНЕТЕ.
//
// Владелец: «главный врач cannot see the admission of the patients of the
// departments. in their cabinet».
//
// Что здесь закреплено, по порядку важности:
//
//   1. ГЛАВНЫЙ ВРАЧ ВИДИТ ТЕХ, КОГО НЕ ЛЕЧИТ. Это не послабление, а суть его
//      работы: первичный осмотр он проводит до того, как лечащий врач вообще
//      появится, и назначает лечащего следом. Проверяется по САМОМУ ЗАПРОСУ —
//      сужения «я — лечащий» в нём нет, — а не по тому, что на экране что-то
//      нарисовалось.
//   2. ПАЛАТНЫЙ ВРАЧ ПО-ПРЕЖНЕМУ ВИДИТ ТОЛЬКО СВОИХ. Ширина приходит С
//      СЕРВЕРА (inpatient_capabilities → scope), и не ответивший сервер
//      оставляет самое узкое.
//   3. ДЕЙСТВИЯ — РОВНО ТЕ, ЧТО РАЗРЕШИЛ СЕРВЕР. Кнопки «Провести первичный
//      осмотр» и «Назначить лечащего врача» рисуются по ответу `can`, и при
//      пустом ответе на их месте подпись, а не кнопка.
//   4. ЧУЖИЕ ДЕНЬГИ НЕДОСТУПНЫ. Широкий взгляд на стационар не расширяет
//      денежных запросов: карточка врача, приёмы и услуги остаются сужены на
//      свой id, полоса стационара читает из `admissions` только `id, status`,
//      и ни один запрос не называет чужого врача. Проверяется тем же способом,
//      что в doctor-dashboard.test.mjs.
//   5. ПУСТОТА ГОВОРИТ СЛОВАМИ — и разными: «у меня никого» и «в стационаре
//      никого» — разные факты.

import { test } from 'node:test';
import assert from 'node:assert';

// --- fake DOM (тот же харнесс, что у doctor-dashboard.test.mjs) -------------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={setProperty(k,v){this[k]=v;},getPropertyValue(k){return this[k];}};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 _desc(o=[]){for(const c of this.children||[]){o.push(c);if(c._desc)c._desc(o);}return o;}
 _sel(n,s){ if(s[0]==='#')return (n.attrs&&n.attrs.id)===s.slice(1);
            if(s[0]==='.')return String(n.className||'').split(/\s+/).includes(s.slice(1));
            return String(n.tagName||'').toLowerCase()===s.toLowerCase(); }
 querySelector(s){return this._desc().find((n)=>this._sel(n,s))||null;}
 querySelectorAll(s){return this._desc().filter((n)=>this._sel(n,s));}
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
const styleEls = new Map();
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return styleEls.get(id) || null; },
};
function makeLocalStorage() {
  const store = new Map();
  return { getItem: (k) => (store.has(k) ? store.get(k) : null),
           setItem: (k, v) => { store.set(k, String(v)); },
           removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — i18n.js выбирает язык ОДИН раз при загрузке модуля.
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: null } },
  confirm: () => true,
  easymedSetTabSub: () => {},
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const allButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const buttonByText = (root, re) => allButtons(root).find((b) => re.test(textOf(b)));
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// ПОСЕВ. Четверо в койках, и ни один из них не «мой» для главного врача:
//   a-1 'admitted' — поступил, первичного осмотра нет (лечащего нет вовсе);
//   a-2 'examined' — осмотрен, лечащий ещё не назначен;
//   a-3 'active'   — лечит ПАЛАТНЫЙ врач (единственный «свой» у него);
//   a-4 'active'   — лечит третий врач, посторонний обоим.
// ---------------------------------------------------------------------------
const HEAD = { id: 'u-head', full_name: 'Рахимов Шухрат', specialty: 'Хирург', is_doctor: true, active: true, role: 'doctor',
               salary_type: 'percentage', service_rates: [], kpi_links: [], rooms: null };
const WARD = { id: 'u-ward', full_name: 'Каримова Азиза', specialty: 'Терапевт', is_doctor: true, active: true, role: 'doctor',
               salary_type: 'percentage', service_rates: [{ service_id: 's-1', percentage: 40 }], kpi_links: [], rooms: null };
const OTHER = { id: 'u-other', full_name: 'Юсупов Бахтиёр', specialty: 'Невролог', is_doctor: true, active: true, role: 'doctor',
                salary_type: 'percentage', service_rates: [{ service_id: 's-1', percentage: 50 }], kpi_links: [], rooms: null };

const pat = (id, mrn, name) => ({ id, mrn, full_name: name, last_name: name.split(' ')[0], first_name: name.split(' ')[1] || '', phone: '' });
const P1 = pat('p-1', 'MRN-001', 'Иванов Пётр');
const P2 = pat('p-2', 'MRN-002', 'Саидова Нилуфар');
const P3 = pat('p-3', 'MRN-003', 'Тошев Жасур');
const P4 = pat('p-4', 'MRN-004', 'Рахимов Азиз');

const ADM = [
  { id: 'a-3', admission_no: 'A-3', status: 'active',   admission_diagnosis: 'J18', admitted_at: '2026-09-01T08:00:00Z',
    department: 'Терапия', patient_id: 'p-3', attending_doctor_id: 'u-ward',  ward_id: 'w-1', bed_id: 'b-3',
    patients: P3, wards: { name: 'Терапия' }, beds: { code: 'K-3' }, attending: { full_name: WARD.full_name } },
  { id: 'a-1', admission_no: 'A-1', status: 'admitted', admission_diagnosis: '',    admitted_at: '2026-09-04T09:00:00Z',
    department: 'Хирургия', patient_id: 'p-1', attending_doctor_id: null,     ward_id: 'w-1', bed_id: 'b-1',
    patients: P1, wards: { name: 'Хирургия' }, beds: { code: 'K-1' }, attending: null },
  { id: 'a-2', admission_no: 'A-2', status: 'examined', admission_diagnosis: 'K35', admitted_at: '2026-09-03T10:00:00Z',
    department: 'Хирургия', patient_id: 'p-2', attending_doctor_id: null,     ward_id: 'w-1', bed_id: 'b-2',
    patients: P2, wards: { name: 'Хирургия' }, beds: { code: 'K-2' }, attending: null },
  { id: 'a-4', admission_no: 'A-4', status: 'active',   admission_diagnosis: 'I10', admitted_at: '2026-09-02T11:00:00Z',
    department: 'Неврология', patient_id: 'p-4', attending_doctor_id: 'u-other', ward_id: 'w-1', bed_id: 'b-4',
    patients: P4, wards: { name: 'Неврология' }, beds: { code: 'K-4' }, attending: { full_name: OTHER.full_name } },
];

// Деньги ЧУЖОГО врача — они существуют в базе, и ни один запрос кабинета
// главного врача не имеет права их назвать.
const VISITS = [
  { id: 'v-o1', doctor_id: 'u-other', visit_date: new Date().toISOString(), duration_minutes: 30, status: 'arrived',
    patient_id: 'p-4', service_id: 's-1', room_id: null, sync_origin: null, patients: P4, services: { id: 's-1', name: 'Приём', tax_rate: 0 }, rooms: null },
];
const VISIT_SERVICES = [
  { id: 'sv-o1', visit_id: 'v-o1', doctor_id: 'u-other', service_id: 's-1', status: 'completed', quantity: 1,
    unit_price: 999000, total: 999000, invoice_item_id: null, sync_origin: null, services: { id: 's-1', name: 'Приём', tax_rate: 0 },
    visits: { visit_date: VISITS[0].visit_date, patient_id: 'p-4', patients: P4, status: 'arrived' },
    users: { full_name: OTHER.full_name, specialty: OTHER.specialty, rooms: null }, consultation_types: null },
];

// --- честный fake /api/db + /api/rpc ---------------------------------------
let dbCalls = [];
let rpcCalls = [];
let CAPS = null;            // что отвечает inpatient_capabilities
let ADMISSION_ROWS = ADM;   // подменяется в тесте про пустоту

function matches(row, f) {
  if (f.or) return true;
  const v = row[f.col];
  switch (f.op) {
    case 'eq':  return String(v) === String(f.val);
    case 'neq': return String(v) !== String(f.val);
    case 'is':  return f.val === null ? (v === null || v === undefined) : v === f.val;
    case 'in':  return (f.val || []).map(String).includes(String(v));
    case 'gte': return String(v) >= String(f.val);
    case 'gt':  return String(v) >  String(f.val);
    case 'lte': return String(v) <= String(f.val);
    case 'lt':  return String(v) <  String(f.val);
    default:    return true;
  }
}
const TABLES = () => ({
  users: [HEAD, WARD, OTHER],
  visits: VISITS,
  visit_services: VISIT_SERVICES,
  invoice_items: [], invoices: [], recommended_services: [],
  admissions: ADMISSION_ROWS,
});
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push(name);
    if (name === 'inpatient_capabilities') {
      return { ok: true, json: async () => ({ data: CAPS }) };
    }
    return { ok: true, json: async () => ({ data: null }) };
  }
  if (u.startsWith('/api/db')) {
    dbCalls.push(body);
    let rows = TABLES()[body.table] || [];
    for (const f of (body.filters || [])) rows = rows.filter((r) => matches(r, f));
    for (const o of (body.order || []).slice().reverse()) {
      rows = rows.slice().sort((a, b) => (String(a[o.col]) < String(b[o.col]) ? -1 : String(a[o.col]) > String(b[o.col]) ? 1 : 0) * (o.asc ? 1 : -1));
    }
    if (body.limit) rows = rows.slice(0, body.limit);
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderConsultation } = await import('../views/consultation.js');
const dash = await import('../views/doctor-dashboard.js');
const perms = await import('../permissions.js');
perms.setFullAccess('test');

function loginAs(user) { window.easymed.state.user = user ? { ...user, is_admin: false, is_super_admin: false } : null; }
function reset() { dbCalls = []; rpcCalls = []; dash.resetDoctorDashboard(); }

const HEAD_CAPS = { roles: ['doctor', 'head_doctor'], scope: 'all',
  can: { admit: true, cancel_order: true, examine: true, set_attending: true,
         request_discharge: true, cancel_discharge_request: true, discharge: true } };
const WARD_CAPS = { roles: ['doctor'], scope: 'own',
  can: { admit: false, cancel_order: false, examine: false, set_attending: false,
         request_discharge: true, cancel_discharge_request: true, discharge: false } };

/** Открыть кабинет на вкладке «Стационар» и дождаться, пока он дочитает. */
async function openWard(user, caps, rows = ADM) {
  reset();
  loginAs(user);
  CAPS = caps;
  ADMISSION_ROWS = rows;
  const host = mk('div');
  await renderConsultation(host, { onNavigate: () => {}, payload: { sub: 'inpatients' } });
  await tick();
  return host;
}
const admissionsCall = () => dbCalls.filter((c) => c.table === 'admissions').pop();

// ===========================================================================
test('главный врач видит В КАБИНЕТЕ пациентов, которых он НЕ лечит — запрос не сужен на «я лечащий»', async () => {
  const host = await openWard(HEAD, HEAD_CAPS);

  const call = admissionsCall();
  assert.ok(call, 'вкладка обязана спросить госпитализации: ' + dbCalls.map((c) => c.table).join(','));
  const narrowed = (call.filters || []).some((f) => f.col === 'attending_doctor_id');
  assert.strictEqual(narrowed, false,
    'сужения «я — лечащий» у главного врача быть не может, иначе он не увидит НИКОГО из тех, кого обязан осмотреть: '
    + JSON.stringify(call.filters));
  // «В койке», а не только «лечится»: пациент виден с первой минуты.
  const inBed = (call.filters || []).find((f) => f.col === 'status' && f.op === 'in');
  assert.ok(inBed && inBed.val.includes('admitted') && inBed.val.includes('examined'),
    'список обязан включать состояния до лечения: ' + JSON.stringify(inBed));

  const txt = textOf(host);
  for (const name of ['Иванов Пётр', 'Саидова Нилуфар', 'Тошев Жасур', 'Рахимов Азиз']) {
    assert.ok(txt.includes(name), 'в стационаре не хватает пациента ' + name);
  }
  assert.ok(txt.includes('Стационар: все пациенты'), 'список назван тем, что он есть: ' + txt.slice(0, 200));
  assert.ok(txt.includes('активные госпитализации: 4'));
  assert.ok(txt.includes('Первичный осмотр и назначение лечащего врача — по всему стационару.'),
    'почему видно чужих — сказано словами');
  // Чей пациент — видно: без этого «осмотрен» и «лечится» неразличимы.
  assert.ok(txt.includes('лечащий: ' + WARD.full_name), 'лечащий врач назван по имени');
  assert.ok(txt.includes('без лечащего врача'), 'и его отсутствие — тоже');
});

test('порядок списка — это работа: неосмотренные первыми, затем без лечащего врача', async () => {
  const host = await openWard(HEAD, HEAD_CAPS);
  const names = walk(host).filter((n) => n.tagName === 'BUTTON' && /MRN-00/.test(textOf(n)))
    .map((n) => textOf(n).trim().split('  ')[0].trim());
  assert.ok(names[0].includes('Иванов Пётр'), 'сверху тот, кого не осмотрели: ' + JSON.stringify(names));
  assert.ok(names[1].includes('Саидова Нилуфар'), 'следом — осмотренный без лечащего: ' + JSON.stringify(names));
});

test('главный врач делает ровно то, что разрешил сервер: осмотр и назначение лечащего', async () => {
  const host = await openWard(HEAD, HEAD_CAPS);
  assert.ok(buttonByText(host, /Провести первичный осмотр/), 'первичный осмотр — из кабинета');
  assert.ok(buttonByText(host, /Назначить лечащего врача/), 'и назначение лечащего');
  // Дальше кабинет не идёт: выписка и отмена заявки живут в разделе «Стационар».
  assert.strictEqual(buttonByText(host, /Оформить выписку|Отменить заявку/), undefined,
    'кабинет не отращивает шагов маршрута, которых у него не было');
});

test('сервер сказал «нельзя» — на месте кнопки подпись, а не кнопка', async () => {
  // Широкая область без права на шаг: так выглядит роль, у которой отняли
  // первичный осмотр. Кнопка обязана исчезнуть вместе с правом.
  const host = await openWard(HEAD, { roles: ['admin'], scope: 'all', can: {} });
  const txt = textOf(host);
  assert.strictEqual(buttonByText(host, /Провести первичный осмотр/), undefined);
  assert.strictEqual(buttonByText(host, /Назначить лечащего врача/), undefined);
  assert.ok(txt.includes('Ждёт главного врача'), 'вместо кнопки — кого ждут: ' + txt.slice(0, 300));
  assert.ok(txt.includes('Ждёт лечащего врача'));
});

test('палатный врач по-прежнему видит только своих — и запрос сужен на него', async () => {
  const host = await openWard(WARD, WARD_CAPS);

  const call = admissionsCall();
  const own = (call.filters || []).some((f) => f.col === 'attending_doctor_id' && f.op === 'eq' && f.val === 'u-ward');
  assert.ok(own, 'запрос палатного врача обязан сузиться на него: ' + JSON.stringify(call.filters));

  const txt = textOf(host);
  assert.ok(txt.includes('Тошев Жасур'), 'свой пациент на месте');
  for (const name of ['Иванов Пётр', 'Саидова Нилуфар', 'Рахимов Азиз']) {
    assert.ok(!txt.includes(name), 'чужой пациент ' + name + ' в кабинете палатного врача');
  }
  assert.ok(txt.includes('Пациенты в стационаре'), 'заголовок остаётся прежним');
  assert.ok(!txt.includes('по всему стационару'), 'и объяснения про весь стационар у него нет');
});

test('сервер не ответил — остаёмся на самом узком, а не показываем всех', async () => {
  const host = await openWard(WARD, null);   // data: null — как при сбое RPC
  const call = admissionsCall();
  const own = (call.filters || []).some((f) => f.col === 'attending_doctor_id' && f.op === 'eq' && f.val === 'u-ward');
  assert.ok(own, 'без ответа сервера область обязана остаться узкой: ' + JSON.stringify(call.filters));
  assert.ok(!textOf(host).includes('Иванов Пётр'), 'чужих не показываем по умолчанию');
});

test('пустой стационар говорит словами, и «у меня никого» — не то же, что «в стационаре никого»', async () => {
  const ward = await openWard(WARD, WARD_CAPS, []);
  assert.ok(textOf(ward).includes('Нет активных стационарных пациентов.'), textOf(ward).slice(0, 300));

  const head = await openWard(HEAD, HEAD_CAPS, []);
  assert.ok(textOf(head).includes('В стационаре сейчас никого нет.'), textOf(head).slice(0, 300));
});

// ===========================================================================
// ДЕНЬГИ ОСТАЮТСЯ ЛИЧНЫМИ
// ===========================================================================
test('широкий взгляд на стационар не расширяет НИ ОДНОГО денежного запроса', async () => {
  reset();
  loginAs(HEAD);
  CAPS = HEAD_CAPS;
  const host = mk('div');
  await renderConsultation(host, { onNavigate: () => {}, payload: null });   // дашборд
  await tick(80);

  const scoped = dbCalls.filter((c) => ['users', 'visits', 'visit_services'].includes(c.table));
  assert.ok(scoped.length >= 2, 'дашборд обязан спросить свою карточку и свои приёмы: '
    + dbCalls.map((c) => c.table).join(','));
  for (const c of scoped) {
    const own = (c.filters || []).some((f) => (f.col === 'doctor_id' || f.col === 'id')
      && f.op === 'eq' && f.val === 'u-head');
    assert.ok(own, 'запрос к ' + c.table + ' не сужен на себя: ' + JSON.stringify(c.filters));
  }
  assert.strictEqual(JSON.stringify(dbCalls).includes('u-other'), false,
    'ни один запрос главного врача не назвал чужого врача');
  assert.strictEqual(JSON.stringify(dbCalls).includes('u-ward'), false,
    'и второго тоже');

  // Полоса стационара читает ТОЛЬКО клинические колонки: денег в ней нет вовсе.
  const strip = dbCalls.find((c) => c.table === 'admissions');
  assert.ok(strip, 'полоса главного врача обязана спросить стационар');
  assert.strictEqual(String(strip.columns).replace(/\s+/g, ''), 'id,status',
    'в полосе не может быть ни одной денежной колонки: ' + strip.columns);

  const txt = textOf(host);
  assert.ok(txt.includes('Стационар отделения'), 'полоса на месте: ' + txt.slice(0, 300));
  assert.ok(txt.includes('Ждут первичного осмотра'));
  assert.ok(txt.includes('Ждут лечащего врача'));
  assert.ok(!txt.includes(OTHER.full_name), 'чужого врача на дашборде нет');
  assert.ok(!txt.includes((999000).toLocaleString('ru-RU')), 'чужих денег на дашборде нет');
});

test('у палатного врача полосы главного врача нет вовсе', async () => {
  reset();
  loginAs(WARD);
  CAPS = WARD_CAPS;
  const host = mk('div');
  await renderConsultation(host, { onNavigate: () => {}, payload: null });
  await tick(80);
  const txt = textOf(host);
  assert.ok(!txt.includes('Стационар отделения'), 'полоса — только у того, кому сервер сказал «all»');
  assert.strictEqual(dbCalls.some((c) => c.table === 'admissions'), false,
    'и лишнего запроса за ней тоже нет');
});
