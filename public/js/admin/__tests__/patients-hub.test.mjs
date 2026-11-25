// PATIENTS_HUB_V1 (2026-09-05) — «Пациенты» тремя вкладками: список · очередь ·
// записи (docs/plans/2026-09-05-ui-redesign-and-calendar.md, задача 4).
//
// Что здесь действительно проверяется — по одному предложению на решение:
//
//   * КАЖДАЯ вкладка монтируется и показывает СВОЁ содержимое, а не пустоту:
//     список пациентов, живую доску очереди и календарь записи;
//   * ПОДМАРШРУТ переживает перезагрузку и ссылку: '#patients/queue' и
//     '#patients/calendar' открывают свою вкладку, а переключение вкладки
//     пишется через replaceState (не pushState — вкладка не новое место для
//     кнопки «Назад») и сообщается оболочке через easymedSetTabSub, иначе
//     следующий navigate() в раздел перепишет хеш из payload панели;
//   * ОПРОС ОЧЕРЕДИ живёт ровно столько, сколько её видно: уход на соседнюю
//     вкладку снимает таймер, возврат заводит его снова. Проверяется по САМОМУ
//     таймеру, а не по паузе в тесте;
//   * РЕГИСТРАТУРА видит все три вкладки — та самая роль, ради которой раздел
//     и собран; ключ `appointments` не значится ни в одной настроенной роли,
//     поэтому календарь едет с ключом `patients` (permissions.js);
//   * ОТДЕЛЬНЫЙ МАРШРУТ #queue цел — он и пункт меню, и адрес для роли, у
//     которой есть доска, но нет картотеки;
//   * доска НЕ МОНТИРУЕТСЯ ДВАЖДЫ: у queue.js модульные синглтоны, и второе
//     монтирование в тот же контейнер молча увело бы обновление у первого;
//   * ЗАВЕСТИ ПАЦИЕНТА по-прежнему можно с первой вкладки, и подсказка
//     онбординга целится в живую кнопку, а не в удалённую призывную кнопку меню;
//   * вкладка «Записи» монтируется ДАЖЕ ЕСЛИ календаря нет: параллельно с этой
//     работой его переписывают (задача 5), и его поломка обязана остаться в
//     одной вкладке, а не уронить весь раздел.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// Fake-DOM harness — copied from __tests__/lab-panels-mode.test.mjs (itself
// from telephony-settings / system-view): these views render Icon() calls,
// which go through ui.js's html() -> a <template> parse.
// ---------------------------------------------------------------------------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,target:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} scrollIntoView(){} remove(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 getBoundingClientRect(){return {top:0,left:0,width:0,height:0,bottom:0,right:0};}
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
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;},querySelector(){return null;},querySelectorAll(){return [];}};

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — i18n.js picks its language ONCE, at module load, from
// this store, so pin it BEFORE the view imports below.
fakeLocalStorage.setItem('admin.lang', 'ru');

// HASH_SUBROUTE_V1 — the shell hook the host reports its tab to. Recorded, not
// stubbed away: the deep link IS the feature.
let tabSubCalls = [];
globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: fakeLocalStorage,
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo(){}, scrollY: 0,
  easymed: { state: { user: { id: 'u-1', full_name: 'Регистратор', company_id: 'c-1', role: 'registrar' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => true,
  easymedSetTabSub: (tabId, sub) => { tabSubCalls.push([tabId, sub]); },
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
// MOTION_REVEAL_ONCE_V1 — без IntersectionObserver помощник появления вообще
// не прячет содержимое (motion.js честно уходит в «видно сразу»), и мигание,
// которое мы ловим, невозможно ВОСПРОИЗВЕСТИ. Поэтому наблюдатель здесь есть —
// поддельный, но настоящий по счёту: revealOn заводит РОВНО ОДИН на вызов, так
// что число заведённых наблюдателей и есть число проигранных появлений.
let observersMade = 0;
globalThis.IntersectionObserver = class { constructor() { observersMade++; } observe(){} unobserve(){} disconnect(){} };
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.cancelAnimationFrame=()=>{};

// history is absent in Node. The tab writes the URL through it, so record the
// writes rather than stub them away.
let lastHistoryUrl = null;
let pushes = 0, replaces = 0;
globalThis.history = {
  state: null,
  replaceState(st, _title, url) { this.state = st; lastHistoryUrl = url; replaces++; },
  pushState(st, _title, url) { this.state = st; lastHistoryUrl = url; pushes++; },
};

// ---------------------------------------------------------------------------
// Timers. The queue poll is the thing under test in the lifecycle case, so it
// is observed at the TIMER, not by sleeping and hoping. 10 000 ms is the
// board's interval (queue.js POLL_MS) and nothing else in scope uses it.
// ---------------------------------------------------------------------------
const liveIntervals = new Map();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const intervalFns = new Map();   // WAIT_REG_V1 (ревью M6) — тело минутного опроса, чтобы позвать его без ожидания
globalThis.setInterval = (fn, ms, ...rest) => { const id = realSetInterval(fn, ms, ...rest); liveIntervals.set(id, ms); intervalFns.set(id, fn); return id; };
globalThis.clearInterval = (id) => { liveIntervals.delete(id); return realClearInterval(id); };
const queuePolls = () => [...liveIntervals.values()].filter((ms) => ms === 10000).length;

// --- fake transport --------------------------------------------------------
const PATIENTS = [
  { id: 'p-1', company_id: 'c-1', full_name: 'Эргашев Жахонгир', first_name: 'Жахонгир', last_name: 'Эргашев',
    mrn: 'MRN-1', phone: '+998901112233', date_of_birth: '1990-04-01', gender: 'male', registration_date: '2026-09-01' },
];
const BOARD = {
  groups: [{
    kind: 'doctor', label: 'Пулатов А.', waiting_count: 2, unpaid_count: 1, done_count: 3, now: [7],
    tickets: [
      { number: 7, patient_name: 'Эргашев Жахонгир', services: ['Консультация'], state: 'serving' },
      { number: 8, patient_name: 'Каримова Азиза',   services: ['Консультация'], state: 'unpaid'  },
    ],
  }],
};
let rpcCalls = [];
let rpcArgs = [];   // BOOKING_DAY_V1 — с какими аргументами звали RPC
let AGGS = null;   // V3120_FIX — ответ patient_base_aggregates
let WAITING = null;   // WAIT_REG_V1 — ответ registrar_waiting («Ждут регистрации»)
// BOOKING_DAY_V1 — врачи, виды консультаций и день врача (calendar_slots).
const DOCTORS = [
  { id: 7, full_name: 'Алиева Нигора', specialty: 'Терапевт', role: 'doctor', is_doctor: 1,
    service_rates: JSON.stringify([{ service_id: 21, pct: 20 }, { service_id: 22, pct: 20 }]) },   // BOOKING_DAY_SERVICE_V1 — услуги врача
  { id: 8, full_name: 'Каримов Бахтиёр', specialty: 'Кардиолог', role: 'doctor', is_doctor: 1 },
  { id: 9, full_name: 'Регистратор Анна', specialty: '', role: 'registrar', is_doctor: 0 },
];
const CTYPES = [{ id: 3, name: 'Первичная консультация', price: 100000, active: 1 }];
// BOOKING_DAY_CANCEL_V1 — визиты записей дня (время до секунды берётся отсюда).
const VISITS = [
  { id: 101, visit_date: '2026-11-13T04:00:00.000Z', status: 'confirmed' },
  { id: 102, visit_date: '2026-11-13T05:00:00.000Z', status: 'arrived' },
];
// BOOKING_DAY_SERVICE_V1 — каталог: две услуги врача 7 и чужая.
const SERVICES = [
  { id: 21, name: 'Консультация терапевта', duration_minutes: 20, price: 90000, active: 1 },
  { id: 22, name: 'ЭКГ', duration_minutes: 0, price: 60000, active: 1 },
  { id: 23, name: 'МРТ головы', duration_minutes: 45, price: 900000, active: 1 },
];
// BOOKING_DAY_DETAIL_V1 — услуги записей дня (visit_services с именем услуги).
const VISIT_LINES = [
  { visit_id: 101, status: 'added', services: { name: 'УЗИ брюшной полости' }, consultation_types: null },
  { visit_id: 101, status: 'added', services: { name: 'Общий анализ крови' }, consultation_types: null },
  { visit_id: 101, status: 'cancelled', services: { name: 'Отменённая услуга' }, consultation_types: null },
  { visit_id: 102, status: 'added', services: null, consultation_types: { name: 'Первичная консультация' } },
];
const DAY = {
  date: 'x', duration_minutes: 30, window: { from: '09:00', to: '12:00', breaks: [{ from: '10:30', to: '11:00' }] },
  slots: [{ start: '09:30', end: '10:00', start_iso: '2026-11-13T04:30:00.000Z' }, { start: '11:00', end: '11:30', start_iso: '2026-11-13T06:00:00.000Z' }, { start: '11:30', end: '12:00', start_iso: '2026-11-13T06:30:00.000Z' }],
  busy: [
    { visit_id: 101, from: '09:00', to: '09:30', from_min: 540, status: 'confirmed', patient_id: 'p-1', patient_name: 'Эргашев Жахонгир' },
    { visit_id: 102, from: '10:00', to: '10:30', from_min: 600, status: 'arrived', patient_id: 'p-2', patient_name: 'Юсупова Дилноза' },
  ],
};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push(name);
    rpcArgs.push([name, body]);
    if (name === 'calendar_slots') return ok({ data: { ...JSON.parse(JSON.stringify(DAY)), date: body && body.date } });
    if (name === 'queue_board') return ok({ data: JSON.parse(JSON.stringify(BOARD)) });
    // PATIENT_SORT_DROPDOWN_V1 — по умолчанию список сортируется по последнему визиту: страницу отдаёт сервер.
    if (name === 'patient_list_page') return ok({ data: { rows: JSON.parse(JSON.stringify(PATIENTS)), total: PATIENTS.length } });
    // PATIENT_BOT_INVITE_V1 — кто из страницы подключён к боту пациента.
    if (name === 'patient_bot_status') return ok({ data: { bot: true, sms_ready: false, linked: ['p-1'] } });
    // V3120_FIX — сводка реестра: депозит и долг раздельно (rpc/patient-aggregates.js).
    if (name === 'patient_base_aggregates') return ok({ data: AGGS });
    if (name === 'registrar_waiting') return ok({ data: WAITING ? JSON.parse(JSON.stringify(WAITING)) : null });   // WAIT_REG_V1
    // V3120_FIX — настоящая форма ответа сервера (rpc/telegram.js telegramChatsList).
    if (name === 'telegram_chats_list') return ok({ data: { chats: [{ chat_id: '1', phone: '+998901112233', patients: [{ id: 'p-1', name: 'Эргашев Жахонгир' }] }], unread: 0, folders: [] } });
    return ok({ data: null });
  }
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    const op = (body && body.op) || 'select';
    // BOOKING_DAY_V1 — врачи и виды консультаций для «Бронирования».
    const rows = { patients: PATIENTS, users: DOCTORS, consultation_types: CTYPES, visit_services: VISIT_LINES, services: SERVICES, visits: VISITS }[table] || [];
    return ok({ data: op === 'select' ? JSON.parse(JSON.stringify(rows)) : null, count: rows.length });
  }
  return ok({ data: null });
};

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const { renderPatientsHub, mountCalendarInto } = await import('../views/patients-hub.js');
const { railToolsFor } = await import('../rail-tools.js');   // PATIENTS_RAIL_V1
const { openPatientCreateModal } = await import('../views/patient-create-modal.js?v=onewin1');
const { renderQueue, stopQueuePolling } = await import('../views/queue.js?v=q7');
const perms = await import('../permissions.js');
const { setFullAccess, setEffectiveFromRole, isModuleAllowed, isRouteAllowed, canCreatePatient } = perms;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
// PATIENTS_RAIL_V1 — кнопки вкладок живут в левой колонке: экран отдаёт их через
// rail-tools.js, и тест берёт их оттуда же (тот же экземпляр модуля, что у экрана).
const railButtons = () => ((railToolsFor('patients') || (() => []))() || []).flat().filter((n) => n && n.tagName === 'BUTTON');
// DUP_TO_RAIL_V1 — в колонке под вкладками ещё и «Дубликаты» (своей группой); вкладки — без неё.
const tabButtons = () => railButtons().filter((n) => !('data-rail-dup' in n.attrs));
// WAIT_REG_V1 (ревью) — у регистратуры «Записи CRM» первой: вкладки ищутся по имени, а не по месту.
const byTab = () => Object.fromEntries(tabButtons().map((b) => [b.attrs['data-tab'], b]));
// REFERRALS_TAB_V1 — запрос не счётчика «Направлений врача» (его источник — 'doctor').
const notRef = (b) => !(b && Array.isArray(b.sources) && b.sources.length === 1 && b.sources[0] === 'doctor');
const tabLabel = (b) => walk(b).filter((n) => n.tagName !== 'SVG' && !(n.attrs && n.attrs['data-tab-badge'])).map((n) => n._t || '').join('').trim();
const panelFor = (root, id) => walk(root).find((n) => n.attrs['data-tab-panel'] === id);
const visiblePanels = (root) => walk(root).filter((n) => n.attrs['data-tab-panel'] && n.style.display !== 'none');
const boards = (root) => walk(root).filter((n) => 'data-queue-board' in n.attrs);

