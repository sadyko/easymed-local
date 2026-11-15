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
globalThis.setInterval = (fn, ms, ...rest) => { const id = realSetInterval(fn, ms, ...rest); liveIntervals.set(id, ms); return id; };
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
const { renderBookingDay } = await import('../views/booking-day.js');   // BOOKING_DAY_TO_WIZARD_V1 — с подменой окна услуг
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
const tabButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON' && n.attrs.role === 'tab');
const tabLabel = (b) => walk(b).filter((n) => n.tagName !== 'SVG').map((n) => n._t || '').join('').trim();
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

  const btns = tabButtons(box);
  // BOOKING_DAY_V1 — четвёртая вкладка «Бронирование»: день одного врача.
  assert.deepEqual(btns.map(tabLabel), ['Список', 'Очередь', 'Записи', 'Бронирование'], 'полоса вкладок не та');
  assert.equal(hub.activeTab(), 'list', 'по умолчанию открывается не список');
  assert.equal(visiblePanels(box).length, 1, 'видна не ровно одна вкладка');

  // 1. Список — фамилия из картотеки и кнопка создания.
  assert.ok(textOf(panelFor(box, 'list')).includes('Эргашев Жахонгир'), 'на вкладке «Список» нет пациента');

  // 2. Очередь — живая доска: номер, имя, состояние талона.
  btns[1].click(); await tick();
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
  btns[2].click(); await tick();
  assert.equal(hub.activeTab(), 'calendar');
  assert.ok(textOf(panelFor(box, 'calendar')).includes('Сетка календаря'), 'вкладка «Записи» пуста');
  assert.deepEqual(calls.map((o) => o.embedded), [true], 'календарь смонтирован не встроенным');

  hub.destroy();
});

test('полоса вкладок доступна с клавиатуры: стрелки, Home и End', async () => {
  reset();
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
  const btns = tabButtons(box);
  // В tablist из порядка обхода Tab вынуто всё, кроме активной вкладки, —
  // значит по стрелкам обязано ходить, иначе двух вкладок из трёх для
  // клавиатуры просто не существует.
  assert.deepEqual(btns.map((b) => b.attrs.tabindex), ['0', '-1', '-1', '-1']);
  const press = (b, key) => b.dispatchEvent({ type: 'keydown', key, preventDefault() {} });

  press(btns[0], 'ArrowRight'); await tick();
  assert.equal(hub.activeTab(), 'queue');
  press(btns[1], 'ArrowRight'); await tick();
  assert.equal(hub.activeTab(), 'calendar');
  press(btns[2], 'ArrowRight'); await tick();
  assert.equal(hub.activeTab(), 'booking');   // BOOKING_DAY_V1
  press(btns[3], 'ArrowRight'); await tick();
  assert.equal(hub.activeTab(), 'list', 'стрелка вправо с последней вкладки не вернулась к первой');
  press(btns[0], 'ArrowLeft'); await tick();
  assert.equal(hub.activeTab(), 'booking');
  press(btns[3], 'Home'); await tick();
  assert.equal(hub.activeTab(), 'list');
  press(btns[0], 'End'); await tick();
  assert.equal(hub.activeTab(), 'booking');
  // Активная вкладка — единственная в порядке обхода, и она же помечена.
  assert.deepEqual(tabButtons(box).map((b) => b.attrs['aria-selected']), ['false', 'false', 'false', 'true']);
  assert.deepEqual(tabButtons(box).map((b) => b.attrs.tabindex), ['-1', '-1', '-1', '0']);
  hub.destroy();
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

  // Незнакомый подмаршрут — это не пустой экран: раздел открывается списком.
  const junk = await renderPatientsHub(mk('div'), ctxFor({ sub: 'нет-такой' }), { calendarLoader: async () => async () => {} });
  assert.equal(junk.activeTab(), 'list');
  junk.destroy();

  // А переключение вкладки — пишет адрес и сообщает о нём оболочке.
  reset();
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
  assert.equal(replaces, 0, 'монтирование не должно переписывать адрес — его уже написал navigate()');

  const btns = tabButtons(box);
  btns[1].click(); await tick();
  assert.equal(lastHistoryUrl, '#patients/queue');
  assert.deepEqual(tabSubCalls.at(-1), ['patients', 'queue'], 'оболочке не сообщили о вкладке');
  btns[0].click(); await tick();
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
  const btns = tabButtons(box);
  // Список открыт — доска ещё не смонтирована, значит и опроса нет.
  assert.equal(queuePolls(), 0, 'спрятанная доска опрашивает базу, хотя её никто не открывал');

  btns[1].click(); await tick();
  assert.equal(queuePolls(), 1, 'открытая доска не обновляет себя');

  btns[0].click(); await tick();
  assert.equal(queuePolls(), 0, 'ушли с вкладки, а доска продолжает ходить в базу каждые 10 секунд');

  btns[1].click(); await tick();
  assert.equal(queuePolls(), 1, 'вернулись на вкладку, а доска больше не обновляется');
  const callsAfterReturn = rpcCalls.filter((n) => n === 'queue_board').length;
  assert.ok(callsAfterReturn >= 2, 'возврат на вкладку не перечитал доску — она показывала бы минуты давности');

  btns[2].click(); await tick();
  assert.equal(queuePolls(), 0, 'уход на «Записи» не остановил опрос очереди');

  hub.destroy();
  assert.equal(queuePolls(), 0);
});

