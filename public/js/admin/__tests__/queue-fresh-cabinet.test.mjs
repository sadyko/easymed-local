// QUEUE_FRESH_V1 (3.21.0) — «МОИ ПРИЁМЫ»: ЗАВЕРШЁННЫЙ ПРИЁМ НЕ ВИСИТ В ОЧЕРЕДИ.
//
// Кабинет — панель из кэша оболочки: при возврате его показывают, а не
// перерисовывают (admin.js, страж app-shell.test.mjs). Владелец: после
// «Завершить приём» строка «Идёт приём / Продолжить» висела сверху до F5.
//
// Что здесь закреплено:
//   1. Окно приёма сообщило «строка завершена» (queue-fresh.js) — строка СРАЗУ
//      уходит из «Активных»; возврат ({ sub: 'work' } → ctx.onPayload)
//      перечитывает очередь, а фильтр и поиск врача остаются.
//   2. Возврат без сообщения (черновик, «Пауза») — ничего не перечитывается:
//      строка остаётся «Идёт приём» сверху.
//   3. Сбой перечитывания — прежний список на месте, следующий возврат пробует снова.
// Стенд тот же, что у cabinet-queue-order.test.mjs: честный /api/db с фильтрами.

import { test } from 'node:test';
import assert from 'node:assert';

// --- fake DOM (тот же харнесс, что у cabinet-queue-order.test.mjs) ----------
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
// ПОСЕВ: четыре услуги одного врача на сегодня (сервер отдаёт новые сверху).
// ---------------------------------------------------------------------------
const DOC = { id: 'u-doc', full_name: 'Каримова Азиза', specialty: 'Терапевт', is_doctor: true, active: true, role: 'doctor' };
const SVC = { name: 'Приём терапевта', type: 'consultation', duration_minutes: 30,
              service_types: { name: 'Консультация' }, departments: { kind: 'consultation' } };