// The registrar as the clinic actually configures her (migration 055 seeds
// patients + registration + crm; `appointments` is not a grantable key and
// never was — that is the whole point of the permissions decision under test).
const REGISTRAR = { name: 'registrar', permissions: {
  // V3120_FIX — `queue` в наборе: доску сервер отдаёт только по этому ключу
  // (rpc/queue.js), и вкладка «Очередь» теперь видна по тому же правилу.
  sections: ['patients', 'registration', 'crm', 'cashier', 'dashboard', 'queue'],
  levels: { patients: 'editor', registration: 'editor', crm: 'editor', cashier: 'editor', dashboard: 'viewer' },
} };

function ctxFor(payload = null, navigated = []) {
  return { onNavigate: (v) => navigated.push(v), payload, tabId: 'patients' };
}

function reset() {
  tabSubCalls = []; rpcCalls = []; lastHistoryUrl = null; pushes = 0; replaces = 0;
  observersMade = 0;
  // Окна живут в document.body и в этом поддельном дереве сами не уходят
  // (F.remove() — заглушка), поэтому счёт окон обнуляется здесь.
  document.body.children.length = 0;
  stopQueuePolling();
  setFullAccess('Admin');
}
const openDialogs = (name) => walk(document.body).filter((n) => n.attrs && n.attrs['data-dialog'] === name);

// ===========================================================================
test('каждая вкладка показывает СВОЁ: список пациентов, доска очереди, календарь', async () => {
  reset();
  const box = mk('div');
  const calls = [];
  const stubCalendar = async () => async (host, opts) => {
    calls.push(opts);
    host.appendChild(mk('div')).textContent = 'Сетка календаря';
  };
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: stubCalendar });

  const btns = byTab(box);
  // BOOKING_TAB_REMOVED_V1 — «Бронирования» нет.
  // WAIT_REG_V1 — пятая, у стойки: «Записи CRM» (CRM_BOOKINGS_TAB_V1). Права здесь — полные (администратор):
  // «Пациенты» первыми; у регистратуры «Записи CRM» первой (ревью, тест ниже).
  assert.deepEqual(tabButtons(box).map(tabLabel), ['Пациенты', 'Очередь', 'Записи', 'Записи CRM', 'Направления врача'], 'полоса вкладок не та');
  assert.equal(hub.activeTab(), 'list', 'по умолчанию открывается не список');
  assert.equal(visiblePanels(box).length, 1, 'видна не ровно одна вкладка');

  // 1. Список — фамилия из картотеки и кнопка создания.
  assert.ok(textOf(panelFor(box, 'list')).includes('Эргашев Жахонгир'), 'на вкладке «Список» нет пациента');

  // 2. Очередь — живая доска: номер, имя, состояние талона.
  btns.queue.click(); await tick();
  assert.equal(hub.activeTab(), 'queue');
  const q = textOf(panelFor(box, 'queue'));
  assert.ok(q.includes('Пулатов А.'), 'на доске нет назначения');
  assert.ok(q.includes('принимают') && q.includes('ожидает оплату'),
    'доска потеряла состояния талонов — она про то, кто ждёт и кто оплатил');
  assert.ok(rpcCalls.includes('queue_board'), 'доска не спросила queue_board');
  // Внутри раздела заголовок «Очередь» не повторяется — его несёт верхняя панель.
  assert.equal(walk(panelFor(box, 'queue')).filter((n) => hasClass(n, 'page-head')).length, 0,
    'встроенная доска всё ещё рисует собственную шапку раздела');

  // 3. Записи — календарь, встроенным (свою полосу вкладок он не рисует).
  btns.calendar.click(); await tick();
  assert.equal(hub.activeTab(), 'calendar');
  assert.ok(textOf(panelFor(box, 'calendar')).includes('Сетка календаря'), 'вкладка «Записи» пуста');
  assert.deepEqual(calls.map((o) => o.embedded), [true], 'календарь смонтирован не встроенным');

  hub.destroy();
});