test('доска не монтируется дважды: возврат на вкладку не заводит вторую', async () => {
  reset();
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
  const btns = tabButtons(box);
  btns[1].click(); await tick();
  assert.equal(boards(box).length, 1);
  const firstBoard = boards(box)[0];
  btns[0].click(); await tick();
  btns[1].click(); await tick();
  btns[0].click(); await tick();
  btns[1].click(); await tick();
  assert.equal(boards(box).length, 1, 'в контейнере вкладки выросла вторая доска');
  // И это ТА ЖЕ доска: вкладка не пересобирается заново, поэтому день, поиск и
  // прокрутка карточек переживают уход на соседнюю вкладку. Пересборка вместо
  // возобновления — это как раз тот случай, когда доски становится две.
  assert.equal(boards(box)[0], firstBoard, 'вкладку пересобрали заново вместо того, чтобы разбудить');
  assert.equal(queuePolls(), 1, 'у одной доски два таймера — модульные синглтоны разъехались');
  // И два быстрых нажатия подряд тоже не должны развести две доски.
  btns[0].click(); btns[1].click(); btns[1].click(); await tick();
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
  assert.deepEqual(tabButtons(box).map(tabLabel), ['Список', 'Очередь', 'Записи', 'Бронирование'],
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
  const btns = tabButtons(box);
  btns[2].click(); await tick();
  assert.equal(hub.activeTab(), 'calendar');
  assert.ok(textOf(panelFor(box, 'calendar')).includes('Календарь записи не открылся'));
  btns[0].click(); await tick();
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
  const btns = tabButtons(box);
  btns[2].click(); await tick();
  assert.ok(textOf(panelFor(box, 'calendar')).includes('Календарь записи не открылся'), 'первая попытка должна была упасть');

  // Возврат на вкладку пробует снова — раньше флаг mounted держал заглушку.
  btns[0].click(); await tick();
  btns[2].click(); await tick();
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
  tabButtons(box)[2].click(); await tick();
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
  assert.strictEqual((src.match(/=> openFastRegistration\(\)/g) || []).length, 1,
    'входов быстрой регистрации стало не один — тест перечисляет не все');

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
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });
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
  const dupChip = walk(box).find((n) => n.tagName === 'BUTTON' && String(n.attrs.title || '').startsWith('Возможные дубликаты'));
  assert.ok(dupChip, 'в шапке списка нет фильтра дубликатов');
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
    ['nurse',     ['patients', 'queue'],        ['Список', 'Очередь']],
    ['cashier',   ['patients', 'queue'],        ['Список', 'Очередь']],
    ['lab',       ['patients', 'labs'],         ['Список']],
    // BOOKING_DAY_V1 — «Бронирование» видят те же, кому открыты «Записи».
    ['registrar', ['patients', 'queue'],        ['Список', 'Очередь', 'Записи', 'Бронирование']],
    ['doctor',    ['patients'],                 ['Список', 'Записи', 'Бронирование']],
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

test('V3120_FIX: «Баланс» в реестре показывает и депозит, и долг — долг не растворяется', async () => {
  reset();
  setFullAccess('Admin');
  AGGS = [{ patient_id: 'p-1', visit_count: 2, balance: 120000, debt: 375000, net_balance: -255000 }];
  try {
    const { renderPatients } = await import('../views/patients.js?v=v3120bal');
    const box = mk('div');
    await renderPatients(box, { onNavigate() {}, embedded: true });
    await tick(60);
    const t = textOf(box);
    assert.match(t, /\+120\s000/, 'депозит пациента не виден: ' + t.slice(0, 300));
    assert.match(t, /долг 375\s000/, 'долг пациента пропал из реестра');
    // без долга — только депозит, без красной строки
    AGGS = [{ patient_id: 'p-1', visit_count: 2, balance: 0, debt: 0, net_balance: 0 }];
    const box2 = mk('div');
    await renderPatients(box2, { onNavigate() {}, embedded: true });
    await tick(60);
    assert.equal(walk(box2).filter((n) => hasClass(n, 'pt-bal-debt')).length, 0, 'строка долга у пациента без долга');
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

// ===========================================================================
// BOOKING_DAY_V1 (2026-11-13) — вкладка «Бронирование»: владелец — «it should
// have filters and random date should be today, and search place for doctor,
// and if doctor chosen, down place it should show consultation times and list
// of patient».
// ===========================================================================
const localYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const byData = (root, attr) => walk(root).filter((n) => n.attrs && n.attrs[attr] != null);

test('BOOKING_DAY_V1: дата — сегодня, до выбора врача — подсказка, поиск врача — только врачи, по специальности', async () => {
  reset(); rpcArgs = [];
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor({ sub: 'booking' }), { calendarLoader: async () => async () => {} });
  await tick(60);
  assert.equal(hub.activeTab(), 'booking', 'адрес #patients/booking открыл не «Бронирование»');
  const panel = panelFor(box, 'booking');
  const date = walk(panel).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'date');
  assert.equal(date.value, localYmd(new Date()), 'дата по умолчанию — не сегодня');
  assert.equal(byData(panel, 'data-bkd-hint').length, 1, 'до выбора врача нет подсказки');
  assert.ok(!rpcArgs.some(([n]) => n === 'calendar_slots'), 'расписание спрошено без врача');

  // В поиске — только врачи (регистратор не врач), по алфавиту.
  const opts = () => byData(panel, 'data-bkd-doctor-opt').map((n) => n.attrs['data-bkd-doctor-opt']);
  assert.deepEqual(opts(), ['7', '8']);
  // Специальность сужает список.
  const spec = byData(panel, 'data-bkd-spec')[0];
  spec.value = 'Кардиолог'; spec.dispatchEvent({ type: 'change' });
  assert.deepEqual(opts(), ['8'], 'специальность не сузила поиск врача');
  hub.destroy();
});

test('BOOKING_DAY_V1: выбран врач — время приёма (свободное и занятое по порядку) и пациенты; статус фильтрует; имя открывает карту', async () => {
  reset(); rpcArgs = [];
  const navigated = [];
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor({ sub: 'booking' }, navigated), { calendarLoader: async () => async () => {} });
  await tick(60);
  const panel = panelFor(box, 'booking');
  byData(panel, 'data-bkd-doctor-opt').find((n) => n.attrs['data-bkd-doctor-opt'] === '7').click();
  await tick(60);

  const call = rpcArgs.filter(([n]) => n === 'calendar_slots').pop();
  assert.ok(call, 'день врача не спрошен');
  assert.deepEqual([call[1].doctor_id, call[1].date], [7, localYmd(new Date())], 'спросили не того врача или не сегодня');

  // Лента: 09:00 занято, 09:30 свободно, 10:00 занято, 11:00 и 11:30 свободны.
  const chips = walk(panel).filter((n) => n.attrs && (n.attrs['data-bkd-free'] != null || n.attrs['data-bkd-busy'] != null))
    .map((n) => (n.attrs['data-bkd-free'] != null ? 'free ' + n.attrs['data-bkd-free'] : 'busy ' + n.attrs['data-bkd-busy']));
  assert.deepEqual(chips, ['busy 09:00', 'free 09:30', 'busy 10:00', 'free 11:00', 'free 11:30']);
  const head = textOf(byData(panel, 'data-bkd-head')[0]);
  assert.ok(head.includes('Алиева Нигора') && head.includes('09:00–12:00') && head.includes('10:30–11:00'), 'сводка дня не та: ' + head);

  // Пациенты: двое; фильтр «Пришёл» оставляет одну.
  const rows = () => byData(panel, 'data-bkd-row').map((n) => n.attrs['data-bkd-row']);
  assert.deepEqual(rows(), ['101', '102']);
  byData(panel, 'data-bkd-status').find((n) => n.attrs['data-bkd-status'] === 'arrived').click();
  assert.deepEqual(rows(), ['102'], 'фильтр статуса не сработал');
  byData(panel, 'data-bkd-status').find((n) => n.attrs['data-bkd-status'] === 'all').click();

  // Имя пациента — в его карту.
  byData(panel, 'data-bkd-open').find((n) => n.attrs['data-bkd-open'] === 'p-1').click();
  await tick(60);
  assert.ok(navigated.includes('patient-card'), 'имя пациента не открыло карту');

  // Следующий день — новый запрос на завтра.
  walk(panel).find((n) => n.tagName === 'BUTTON' && n.attrs['aria-label'] === 'Следующий день').click();
  await tick(60);
  const next = rpcArgs.filter(([n]) => n === 'calendar_slots').pop();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  assert.equal(next[1].date, localYmd(tomorrow), '«‹ ›» не сменил день');
  hub.destroy();
});

// BOOKING_DAY_V2 — владелец: «make it possibe to chose time and make booking too
// for registrars». «Записать» в свободной строке → поиск пациента → calendar_book.
test('BOOKING_DAY_V2: «Записать» в свободное время — найти пациента и записать (calendar_book); день перечитан', async () => {
  reset(); rpcArgs = [];
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor({ sub: 'booking' }), { calendarLoader: async () => async () => {} });
  await tick(60);
  const panel = panelFor(box, 'booking');
  byData(panel, 'data-bkd-doctor-opt').find((n) => n.attrs['data-bkd-doctor-opt'] === '7').click();
  await tick(60);

  // Слева время, справа пациент или «Свободно»: строки по порядку.
  const order = walk(panel).filter((n) => n.attrs && (n.attrs['data-bkd-free'] != null || n.attrs['data-bkd-busy'] != null) && hasClass(n, 'bkd-sched-row'))
    .map((n) => (n.attrs['data-bkd-free'] != null ? 'free ' + n.attrs['data-bkd-free'] : 'busy ' + n.attrs['data-bkd-busy']));
  assert.deepEqual(order, ['busy 09:00', 'free 09:30', 'busy 10:00', 'free 11:00', 'free 11:30']);

  byData(panel, 'data-bkd-book').find((n) => n.attrs['data-bkd-book'] === '09:30').click();
  await tick(20);
  const search = byData(panel, 'data-bkd-book-search')[0];
  assert.ok(search, 'у свободной строки не открылся поиск пациента');
  search.value = 'Эрга';
  search.dispatchEvent({ type: 'input' });
  await tick(400);
  const hit = walk(panel).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt'));
  assert.ok(hit, 'пациент не найден в строке записи');
  const before = rpcArgs.filter(([n]) => n === 'calendar_slots').length;
  hit.click();
  await tick(80);

  const bookCall = rpcArgs.find(([n]) => n === 'calendar_book');
  assert.ok(bookCall, 'запись не ушла на сервер');
  assert.deepEqual([bookCall[1].patient_id, bookCall[1].doctor_id, bookCall[1].start, bookCall[1].duration_minutes, bookCall[1].status],
    ['p-1', 7, '2026-11-13T04:30:00.000Z', 30, 'scheduled'], 'записали не того, не к тому или не на то время');
  // BOOKING_DAY_SERVICE_V1 — запись уносит услугу врача строкой визита.
  assert.equal(bookCall[1].service_id, 21, 'запись без услуги врача');
  assert.deepEqual(bookCall[1].line, { service_id: 21 }, 'услуга не ушла строкой визита');
  assert.ok(rpcArgs.filter(([n]) => n === 'calendar_slots').length > before, 'после записи день не перечитан');
  hub.destroy();
});

