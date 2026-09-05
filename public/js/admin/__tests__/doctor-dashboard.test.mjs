// DOCTOR_DASHBOARD_V1 (2026-09-05) — кабинет врача открывается ДАШБОРДОМ.
//
// Что здесь закреплено, по порядку важности:
//
//   1. КАЖДАЯ ЦИФРА СЧИТАЕТСЯ, А НЕ РИСУЕТСЯ. Показатели считаются из
//      посеянных данных и сверяются с числами, посчитанными РУКОЙ в шапке
//      фикстуры (доля врача — по формуле отчёта «Зарплата врачей»: база минус
//      доля скидки счёта, минус налог услуги, умножить на процент). Тест
//      «нарисовалось какое-то число» пропустил бы ровно тот класс ошибок, ради
//      которого этот экран и проверяют.
//   2. ЧУЖИЕ ДЕНЬГИ НЕДОСТУПНЫ ПОДМЕНОЙ АРГУМЕНТА. У загрузчика аргумента
//      нет; лишний аргумент игнорируется, и запросы всё равно уходят с id
//      вошедшего врача. Смена пользователя меняет фильтр — и заработок.
//   3. КОЛОНКА ДНЯ — это день ВРАЧА: сегодняшние приёмы по времени, с
//      возрастом, услугой и состоянием «пришёл».
//   4. ОКЛАД НЕ ВЫДУМЫВАЕТСЯ. У врача на фиксированном окладе дневного
//      заработка нет — прочерк и подпись, а не аккуратный ноль.
//   5. РАБОЧИЙ СПИСОК НЕ ПОТЕРЯН: он в один щелчок, работает и живёт по
//      своему адресу '#consultation/work', который переживает перезагрузку.

import { test } from 'node:test';
import assert from 'node:assert';

// --- fake DOM (тот же харнесс, что у lab-panels-mode.test.mjs) --------------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={setProperty(k,v){this[k]=v;},getPropertyValue(k){return this[k];}};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 // Очередь кабинета красит тело в гнездо ПО id (containerRef.querySelector
 // ('#svc-body')), поэтому заглушка «всегда null» превратила бы рабочий список
 // в пустую карточку — и тест «список работает» проходил бы, ничего не проверив.
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

let tabSubCalls = [];
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: null } },
  confirm: () => true,
  easymedSetTabSub: (tabId, sub) => { tabSubCalls.push([tabId, sub]); },
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

let lastHistoryUrl = null;
globalThis.history = {
  state: null,
  replaceState(st, _t, url) { this.state = st; lastHistoryUrl = url; },
  pushState(st, _t, url) { this.state = st; lastHistoryUrl = url; },
};

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const allButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const buttonByText = (root, re) => allButtons(root).find((b) => re.test(textOf(b)));
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// ПОСЕВ. «Сегодня» в фикстуре — 5 сентября 2026, 11:00 местного времени.
//
// Врач A — процент за услугу: приём терапевта (s-1, налог 6%) 40 %,
//          УЗИ (s-2, налог 0 %) 50 %.
// Врач B — тоже процент, но своя ставка и свои приёмы: он существует только
//          ради проверки «чужие деньги не достаются подменой».
//
// РУЧНОЙ СЧЁТ ДОЛИ ВРАЧА A (формула reports.js ITEM_FEE_SQL):
//   sv1  s-1 · 200 000, счёт inv-1: подытог 200 000, скидка 20 000, оплачен
//        база 200 000 − 20 000 = 180 000; налог 6 % → 180 000 × 0,94 = 169 200
//        доля 169 200 × 0,40 = 67 680
//   sv3  s-1 · 100 000, счёт inv-2 без скидки, не оплачен
//        база 100 000; налог 6 % → 94 000; доля 94 000 × 0,40 = 37 600
//   sv5  s-2 · 300 000, счёта нет → скидки нет, налог 0
//        доля 300 000 × 0,50 = 150 000            (вчера, 4 сентября)
//   sv6  s-1 · 100 000, счёта нет → 100 000 × 0,94 × 0,40 = 37 600
//                                                (27 августа — прошлая неделя)
// ---------------------------------------------------------------------------
const NOW = new Date(2026, 8, 5, 11, 0, 0);          // 5 сентября 2026, 11:00
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm, 0).toISOString();