// PATIENTS_RAIL_V1 — вкладки стали пунктами левой колонки: каждая в порядке обхода
// Tab (настоящие <button>), выбранная помечена aria-current, ровно одна.
test('кнопки раздела в колонке: каждая доступна с клавиатуры, выбранная помечена', async () => {
  reset();
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
  const btns = tabButtons(box);
  assert.ok(btns.every((b) => b.tagName === 'BUTTON' && b.attrs.tabindex !== '-1'), 'кнопка выпала из обхода Tab');
  assert.equal(walk(box).filter((n) => n.attrs && n.attrs.role === 'tab').length, 0, 'в экране снова полоса вкладок');
  const current = () => tabButtons(box).map((b) => b.attrs['aria-current'] || null);
  assert.deepEqual(current(), ['page', null, null, null, null]);
  btns[2].click(); await tick();
  assert.equal(hub.activeTab(), 'calendar');
  assert.deepEqual(current(), [null, null, 'page', null, null]);
  assert.ok(hasClass(btns[2], 'active') && !hasClass(btns[0], 'active'), 'выделена не та кнопка');
  btns[3].click(); await tick();
  assert.equal(hub.activeTab(), 'waiting');   // WAIT_REG_V1
  assert.deepEqual(current(), [null, null, null, 'page', null]);
  hub.destroy();
});

// WAIT_REG_V1 (ревью, решение владельца) — РЕГИСТРАТУРЕ «Записи CRM» первой и открытой по умолчанию;
// «Пациенты» пишутся в адрес явно (#patients/list). Администратору (и регистратору с ролью
// администратора) — «Пациенты» первыми, как прежде. PATIENTS_RAIL_V1 — кнопки колонки нажимаются,
// стрелок у них больше нет (слияние с local/ai-on-main, 2026-11-23).
test('WAIT_REG_V1 (ревью): регистратуре «Записи CRM» — первой и открытой; адрес — по тому же порядку; администратору — «Пациенты» первыми', async () => {
  const sessionUser = globalThis.window.easymed.state.user;
  try {
    reset();
    globalThis.window.easymed.state.user = { ...sessionUser, role: 'registrar' };
    setEffectiveFromRole(REGISTRAR);
    const box = mk('div');
    const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
    const btns = tabButtons(box);
    assert.deepEqual(btns.map((b) => b.attrs['data-tab']), ['waiting', 'list', 'queue', 'calendar', 'referrals']);
    assert.equal(hub.activeTab(), 'waiting', 'регистратуре по умолчанию открылись не «Записи CRM»');
    assert.deepEqual(btns.map((b) => b.attrs['aria-current'] || null), ['page', null, null, null, null]);
    assert.equal(replaces, 0, 'монтирование переписало адрес');
    btns[1].click(); await tick();
    assert.equal(hub.activeTab(), 'list');
    assert.equal(lastHistoryUrl, '#patients/list', '«Пациенты» у регистратуры не записаны в адрес — F5 увёл бы с них');
    btns[0].click(); await tick();
    assert.equal(hub.activeTab(), 'waiting');
    assert.equal(lastHistoryUrl, '#patients/waiting');
    hub.destroy();
    // Адрес #patients/list — «Пациенты».
    const listed = await renderPatientsHub(mk('div'), ctxFor({ sub: 'list' }), { calendarLoader: async () => async () => {} });
    assert.equal(listed.activeTab(), 'list');
    listed.destroy();

    // Администратор и регистратор с ролью администратора — «Пациенты» первыми и открытыми.
    for (const user of [{ ...sessionUser, role: 'admin' }, { ...sessionUser, role: 'registrar', extra_roles: ['admin'] }]) {
      reset();
      globalThis.window.easymed.state.user = user;
      setEffectiveFromRole(REGISTRAR);
      const b = mk('div');
      const h2 = await renderPatientsHub(b, ctxFor(), { calendarLoader: async () => async () => {} });
      assert.deepEqual(tabButtons(b).map((x) => x.attrs['data-tab']), ['list', 'queue', 'calendar', 'waiting', 'referrals'], JSON.stringify(user));
      assert.equal(h2.activeTab(), 'list');
      h2.destroy();
    }
  } finally {
    globalThis.window.easymed.state.user = sessionUser;
    setFullAccess('Admin');
  }
});

test('вкладка живёт в адресе: подмаршрут переживает перезагрузку и переходит replaceState', async () => {
  reset();
  // Перезагрузка на '#patients/queue': оболочка отдаёт payload.sub — раздел
  // обязан открыться очередью, а не сброситься на список.
  const reloaded = await renderPatientsHub(mk('div'), ctxFor({ sub: 'queue' }), { calendarLoader: async () => async () => {} });
  assert.equal(reloaded.activeTab(), 'queue', 'глубокая ссылка #patients/queue не открыла очередь');
  reloaded.destroy();

  const deep = await renderPatientsHub(mk('div'), ctxFor({ sub: 'calendar' }), { calendarLoader: async () => async () => {} });
  assert.equal(deep.activeTab(), 'calendar', 'глубокая ссылка #patients/calendar не открыла записи');
  deep.destroy();

  // Незнакомый подмаршрут — это не пустой экран: раздел открывается вкладкой по умолчанию — списком
  // (WAIT_REG_V1, ревью — у регистратуры это «Ждут регистрации», тест выше).
  const junk = await renderPatientsHub(mk('div'), ctxFor({ sub: 'нет-такой' }), { calendarLoader: async () => async () => {} });
  assert.equal(junk.activeTab(), 'list');
  junk.destroy();

  // А переключение вкладки — пишет адрес и сообщает о нём оболочке.
  reset();
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
  assert.equal(replaces, 0, 'монтирование не должно переписывать адрес — его уже написал navigate()');

  const btns = byTab(box);
  btns.queue.click(); await tick();
  assert.equal(lastHistoryUrl, '#patients/queue');
  assert.deepEqual(tabSubCalls.at(-1), ['patients', 'queue'], 'оболочке не сообщили о вкладке');
  btns.list.click(); await tick();
  assert.equal(lastHistoryUrl, '#patients', 'возврат на список не очистил подмаршрут');
  assert.deepEqual(tabSubCalls.at(-1), ['patients', null]);
  assert.equal(pushes, 0, 'вкладка попала в историю через pushState — «Назад» перестанет выводить из раздела');
  assert.ok(replaces >= 2);
  hub.destroy();
});

test('опрос очереди живёт ровно столько, сколько её видно', async () => {
  reset();
  assert.equal(queuePolls(), 0, 'до раздела опроса быть не должно');

  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
  const btns = byTab(box);
  // Список открыт — доска ещё не смонтирована, значит и опроса нет.
  assert.equal(queuePolls(), 0, 'спрятанная доска опрашивает базу, хотя её никто не открывал');

  btns.queue.click(); await tick();
  assert.equal(queuePolls(), 1, 'открытая доска не обновляет себя');

  btns.list.click(); await tick();
  assert.equal(queuePolls(), 0, 'ушли с вкладки, а доска продолжает ходить в базу каждые 10 секунд');

  btns.queue.click(); await tick();
  assert.equal(queuePolls(), 1, 'вернулись на вкладку, а доска больше не обновляется');
  const callsAfterReturn = rpcCalls.filter((n) => n === 'queue_board').length;
  assert.ok(callsAfterReturn >= 2, 'возврат на вкладку не перечитал доску — она показывала бы минуты давности');

  btns.calendar.click(); await tick();
  assert.equal(queuePolls(), 0, 'уход на «Записи» не остановил опрос очереди');

  hub.destroy();
  assert.equal(queuePolls(), 0);
});

test('доска не монтируется дважды: возврат на вкладку не заводит вторую', async () => {
  reset();
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
  const btns = byTab(box);
  btns.queue.click(); await tick();
  assert.equal(boards(box).length, 1);
  const firstBoard = boards(box)[0];
  btns.list.click(); await tick();
  btns.queue.click(); await tick();
  btns.list.click(); await tick();
  btns.queue.click(); await tick();
  assert.equal(boards(box).length, 1, 'в контейнере вкладки выросла вторая доска');
  // И это ТА ЖЕ доска: вкладка не пересобирается заново, поэтому день, поиск и
  // прокрутка карточек переживают уход на соседнюю вкладку. Пересборка вместо
  // возобновления — это как раз тот случай, когда доски становится две.
  assert.equal(boards(box)[0], firstBoard, 'вкладку пересобрали заново вместо того, чтобы разбудить');
  assert.equal(queuePolls(), 1, 'у одной доски два таймера — модульные синглтоны разъехались');
  // И два быстрых нажатия подряд тоже не должны развести две доски.
  btns.list.click(); btns.queue.click(); btns.queue.click(); await tick();
  assert.equal(boards(box).length, 1);
  hub.destroy();
});

test('регистратура видит все три вкладки, и календарь ей открыт', async () => {
  reset();
  setEffectiveFromRole(REGISTRAR);
  // Раздел ей вообще доступен...
  assert.equal(isRouteAllowed('patients'), true);
  // ...и вкладка «Записи» — тоже: ключ `appointments` не значится ни в одной
  // настроенной роли, поэтому календарь едет с ключом картотеки.
  assert.equal(isModuleAllowed('appointments'), true, 'регистратура не видит календарь записи');
  assert.equal(isRouteAllowed('appointments'), true, 'отдельный адрес календаря для регистратуры закрыт');

  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
  assert.deepEqual(tabButtons(box).map(tabLabel), ['Записи CRM', 'Пациенты', 'Очередь', 'Записи', 'Направления врача'],   // CRM_BOOKINGS_TAB_V1 — имя вкладки
    'регистратура недосчиталась вкладок');
  hub.destroy();

  // А роль БЕЗ картотеки календарь по-прежнему не открывает — следствие не
  // должно превратиться во всеобщий доступ.
  setEffectiveFromRole({ name: 'lab', permissions: { sections: ['labs'], levels: { labs: 'editor' } } });
  assert.equal(isModuleAllowed('appointments'), false);
  assert.equal(isRouteAllowed('appointments'), false);
  setFullAccess('Admin');
});

