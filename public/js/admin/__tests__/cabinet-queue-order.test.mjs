// CABINET_ACTIVE_FIRST_V1 (2026-10-29) — «МОИ ПРИЁМЫ»: СНАЧАЛА ТО, С ЧЕМ РАБОТАТЬ.
//
// Владелец: «Идёт приём» сверху, потом «готов к осмотру», потом «ожидает
// кассу»; осмотренных при открытии кабинета не видно.
//
// Что здесь закреплено:
//   1. ПОРЯДОК — чистая функция sortQueue (как sortInpatients): идёт приём →
//      касса закончила («В очереди» или «Запланирован» при оплаченном или
//      частично оплаченном счёте) → ждёт кассу → осмотрен. Внутри группы —
//      порядок, как пришёл с сервера (новые записи сверху).
//   2. «ГОТОВ К ОСМОТРУ» — ТО ЖЕ ПРАВИЛО, ЧТО ОТКРЫВАЕТ ПРИЁМ: строка, которую
//      список поставил к готовым, открывается и получает «Начать»; ждущая
//      кассу — отказ и «Ожидает кассу».
//   3. ФИЛЬТР «Активные» стоит первым и выбран при КАЖДОМ открытии кабинета;
//      внутри открытого кабинета выбор держится.
//   4. ПЛИТКА «В очереди / готовы к осмотру» ведёт на «Активные», и число на
//      ней равно числу строк под ней (прежде она считала «Идёт приём», а
//      щелчок его прятал).
//   5. «Осмотрен» в выпадающем списке называется «Завершённые», а подпись
//      строки остаётся «Осмотрен».

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
 // Очередь кабинета красит тело в гнездо ПО id (containerRef.querySelector
 // ('#svc-body')): заглушка «всегда null» оставила бы список пустым.
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
// Уведомления (toast) пишутся в #toast — стенд их запоминает.
const TOASTS = [];
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return id === 'toast' ? toastEl : null; },
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
  easymedSetTabSub() {},
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState(st) { this.state = st; }, pushState(st) { this.state = st; } };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const buttonByText = (root, re) => walk(root).find((n) => n.tagName === 'BUTTON' && re.test(textOf(n)));
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// ПОСЕВ. Девять услуг одного врача, все — на сегодня. Сервер отдаёт их новыми
// сверху (created_at по убыванию) — в том порядке, в каком они записаны ниже.
// ---------------------------------------------------------------------------
const DOC = { id: 'u-doc', full_name: 'Каримова Азиза', specialty: 'Терапевт', is_doctor: true, active: true, role: 'doctor' };
const SVC = { name: 'Приём терапевта', type: 'consultation', duration_minutes: 30,
              service_types: { name: 'Консультация' }, departments: { kind: 'consultation' } };
