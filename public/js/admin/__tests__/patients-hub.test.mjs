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
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push(name);
    if (name === 'queue_board') return ok({ data: JSON.parse(JSON.stringify(BOARD)) });
    return ok({ data: null });
  }
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    const op = (body && body.op) || 'select';
    const rows = { patients: PATIENTS }[table] || [];
    return ok({ data: op === 'select' ? JSON.parse(JSON.stringify(rows)) : null, count: rows.length });
  }
  return ok({ data: null });
};

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const { renderPatientsHub, mountCalendarInto } = await import('../views/patients-hub.js');
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
  sections: ['patients', 'registration', 'crm', 'cashier', 'dashboard'],
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
  assert.deepEqual(btns.map(tabLabel), ['Список', 'Очередь', 'Записи'], 'полоса вкладок не та');
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
  assert.deepEqual(btns.map((b) => b.attrs.tabindex), ['0', '-1', '-1']);
  const press = (b, key) => b.dispatchEvent({ type: 'keydown', key, preventDefault() {} });

  press(btns[0], 'ArrowRight'); await tick();
  assert.equal(hub.activeTab(), 'queue');
  press(btns[1], 'ArrowRight'); await tick();
  assert.equal(hub.activeTab(), 'calendar');
  press(btns[2], 'ArrowRight'); await tick();
  assert.equal(hub.activeTab(), 'list', 'стрелка вправо с последней вкладки не вернулась к первой');
  press(btns[0], 'ArrowLeft'); await tick();
  assert.equal(hub.activeTab(), 'calendar');
  press(btns[2], 'Home'); await tick();
  assert.equal(hub.activeTab(), 'list');
  press(btns[0], 'End'); await tick();
  assert.equal(hub.activeTab(), 'calendar');
  // Активная вкладка — единственная в порядке обхода, и она же помечена.
  assert.deepEqual(tabButtons(box).map((b) => b.attrs['aria-selected']), ['false', 'false', 'true']);
  assert.deepEqual(tabButtons(box).map((b) => b.attrs.tabindex), ['-1', '-1', '0']);
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
  assert.deepEqual(tabButtons(box).map(tabLabel), ['Список', 'Очередь', 'Записи'],
    'регистратура недосчиталась вкладок');
  hub.destroy();

  // А роль БЕЗ картотеки календарь по-прежнему не открывает — следствие не
  // должно превратиться во всеобщий доступ.
  setEffectiveFromRole({ name: 'lab', permissions: { sections: ['labs'], levels: { labs: 'editor' } } });
  assert.equal(isModuleAllowed('appointments'), false);
  assert.equal(isRouteAllowed('appointments'), false);
  setFullAccess('Admin');
});

test('вкладка «Записи» монтируется, даже когда календаря ещё нет', async () => {
  reset();
  const host = mk('div');
  const okFalse = await mountCalendarInto(host, ctxFor(), async () => { throw new Error('half-written'); });
  assert.equal(okFalse, false);
  const said = textOf(host);
  assert.ok(said.includes('Календарь записи готовится'), 'вкладка молчит о том, что экран недоступен');
  assert.ok(said.includes('очередь работают как обычно'), 'не сказано, что остальные вкладки живы');

  // И в самом хосте: поломка календаря не уносит список и очередь.
  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => { throw new Error('half-written'); } });
  const btns = tabButtons(box);
  btns[2].click(); await tick();
  assert.equal(hub.activeTab(), 'calendar');
  assert.ok(textOf(panelFor(box, 'calendar')).includes('Календарь записи готовится'));
  btns[0].click(); await tick();
  assert.ok(textOf(panelFor(box, 'list')).includes('Эргашев Жахонгир'), 'список пострадал из-за календаря');
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
  setEffectiveFromRole(NURSE);
  // Роль подобрана верно: раздел «Пациенты» ей открыт (иначе мы проверяли бы
  // маршрутный гейт, а не гейт действия), а ключа регистрации нет.
  assert.strictEqual(isRouteAllowed('patients'), true, 'медсестре закрыли саму картотеку — проверяем не то');
  assert.strictEqual(isModuleAllowed('registration'), false, 'у медсестры оказался ключ регистрации');
  assert.strictEqual(canCreatePatient(), false);

  const box = mk('div');
  const hub = await renderPatientsHub(box, ctxFor(), { calendarLoader: async () => async () => {} });

  // Вход 1 — кнопка «Создать пациента» в шапке списка (views/patients.js).
  const createBtn = walk(box).find((n) => n.attrs['data-onb'] === 'create-patient');
  assert.ok(createBtn, 'на вкладке «Список» нет кнопки создания пациента');
  createBtn.click();
  assert.strictEqual(openDialogs('patient-create').length, 0, 'кнопка шапки открыла окно в обход права');
  assert.strictEqual(openDialogs('access-denied').length, 1, 'кнопка шапки промолчала — это читается как поломка');

  // Вход 2 — ссылка «Создать нового пациента?» в пустом состоянии списка.
  document.body.children.length = 0;
  const emptyLink = walk(box).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'link-btn'));
  assert.ok(emptyLink, 'в пустом состоянии списка нет ссылки создания');
  emptyLink.click();
  assert.strictEqual(openDialogs('patient-create').length, 0, 'пустое состояние открыло окно в обход права');
  assert.strictEqual(openDialogs('access-denied').length, 1, 'пустое состояние промолчало');

  // Вход 3 — «Калькулятор услуг» отдаёт окну подбора обратный вызов
  // onCreatePatient, и это ТА ЖЕ функция openCreatePatient, что у двух входов
  // выше: в views/patients.js ровно ОДИН вызов openPatientCreateModal, через
  // который проходят все входы экрана. Четвёртому пути взяться неоткуда — и
  // это утверждение про «неоткуда».
  const src = read('public/js/admin/views/patients.js');
  assert.strictEqual((src.match(/openPatientCreateModal\(/g) || []).length, 1,
    'в списке пациентов появился второй вызов окна — он пройдёт мимо гейта');
  assert.strictEqual((src.match(/=> openCreatePatient\(\)/g) || []).length, 3,
    'входов создания пациента стало не три — тест перечисляет не все');
  assert.ok(/onCreatePatient: \(\) => openCreatePatient\(\)/.test(src),
    'калькулятор услуг больше не ходит через общий вход');

  // И сама дверь, куда ведут все трое, отвечает отказом.
  document.body.children.length = 0;
  assert.strictEqual(openPatientCreateModal({}), null, 'дверь пустила роль без права');
  assert.strictEqual(openDialogs('access-denied').length, 1);

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