const dayAt = (offset, hh = 9) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(hh, 0, 0, 0); return d.toISOString(); };
const TODAY = dayAt(0);
let seq = 0;
const created = () => { const d = new Date(); d.setHours(8, 59 - (seq++), 0, 0); return d.toISOString(); };
const vs = (id, status, last, first, visitDate = TODAY) => ({
  id, status, quantity: 1, unit_price: 100000, total: 100000, created_at: created(), price_tier: null,
  invoice_item_id: null, visit_id: 'v-' + id, service_id: 's-1', doctor_id: 'u-doc',
  consultation_type_id: null, sync_origin: null, services: SVC, consultation_types: null,
  users: { full_name: DOC.full_name, specialty: DOC.specialty, rooms: null },
  visits: { visit_date: visitDate, patient_id: 'p-' + id, status: 'arrived',
            patients: { full_name: last + ' ' + first, last_name: last, first_name: first, mrn: 'MRN-' + id, phone: '' } },
});
const BASE = [
  vs('q1', 'queued',      'Аминов',  'Олим'),
  vs('p1', 'in_progress', 'Гаипов',  'Тимур'),
  vs('q2', 'queued',      'Зокиров', 'Бобур'),
  vs('c1', 'completed',   'Бакиев',  'Санжар'),
];
let ROWS = BASE.map((r) => ({ ...r }));
const reseed = () => { ROWS = BASE.map((r) => ({ ...r })); };
const setServerStatus = (id, status) => { ROWS = ROWS.map((r) => (r.id === id ? { ...r, status } : r)); };
let VISITS = [];
let FAIL_QUEUE = false;
let QUEUE_READS = 0;
let REFUNDED = new Set();   // строки, за которые касса вернула деньги (REFUND_ANY_V1, окно «Платежи»)

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
const TABLES = () => ({ users: [DOC], visit_services: ROWS, invoice_items: [], visits: VISITS, recommended_services: [], admissions: [], patients: [] });
globalThis.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (String(url).startsWith('/api/db')) {
    // Чтение ОЧЕРЕДИ кабинета — то, у которого есть присоединение consultation_types(…).
    const isQueue = body.table === 'visit_services' && /consultation_types\(/.test(String(body.columns || ''));
    if (isQueue) {
      // DIAG_ROUTE_V1 (D7) — очередь читается двумя запросами (открытые строки и окно
      // завершённых); одно перечитывание — один запрос открытых.
      if ((body.filters || []).some((f) => f.col === 'status' && f.op === 'in')) QUEUE_READS++;
      if (FAIL_QUEUE) return { ok: false, status: 500, json: async () => ({ error: { message: 'сбой сервера' } }) };
    }
    let rows = TABLES()[body.table] || [];
    for (const f of (body.filters || [])) rows = rows.filter((r) => matches(r, f));
    for (const o of (body.order || []).slice().reverse()) {
      rows = rows.slice().sort((a, b) => (String(a[o.col]) < String(b[o.col]) ? -1 : String(a[o.col]) > String(b[o.col]) ? 1 : 0) * (o.asc ? 1 : -1));
    }
    if (body.limit) rows = rows.slice(0, body.limit);
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  if (String(url) === '/api/rpc/refunded_lines') {
    return { ok: true, json: async () => ({ data: { line_ids: (body.line_ids || []).filter((id) => REFUNDED.has(Number(id))) } }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const cabinet = await import('../views/consultation.js');
const QF = await import('../queue-fresh.js');
const perms = await import('../permissions.js');
perms.setFullAccess('test');
window.easymed.state.user = { ...DOC, is_admin: false, is_super_admin: false };

let HOOK = null;
const NAV = [];
async function openWork() {
  NAV.length = 0;
  HOOK = null;
  const root = mk('div');
  await cabinet.renderConsultation(root, {
    onNavigate: (v, p) => NAV.push([v, p]), tabId: 'consultation', payload: { sub: 'work' },
    onPayload: (fn) => { HOOK = fn; },
  });
  await tick(60);
  return root;
}
const NAMES = () => ROWS.map((r) => r.visits.patients.full_name);
const statusSelect = (root) => walk(root).find((n) => n.tagName === 'SELECT');
const selectedStatus = (root) => statusSelect(root).value;
const pickStatus = (root, value) => { const sel = statusSelect(root); sel.dispatchEvent({ type: 'change', target: { value }, currentTarget: sel }); };
const bodyRows = (root) => { const tb = walk(root).find((n) => n.tagName === 'TBODY'); return tb ? tb.children.filter((n) => n.tagName === 'TR') : []; };
const nameOf = (tr) => NAMES().find((n) => textOf(tr).includes(n)) || null;
const visibleNames = (root) => bodyRows(root).map(nameOf).filter(Boolean);
const rowOf = (root, name) => bodyRows(root).find((tr) => nameOf(tr) === name);
const searchInput = (root) => walk(root).find((n) => n.tagName === 'INPUT');
async function typeSearch(root, value) {
  const inp = searchInput(root);
  inp.dispatchEvent({ type: 'input', target: { value }, currentTarget: inp });
  await tick(600);   // поиск — с задержкой (SEARCH_DEBOUNCE_V1, 500 мс)
}
const tileByLabel = (root, label) => byClass(root, 'ws-kpi-card').find((c) => textOf(c).includes(label));
const tileValue = (tile) => textOf(byClass(tile, 'ws-kpi-val')[0]).trim();

// ===========================================================================
test('подписан приём: строка СРАЗУ уходит из «Активных»; возврат перечитывает очередь, фильтр и поиск врача на месте', async (t) => {
  const root = await openWork();
  t.after(async () => { reseed(); await typeSearch(root, ''); });   // поиск живёт в модуле — вернуть соседним проверкам
  assert.strictEqual(typeof HOOK, 'function', 'кабинет не подписан на возврат (ctx.onPayload)');
  assert.deepStrictEqual(visibleNames(root), ['Гаипов Тимур', 'Аминов Олим', 'Зокиров Бобур'], 'стенд: «Идёт приём» не сверху');
  await typeSearch(root, 'Гаипов');
  assert.deepStrictEqual(visibleNames(root), ['Гаипов Тимур']);
  // Окно приёма подписало строку: сервер уже 'completed', кабинету сообщено.
  setServerStatus('p1', 'completed');
  QF.noteLineStatus('p1', 'completed');
  assert.deepStrictEqual(visibleNames(root), [], 'завершённый приём остался в «Активных» до возврата');
  const reads = QUEUE_READS;
  HOOK({ sub: 'work' });
  await tick(80);
  assert.strictEqual(QUEUE_READS, reads + 1, 'возврат не перечитал очередь');
  assert.strictEqual(selectedStatus(root), 'active', 'возврат сбросил фильтр');
  assert.strictEqual(searchInput(root).value, 'Гаипов', 'возврат сбросил поиск');
  assert.deepStrictEqual(visibleNames(root), []);
  pickStatus(root, 'completed');
  assert.deepStrictEqual(visibleNames(root), ['Гаипов Тимур'], 'завершённый приём не в «Завершённых»');
  assert.ok(textOf(rowOf(root, 'Гаипов Тимур')).includes('Осмотрен'));
  assert.strictEqual(tileValue(tileByLabel(root, 'Осмотрено сегодня')), '2');
});

// Ревью m1 — возврат боковым меню или «Назад» onPayload не зовёт: строки уже верные
// (applyLineStatus), а плитки над ними стояли прежними до следующей перерисовки.
test('сообщение о статусе строки пересчитывает и плитки — без возврата (боковое меню, «Назад»)', async (t) => {
  t.after(reseed);
  const root = await openWork();
  const review = () => tileValue(tileByLabel(root, 'В очереди / готовы к осмотру'));
  const seen = () => tileValue(tileByLabel(root, 'Осмотрено сегодня'));
  assert.deepStrictEqual([review(), seen()], ['3', '1'], 'стенд: плитки до подписи');
  setServerStatus('p1', 'completed');
  QF.noteLineStatus('p1', 'completed');   // HOOK не зовётся — так возвращает боковое меню
  assert.deepStrictEqual(visibleNames(root), ['Аминов Олим', 'Зокиров Бобур']);
  assert.deepStrictEqual([review(), seen()], ['2', '2'], 'плитки остались прежними после подписи');
  assert.strictEqual(byClass(root, 'ws-kpi').length, 1, 'плитки нарисованы второй раз, а не заменены');
});

test('возврат без сообщения (черновик, «Пауза») — очередь не перечитывается, «Идёт приём» сверху с «Продолжить»', async (t) => {
  t.after(reseed);
  const root = await openWork();
  const reads = QUEUE_READS;
  HOOK({ sub: 'work' });
  await tick(80);
  assert.strictEqual(QUEUE_READS, reads, 'возврат без изменений перечитал очередь');
  const rows = bodyRows(root);
  assert.strictEqual(nameOf(rows[0]), 'Гаипов Тимур');
  assert.ok(textOf(rows[0]).includes('Идёт приём') && textOf(rows[0]).includes('Продолжить'), 'черновик выбил строку из «Идёт приём»');
});

test('сбой перечитывания: прежний список на месте, флаг «устарела» остаётся — следующий возврат пробует снова', async (t) => {
  t.after(() => { reseed(); FAIL_QUEUE = false; });
  const root = await openWork();
  setServerStatus('q1', 'completed');
  QF.noteLineStatus('q1', 'completed');
  FAIL_QUEUE = true;
  HOOK({ sub: 'work' });
  await tick(80);
  assert.deepStrictEqual(visibleNames(root), ['Гаипов Тимур', 'Зокиров Бобур'], 'сбой чтения опустошил список');
  FAIL_QUEUE = false;
  const reads = QUEUE_READS;
  HOOK({ sub: 'work' });
  await tick(80);
  assert.strictEqual(QUEUE_READS, reads + 1, 'после сбоя очередь больше не перечитывается');
  pickStatus(root, 'completed');
  assert.deepStrictEqual(visibleNames(root), ['Аминов Олим', 'Бакиев Санжар']);
});

// --- «Обновить» у очереди ---------------------------------------------------
const rangeBtn = (root, label) => walk(root).find((n) => n.attrs && n.attrs.id === 'svc-range').children.find((b) => textOf(b).trim() === label);

test('«Обновить» перечитывает очередь, а фильтр, период и поиск врача остаются', async (t) => {
  const root = await openWork();
  // Поиск и период живут в модуле кабинета и между открытиями — вернуть их соседним проверкам.
  t.after(async () => { reseed(); await typeSearch(root, ''); rangeBtn(root, 'Период').click(); await tick(); });
  pickStatus(root, 'all');
  rangeBtn(root, 'Неделя').click();
  await tick();
  await typeSearch(root, 'Аминов');
  assert.deepStrictEqual(visibleNames(root), ['Аминов Олим']);
  setServerStatus('q1', 'completed');   // другой экран (касса, второе окно) завершил строку
  const btn = buttonByText(root, /Обновить/);
  assert.ok(btn, 'у очереди нет кнопки «Обновить»');
  assert.strictEqual(btn.attrs.title, 'Перечитать список приёмов');
  const reads = QUEUE_READS;
  btn.click();
  await tick(80);
  assert.strictEqual(QUEUE_READS, reads + 1, '«Обновить» не перечитал очередь');
  assert.strictEqual(selectedStatus(root), 'all', '«Обновить» сбросил фильтр');
  assert.ok(hasClass(rangeBtn(root, 'Неделя'), 'on'), '«Обновить» сбросил период');
  assert.strictEqual(searchInput(root).value, 'Аминов', '«Обновить» сбросил поиск');
  assert.ok(textOf(rowOf(root, 'Аминов Олим')).includes('Осмотрен'), 'перечитанный статус не показан');
});

test('подписи «Обновить» — в словаре на трёх языках, uz/en без кириллицы', async () => {
  const { STRINGS } = await import('../i18n-strings.js');
  for (const key of ['Обновить', 'Перечитать список приёмов']) {
    const e = STRINGS[key];
    assert.ok(e && e.ru && e.uz && e.en, 'нет ключа словаря: ' + key);
    for (const lang of ['uz', 'en']) assert.doesNotMatch(e[lang], /[Ѐ-ӿ]/, key + ': ' + lang);
  }
});

// --- незавершённые прошлых дней ----------------------------------------------
const pastToggle = (root) => walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && 'data-past-toggle' in n.attrs);

test('незавершённые прошлых дней — внизу «Активных» свёрнутой группой; раскрывается; новое открытие кабинета её сворачивает', async (t) => {
  ROWS = [...BASE.map((r) => ({ ...r })),
    vs('o1', 'queued',      'Юсупов',   'Акмал', dayAt(-1)),
    vs('o2', 'in_progress', 'Хасанова', 'Лола',  dayAt(-3)),
    vs('o3', 'completed',   'Шарипов',  'Ильёс', dayAt(-1)),
    vs(905,  'queued',      'Рахимов',  'Анвар', dayAt(-2))];   // касса вернула деньги («Платежи» → «Вернуть услугу»)
  REFUNDED = new Set([905]);
  t.after(() => { reseed(); REFUNDED = new Set(); });
  const root = await openWork();
  assert.deepStrictEqual(visibleNames(root), ['Гаипов Тимур', 'Аминов Олим', 'Зокиров Бобур'],
    'вчерашние незавершённые стоят среди сегодняшней работы');
  const head = pastToggle(root);
  assert.ok(head, 'группы «Незавершённые с прошлых дней» нет');
  assert.ok(textOf(head).includes('Незавершённые с прошлых дней · 2'), textOf(head));
  assert.strictEqual(head.attrs['aria-expanded'], 'false', 'группа открылась раскрытой');
  head.click();
  assert.deepStrictEqual(visibleNames(root), ['Гаипов Тимур', 'Аминов Олим', 'Зокиров Бобур', 'Хасанова Лола', 'Юсупов Акмал'],
    'раскрытая группа — не внизу или не те строки');
  assert.strictEqual(pastToggle(root).attrs['aria-expanded'], 'true');
  // «Все статусы» — без группы: строки на своих местах, как раньше.
  pickStatus(root, 'all');
  assert.strictEqual(pastToggle(root), undefined, 'группа видна вне «Активных»');
  assert.ok(visibleNames(root).includes('Юсупов Акмал') && visibleNames(root).includes('Шарипов Ильёс'));
  // Возвращённая строка — не работа (REFUND_ANY_V1): ни в «Активных», ни в группе; видна в «Все статусы».
  assert.ok(visibleNames(root).includes('Рахимов Анвар'), 'возвращённая строка пропала из «Все статусы»');
  // Новое открытие кабинета — группа снова свёрнута.
  const again = await openWork();
  assert.strictEqual(pastToggle(again).attrs['aria-expanded'], 'false');
  assert.ok(!visibleNames(again).includes('Юсупов Акмал'));
});

// Ревью m3 — «Активные», где сегодняшняя работа сделана, а остались только незавершённые
// прошлых дней: была одна свёрнутая группа без слов, а «Показано N» считало и спрятанные строки.
const svcBody = (root) => walk(root).find((n) => n.attrs && n.attrs.id === 'svc-body');
const shownCount = (root) => textOf(walk(root).find((n) => n.attrs && n.attrs.id === 'svc-count')).trim();
const EMPTY_ACTIVE = 'Активных приёмов нет. Осмотренные — в фильтре «Завершённые».';

test('«Активные» только с незавершёнными прошлых дней — подсказка над группой; «Показано» — без строк свёрнутой группы', async (t) => {
  ROWS = [vs('c9', 'completed', 'Бакиев', 'Санжар'), vs('o9', 'queued', 'Юсупов', 'Акмал', dayAt(-1))];
  t.after(reseed);
  const root = await openWork();
  assert.deepStrictEqual(visibleNames(root), [], 'вчерашняя строка — не в группе');
  assert.ok(pastToggle(root), 'группы «Незавершённые с прошлых дней» нет');
  const kids = svcBody(root).children;
  const hintAt = kids.findIndex((n) => hasClass(n, 'empty') && textOf(n).includes(EMPTY_ACTIVE));
  const tableAt = kids.findIndex((n) => n.tagName === 'TABLE');
  assert.ok(hintAt > -1, 'нет подсказки «Активных приёмов нет…»: ' + textOf(svcBody(root)));
  assert.ok(hintAt < tableAt, 'подсказка — не над группой');
  assert.strictEqual(shownCount(root), '0', '«Показано» считает строки свёрнутой группы');
  pastToggle(root).click();
  assert.strictEqual(shownCount(root), '1', 'раскрытая группа — строки на экране, «Показано» их не считает');   // ревью-2
  // Сегодня ничего не осмотрено — подсказка про «Завершённые» вела бы в пустой фильтр,
  // а «Нет записей за период» — неправда: строки есть в группе. Остаётся одна группа.
  ROWS = [vs('o9', 'queued', 'Юсупов', 'Акмал', dayAt(-1))];
  const bare = await openWork();
  assert.ok(pastToggle(bare));
  assert.ok(!byClass(bare, 'empty').length, 'подсказка без осмотренных: ' + byClass(bare, 'empty').map(textOf).join(' | '));
});

// Ревью-2 — «Показано N» считает ВИДИМЫЕ строки: свёрнутая группа прошлых дней в число не
// входит, раскрытая — входит (её строки на экране). Раньше раскрытая группа не считалась.
test('«Показано N» в «Активных» — видимые строки: свёрнутая группа прошлых дней не считается, раскрытая — считается', async (t) => {
  ROWS = [...BASE.map((r) => ({ ...r })), vs('o1', 'queued', 'Юсупов', 'Акмал', dayAt(-1)), vs('o2', 'in_progress', 'Хасанова', 'Лола', dayAt(-3))];
  t.after(reseed);
  const root = await openWork();
  assert.strictEqual(shownCount(root), '3', '«Показано» считает и свёрнутую группу');
  pastToggle(root).click();
  assert.strictEqual(shownCount(root), '5', 'раскрытая группа на экране, а «Показано» её не считает');
  pastToggle(root).click();
  assert.strictEqual(shownCount(root), '3', 'свёрнутая снова группа осталась в «Показано»');
  pickStatus(root, 'all');
  assert.strictEqual(shownCount(root), '6', '«Все статусы» — все строки');
});

test('isPastOpen / splitPastOpen: рабочая строка визита раньше сегодняшнего МЕСТНОГО дня; группа — только в «Активных»', () => {
  const now = new Date(2026, 10, 2, 10, 0);
  const at = (y, m, d, hh, mm = 0) => new Date(y, m, d, hh, mm).toISOString();
  const rows = [
    { id: 'a', status: 'queued',      visitDate: at(2026, 10, 1, 23, 50) },   // вчера поздно вечером
    { id: 'b', status: 'in_progress', visitDate: at(2026, 10, 2, 0, 30) },    // сегодня 00:30 — не прошлый день
    { id: 'c', status: 'completed',   visitDate: at(2026, 9, 30, 9) },        // завершён — не «незавершённый»
    { id: 'd', status: 'added',       visitDate: at(2026, 9, 28, 9) },
    { id: 'e', status: 'queued',      visitDate: null },
  ];
  assert.deepStrictEqual(rows.filter((r) => cabinet.isPastOpen(r, now)).map((r) => r.id), ['a', 'd']);
  const s = cabinet.splitPastOpen(rows, 'active', now);
  assert.deepStrictEqual([s.main.map((r) => r.id), s.past.map((r) => r.id)], [['b', 'c', 'e'], ['a', 'd']]);
  assert.deepStrictEqual(cabinet.splitPastOpen(rows, 'all', now).past, []);
});

test('подпись группы — в словаре на трёх языках, с {n}, uz/en без кириллицы', async () => {
  const { STRINGS } = await import('../i18n-strings.js');
  const e = STRINGS['Незавершённые с прошлых дней · {n}'];
  assert.ok(e && e.ru && e.uz && e.en, 'нет ключа словаря');
  for (const lang of ['uz', 'en']) {
    assert.doesNotMatch(e[lang], /[Ѐ-ӿ]/, lang);
    assert.ok(e[lang].includes('{n}'), lang + ' без {n}');
  }
});

// --- «Мой день» -------------------------------------------------------------
test('«Мой день»: подписанный приём сразу уходит в «Завершённые · N» — без F5', async (t) => {
  VISITS = BASE.filter((r) => r.status !== 'completed').map((r) => ({
    id: r.visit_id, visit_date: r.visits.visit_date, status: 'arrived', patient_id: r.visits.patient_id,
    service_id: 's-1', doctor_id: 'u-doc', sync_origin: null, duration_minutes: 30, room_id: null,
    patients: { id: r.visits.patient_id, mrn: r.visits.patients.mrn, full_name: r.visits.patients.full_name,
                last_name: r.visits.patients.last_name, first_name: r.visits.patients.first_name },
    services: { id: 's-1', name: 'Приём терапевта' }, rooms: null }));
  t.after(() => { VISITS = []; reseed(); });
  const root = await openWork();
  const dayCards = () => byClass(root, 'dd-appt');
  // REPEAT_VISIT_V1 — под лентой дня есть ещё группа «Записи вперёд · N» с той же
  // шапкой: «Завершённые» ищутся в самой ленте дня.
  const doneHead = () => byClass(byClass(root, 'dd-day-list')[0] || root, 'dd-done-h')[0];
  buttonByText(root, /Дашборд/).click();
  await tick(80);
  assert.ok(dayCards().some((c) => textOf(c).includes('Гаипов')), 'стенд: в «Моём дне» нет идущего приёма');
  assert.strictEqual(doneHead(), undefined, 'стенд: завершённых сегодня ещё нет');
  buttonByText(root, /Мои приёмы/).click();
  await tick(60);
  // Окно приёма подписало строку p1.
  setServerStatus('p1', 'completed');
  QF.noteLineStatus('p1', 'completed');
  buttonByText(root, /Дашборд/).click();   // сразу, без ожидания сервера
  assert.ok(doneHead() && textOf(doneHead()).includes('Завершённые · 1'), '«Мой день» не увёл завершённый приём в «Завершённые»');
  assert.ok(!dayCards().some((c) => textOf(c).includes('Гаипов')), 'завершённый приём остался в ленте дня');
  assert.ok(dayCards().some((c) => textOf(c).includes('Аминов')), 'незавершённые пропали из ленты');
  await tick(80);
  assert.ok(doneHead() && textOf(doneHead()).includes('Завершённые · 1'));
});

// Ревью m2 — строка, за которую касса вернула деньги (REFUND_ANY_V1, s.refunded), — не работа
// врача: визит с подписанной строкой и возвращённой строкой «в очереди» — завершён.
test('«Мой день»: подписанная строка + возвращённая строка «в очереди» — визит в «Завершённых»', async () => {
  const D = await import('../views/doctor-dashboard.js');
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const at = new Date(now); at.setHours(9, 0, 0, 0);
  const visits = [{ id: 'v1', at: at.toISOString(), status: 'arrived', patientId: 'p1', patientName: 'Пациент Тест' }];
  const day = (services) => D.foldDayColumn(D.buildDayColumn({ visits, services, now }));
  const signedPlusRefunded = day([
    { id: 1, visitId: 'v1', status: 'completed', refunded: false },
    { id: 2, visitId: 'v1', status: 'queued', refunded: true },
  ]);
  assert.deepStrictEqual([signedPlusRefunded.done.length, signedPlusRefunded.open.length], [1, 0],
    'визит с возвращённой строкой не ушёл в «Завершённые»');
  // Только возвращённые строки — работы не было: не «завершён».
  const onlyRefunded = day([{ id: 3, visitId: 'v1', status: 'queued', refunded: true }]);
  assert.deepStrictEqual([onlyRefunded.done.length, onlyRefunded.open.length], [0, 1], 'визит без работы — «завершён»');
  // Невозвращённая строка в очереди держит визит в ленте, как прежде.
  const stillOpen = day([
    { id: 4, visitId: 'v1', status: 'completed', refunded: false },
    { id: 5, visitId: 'v1', status: 'queued', refunded: false },
  ]);
  assert.deepStrictEqual([stillOpen.done.length, stillOpen.open.length], [0, 1]);
});