const VISIT_DAY = (() => { const d = new Date(); d.setHours(9, 0, 0, 0); return d.toISOString(); })();
let seq = 0;
const created = () => { const d = new Date(); d.setHours(8, 59 - (seq++), 0, 0); return d.toISOString(); };
const vs = (id, status, last, first, invoiceItemId = null) => ({
  id, status, quantity: 1, unit_price: 100000, total: 100000, created_at: created(),
  invoice_item_id: invoiceItemId, visit_id: 'v-' + id, service_id: 's-1', doctor_id: 'u-doc',
  consultation_type_id: null, sync_origin: null, services: SVC, consultation_types: null,
  users: { full_name: DOC.full_name, specialty: DOC.specialty, rooms: null },
  visits: { visit_date: VISIT_DAY, patient_id: 'p-' + id, status: 'arrived',
            patients: { full_name: last + ' ' + first, last_name: last, first_name: first, mrn: 'MRN-' + id, phone: '' } },
});
const VS_ROWS = [
  vs('q1', 'queued',      'Аминов',     'Олим'),
  vs('c1', 'completed',   'Бакиев',     'Санжар'),
  vs('a1', 'added',       'Валиева',    'Дилноза', 'ii-unpaid'),
  vs('p1', 'in_progress', 'Гаипов',     'Тимур'),
  vs('a2', 'added',       'Давлатова',  'Мохира',  'ii-paid'),
  vs('a3', 'added',       'Ергашев',    'Шухрат',  'ii-partial'),
  vs('a4', 'added',       'Жураев',     'Анвар'),
  vs('q2', 'queued',      'Зокиров',    'Бобур'),
  vs('c2', 'completed',   'Ибрагимова', 'Нигора'),
];
const ITEM_ROWS = [
  { id: 'ii-unpaid',  invoices: { status: 'unpaid' } },
  { id: 'ii-paid',    invoices: { status: 'paid' } },
  { id: 'ii-partial', invoices: { status: 'partial' } },
];
const NAMES = VS_ROWS.map((r) => r.visits.patients.full_name);
// Ожидаемый порядок «Активных»: идёт приём; готовы к осмотру (очередь и
// оплаченные / частично оплаченные «Запланирован») — как пришли; ждут кассу.
const ACTIVE_ORDER = ['Гаипов Тимур', 'Аминов Олим', 'Давлатова Мохира', 'Ергашев Шухрат', 'Зокиров Бобур',
                      'Валиева Дилноза', 'Жураев Анвар'];
const DONE_ORDER = ['Бакиев Санжар', 'Ибрагимова Нигора'];