test('BOOKING_DAY_V2: «Записи» только на просмотр — кнопки «Записать» нет, расписание видно', async () => {
  reset(); rpcArgs = [];
  setEffectiveFromRole({ name: 'registrar', permissions: { sections: ['patients', 'queue'], levels: {}, grants: { 'patients.calendar': 'view' } } });
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor({ sub: 'booking' }), { calendarLoader: async () => async () => {} });
  await tick(60);
  const panel = panelFor(box, 'booking');
  assert.ok(panel, 'вкладка «Бронирование» не видна роли с просмотром «Записей»');
  byData(panel, 'data-bkd-doctor-opt').find((n) => n.attrs['data-bkd-doctor-opt'] === '7').click();
  await tick(60);
  assert.ok(byData(panel, 'data-bkd-free').length > 0, 'свободного времени не видно');
  assert.equal(byData(panel, 'data-bkd-book').length, 0, 'кнопка «Записать» у роли без права записи');
  hub.destroy();
  setFullAccess('Admin');
});

// BOOKING_DAY_DETAIL_V1 / BOOKING_DAY_TO_WIZARD_V1 — владелец: «make it more
// detailed, id of patient and name of service too» и «when you press it, it
// should come to service added place as service added and continue process».
test('BOOKING_DAY_DETAIL_V1: у записи — номер карты и услуги визита (без отменённых), консультация — своим названием', async () => {
  reset(); rpcArgs = [];
  const host = mk('div');
  const api = await renderBookingDay(host, { onNavigate() {} });
  api.pickDoctor(DOCTORS[0]);
  await tick(120);
  const row = byData(host, 'data-bkd-row').find((n) => n.attrs['data-bkd-row'] === '101');
  const t = textOf(row);
  assert.ok(t.includes('MRN-1'), 'нет номера карты: ' + t);
  assert.ok(t.includes('УЗИ брюшной полости') && t.includes('Общий анализ крови'), 'нет услуг визита: ' + t);
  assert.ok(!t.includes('Отменённая услуга'), 'отменённая услуга показана');
  const row2 = byData(host, 'data-bkd-row').find((n) => n.attrs['data-bkd-row'] === '102');
  assert.ok(textOf(row2).includes('Первичная консультация'), 'вид консультации не назван');
});