const DOCTOR_A = {
  id: 'u-doc-a', full_name: 'Каримова Азиза', specialty: 'Терапевт', is_doctor: true, active: true, role: 'doctor',
  salary_type: 'percentage', salary_fixed: 0, salary_percent: 0, room_id: 'r-1',
  service_rates: [{ service_id: 's-1', percentage: 40 }, { service_id: 's-2', percentage: 50 }],
  kpi_links: [], rooms: { id: 'r-1', name: '204' },
};
const DOCTOR_B = {
  id: 'u-doc-b', full_name: 'Юсупов Бахтиёр', specialty: 'Хирург', is_doctor: true, active: true, role: 'doctor',
  salary_type: 'percentage', salary_fixed: 0, salary_percent: 0, room_id: null,
  service_rates: [{ service_id: 's-1', percentage: 10 }], kpi_links: [], rooms: null,
};
const DOCTOR_FIX = {
  id: 'u-doc-fix', full_name: 'Собиров Улугбек', specialty: 'Кардиолог', is_doctor: true, active: true, role: 'doctor',
  salary_type: 'fixed', salary_fixed: 9000000, service_rates: [{ service_id: 's-1', percentage: 40 }],
  kpi_links: [], rooms: null,
};

const P1 = { id: 'p-1', mrn: 'MRN-001', full_name: 'Иванов Пётр', last_name: 'Иванов', first_name: 'Пётр', phone: '+998901112233', date_of_birth: '1990-03-10' };
const P2 = { id: 'p-2', mrn: 'MRN-002', full_name: 'Саидова Нилуфар', last_name: 'Саидова', first_name: 'Нилуфар', phone: '', date_of_birth: '2001-09-06' };
const P3 = { id: 'p-3', mrn: 'MRN-003', full_name: 'Тошев Жасур', last_name: 'Тошев', first_name: 'Жасур', phone: '', date_of_birth: null };
const P4 = { id: 'p-4', mrn: 'MRN-004', full_name: 'Рахимов Азиз', last_name: 'Рахимов', first_name: 'Азиз', phone: '', date_of_birth: '1975-01-20' };

const SVC_1 = { id: 's-1', name: 'Приём терапевта', tax_rate: 6, duration_minutes: 30 };
const SVC_2 = { id: 's-2', name: 'УЗИ брюшной полости', tax_rate: 0, duration_minutes: 20 };
const ROOM = { id: 'r-1', name: '204', code: '204' };

const VISIT_ROWS = [
  { id: 'v-4', doctor_id: 'u-doc-a', visit_date: at(2026, 9, 5, 8, 15), duration_minutes: 15, status: 'no_show',   patient_id: 'p-3', service_id: 's-1', room_id: 'r-1', sync_origin: null, patients: P3, services: SVC_1, rooms: ROOM },
  { id: 'v-1', doctor_id: 'u-doc-a', visit_date: at(2026, 9, 5, 9, 0),  duration_minutes: 30, status: 'arrived',   patient_id: 'p-1', service_id: 's-1', room_id: 'r-1', sync_origin: null, patients: P1, services: SVC_1, rooms: ROOM },
  { id: 'v-2', doctor_id: 'u-doc-a', visit_date: at(2026, 9, 5, 9, 30), duration_minutes: 30, status: 'scheduled', patient_id: 'p-2', service_id: 's-1', room_id: 'r-1', sync_origin: null, patients: P2, services: SVC_1, rooms: ROOM },
  { id: 'v-3', doctor_id: 'u-doc-a', visit_date: at(2026, 9, 5, 14, 0), duration_minutes: 20, status: 'confirmed', patient_id: 'p-1', service_id: 's-2', room_id: 'r-1', sync_origin: null, patients: P1, services: SVC_2, rooms: ROOM },
  { id: 'v-5', doctor_id: 'u-doc-a', visit_date: at(2026, 9, 4, 10, 0), duration_minutes: 20, status: 'arrived',   patient_id: 'p-4', service_id: 's-2', room_id: 'r-1', sync_origin: null, patients: P4, services: SVC_2, rooms: ROOM },
  { id: 'v-6', doctor_id: 'u-doc-a', visit_date: at(2026, 8, 27, 10, 0), duration_minutes: 30, status: 'arrived',  patient_id: 'p-4', service_id: 's-1', room_id: 'r-1', sync_origin: null, patients: P4, services: SVC_1, rooms: ROOM },
  // Приём ВРАЧА B — в кабинете A его быть не должно ни при каких условиях.
  { id: 'v-b1', doctor_id: 'u-doc-b', visit_date: at(2026, 9, 5, 10, 0), duration_minutes: 30, status: 'arrived',  patient_id: 'p-2', service_id: 's-1', room_id: null, sync_origin: null, patients: P2, services: SVC_1, rooms: null },
];