function matches(row, f) {
  if (f.or) return true;
  const v = row[f.col];
  switch (f.op) {
    case 'eq':  return String(v) === String(f.val);
    case 'is':  return f.val === null ? (v === null || v === undefined) : v === f.val;
    case 'in':  return (f.val || []).map(String).includes(String(v));
    case 'gte': return String(v) >= String(f.val);
    case 'lt':  return String(v) <  String(f.val);
    default:    return true;
  }
}
let ROWS = VS_ROWS;   // тест «пустые Активные» подменяет посев на время своего прогона
const TABLES = () => ({ users: [DOC], visit_services: ROWS, invoice_items: ITEM_ROWS, visits: [], recommended_services: [], admissions: [], patients: [] });
globalThis.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (String(url).startsWith('/api/db')) {
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

const cabinet = await import('../views/consultation.js');
const perms = await import('../permissions.js');
perms.setFullAccess('test');
window.easymed.state.user = { ...DOC, is_admin: false, is_super_admin: false };

const NAV = [];
async function openWork() {
  NAV.length = 0;
  const root = mk('div');
  await cabinet.renderConsultation(root, { onNavigate: (v, p) => NAV.push([v, p]), tabId: 'consultation', payload: { sub: 'work' } });
  await tick(60);
  return root;
}
const statusSelect = (root) => walk(root).find((n) => n.tagName === 'SELECT');
const selectedStatus = (root) => statusSelect(root).value;
const pickStatus = (root, value) => { const sel = statusSelect(root); sel.dispatchEvent({ type: 'change', target: { value }, currentTarget: sel }); };
const bodyRows = (root) => { const tb = walk(root).find((n) => n.tagName === 'TBODY'); return tb ? tb.children.filter((n) => n.tagName === 'TR') : []; };
const nameOf = (tr) => NAMES.find((n) => textOf(tr).includes(n)) || null;
const visibleNames = (root) => bodyRows(root).map(nameOf);
const svcCount = (root) => walk(root).find((n) => n.attrs && n.attrs.id === 'svc-count').textContent;
const tileByLabel = (root, label) => byClass(root, 'ws-kpi-card').find((c) => textOf(c).includes(label));
const tileValue = (tile) => textOf(byClass(tile, 'ws-kpi-val')[0]).trim();

// ===========================================================================
test('sortQueue: идёт приём → готов к осмотру → ждёт кассу → осмотрен; внутри группы — как пришло', () => {
  const rows = [
    { id: 'c1', status: 'completed' },
    { id: 'a-unpaid', status: 'added', invoiceStatus: 'unpaid' },
    { id: 'q1', status: 'queued' },
    { id: 'p1', status: 'in_progress' },
    { id: 'a-paid', status: 'added', invoiceStatus: 'paid' },
    { id: 'a-none', status: 'added', invoiceStatus: null },
    { id: 'p2', status: 'in_progress' },
    { id: 'a-part', status: 'added', invoiceStatus: 'partial' },
    { id: 'q2', status: 'queued' },
    { id: 'c2', status: 'completed' },
  ];
  const before = rows.map((r) => r.id);
  const out = cabinet.sortQueue(rows);
  assert.deepStrictEqual(out.map((r) => r.id),
    ['p1', 'p2', 'q1', 'a-paid', 'a-part', 'q2', 'a-unpaid', 'a-none', 'c1', 'c2']);
  assert.deepStrictEqual(rows.map((r) => r.id), before, 'sortQueue переставил исходный массив');
  assert.notStrictEqual(out, rows, 'sortQueue вернул тот же массив, а не копию');
  assert.deepStrictEqual(cabinet.sortQueue([]), []);
});

test('«касса закончила» — одно правило: «Запланирован» отпускает только оплаченный или частично оплаченный счёт', () => {
  const { cashierReleased, queueRank } = cabinet;
  assert.strictEqual(cashierReleased({ status: 'added', invoiceStatus: 'paid' }), true);
  assert.strictEqual(cashierReleased({ status: 'added', invoiceStatus: 'partial' }), true);
  assert.strictEqual(cashierReleased({ status: 'added', invoiceStatus: 'unpaid' }), false);
  assert.strictEqual(cashierReleased({ status: 'added', invoiceStatus: null }), false);
  for (const s of ['queued', 'in_progress', 'completed']) assert.strictEqual(cashierReleased({ status: s }), true, s);
  assert.deepStrictEqual(
    [{ status: 'in_progress' }, { status: 'queued' }, { status: 'added', invoiceStatus: 'partial' },
     { status: 'added', invoiceStatus: 'unpaid' }, { status: 'completed' }, { status: 'cancelled' }].map(queueRank),
    [0, 1, 1, 2, 3, 4], 'неизвестный статус — в конец, а не потерян');
});

test('кабинет открывается на «Активных»: идёт приём, потом готовые к осмотру, потом ждущие кассу; осмотренных нет', async () => {
  const root = await openWork();
  assert.strictEqual(selectedStatus(root), 'active', 'кабинет открылся не на «Активных»');
  assert.deepStrictEqual(visibleNames(root), ACTIVE_ORDER);
  assert.strictEqual(svcCount(root), '7', '«Показано» считает не то, что видно');
  // Кнопка строки — по тому же правилу, что и место строки.
  const rows = bodyRows(root);
  assert.ok(textOf(rows[0]).includes('Продолжить'), 'идёт приём — «Продолжить»');
  for (const tr of rows.slice(1, 5)) assert.ok(textOf(tr).includes('Начать'), nameOf(tr) + ': готов к осмотру, а «Начать» нет');
  for (const tr of rows.slice(5)) assert.ok(textOf(tr).includes('Ожидает кассу'), nameOf(tr) + ': ждёт кассу, а подписи нет');
  // «Все статусы» — осмотренные в самом конце, остальное как в «Активных».
  pickStatus(root, 'all');
  assert.deepStrictEqual(visibleNames(root), [...ACTIVE_ORDER, ...DONE_ORDER]);
});

test('выпадающий список: «Активные» первыми; «Осмотрен» называется «Завершённые», строка — по-прежнему «Осмотрен»', async () => {
  const root = await openWork();
  const opts = statusSelect(root).children.filter((n) => n.tagName === 'OPTION');
  assert.deepStrictEqual(opts.map((o) => o.attrs.value), ['active', 'all', 'queued', 'in_progress', 'completed']);
  assert.deepStrictEqual(opts.map((o) => textOf(o).trim()), ['Активные', 'Все статусы', 'В очереди', 'Идёт приём', 'Завершённые']);
  assert.ok('selected' in opts[0].attrs, 'при открытии отмечен не пункт «Активные»');
  pickStatus(root, 'completed');
  assert.deepStrictEqual(visibleNames(root), DONE_ORDER);
  for (const tr of bodyRows(root)) assert.ok(textOf(tr).includes('Осмотрен'), nameOf(tr) + ': подпись строки перестала быть «Осмотрен»');
});

test('«Активные» выбираются при КАЖДОМ открытии кабинета, а внутри открытого кабинета выбор держится', async () => {
  const root = await openWork();
  pickStatus(root, 'all');
  assert.strictEqual(selectedStatus(root), 'all');
  // Внутри кабинета: на дашборд и обратно — выбор тот же.
  buttonByText(root, /Дашборд/).click();
  await tick(60);
  buttonByText(root, /Мои приёмы/).click();
  await tick(60);
  assert.strictEqual(selectedStatus(root), 'all', 'переключение вкладок сбросило фильтр');
  assert.strictEqual(visibleNames(root).length, 9);
  // Новое открытие кабинета — снова «Активные».
  const again = await openWork();
  assert.strictEqual(selectedStatus(again), 'active', 'новое открытие кабинета не вернуло «Активные»');
  assert.deepStrictEqual(visibleNames(again), ACTIVE_ORDER);
});

test('плитка «В очереди / готовы к осмотру» ведёт на «Активные»: число на плитке = строк под ней', async () => {
  const root = await openWork();
  pickStatus(root, 'completed');
  const tile = tileByLabel(root, 'В очереди / готовы к осмотру');
  assert.ok(tile, 'нет плитки «В очереди / готовы к осмотру»');
  assert.strictEqual(tileValue(tile), '7');
  tile.click();
  assert.strictEqual(selectedStatus(root), 'active', 'щелчок по плитке ведёт не на «Активные»');
  assert.strictEqual(visibleNames(root).length, 7, 'число на плитке и строки под ней разошлись');
  assert.ok(visibleNames(root).includes('Гаипов Тимур'), '«Идёт приём» посчитан на плитке, а в список не попал');
  assert.ok(hasClass(tileByLabel(root, 'В очереди / готовы к осмотру'), 'on'), 'плитка «Активных» не отмечена');
});

test('пустые «Активные» в конце дня говорят, где осмотренные, а не «записей нет»', async (t) => {
  ROWS = VS_ROWS.filter((r) => r.status === 'completed');
  t.after(() => { ROWS = VS_ROWS; });
  const root = await openWork();
  const body = walk(root).find((n) => n.attrs && n.attrs.id === 'svc-body');
  const empty = byClass(body, 'empty')[0];
  assert.ok(empty && textOf(empty).includes('Активных приёмов нет. Осмотренные — в фильтре «Завершённые».'),
    'пустые «Активные» выглядят как пустой день: ' + (empty ? textOf(empty).trim() : 'подписи нет'));
  pickStatus(root, 'completed');
  assert.deepStrictEqual(visibleNames(root), DONE_ORDER);
});

test('приём открывается по тому же правилу: ждущий кассу — отказ, оплаченный «Запланирован» — открывается', async () => {
  const root = await openWork();
  const nameBtn = (name) => walk(root).find((n) => n.tagName === 'BUTTON' && textOf(n).trim() === name);
  TOASTS.length = 0;
  nameBtn('Валиева Дилноза').click();
  await tick();
  assert.ok(TOASTS.some((m) => m.includes('Услуга ещё не проведена кассой')), 'ждущий кассу открылся: ' + TOASTS.join(' | '));
  assert.strictEqual(NAV.length, 0, 'ждущий кассу открыт');
  nameBtn('Давлатова Мохира').click();
  await tick(60);
  assert.deepStrictEqual(NAV.map(([v, p]) => [v, p.serviceId]), [['service-workspace', 'a2']], 'оплаченный «Запланирован» не открылся');
});