test('BOOKING_DAY_TO_WIZARD_V1: сегодняшняя запись открывает окно услуг для этого пациента; имя — карту; другой день — не нажимается', async () => {
  reset(); rpcArgs = [];
  const wizard = [];
  const wizardPatients = [];   // какую карту получило окно услуг
  const navigated = [];
  const host = mk('div');
  const api = await renderBookingDay(host, { onNavigate: (v) => navigated.push(v) },
    { openVisitWizard: async (onSaved, patient) => { wizard.push(patient && patient.id); wizardPatients.push(patient); await onSaved(); } });
  api.pickDoctor(DOCTORS[0]);
  await tick(120);
  const row = () => byData(host, 'data-bkd-row').find((n) => n.attrs['data-bkd-row'] === '101');
  assert.equal(row().attrs['data-bkd-wizard'], '101', 'сегодняшняя запись не нажимается');

  // Имя — карта пациента, окно услуг не открывается.
  byData(row(), 'data-bkd-open')[0].click();
  await tick(60);
  assert.ok(navigated.includes('patient-card'), 'имя не открыло карту');
  assert.equal(wizard.length, 0, 'нажатие на имя открыло ещё и окно услуг');

  // Строка — окно услуг для этого пациента; после него день перечитан.
  const before = rpcArgs.filter(([n]) => n === 'calendar_slots').length;
  row().click();
  await tick(120);
  assert.deepEqual(wizard, ['p-1'], 'окно услуг открылось не для того пациента');
  assert.ok(rpcArgs.filter(([n]) => n === 'calendar_slots').length > before, 'после оформления день не перечитан');

  // Завтра — запись видна, но в сегодняшний счёт её не оформить.
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  api.setDate(localYmd(tomorrow));
  await tick(120);
  assert.equal(row().attrs['data-bkd-wizard'], undefined, 'запись другого дня нажимается');
});