const VS_ROWS = [
  { id: 'sv1', visit_id: 'v-1', doctor_id: 'u-doc-a', service_id: 's-1', status: 'completed', quantity: 1, unit_price: 200000, total: 200000, invoice_item_id: 'ii-1', sync_origin: null, services: SVC_1 },
  { id: 'sv2', visit_id: 'v-1', doctor_id: 'u-doc-a', service_id: 's-2', status: 'queued',    quantity: 1, unit_price: 100000, total: 100000, invoice_item_id: null,  sync_origin: null, services: SVC_2 },
  { id: 'sv3', visit_id: 'v-2', doctor_id: 'u-doc-a', service_id: 's-1', status: 'completed', quantity: 1, unit_price: 100000, total: 100000, invoice_item_id: 'ii-2', sync_origin: null, services: SVC_1 },
  { id: 'sv4', visit_id: 'v-3', doctor_id: 'u-doc-a', service_id: 's-2', status: 'queued',    quantity: 1, unit_price: 50000,  total: 50000,  invoice_item_id: null,  sync_origin: null, services: SVC_2 },
  { id: 'sv5', visit_id: 'v-5', doctor_id: 'u-doc-a', service_id: 's-2', status: 'completed', quantity: 1, unit_price: 300000, total: 300000, invoice_item_id: null,  sync_origin: null, services: SVC_2 },
  { id: 'sv6', visit_id: 'v-6', doctor_id: 'u-doc-a', service_id: 's-1', status: 'completed', quantity: 1, unit_price: 100000, total: 100000, invoice_item_id: null,  sync_origin: null, services: SVC_1 },
  // Деньги врача B: 400 000 · 10 % (налог 6 %) = 37 600. Ни одна из этих строк
  // не имеет права попасть в кабинет A.
  { id: 'svb', visit_id: 'v-b1', doctor_id: 'u-doc-b', service_id: 's-1', status: 'completed', quantity: 1, unit_price: 400000, total: 400000, invoice_item_id: null, sync_origin: null, services: SVC_1 },
];

// Рабочий список кабинета (consultation.js) читает те же строки, но с другими
// присоединениями: визит с пациентом и исполнитель. Дорисовываем их здесь, а не
// вторым набором фикстур — два посева одних и тех же услуг разъехались бы.
for (const r of VS_ROWS) {
  const v = VISIT_ROWS.find((x) => x.id === r.visit_id);
  r.visits = { visit_date: v.visit_date, patient_id: v.patient_id, patients: v.patients, status: v.status };
  const doc = [DOCTOR_A, DOCTOR_B].find((d) => d.id === r.doctor_id);
  r.users = { full_name: doc.full_name, specialty: doc.specialty, rooms: null };
  r.consultation_types = null;
}

const ITEM_ROWS = [
  { id: 'ii-1', invoice_id: 'inv-1', total: 200000 },
  { id: 'ii-2', invoice_id: 'inv-2', total: 100000 },
];
const INVOICE_ROWS = [
  { id: 'inv-1', subtotal: 200000, discount_amount: 20000, status: 'paid' },
  { id: 'inv-2', subtotal: 100000, discount_amount: 0,     status: 'unpaid' },
];