test('вкладка «Записи» монтируется, даже когда календарь не загрузился, и НАЗЫВАЕТ причину', async () => {
  reset();
  const host = mk('div');
  const okFalse = await mountCalendarInto(host, ctxFor(), async () => { throw new Error('half-written'); });
  assert.equal(okFalse, false);
  const said = textOf(host);
  assert.ok(said.includes('Календарь записи не открылся'), 'вкладка молчит о том, что экран недоступен');
  assert.ok(said.includes('очередь работают как обычно'), 'не сказано, что остальные вкладки живы');
  // CALENDAR_RETRY_V1 — с одного снимка экрана клиники должно быть видно, ЧТО
  // случилось. «Готовится» читалось как «ещё не написано» и уводило разбор в
  // сторону на неделю.
  assert.ok(said.includes('half-written'), 'причина сбоя не показана — со снимка экрана её не прочитать');

  // И в самом хосте: поломка календаря не уносит список и очередь.
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => { throw new Error('half-written'); } });
  const btns = byTab(box);
  btns.calendar.click(); await tick();
  assert.equal(hub.activeTab(), 'calendar');
  assert.ok(textOf(panelFor(box, 'calendar')).includes('Календарь записи не открылся'));
  btns.list.click(); await tick();
  assert.ok(textOf(panelFor(box, 'list')).includes('Эргашев Жахонгир'), 'список пострадал из-за календаря');
  hub.destroy();
});

test('CALENDAR_RETRY_V1: одна неудачная загрузка не гасит календарь до конца дня', async () => {
  reset();
  // Первая попытка падает (программа ещё поднималась), вторая — удаётся.
  let attempt = 0;
  const loader = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('сеть моргнула');
    return async (host) => { host.appendChild(mk('div')).textContent = 'СЕТКА ЗАПИСИ'; };
  };
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: loader });
  const btns = byTab(box);
  btns.calendar.click(); await tick();
  assert.ok(textOf(panelFor(box, 'calendar')).includes('Календарь записи не открылся'), 'первая попытка должна была упасть');

  // Возврат на вкладку пробует снова — раньше флаг mounted держал заглушку.
  btns.list.click(); await tick();
  btns.calendar.click(); await tick();
  assert.equal(attempt, 2, 'вторая попытка не состоялась — вкладка залипла на заглушке');
  assert.ok(textOf(panelFor(box, 'calendar')).includes('СЕТКА ЗАПИСИ'), 'календарь не поднялся со второй попытки');
  hub.destroy();
});

test('CALENDAR_RETRY_V1: кнопка «Повторить» грузит календарь заново', async () => {
  reset();
  let attempt = 0;
  const loader = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('сеть моргнула');
    return async (host) => { host.appendChild(mk('div')).textContent = 'СЕТКА ЗАПИСИ'; };
  };
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: loader });
  byTab(box).calendar.click(); await tick();
  const panel = panelFor(box, 'calendar');
  const again = walk(panel).filter((n) => n.tagName === 'BUTTON').find((b) => textOf(b).includes('Повторить'));
  assert.ok(again, 'кнопки «Повторить» нет — оператору нечем поднять экран');
  again.click(); await tick(); await tick();
  assert.ok(textOf(panelFor(box, 'calendar')).includes('СЕТКА ЗАПИСИ'), '«Повторить» не подняло календарь');
  hub.destroy();
});

test('договор с календарём: renderRoomCalendar(container, { onNavigate, embedded })', () => {
  const src = read('public/js/admin/views/room-calendar.js');
  assert.ok(/export async function renderRoomCalendar\s*\(\s*container\s*,\s*\{[^}]*embedded/.test(src),
    'календарь сменил подпись — хост «Пациентов» звал бы его вслепую');
  const hub = read('public/js/admin/views/patients-hub.js');
  assert.ok(hub.includes("'./room-calendar.js?v=aug17e'"),
    'хост берёт календарь по другому адресу модуля, чем admin.js — это два экземпляра');
  assert.ok(hub.includes('renderRoomCalendar'), 'хост не проверяет, что модуль отдал именно календарь');
});

test('отдельный маршрут #queue цел — с собственной шапкой раздела', async () => {
  reset();
  const box = mk('div');
  const ctl = await renderQueue(box, {});   // ровно так его зовёт admin.js
  assert.equal(walk(box).filter((n) => hasClass(n, 'page-head')).length, 1,
    'у самостоятельного экрана очереди пропала шапка раздела');
  assert.ok(textOf(box).includes('Пулатов А.'), 'самостоятельная доска пуста');
  ctl.stop(); ctl.destroy();

  const js = read('public/js/admin.js');
  assert.ok(/case 'queue':\s*return void await renderQueue\(/.test(js), 'маршрут #queue пропал из оболочки');
  assert.ok(/case 'appointments':\s*return void await renderRoomCalendar\(/.test(js), 'маршрут #appointments пропал');
  assert.ok(/case 'patients':\s*return void await renderPatientsHub\(/.test(js), 'маршрут «Пациенты» не открывает хост');
  assert.ok(js.includes("{ id: 'queue',    label: 'Очередь'"), 'пункт меню «Очередь» пропал');
});

test('завести пациента можно с первой вкладки, и подсказка целится в живую кнопку', async () => {
  reset();
  const navigated = [];
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(null, navigated), { calendarLoader: async () => async () => {} });
  const createBtn = walk(box).find((n) => n.attrs['data-onb'] === 'create-patient');
  assert.ok(createBtn, 'на вкладке «Список» нет кнопки создания пациента');
  createBtn.click();
  // PATIENT_ONE_WINDOW_V1 (задача 7) — кнопка больше НЕ уводит на страницу
  // регистрации: страницы нет, карта заводится окном ПОВЕРХ этого же списка
  // (views/patient-create-modal.js). Уход с раздела здесь и был бы регрессией.
  assert.deepEqual(navigated, [], 'кнопка увела с раздела вместо того, чтобы открыть окно');
  const dlg = walk(document.body).find((n) => n.attrs && n.attrs['data-dialog'] === 'patient-create');
  assert.ok(dlg, 'кнопка не открыла окно заведения пациента');
  dlg.remove();
  hub.destroy();

  // Подсказка онбординга: цель — та самая кнопка, а не удалённая .sidebar-cta.
  const onb = read('public/js/admin/onboarding.js');
  assert.ok(!/target:\s*\{\s*selector:\s*'\.sidebar-cta'\s*\}/.test(onb),
    'подсказка всё ещё целится в призывную кнопку меню, которой больше нет');
  assert.ok(onb.includes('[data-onb="create-patient"]'), 'подсказка не нашла новую цель');
  assert.ok(onb.includes('Создать пациента</b>'), 'в подсказке осталось старое название кнопки');
});

// ===========================================================================
// PATIENT_CREATE_GATE_V1 (2026-09-05) — заведение пациента снова под правом.
//
// Что здесь восстанавливается. До перекроя все три «Создать пациента» звали
// onNavigate('registration'), и утверждение assert.deepEqual(navigated,
// ['registration']) в ЭТОМ файле было единственным, что стерегло право:
// маршрут гейтила оболочка. PATIENT_ONE_WINDOW_V1 заменил страницу окном,
// утверждение заменили на «открылось окно» — верное про новое поведение и
// НИЧЕГО не говорящее про право. Ключ `registration` выдан только регистратуре
// (миграция 055), сервер подстраховать не может (canWrite() не получает
// подключения к базе) — и медсестра, врач или своя роль с ключом `patients`
// заводили карты беспрепятственно.
//
// Проверяется поведение с ОБЕИХ сторон: роли без ключа отказано с каждого
// входа, роли с ключом — открыто.
// ===========================================================================
const NURSE = { name: 'nurse', permissions: {
  sections: ['patients', 'procedures', 'beds'],
  levels: { patients: 'editor', procedures: 'editor', beds: 'editor' },
} };

test('без права «Регистрация пациента» окно не открывается ни с одного входа списка', async () => {
  reset();
  // V3120_FIX — вошедший тоже медсестра: роль сессии входит в набор ролей
  // (actorRoleCodes), и с регистратором в сессии кнопки были бы законны.
  const sessionUser = globalThis.window.easymed.state.user;
  globalThis.window.easymed.state.user = { ...sessionUser, role: 'nurse' };
  setEffectiveFromRole(NURSE);
  // Роль подобрана верно: раздел «Пациенты» ей открыт (иначе мы проверяли бы
  // маршрутный гейт, а не гейт действия), а ключа регистрации нет.
  assert.strictEqual(isRouteAllowed('patients'), true, 'медсестре закрыли саму картотеку — проверяем не то');
  assert.strictEqual(isModuleAllowed('registration'), false, 'у медсестры оказался ключ регистрации');
  assert.strictEqual(canCreatePatient(), false);

  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });

  // V3120_FIX (2026-09-27) — кнопка, ведущая в отказ, НЕ РИСУЕТСЯ. Прежде
  // этот тест требовал, чтобы кнопка была и отвечала видимым отказом;
  // инспекция v3.12.0 показала, что отказ после нажатия читается хуже, чем
  // отсутствие кнопки: её нажимают снова. Замок на самом окне остаётся —
  // его проверяет конец теста («сама дверь отвечает отказом»).
  // Вход 1 — кнопка «Создать пациента» в шапке списка (views/patients.js).
  assert.strictEqual(walk(box).find((n) => n.attrs['data-onb'] === 'create-patient'), undefined,
    'кнопка «Создать пациента» нарисована роли без права');
  // Вход 2 — ссылка «Создать нового пациента?» в пустом состоянии списка.
  assert.strictEqual(walk(box).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'link-btn')), undefined,
    'ссылка «Создать нового пациента?» нарисована роли без права');

  // Вход 3 — «Калькулятор услуг» отдаёт окну подбора обратный вызов
  // onCreatePatient, и это ТА ЖЕ функция openCreatePatient, что у двух входов
  // выше: в views/patients.js ровно ОДИН вызов openPatientCreateModal, через
  // который проходят входы 1-3. FAST_REG_ONE_SCREEN_V1 добавил вход 4 (ниже) —
  // он зовёт СВОЮ обёртку openFastRegistration(), а не openCreatePatient()
  // напрямую, так что пин на «=> openCreatePatient()» его не увидит и расти
  // не обязан; у нового входа свой собственный пин следующей строкой.
  const src = read('public/js/admin/views/patients.js');
  assert.strictEqual((src.match(/openPatientCreateModal\(/g) || []).length, 1,
    'в списке пациентов появился второй вызов окна — он пройдёт мимо гейта');
  assert.strictEqual((src.match(/=> openCreatePatient\(\)/g) || []).length, 3,
    'входов создания пациента стало не три — тест перечисляет не все');
  assert.ok(/onCreatePatient: \(\) => openCreatePatient\(\)/.test(src),
    'калькулятор услуг больше не ходит через общий вход');
  // FAST_REG_MERGED_V1 (2026-11-21) — отдельного входа в окно fast-registration.js
  // со списка больше нет: «Быстрая регистрация» — это кнопка create-patient выше.
  assert.strictEqual((src.match(/openFastRegistration/g) || []).length, 0,
    'со списка снова ведёт отдельный вход быстрой регистрации — он пройдёт мимо этого перечня');

  // Вход 4 — кнопка «Быстрая регистрация» в шапке списка (views/patients.js).
  // FAST_REG_ONE_SCREEN_V1 — у неё СВОЁ окно (views/fast-registration.js), и
  // право оно спрашивает само, тем же ключом и тем же видимым отказом. Окно
  // грузится динамическим импортом, поэтому отказ ждут, а не читают сразу.
  assert.strictEqual(walk(box).find((n) => n.attrs['data-onb'] === 'fast-registration'), undefined,
    'кнопка «Быстрая регистрация» нарисована роли без права');   // V3120_FIX
  // «Госпитализация» — тот же довод: заявку медсестре сервер не оформит.
  assert.strictEqual(walk(box).find((n) => n.attrs['data-act'] === 'admission'), undefined,
    'кнопка «Госпитализация» нарисована роли, которой сервер откажет');

  // И сама дверь, куда ведут все четверо, отвечает отказом.
  document.body.children.length = 0;
  assert.strictEqual(openPatientCreateModal({}), null, 'дверь пустила роль без права');
  assert.strictEqual(openDialogs('access-denied').length, 1);

  globalThis.window.easymed.state.user = sessionUser;
  hub.destroy();
  setFullAccess('Admin');
});