// BOOKING_DAY_SERVICE_V1 — владелец: «why services of doctor is not coming, if
// there is one it should come randomly». «Услуга» — услуги врача (service_rates),
// первая выбрана сразу; длительность слотов — её длительность.
test('BOOKING_DAY_SERVICE_V1: у выбранного врача — его услуги, первая уже выбрана; слоты — по её длительности', async () => {
  reset(); rpcArgs = [];
  const host = mk('div');
  const api = await renderBookingDay(host, { onNavigate() {} });
  api.pickDoctor(DOCTORS[0]);
  await tick(120);
  const sel = byData(host, 'data-bkd-type')[0];
  const opts = walk(sel).filter((n) => n.tagName === 'OPTION').map((n) => n.attrs.value);
  assert.deepEqual(opts, ['svc:21', 'svc:22', 'ct:3'], 'в списке не услуги врача (или чужая услуга)');   // BOOKING_DAY_SERVICE_REQUIRED_V1 — «Без услуги» нет
  assert.equal(api.state.choice, 'svc:21', 'первая услуга врача не выбрана сама');
  const slots = rpcArgs.filter(([n]) => n === 'calendar_slots').pop();
  assert.equal(slots[1].duration_minutes, 20, 'слоты не по длительности услуги');

  // ЭКГ без своей длительности — 30, как у сервера.
  sel.value = 'svc:22'; sel.dispatchEvent({ type: 'change' });
  await tick(80);
  assert.equal(rpcArgs.filter(([n]) => n === 'calendar_slots').pop()[1].duration_minutes, 30);

  // Врач без услуг — первым идёт вид консультации.
  api.pickDoctor(DOCTORS[1]);
  await tick(80);
  assert.equal(api.state.choice, 'ct:3');
});