// --- честный fake /api/db: фильтры ПРИМЕНЯЮТСЯ ------------------------------
// Иначе проверка «запрос сужен на своего врача» ничего бы не значила: строки
// чужого врача приезжали бы в любом случае и тест «не видно чужого» проходил бы
// по причине, не имеющей отношения к делу.
let dbCalls = [];
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
  users: [DOCTOR_A, DOCTOR_B, DOCTOR_FIX],
  visits: VISIT_ROWS,
  visit_services: VS_ROWS,
  invoice_items: ITEM_ROWS,
  invoices: INVOICE_ROWS,
  recommended_services: [],
  admissions: [],
});
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
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

const dash = await import('../views/doctor-dashboard.js');
const { renderConsultation } = await import('../views/consultation.js');
const perms = await import('../permissions.js');
perms.setFullAccess('test');

function loginAs(user) { window.easymed.state.user = user ? { ...user, is_admin: false, is_super_admin: false } : null; }
function reset() { dbCalls = []; tabSubCalls = []; lastHistoryUrl = null; dash.resetDoctorDashboard(); }

// Значения, посчитанные рукой в шапке фикстуры.
const SV1_SHARE = 67680;
const SV3_SHARE = 37600;
const SV5_SHARE = 150000;
const SV6_SHARE = 37600;

// «Услуги» в том виде, в каком их отдаёт загрузчик (скидка уже разнесена).
const A_SERVICES = [
  { visitId: 'v-1', serviceId: 's-1', serviceName: 'Приём терапевта', status: 'completed', total: 200000, discount: 20000, taxRate: 6, invoiceStatus: 'paid' },
  { visitId: 'v-1', serviceId: 's-2', serviceName: 'УЗИ брюшной полости', status: 'queued', total: 100000, discount: 0, taxRate: 0, invoiceStatus: null },
  { visitId: 'v-2', serviceId: 's-1', serviceName: 'Приём терапевта', status: 'completed', total: 100000, discount: 0, taxRate: 6, invoiceStatus: 'unpaid' },
  { visitId: 'v-3', serviceId: 's-2', serviceName: 'УЗИ брюшной полости', status: 'queued', total: 50000, discount: 0, taxRate: 0, invoiceStatus: null },
  { visitId: 'v-5', serviceId: 's-2', serviceName: 'УЗИ брюшной полости', status: 'completed', total: 300000, discount: 0, taxRate: 0, invoiceStatus: null },
  { visitId: 'v-6', serviceId: 's-1', serviceName: 'Приём терапевта', status: 'completed', total: 100000, discount: 0, taxRate: 6, invoiceStatus: null },
];
const A_VISITS = VISIT_ROWS.filter((v) => v.doctor_id === 'u-doc-a').map((v) => ({
  id: v.id, at: v.visit_date, status: v.status, patientId: v.patient_id,
  patientName: [v.patients.last_name, v.patients.first_name].join(' '),
  mrn: v.patients.mrn, dob: v.patients.date_of_birth,
  serviceName: v.services.name, room: v.rooms ? v.rooms.name : '',
}));

// ===========================================================================
test('доля врача считается по формуле отчёта: база − скидка счёта, минус налог, × процент', () => {
  const rateMap = dash.serviceRateMap(DOCTOR_A);
  // sv1: (200 000 − 20 000) × 0,94 × 0,40
  assert.strictEqual(Math.round(dash.serviceShare(A_SERVICES[0], rateMap)), SV1_SHARE);
  // sv3: 100 000 × 0,94 × 0,40
  assert.strictEqual(Math.round(dash.serviceShare(A_SERVICES[2], rateMap)), SV3_SHARE);
  // sv5: услуга без налога → скидки и налога нет вовсе
  assert.strictEqual(Math.round(dash.serviceShare(A_SERVICES[4], rateMap)), SV5_SHARE);
  // Услуга, которой нет в ставках врача, доли НЕ приносит — и это не ноль
  // «по умолчанию», а «ставки нет»: выдумывать процент нельзя.
  assert.strictEqual(dash.serviceShare({ serviceId: 's-99', total: 500000, discount: 0, taxRate: 6 }, rateMap), 0);
  // Разнос скидки счёта — та же пропорция, что ITEM_DISCOUNT_SQL.
  const disc = dash.prorateInvoiceDiscounts(ITEM_ROWS, INVOICE_ROWS);
  assert.strictEqual(disc.get('ii-1'), 20000);
  assert.strictEqual(disc.get('ii-2'), 0);
});