test('регистратуре тот же ключ окно ОТКРЫВАЕТ — гейт не превратился в запрет для всех', async () => {
  reset();
  setEffectiveFromRole(REGISTRAR);
  assert.strictEqual(canCreatePatient(), true, 'регистратуре закрыли её собственную работу');

  const box = mk('div');
  // WAIT_REG_V1 (ревью) — у регистратуры по умолчанию «Ждут регистрации»: «Список» — по адресу.
  const hub = await renderPatientsHub(box, ctxFor({ sub: 'list' }), { calendarLoader: async () => async () => {} });
  const createBtn = walk(box).find((n) => n.attrs['data-onb'] === 'create-patient');
  createBtn.click();
  assert.strictEqual(openDialogs('patient-create').length, 1, 'регистратуру не пустили в её собственное окно');
  assert.strictEqual(openDialogs('access-denied').length, 0);
  hub.destroy();
  setFullAccess('Admin');
});

// ===========================================================================
// MOTION_REVEAL_ONCE_V1 — список не мигает на каждую букву в поиске
// ===========================================================================
test('поиск по списку не проигрывает появление заново на каждую букву', async () => {
  reset();
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });

  // Монтирование — появление сыграно ОДИН раз.
  assert.strictEqual(observersMade, 1, 'список не появился при монтировании: ' + observersMade);

  const search = walk(box).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'search');
  assert.ok(search, 'в шапке списка нет поля поиска');

  // Три буквы — три перерисовки таблицы. Ждём ПОЛНОСТЬЮ: поле поиска ждёт
  // дважды — общий дебаунс ui.js (500 мс) и собственный 250 мс списка, — и
  // ожидание короче суммы означало бы, что перерисовки не было вовсе и тест
  // ничего не проверил.
  const typed = [];
  for (const q of ['Э', 'Эр', 'Эрг']) {
    search.value = q;
    search.dispatchEvent({ type: 'input', currentTarget: search, target: search });
    await tick(900);
    typed.push(observersMade);
  }
  assert.deepEqual(typed, [1, 1, 1],
    'появление проигрывается на каждую букву: ' + JSON.stringify(typed));
  // Таблица действительно перерисовывалась — иначе тест не проверил бы ничего.
  assert.ok(textOf(panelFor(box, 'list')).includes('Эргашев Жахонгир'),
    'список после поиска пуст — перерисовки не было, проверять нечего');
  assert.strictEqual(observersMade, 1,
    'на каждую букву список прячется в opacity: 0 и проявляется заново (появлений: ' + observersMade +
    ') — это мигание на самом «печатаемом» экране продукта');

  // И смена фильтра — тоже не повод проигрывать появление снова.
  // DUP_TO_RAIL_V1 — фильтр дубликатов стоит в левой колонке, не в шапке списка; ищется по своей метке.
  const dupChip = railButtons().find((n) => 'data-rail-dup' in n.attrs);
  assert.ok(dupChip, 'в колонке нет фильтра дубликатов');
  // PATIENT_DUP_RULE_V3 — подсказка начинается с «Дубликаты — …» (возможные — отдельный список).
  assert.ok(String(dupChip.attrs.title || '').startsWith('Дубликаты — тот же ПИНФЛ'), 'подсказка дубликатов не та');
  dupChip.click();
  await tick(80);
  assert.strictEqual(observersMade, 1, 'смена фильтра проиграла появление заново');

  hub.destroy();
});

test('глушим таймеры, чтобы прогон завершался', () => {
  stopQueuePolling();
  for (const id of [...liveIntervals.keys()]) { liveIntervals.delete(id); realClearInterval(id); }
  assert.equal(queuePolls(), 0);
});

// ===========================================================================
// V3120_FIX (2026-09-27) — инспекция v3.12.0
// ===========================================================================
test('V3120_FIX: вкладки «Записи» и «Очередь» — только тем, кому сервер отдаст их данные', async () => {
  const sessionUser = globalThis.window.easymed.state.user;
  const CASES = [
    // [роль сессии, разделы, ожидаемые вкладки]
    ['nurse',     ['patients', 'queue'],        ['Пациенты', 'Очередь']],
    ['cashier',   ['patients', 'queue'],        ['Пациенты', 'Очередь']],
    ['lab',       ['patients', 'labs'],         ['Пациенты']],
    ['registrar', ['patients', 'queue'],        ['Записи CRM', 'Пациенты', 'Очередь', 'Записи', 'Направления врача']],   // WAIT_REG_V1 — вкладка стойки первой
    ['doctor',    ['patients'],                 ['Пациенты', 'Записи']],
  ];
  try {
    for (const [role, sections, want] of CASES) {
      reset();
      globalThis.window.easymed.state.user = { ...sessionUser, role };
      setEffectiveFromRole({ name: role, permissions: { sections, levels: {} } });
      const box = mk('div');
      const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
      assert.deepEqual(tabButtons(box).map(tabLabel), want, role + ': не те вкладки «Пациентов»');
      hub.destroy();
    }
    // Адрес просит закрытую вкладку — открывается список, а не стена отказов.
    reset();
    globalThis.window.easymed.state.user = { ...sessionUser, role: 'nurse' };
    setEffectiveFromRole({ name: 'nurse', permissions: { sections: ['patients'], levels: {} } });
    const box = mk('div');
    const hub = await renderPatientsHub(box, ctxFor({ sub: 'calendar' }), { calendarLoader: async () => async () => {} });
    assert.equal(hub.activeTab(), 'list');
    assert.ok(!rpcCalls.includes('calendar_windows'), 'закрытый календарь всё равно спросил сервер');
    hub.destroy();
  } finally {
    globalThis.window.easymed.state.user = sessionUser;
    setFullAccess('Admin');
  }
});