// BOOKING_DAY_SERVICE_REQUIRED_V1 — владелец: «if there is no service no booking
// should happen». Врач без услуг (и клиника без видов консультаций): свободное
// время видно, но «Записать» не открывается, а экран говорит почему.
test('BOOKING_DAY_SERVICE_REQUIRED_V1: у врача нет услуг — записать нельзя, экран объясняет', async () => {
  reset(); rpcArgs = [];
  const saved = CTYPES.splice(0, CTYPES.length);   // клиника без видов консультаций
  try {
    const host = mk('div');
    const api = await renderBookingDay(host, { onNavigate() {} });
    api.pickDoctor(DOCTORS[1]);   // Каримов — без service_rates
    await tick(120);
    assert.equal(api.state.choice, '', 'услуга выбралась, хотя её нет');
    const sel = byData(host, 'data-bkd-type')[0];
    assert.ok(textOf(sel).includes('У врача нет услуг'), 'список не говорит, что услуг нет');
    assert.equal(byData(host, 'data-bkd-noservice').length, 1, 'нет объяснения, почему записать нельзя');
    assert.ok(byData(host, 'data-bkd-free').length > 0, 'свободное время пропало — его должно быть видно');
    assert.equal(byData(host, 'data-bkd-book').length, 0, 'свободная строка всё ещё открывает запись');
    assert.ok(!rpcArgs.some(([n]) => n === 'calendar_book'), 'запись ушла без услуги');
  } finally {
    CTYPES.push(...saved);
  }
});

// BOOKING_DAY_CANCEL_V1 — владелец: «add at the end remove button too». Кнопка
// отмены в конце строки записи: «Записан» / «Подтверждён», с подтверждением,
// не открывает окно услуг; «Пришёл» не отменяется.
test('BOOKING_DAY_CANCEL_V1: отмена записи в конце строки — с подтверждением, без окна услуг; «Пришёл» не отменяется', async () => {
  reset(); rpcArgs = [];
  const cancelled = [];
  const wizard = [];
  const prevConfirm = globalThis.window.confirm;
  let answer = false;
  globalThis.window.confirm = () => answer;
  try {
    const host = mk('div');
    const api = await renderBookingDay(host, { onNavigate() {} }, {
      setVisitStatus: async (v, st) => { cancelled.push([v && v.id, st]); },
      openVisitWizard: async (onSaved, p) => { wizard.push(p && p.id); },
    });
    api.pickDoctor(DOCTORS[0]);
    await tick(120);
    const btnFor = (vid) => byData(host, 'data-bkd-cancel').find((n) => n.attrs['data-bkd-cancel'] === vid);
    assert.ok(btnFor('101'), 'у подтверждённой записи нет кнопки отмены');
    assert.equal(btnFor('102'), undefined, 'у «Пришёл» есть кнопка отмены');

    btnFor('101').click();   // отказ в подтверждении
    await tick(60);
    assert.equal(cancelled.length, 0, 'отменили без согласия');
    assert.equal(wizard.length, 0, 'кнопка отмены открыла окно услуг');

    answer = true;
    const before = rpcArgs.filter(([n]) => n === 'calendar_slots').length;
    btnFor('101').click();
    await tick(120);
    assert.equal(cancelled.length, 1, 'запись не отменена');
    assert.equal(cancelled[0][1], 'cancelled');
    assert.equal(wizard.length, 0, 'кнопка отмены открыла окно услуг');
    assert.ok(rpcArgs.filter(([n]) => n === 'calendar_slots').length > before, 'после отмены день не перечитан');
  } finally {
    globalThis.window.confirm = prevConfirm;
  }
});