test('каждая цифра дашборда сходится с ручным счётом по посеянным данным', () => {
  const stats = dash.computeDoctorStats({
    visits: A_VISITS, services: A_SERVICES,
    rateMap: dash.serviceRateMap(DOCTOR_A), now: NOW, perService: true,
  });
  assert.strictEqual(stats.todayVisits, 4, 'четыре сегодняшних приёма: 08:15, 09:00, 09:30, 14:00');
  assert.strictEqual(stats.todayPatients, 3, 'пациентов трое — p-1 записан дважды');
  assert.strictEqual(stats.todayArrived, 1, 'пришёл и ещё ждёт только v-1 (у него услуга в очереди)');
  assert.strictEqual(stats.todayServices, 4, 'услуг сегодняшних приёмов — четыре');
  assert.strictEqual(stats.todayCompleted, 2, 'завершены sv1 и sv3');
  assert.strictEqual(stats.todayEarned, SV1_SHARE + SV3_SHARE, '67 680 + 37 600 = 105 280');
  assert.strictEqual(stats.todayEarned, 105280);
  assert.strictEqual(stats.todayPaid, SV1_SHARE, 'из них в кассе только счёт inv-1');

  assert.strictEqual(stats.week.services, 3, '30 августа – 5 сентября: sv1, sv3, sv5');
  assert.strictEqual(stats.week.earned, SV1_SHARE + SV3_SHARE + SV5_SHARE);
  assert.strictEqual(stats.week.earned, 255280);
  assert.strictEqual(stats.prevWeek.services, 1, '23–29 августа: только sv6');
  assert.strictEqual(stats.prevWeek.earned, SV6_SHARE);
  assert.strictEqual(stats.deltaServices, 2);
  assert.strictEqual(stats.deltaEarnedPct, Math.round((255280 - 37600) * 100 / 37600));
  assert.strictEqual(stats.deltaEarnedPct, 579);

  assert.strictEqual(stats.series.length, 14, 'окно ровно 14 дней');
  assert.strictEqual(stats.series[13].day, '2026-09-05');
  assert.strictEqual(stats.series[13].isToday, true);
  assert.deepStrictEqual(
    { s: stats.series[13].services, e: stats.series[13].earned }, { s: 2, e: 105280 }, 'сегодня');
  assert.deepStrictEqual(
    { s: stats.series[12].services, e: stats.series[12].earned }, { s: 1, e: 150000 }, 'вчера');
  assert.strictEqual(stats.series[4].day, '2026-08-27');
  assert.deepStrictEqual(
    { s: stats.series[4].services, e: stats.series[4].earned }, { s: 1, e: 37600 }, '27 августа');
  const quiet = stats.series.filter((d) => d.services === 0).length;
  assert.strictEqual(quiet, 11, 'одиннадцать дней без завершённых услуг — и они честные нули');

  assert.deepStrictEqual(stats.topServices, [
    { name: 'Приём терапевта', count: 3, share: 75 },
    { name: 'УЗИ брюшной полости', count: 1, share: 25 },
  ]);
});

test('фиксированный оклад: дневного заработка НЕТ, и ноль вместо него не рисуется', () => {
  assert.strictEqual(dash.perServicePayApplies(DOCTOR_FIX), false);
  assert.strictEqual(dash.perServicePayApplies(DOCTOR_A), true);
  // «фикс + KPI» без сервисного KPI переменной с услуг не даёт…
  assert.strictEqual(dash.perServicePayApplies(
    { salary_type: 'fix_plus_kpi', kpi_links: ['referrals'] }), false);
  // …а с отмеченным «Услуги» — даёт.
  assert.strictEqual(dash.perServicePayApplies(
    { salary_type: 'fix_plus_kpi', kpi_links: ['referrals', 'services'] }), true);

  const stats = dash.computeDoctorStats({
    visits: A_VISITS, services: A_SERVICES,
    rateMap: dash.serviceRateMap(DOCTOR_FIX), now: NOW, perService: false,
  });
  assert.strictEqual(stats.todayEarned, 0, 'считать нечего…');
  assert.strictEqual(stats.todayCompleted, 2, '…но работа за день посчитана та же');
});