// ROLE_QUEUE_V1 (3.25.0) — «Видимость разделов» прячет «Очередь» у всей клиники
// (nav-visibility-logic.js): пункт меню и маршрут #queue. Вкладка «Очередь» внутри
// «Пациентов» о скрытии не знала и оставалась у всех, кому выдана доска. Правило —
// оболочки (window.easymed.isNavHidden), то же, что у меню и плиток «Настроек».
test('ROLE_QUEUE_V1: скрытая в «Видимости разделов» «Очередь» пропадает и вкладкой «Пациентов»', async () => {
  const sessionUser = globalThis.window.easymed.state.user;
  const hidden = new Set(['queue']);
  try {
    reset();
    globalThis.window.easymed.state.user = { ...sessionUser, role: 'registrar' };
    setEffectiveFromRole({ name: 'registrar', permissions: { sections: ['patients', 'queue'], levels: {} } });
    let box = mk('div');
    let hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
    assert.deepEqual(tabButtons(box).map(tabLabel), ['Записи CRM', 'Пациенты', 'Очередь', 'Записи', 'Направления врача'], 'подготовка: без скрытия вкладка «Очередь» есть');   // CRM_BOOKINGS_TAB_V1 — имя
    hub.destroy();

    globalThis.window.easymed.isNavHidden = (id) => hidden.has(id);
    box = mk('div');
    hub = await renderPatientsHub(box, ctxFor({ sub: 'queue' }), { calendarLoader: async () => async () => {} });
    assert.deepEqual(tabButtons(box).map(tabLabel), ['Записи CRM', 'Пациенты', 'Записи', 'Направления врача'], 'скрытая «Очередь» осталась вкладкой «Пациентов»');   // CRM_BOOKINGS_TAB_V1 — имя
    assert.equal(hub.activeTab(), 'list', 'адрес #patients/queue открыл скрытую доску');
    assert.equal(boards(box).length, 0, 'доска смонтирована, хотя раздел скрыт');
    hub.destroy();

    // Скрыт другой раздел — «Очередь» на месте.
    hidden.clear(); hidden.add('labs');
    box = mk('div');
    hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
    assert.ok(tabButtons(box).map(tabLabel).includes('Очередь'), 'скрытие чужого раздела унесло «Очередь»');
    hub.destroy();
  } finally {
    delete globalThis.window.easymed.isNavHidden;
    globalThis.window.easymed.state.user = sessionUser;
    setFullAccess('Admin');
  }
});

// PATIENT_BOT_INVITE_V1 — отметка Telegram переехала в конец строки и читается
// из patient_bot_status; разбор ответа telegram_chats_list строке больше не нужен.
test('V3120_FIX / PATIENT_BOT_INVITE_V1: отметка Telegram в конце строки — по ответу patient_bot_status', async () => {
  reset();
  setFullAccess('Admin');
  const warns = [];
  const origWarn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    // свежий экземпляр модуля: отметки запоминаются на сессию (telegramLinked)
    const { renderPatients } = await import('../views/patients.js?v=v3120tg');
    const box = mk('div');
    await renderPatients(box, { onNavigate() {}, embedded: true });
    await tick(60);
    assert.ok(rpcCalls.includes('patient_bot_status'), 'реестр не спросил, кто подключён к боту');
    const marks = walk(box).filter((n) => hasClass(n, 'pt-tg'));
    assert.equal(marks.length, 1, 'у пациента со связкой Telegram нет отметки');
    // и подпись листания — по-русски
    const t = textOf(box);
    assert.ok(!/Page \d+ of/.test(t), 'подпись листания осталась английской');
    assert.ok(t.includes('Страница 1 из 1'), 'нет русской подписи листания: ' + t.slice(0, 200));
    assert.ok(!t.includes('Sort: Recent'), 'кнопка сортировки осталась английской');
  } finally {
    console.warn = origWarn;
  }
});

// BALANCE_COL_REMOVED_V1 (2026-11-21, владелец: «remove the balance place») —
// колонки «Баланс» в реестре нет; долг виден меткой у имени (DEBT_FLOW_V1).
test('BALANCE_COL_REMOVED_V1: в реестре нет колонки «Баланс» и сумм депозита', async () => {
  reset();
  setFullAccess('Admin');
  AGGS = [{ patient_id: 'p-1', visit_count: 2, balance: 120000, debt: 375000, net_balance: -255000 }];
  try {
    const { renderPatients } = await import('../views/patients.js?v=balrm1');
    const box = mk('div');
    await renderPatients(box, { onNavigate() {}, embedded: true });
    await tick(60);
    const heads = walk(box).filter((n) => n.tagName === 'TH').map(textOf);
    assert.ok(!heads.some((x) => /Баланс/.test(x)), 'колонка «Баланс» вернулась: ' + heads.join(' | '));
    assert.doesNotMatch(textOf(box), /Депозит\s*120/, 'сумма депозита снова в строке реестра');
    assert.equal(walk(box).filter((n) => hasClass(n, 'pt-bal-debt')).length, 0);
  } finally {
    AGGS = null;
  }
});

// LAST_VISIT_TRUE_V1 — «Последний визит» в реестре — последний СОСТОЯВШИЙСЯ
// (местный день от сервера), под датой — ближайшая запись; без состоявшихся
// визитов — местный день регистрации и «визитов не было».
test('LAST_VISIT_TRUE_V1: под датой последнего визита — «запись: …», будущая запись не «последний визит»', async () => {
  reset();
  setFullAccess('Admin');
  AGGS = [{ patient_id: 'p-1', visit_count: 2, balance: 0, debt: 0, net_balance: 0,
    last_visit: '2026-10-20T05:00:00Z', last_visit_day: '2026-10-20',
    next_visit: '2026-11-03T04:00:00Z', next_visit_day: '2026-11-03', registration_day: '2026-09-01' }];
  try {
    const { renderPatients } = await import('../views/patients.js?v=lastvisit1');
    const box = mk('div');
    await renderPatients(box, { onNavigate() {}, embedded: true });
    await tick(60);
    const t = textOf(box);
    assert.ok(t.includes('20 октября 2026'), 'нет даты последнего состоявшегося визита: ' + t.slice(0, 400));
    assert.ok(t.includes('запись: 3 ноября 2026'), 'ближайшая запись не названа под датой: ' + t.slice(0, 400));
    assert.ok(t.includes('визитов: 2'));
    // Только будущая запись: дата — день регистрации, «визитов не было», запись — под датой.
    AGGS = [{ patient_id: 'p-1', visit_count: 0, balance: 0, debt: 0, net_balance: 0,
      last_visit: null, last_visit_day: null, next_visit: '2026-11-03T04:00:00Z', next_visit_day: '2026-11-03', registration_day: '2026-09-01' }];
    const box2 = mk('div');
    await renderPatients(box2, { onNavigate() {}, embedded: true });
    await tick(60);
    const t2 = textOf(box2);
    assert.ok(t2.includes('1 сентября 2026') && t2.includes('визитов не было') && t2.includes('запись: 3 ноября 2026'), t2.slice(0, 400));
  } finally {
    AGGS = null;
  }
});

// BOOKING_TAB_REMOVED_V1 (2026-11-23) — вкладки «Бронирование» больше нет; её тесты ушли вместе с
// views/booking-day.js. Старый адрес #patients/booking — тест «вкладка живёт в адресе» ниже не нужен:
// SUB_TO_TAB ведёт его в «Записи CRM» (проверка — в тесте WAIT_REG_V1 о порядке вкладок).