test('колонка дня — сегодняшние приёмы по времени, с возрастом, услугой и «пришёл»', () => {
  const day = dash.buildDayColumn({ visits: A_VISITS, services: A_SERVICES, now: NOW });
  assert.deepStrictEqual(day.rows.map((r) => r.time), ['08:15', '09:00', '09:30', '14:00'],
    'строго по времени приёма, а не по порядку в базе');
  assert.deepStrictEqual(day.rows.map((r) => r.id), ['v-4', 'v-1', 'v-2', 'v-3']);
  assert.deepStrictEqual(day.rows.map((r) => r.patientName),
    ['Тошев Жасур', 'Иванов Пётр', 'Саидова Нилуфар', 'Иванов Пётр']);
  assert.deepStrictEqual(day.rows.map((r) => r.age), [null, 36, 24, 36],
    'возраст на 5 сентября; у Саидовой день рождения 6-го — ещё 24, а не 25');
  assert.deepStrictEqual(day.rows.map((r) => r.arrived), [false, true, false, false]);
  assert.deepStrictEqual(day.rows.map((r) => r.past), [true, true, true, false]);
  assert.strictEqual(day.nowAt, 3, 'черта «сейчас» стоит перед приёмом на 14:00');
  assert.deepStrictEqual(day.rows.map(dash.dayStateLabel),
    ['Не пришёл', 'Пришёл, ждёт', 'Приём завершён', 'Подтверждён']);
  assert.strictEqual(day.rows[1].mrn, 'MRN-001');
  assert.strictEqual(day.rows[1].serviceName, 'Приём терапевта');
  assert.strictEqual(day.rows[1].room, '204');

  // Приём, у которого ВСЕ услуги завершены, называется завершённым, даже если
  // статус визита остался «пришёл»: осмотр важнее записи.
  const done = dash.buildDayColumn({
    visits: [A_VISITS[1]],
    services: [{ ...A_SERVICES[0] }, { ...A_SERVICES[1], status: 'completed' }],
    now: NOW,
  });
  assert.strictEqual(done.rows[0].done, true);
  assert.strictEqual(dash.dayStateLabel(done.rows[0]), 'Приём завершён');
});

test('врач не может прочитать чужой заработок: у загрузчика нет аргумента врача', async () => {
  reset();
  loginAs(DOCTOR_A);
  assert.strictEqual(dash.dashboardDoctorId.length, 0,
    'идентичность не параметризуется — параметра просто нет');
  assert.strictEqual(dash.loadDoctorDashboard.length, 0,
    'у загрузчика тоже нет параметра, подменять нечего');

  // Лишний аргумент передаётся НАМЕРЕННО: так выглядела бы попытка подмены.
  await dash.loadDoctorDashboard('u-doc-b');

  const scoped = dbCalls.filter((c) => ['users', 'visits', 'visit_services'].includes(c.table));
  assert.ok(scoped.length >= 3, 'запрошены карточка врача, приёмы и услуги: ' + scoped.map((c) => c.table).join(','));
  for (const c of scoped) {
    const own = (c.filters || []).some((f) => (f.col === 'doctor_id' || f.col === 'id')
      && f.op === 'eq' && f.val === 'u-doc-a');
    assert.ok(own, 'запрос к ' + c.table + ' не сужен на своего врача: ' + JSON.stringify(c.filters));
  }
  const leaked = JSON.stringify(dbCalls).includes('u-doc-b');
  assert.strictEqual(leaked, false, 'ни один запрос не назвал чужого врача');

  const host = mk('div');
  await dash.renderDoctorDashboard(host, {});
  const txt = textOf(host);
  assert.ok(txt.includes((105280).toLocaleString('ru-RU')), 'свой заработок за день на месте: ' + txt.slice(0, 400));
  assert.ok(!txt.includes('Юсупов'), 'чужого врача на экране нет');
  assert.ok(!txt.includes((376000).toLocaleString('ru-RU')), 'чужих денег на экране нет');

  // Тот же файл, другой вошедший пользователь → другой фильтр и другие деньги.
  reset();
  loginAs(DOCTOR_B);
  const hostB = mk('div');
  await dash.renderDoctorDashboard(hostB, {});
  const scopedB = dbCalls.filter((c) => ['users', 'visits', 'visit_services'].includes(c.table));
  for (const c of scopedB) {
    const own = (c.filters || []).some((f) => (f.col === 'doctor_id' || f.col === 'id')
      && f.op === 'eq' && f.val === 'u-doc-b');
    assert.ok(own, 'после смены пользователя запрос к ' + c.table + ' обязан сузиться на него');
  }
  const txtB = textOf(hostB);
  // Врач B: 400 000 × 0,94 × 0,10 = 37 600.
  assert.ok(txtB.includes((37600).toLocaleString('ru-RU')), 'B видит СВОИ 37 600: ' + txtB.slice(0, 300));
  assert.ok(!txtB.includes((105280).toLocaleString('ru-RU')), 'денег врача A у B нет');
});

test('дашборд рисует день, четыре плитки, график и колонку приёмов из живой загрузки', async () => {
  reset();
  loginAs(DOCTOR_A);
  const host = mk('div');
  await dash.renderDoctorDashboard(host, {});
  const txt = textOf(host);

  assert.ok(txt.includes('Каримова Азиза'), 'обращение — это имя врача, а не «Доброе утро»');
  assert.ok(!/Доброе утро|Добрый день|Добрый вечер/.test(txt), 'приветственная полоса не вернулась');
  assert.ok(txt.includes('Терапевт'), 'специальность');

  assert.ok(txt.includes('Приёмов сегодня') && txt.includes('4'), 'приёмы за день');
  assert.ok(txt.includes('Заработано сегодня'), 'деньги за день');
  assert.ok(txt.includes('Услуг завершено'), 'выполненные услуги');
  assert.ok(txt.includes('Завершено 2 из 4 сегодняшних услуг'), 'статистика дня словами: ' + txt.slice(0, 500));

  assert.strictEqual(byClass(host, 'dd-stat').length, 4, 'ровно четыре маленькие плитки');
  assert.strictEqual(byClass(host, 'dd-col').length, 14, 'график — четырнадцать дневных столбцов');
  assert.ok(txt.includes('Частые услуги за 14 дней') && txt.includes('Приём терапевта'));

  const appts = byClass(host, 'dd-appt');
  assert.strictEqual(appts.length, 4, 'в колонке дня — четыре сегодняшних приёма');
  assert.deepStrictEqual(appts.map((a) => textOf(a).trim().split(/\s+/)[0]),
    ['08:15', '09:00', '09:30', '14:00'], 'по времени');
  assert.ok(textOf(appts[1]).includes('Иванов Пётр'));
  assert.ok(textOf(appts[1]).includes('36 г.'), 'возраст рядом с именем');
  assert.ok(textOf(appts[1]).includes('MRN-001'));
  assert.ok(textOf(appts[1]).includes('Пришёл, ждёт'), 'состояние «пришёл» видно');
  assert.strictEqual(byClass(host, 'dd-nowline').length, 1, 'одна черта «сейчас»');

  // Переключатель графика — обе стороны считаются из тех же данных.
  const earnBtn = buttonByText(host, /Заработок/);
  assert.ok(earnBtn, 'переключатель Услуги | Заработок');
  earnBtn.click();
  assert.strictEqual(byClass(host, 'dd-col').length, 14, 'после переключения график остаётся на месте');
});