// ===========================================================================
// WAIT_REG_V1 (3.25.0) — «Ждут регистрации»: вкладка стойки со счётчиком; строки пациентов,
// источник словами, «Оформить по записи» открывает окно визита этого пациента.
// ===========================================================================
test('WAIT_REG_V1: вкладка «Ждут регистрации» — у стойки, со счётчиком; кассе, медсестре и врачу — нет', async () => {
  const sessionUser = globalThis.window.easymed.state.user;
  try {
    reset();
    WAITING = { today: '2026-11-17', count: 2, rows: [
      { patient_id: 'p-1', patient_name: 'Эргашев Жахонгир', mrn: 'MRN-1', phone: '+998901112233', time: '09:30', sources: [{ kind: 'crm', name: '' }], doctors: ['Алиева Нигора'], services: ['Консультация терапевта'], booked_by: ['Оператор Ким'], lines: [] },
      { patient_id: 'p-2', patient_name: 'Юсупова Дилноза', mrn: 'MRN-2', phone: '', time: null, sources: [{ kind: 'doctor', name: 'Алиева Нигора' }], doctors: [], services: ['ОАК'], booked_by: [], lines: [] },
    ] };
    const box = mk('div');
    // Открыт «Список» (адрес): счётчик — только числом (count_only), список не собирается.
    rpcArgs.length = 0;
    const hub = await renderPatientsHub(box, ctxFor({ sub: 'list' }), { calendarLoader: async () => async () => {} });
    await tick(60);
    const btn = tabButtons(box).find((b) => b.attrs['data-tab'] === 'waiting');
    assert.ok(btn, 'у стойки нет вкладки «Ждут регистрации»');
    const badge = walk(btn).find((n) => n.attrs && n.attrs['data-tab-badge'] === 'waiting');
    assert.ok(badge, 'у вкладки нет счётчика');
    assert.equal(badge.textContent, '2', 'счётчик не говорит, сколько ждут');
    assert.equal('hidden' in badge.attrs, false, 'счётчик спрятан при двух ожидающих');
    assert.ok(rpcCalls.includes('registrar_waiting'), 'счётчик не спросил сервер');
    // CRM_BOOKINGS_TAB_V1 — счётчик по фильтру вкладки по умолчанию (сегодня, «CRM / колл-центр», «Ждут»).
    assert.deepEqual(rpcArgs.filter(([n]) => n === 'registrar_waiting').map(([, b]) => b).filter(notRef), [{ count_only: true, sources: ['crm'] }], 'счётчик спросил весь список');
    // REFERRALS_TAB_V1 — у «Направлений врача» свой счётчик — числом, по своему фильтру.
    assert.deepEqual(rpcArgs.filter(([n]) => n === 'registrar_waiting').map(([, b]) => b).filter((b) => !notRef(b)), [{ count_only: true, sources: ['doctor'] }]);
    // ревью L5 — имя вкладки для читалки — с числом; сам значок читалке не виден.
    assert.equal(btn.attrs['aria-label'], 'Записи CRM: 2');
    assert.equal(badge.attrs['aria-hidden'], 'true');
    btn.click(); await tick(60);
    assert.equal(hub.activeTab(), 'waiting');
    const panel = panelFor(box, 'waiting');
    const txt = textOf(panel);
    assert.ok(txt.includes('Эргашев Жахонгир') && txt.includes('Юсупова Дилноза'), 'пациентов нет во вкладке');
    assert.ok(txt.includes('Колл-центр / CRM'), 'источник «Колл-центр / CRM» не назван');
    assert.ok(txt.includes('Направил врач Алиева Нигора'), 'направивший врач не назван');
    assert.ok(txt.includes('09:30') && txt.includes('Консультация терапевта') && txt.includes('Оператор Ким'), 'время, услуги или кто записал не показаны');
    assert.equal(walk(panel).filter((n) => n.attrs && n.attrs['data-rwait-register'] !== undefined).length, 2, 'нет «Оформить по записи»');
    assert.ok(String(lastHistoryUrl).endsWith('#patients/waiting'), 'вкладка не в адресе');
    hub.destroy();
    // Пусто — счётчик спрятан.
    WAITING = { today: '2026-11-17', count: 0, rows: [] };
    const box2 = mk('div');
    const hub2 = await renderPatientsHub(box2, ctxFor({ sub: 'waiting' }), { calendarLoader: async () => async () => {} });
    await tick(60);
    assert.equal(hub2.activeTab(), 'waiting', 'адрес #patients/waiting открыл не ту вкладку');
    const b2 = walk(byTab().waiting).find((n) => n.attrs && n.attrs['data-tab-badge'] === 'waiting');   // PATIENTS_RAIL_V1 — счётчик на пункте колонки
    assert.ok('hidden' in b2.attrs, 'счётчик «0» виден');
    assert.ok(textOf(panelFor(box2, 'waiting')).includes('Сегодня никого не ждём'), 'пустой список не объяснён');
    hub2.destroy();
    // Не стойка — вкладки нет, сервер не спрошен.
    for (const role of ['cashier', 'nurse', 'doctor']) {
      reset();
      globalThis.window.easymed.state.user = { ...sessionUser, role };
      setEffectiveFromRole({ name: role, permissions: { sections: ['patients', 'queue'], levels: {} } });
      const b = mk('div');
      const h3 = await renderPatientsHub(b, ctxFor({ sub: 'waiting' }), { calendarLoader: async () => async () => {} });
      await tick(30);
      assert.equal(tabButtons(b).some((x) => x.attrs['data-tab'] === 'waiting'), false, role + ': вкладка стойки видна');
      assert.equal(h3.activeTab(), 'list', role + ': адрес открыл закрытую вкладку');
      assert.equal(rpcCalls.includes('registrar_waiting'), false, role + ': закрытая вкладка спросила сервер');
      h3.destroy();
    }
  } finally {
    WAITING = null;
    globalThis.window.easymed.state.user = sessionUser;
    setFullAccess('Admin');
  }
});

test('WAIT_REG_V1: «Оформить по записи» открывает окно визита этого пациента; счётчик обновляется вместе со списком', async () => {
  reset();
  const { renderRegistrarWaiting } = await import('../views/registrar-waiting.js');
  let rows = [{ patient_id: 'p-1', patient_name: 'Эргашев Жахонгир', mrn: 'MRN-1', phone: '+998901112233', time: '09:30', sources: [{ kind: 'partner', name: 'med24.uz' }], doctors: [], services: ['УЗИ'], booked_by: [], lines: [] }];
  const counts = [];
  const opened = [];
  const host = mk('div');
  const tab = await renderRegistrarWaiting(host, { onCount: (n) => counts.push(n) }, {
    load: async () => ({ today: '2026-11-17', count: rows.length, rows }),
    openWizard: async (onSaved, patient, opts) => { opened.push({ patient, opts }); rows = []; await onSaved(); },
  });
  assert.ok(textOf(host).includes('Сайт / партнёр · med24.uz'), 'партнёр не назван');
  walk(host).find((n) => n.attrs && n.attrs['data-rwait-register'] === 'p-1').click();
  await tick(60);
  assert.equal(opened.length, 1, 'окно визита не открылось');
  assert.equal(opened[0].patient.id, 'p-1');
  assert.equal(opened[0].patient.full_name, 'Эргашев Жахонгир');
  assert.deepEqual(counts, [1, 0], 'после оформления список и счётчик не перечитаны');
  assert.ok(textOf(host).includes('Сегодня никого не ждём'));
  assert.equal(tab.state.rows.length, 0);
});

// WAIT_REG_V1 (ревью M6) — минутный опрос не ходит в базу, пока раздел спрятан оболочкой; открыт «Список» —
// спрашивается только число.
test('WAIT_REG_V1 (ревью M6): минутный опрос — только когда раздел на экране, и только число', async () => {
  reset();
  WAITING = { today: '2026-11-17', count: 3, rows: [] };
  try {
    const box = mk('div');
    const hub = await renderPatientsHub(box, ctxFor({ sub: 'list' }), { calendarLoader: async () => async () => {} });
    await tick(60);
    const pollId = [...liveIntervals.entries()].filter(([, ms]) => ms === 60000).map(([id]) => id).at(-1);
    assert.ok(pollId != null, 'минутного опроса нет');
    const poll = intervalFns.get(pollId);
    const root = box.children[0];
    const calls = () => rpcArgs.filter(([n, b]) => n === 'registrar_waiting' && notRef(b)).length;   // REFERRALS_TAB_V1 — без счётчика направлений
    const before = calls();
    root.getClientRects = () => [];   // раздел спрятан (display:none у панели оболочки)
    poll(); await tick(30);
    assert.equal(calls(), before, 'спрятанный раздел опросил сервер');
    root.getClientRects = () => [1];
    rpcArgs.length = 0;
    poll(); await tick(30);
    assert.equal(calls(), 1, 'раздел на экране — опроса нет');   // REFERRALS_TAB_V1 — rpcArgs очищен выше
    assert.deepEqual(rpcArgs.filter(([n]) => n === 'registrar_waiting').map(([, b]) => b).filter(notRef), [{ count_only: true, sources: ['crm'] }], 'открыт «Список», а опрос собирает весь список');   // CRM_BOOKINGS_TAB_V1 — фильтр по умолчанию
    hub.destroy();
  } finally {
    WAITING = null;
  }
});