test('пустой день (08:00, записей ещё нет) говорит словами, а не пустотой', async () => {
  reset();
  loginAs({ ...DOCTOR_A, id: 'u-doc-empty', full_name: 'Пустой День' });
  // Врача с таким id в посеве нет — значит нет ни приёмов, ни услуг, ни ставок.
  const host = mk('div');
  await dash.renderDoctorDashboard(host, {});
  const txt = textOf(host);
  assert.ok(txt.includes('На сегодня записей нет'), 'колонка дня объясняет пустоту');
  assert.ok(txt.includes('Как только регистратура запишет пациента'), 'и говорит, что будет дальше');
  assert.ok(txt.includes('приёмов: 0'));
  assert.strictEqual(byClass(host, 'dd-appt').length, 0);
  assert.strictEqual(byClass(host, 'dd-col').length, 14, 'график на месте, все столбцы нулевые');
  assert.ok(txt.includes('За две недели завершённых услуг нет'), 'частоту не выдумываем');
});

test('кабинет ОТКРЫВАЕТСЯ дашбордом, рабочий список — в один щелчок и по своему адресу', async () => {
  reset();
  loginAs(DOCTOR_A);
  const root = mk('div');
  await renderConsultation(root, { tabId: 'consultation', payload: null });
  await tick();

  const dashTab = buttonByText(root, /Дашборд/);
  const workTab = buttonByText(root, /Мои приёмы/);
  assert.ok(dashTab && workTab, 'обе вкладки в шапке');
  assert.strictEqual(dashTab.attrs['aria-pressed'], 'true', 'по умолчанию открыт дашборд');
  assert.strictEqual(workTab.attrs['aria-pressed'], 'false');
  assert.ok(textOf(root).includes('Мой день'), 'дашборд действительно нарисован');

  workTab.click();
  await tick(60);
  assert.strictEqual(lastHistoryUrl, '#consultation/work', 'адрес называет открытую вкладку');
  assert.deepStrictEqual(tabSubCalls.at(-1), ['consultation', 'work'],
    'оболочке сообщено, иначе navigate() перепишет хеш обратно');
  const workText = textOf(root);
  assert.ok(workText.includes('Показано'), 'рабочий список открыт: ' + workText.slice(0, 300));
  assert.ok(workText.includes('Иванов Пётр'), 'и в нём настоящие строки очереди');
  assert.ok(workText.includes('Сегодня') && workText.includes('Неделя'),
    'фильтр периода очереди никуда не делся');

  // Возврат на дашборд обнуляет хвост адреса — кабинет открывается им.
  buttonByText(root, /Дашборд/).click();
  await tick();
  assert.strictEqual(lastHistoryUrl, '#consultation');
  assert.deepStrictEqual(tabSubCalls.at(-1), ['consultation', null]);
});

test('#consultation/work переживает перезагрузку: адрес открывает рабочий список сразу', async () => {
  reset();
  loginAs(DOCTOR_A);
  const root = mk('div');
  // Ровно то, что делает оболочка после F5 на '#consultation/work'.
  await renderConsultation(root, { tabId: 'consultation', payload: { sub: 'work' } });
  await tick(60);
  const txt = textOf(root);
  assert.ok(txt.includes('Показано'), 'открыт рабочий список, а не дашборд');
  assert.ok(!txt.includes('Мой день'), 'дашборд не подменяет адрес');
  assert.strictEqual(buttonByText(root, /Мои приёмы/).attrs['aria-pressed'], 'true');

  // …и «Зарплата» — старый дашборд кабинета — тоже на месте и адресуема.
  reset();
  const root2 = mk('div');
  await renderConsultation(root2, { tabId: 'consultation', payload: { sub: 'pay' } });
  await tick(60);
  assert.strictEqual(buttonByText(root2, /Зарплата/).attrs['aria-pressed'], 'true',
    'ни одна прежняя возможность кабинета не потеряна');
  const payText = textOf(root2);
  // Адрес обязан не только ОТКРЫТЬ вкладку, но и ЗАГРУЗИТЬ её: ленивая
  // подгрузка, висящая только на кнопке, дала бы пустой экран по ссылке.
  assert.ok(payText.includes('Каримова Азиза'), 'зарплата загрузилась по адресу: ' + payText.slice(0, 300));
  assert.ok(/Salary details|Referral rewards|7 дней/.test(payText), 'разбор начислений на месте');
});