// WAIT_REG_V1 (ревью L5, решение владельца) — «услуга не выбрана», кнопка гаснет на время открытия окна,
// фокус клавиатуры переживает перечитывание; «Оформить по записи» у записи без услуги — врач записи, у
// записи соседнего здания — её услуги набранными строками.
test('WAIT_REG_V1 (ревью L5): запись без услуги, кнопка гаснет, фокус после перечитывания — на той же кнопке', async () => {
  reset();
  const { renderRegistrarWaiting } = await import('../views/registrar-waiting.js');
  const rows = [
    { patient_id: 41, patient_name: 'Безуслугова Дина', mrn: '', phone: '', time: '15:00', no_service: true, sources: [{ kind: 'calendar', name: '' }], doctors: ['Иванов'], services: [], booked_by: [],
      lines: [{ kind: 'booking', visit_id: 9, doctor_id: 10, visit_service_id: null }] },
    { patient_id: 42, patient_name: 'Соседова Ева', mrn: '', phone: '', time: '16:00', sources: [{ kind: 'calendar', name: '' }], doctors: ['Петров'], services: ['Консультация'], booked_by: [],
      lines: [{ kind: 'booked', foreign: true, visit_service_id: 77, visit_id: 8, service_id: 21, consultation_type_id: null, doctor_id: 7, name: 'Консультация' }] },
  ];
  const opened = [];
  let release = null;
  const host = mk('div');
  const tab = await renderRegistrarWaiting(host, {}, {
    load: async () => ({ today: '2026-11-17', count: rows.length, rows }),
    openWizard: (onSaved, patient, opts) => { opened.push({ patient, opts }); return new Promise((r) => { release = r; }); },
  });
  const row41 = walk(host).find((n) => n.attrs && n.attrs['data-rwait-row'] === '41');
  assert.ok(walk(row41).some((n) => n.attrs && 'data-rwait-no-service' in n.attrs), '«услуга не выбрана» не показано');
  assert.ok(textOf(row41).includes('услуга не выбрана'));
  const regBtn = (pid) => walk(host).find((n) => n.attrs && n.attrs['data-rwait-register'] === String(pid));
  assert.equal('disabled' in regBtn(41).attrs, false, 'кнопка погашена без причины');
  regBtn(41).click(); await tick(30);
  assert.equal('disabled' in regBtn(42).attrs, true, 'пока окно визита открывается, кнопки не погашены');
  assert.deepEqual(opened[0].opts, { bookingDoctorId: 10 }, 'запись без услуги открыта не на врача записи');
  release({}); await tick(30);
  assert.equal('disabled' in regBtn(42).attrs, false, 'кнопки остались погашены');
  regBtn(42).click(); await tick(30);
  assert.deepEqual(opened[1].opts, { presetLines: [{ service_id: 21, consultation_type_id: null, doctor_id: 7, name: 'Консультация' }], presetFromCrm: false },
    'строки записи соседнего здания не переданы окну визита');
  release({}); await tick(30);
  // Фокус: кнопка пациента 42 в фокусе — после перечитывания фокус на новой кнопке того же пациента.
  const prevActive = Object.getOwnPropertyDescriptor(globalThis.document, 'activeElement');
  let focused = regBtn(42);
  Object.defineProperty(globalThis.document, 'activeElement', { configurable: true, get: () => focused });
  const prevContains = host.children[0].contains;
  host.children[0].contains = (n) => walk(host).includes(n);
  const prevQS = host.children[0].querySelector;
  host.children[0].querySelector = (sel) => {
    const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel);
    return m ? walk(host).find((n) => n.attrs && n.attrs[m[1]] !== undefined && (m[2] === undefined || n.attrs[m[1]] === m[2])) || null : null;
  };
  const old = focused;
  let focusedNow = null;
  // focus() каждой кнопки (и новых, нарисованных перечитыванием) запоминает, кто в фокусе.
  const F = Object.getPrototypeOf(old).constructor;
  const protoFocus = F.prototype.focus;
  F.prototype.focus = function () { focusedNow = this; };
  try {
    await tab.reload();
    assert.ok(focusedNow, 'после перечитывания фокус никуда не вернули');
    assert.notEqual(focusedNow, old, 'фокус остался на снятой кнопке');
    assert.equal(focusedNow.attrs['data-rwait-register'], '42', 'фокус ушёл не на кнопку того же пациента');
  } finally {
    F.prototype.focus = protoFocus;
    host.children[0].contains = prevContains;
    host.children[0].querySelector = prevQS;
    if (prevActive) Object.defineProperty(globalThis.document, 'activeElement', prevActive);
    else delete globalThis.document.activeElement;
  }
});

// CRM_BOOKINGS_TAB_V1 (решение владельца) — «Записи CRM»: фильтры вкладки живут, пока живёт раздел
// (ушли на «Список» и вернулись — тот же фильтр и перечитывание с ним); счётчик вкладки — по фильтру
// по умолчанию, а не по открытому; адрес прежний — #patients/waiting.
test('CRM_BOOKINGS_TAB_V1: фильтры вкладки переживают переход на соседнюю вкладку; счётчик — по фильтру по умолчанию', async () => {
  const sessionUser = globalThis.window.easymed.state.user;
  try {
    reset();
    globalThis.window.easymed.state.user = { ...sessionUser, role: 'registrar' };
    setEffectiveFromRole(REGISTRAR);
    WAITING = { today: '2026-11-17', count: 1, rows: [
      { patient_id: 'p-1', patient_name: 'Эргашев Жахонгир', mrn: 'MRN-1', phone: '', time: '09:30', day: '2026-11-17', status: 'waiting',
        sources: [{ kind: 'crm', name: '' }], doctors: [], services: ['УЗИ'], booked_by: [], lines: [], reasons: [] },
    ] };
    rpcArgs.length = 0;
    const box = mk('div');
    const hub = await renderPatientsHub(box, ctxFor({ sub: 'waiting' }), { calendarLoader: async () => async () => {} });
    await tick(60);
    assert.equal(hub.activeTab(), 'waiting');
    assert.equal(tabLabel(byTab(box).waiting), 'Записи CRM');
    const panel = panelFor(box, 'waiting');
    const calls = () => rpcArgs.filter(([n]) => n === 'registrar_waiting').map(([, b]) => b).filter(notRef);   // REFERRALS_TAB_V1 — без счётчика направлений
    assert.deepEqual(calls(), [{ sources: ['crm'] }], 'вкладка открылась не с фильтром по умолчанию');
    { const sel = walk(panel).find((n) => n.attrs && 'data-rwait-status' in n.attrs); sel.value = 'all'; sel.dispatchEvent({ type: 'change', target: sel, currentTarget: sel }); }   // FILTERS_DROPDOWN_V1 — выпадающий список
    await tick(60);
    assert.deepEqual(calls().slice(1), [{ sources: ['crm'], status: 'all' }, { count_only: true, sources: ['crm'] }],
      'смена статуса — не перечитывание с фильтром или счётчик пошёл за ним');
    rpcArgs.length = 0;
    byTab(box).list.click(); await tick(60);
    byTab(box).waiting.click(); await tick(60);
    assert.deepEqual(calls().filter((b) => !b.count_only), [{ sources: ['crm'], status: 'all' }], 'возврат на вкладку сбросил фильтр');
    assert.equal(String(walk(panel).find((n) => n.attrs && 'data-rwait-status' in n.attrs).value), 'all');
    const badge = walk(byTab().waiting).find((n) => n.attrs && n.attrs['data-tab-badge'] === 'waiting');   // PATIENTS_RAIL_V1 — счётчик на пункте колонки
    assert.equal(badge.textContent, '1');
    assert.ok(String(lastHistoryUrl).endsWith('#patients/waiting'), 'адрес вкладки сменился');
    hub.destroy();
  } finally {
    WAITING = null;
    globalThis.window.easymed.state.user = sessionUser;
    setFullAccess('Admin');
  }
});

// REFERRALS_TAB_V1 (2026-11-24, владелец: «Put referal separately from Записи CRM, put it in block separately») —
// «Направления врача» — свой пункт колонки стойки, отдельным блоком (своя группа колонки); открывает тот же список
// в режиме направлений (источник 'doctor'), адрес #patients/referrals; кассе — нет.
test('REFERRALS_TAB_V1: «Направления врача» — свой пункт стойки, свой адрес и список направлений', async () => {
  reset();
  rpcArgs.length = 0;
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor({ sub: 'referrals' }), { calendarLoader: async () => async () => {} });
  await tick(60);
  assert.equal(hub.activeTab(), 'referrals', 'адрес #patients/referrals открыл не направления');
  assert.equal(tabLabel(byTab(box).referrals), 'Направления врача');
  const panel = panelFor(box, 'referrals');
  assert.ok(walk(panel).some((n) => n.attrs && n.attrs['data-rwait-mode'] === 'referrals'), 'панель — не список направлений');
  assert.deepEqual(rpcArgs.filter(([n]) => n === 'registrar_waiting').map(([, b]) => b).filter((b) => !b.count_only && !notRef(b)), [{ sources: ['doctor'] }]);
  hub.destroy();
});
