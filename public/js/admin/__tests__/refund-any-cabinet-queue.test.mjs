// REFUND_ANY_V1 (2026-10-30, поправка 3) — «МОИ УСЛУГИ» / «МОИ ПРИЁМЫ»:
// ВОЗВРАЩЁННАЯ УСЛУГА — НЕ РАБОТА ВРАЧА.
//
// Касса вернула пациенту деньги за строку (refunded_lines: отметка
// pay_refund_releases 'out', строка без счёта), а статус у строки прежний —
// 'in_progress', 'queued' или 'added' («Оставить услугу в визите»). По одному
// статусу список врача ставил её в «Активные», а плитка «В очереди / готовы к
// осмотру» её считала.
//
// Что здесь закреплено:
//   1. Возвращённой строки нет в «Активные», «В очереди» (ожидающие) и «Идёт
//      приём», и плитка её не считает: число на плитке = строк под ней.
//   2. В «Все статусы» (и в «Завершённых») она видна с пометкой «Услуга
//      возвращена» (слова shared/refunded-line.js); у неначатой — ни «Начать»,
//      ни «Ожидает кассу».
//   3. Сервер спрашивается ОДИН раз на загрузку списка — номерами всех строк,
//      не по строке. Не ответил — список как был (подпись откажет сервер).
//   4. loadServices не меняется (его исходник закреплён dead-visit-lines).

import { test } from 'node:test';
import assert from 'node:assert';
import { REFUNDED_LINE_MARK } from '../../shared/refunded-line.js';

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
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { get() { return ''; }, set() {}, configurable: true });
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
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — язык выбирается при загрузке модуля
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
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// ПОСЕВ. Семь услуг одного врача на сегодня; номера строк — числа, как в базе.
// Возвращены: 11 (приём шёл), 13 (в очереди), 14 (оставлена в визите — 'added'
// без счёта), 15 (осмотрен).
// ---------------------------------------------------------------------------
const DOC = { id: 'u-doc', full_name: 'Каримова Азиза', specialty: 'Терапевт', is_doctor: true, active: true, role: 'doctor' };
const SVC = { name: 'Приём терапевта', type: 'consultation', duration_minutes: 30,
              service_types: { name: 'Консультация' }, departments: { kind: 'consultation' } };
const VISIT_DAY = (() => { const d = new Date(); d.setHours(9, 0, 0, 0); return d.toISOString(); })();
let seq = 0;
const created = () => { const d = new Date(); d.setHours(8, 59 - (seq++), 0, 0); return d.toISOString(); };
const vs = (id, status, last, first, invoiceItemId = null) => ({
  id, status, quantity: 1, unit_price: 100000, total: 100000, created_at: created(),
  invoice_item_id: invoiceItemId, visit_id: 500 + id, service_id: 1, doctor_id: 'u-doc',
  consultation_type_id: null, sync_origin: null, services: SVC, consultation_types: null,
  users: { full_name: DOC.full_name, specialty: DOC.specialty, rooms: null },
  visits: { visit_date: VISIT_DAY, patient_id: 900 + id, status: 'arrived',
            patients: { full_name: last + ' ' + first, last_name: last, first_name: first, mrn: 'MRN-' + id, phone: '' } },
});
const VS_ROWS = [
  vs(11, 'in_progress', 'Гаипов',     'Тимур'),
  vs(12, 'queued',      'Аминов',     'Олим',    1012),
  vs(13, 'queued',      'Зокиров',    'Бобур'),
  vs(14, 'added',       'Валиева',    'Дилноза'),
  vs(15, 'completed',   'Бакиев',     'Санжар'),
  vs(16, 'completed',   'Ибрагимова', 'Нигора',  1016),
  vs(17, 'in_progress', 'Давлатова',  'Мохира',  1017),
];
const ITEM_ROWS = [{ id: 1012, invoices: { status: 'paid' } }, { id: 1016, invoices: { status: 'paid' } }, { id: 1017, invoices: { status: 'paid' } }];
const NAMES = VS_ROWS.map((r) => r.visits.patients.full_name);
const REFUNDED_NAMES = ['Гаипов Тимур', 'Зокиров Бобур', 'Валиева Дилноза', 'Бакиев Санжар'];

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
let REFUNDED = new Set([11, 13, 14, 15]);
let RPC_FAILS = false;
const ASKED = [];   // тела вызовов refunded_lines
const TABLES = () => ({ users: [DOC], visit_services: VS_ROWS, invoice_items: ITEM_ROWS, visits: [], recommended_services: [], admissions: [], patients: [] });
globalThis.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const u = String(url);
  if (u.startsWith('/api/db')) {
    let rows = TABLES()[body.table] || [];
    for (const f of (body.filters || [])) rows = rows.filter((r) => matches(r, f));
    for (const o of (body.order || []).slice().reverse()) {
      rows = rows.slice().sort((a, b) => (String(a[o.col]) < String(b[o.col]) ? -1 : String(a[o.col]) > String(b[o.col]) ? 1 : 0) * (o.asc ? 1 : -1));
    }
    if (body.limit) rows = rows.slice(0, body.limit);
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  if (u === '/api/rpc/refunded_lines') {
    ASKED.push(body);
    if (RPC_FAILS) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
    return { ok: true, json: async () => ({ data: { line_ids: (body.line_ids || []).filter((id) => REFUNDED.has(Number(id))) } }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const cabinet = await import('../views/consultation.js');
const perms = await import('../permissions.js');
perms.setFullAccess('test');
window.easymed.state.user = { ...DOC, is_admin: false, is_super_admin: false };

async function openWork() {
  const root = mk('div');
  await cabinet.renderConsultation(root, { onNavigate: () => {}, tabId: 'consultation', payload: { sub: 'work' } });
  await tick(60);
  return root;
}
const statusSelect = (root) => walk(root).find((n) => n.tagName === 'SELECT');
const pickStatus = (root, value) => { const sel = statusSelect(root); sel.dispatchEvent({ type: 'change', target: { value }, currentTarget: sel }); };
const bodyRows = (root) => { const tb = walk(root).find((n) => n.tagName === 'TBODY'); return tb ? tb.children.filter((n) => n.tagName === 'TR') : []; };
const nameOf = (tr) => NAMES.find((n) => textOf(tr).includes(n)) || null;
const visibleNames = (root) => bodyRows(root).map(nameOf);
const rowOf = (root, name) => bodyRows(root).find((tr) => nameOf(tr) === name);
const marked = (tr) => walk(tr).some((n) => n.attrs && 'data-refunded-mark' in n.attrs);
const svcCount = (root) => walk(root).find((n) => n.attrs && n.attrs.id === 'svc-count').textContent;
const tileByLabel = (root, label) => byClass(root, 'ws-kpi-card').find((c) => textOf(c).includes(label));
const tileValue = (tile) => textOf(byClass(tile, 'ws-kpi-val')[0]).trim();

// ===========================================================================
test('правило одно на список и плитку: возвращённая строка — не в рабочих фильтрах, в «Все статусы» и «Завершённых» — есть', () => {
  const { inStatusFilter, queueRank } = cabinet;
  const work = { status: 'queued' };
  const back = { status: 'queued', refunded: true };
  for (const f of ['active', 'queued']) {
    assert.strictEqual(inStatusFilter(work, f), true, f);
    assert.strictEqual(inStatusFilter(back, f), false, f + ': возвращённая строка в рабочем фильтре');
  }
  assert.strictEqual(inStatusFilter({ status: 'in_progress', refunded: true }, 'in_progress'), false);
  assert.strictEqual(inStatusFilter({ status: 'added', refunded: true }, 'active'), false);
  assert.strictEqual(inStatusFilter(back, 'all'), true);
  assert.strictEqual(inStatusFilter({ status: 'completed', refunded: true }, 'completed'), true, 'сделанное остаётся в «Завершённых»');
  assert.strictEqual(queueRank({ status: 'in_progress', refunded: true }), 3, 'возвращённая — к осмотренным, а не наверх');
  assert.strictEqual(queueRank({ status: 'in_progress' }), 0, 'обычная строка — как прежде');
});

test('«Активные» и плитка «В очереди / готовы к осмотру» — без возвращённых; сервер спрошен один раз номерами всех строк', async () => {
  ASKED.length = 0;
  const root = await openWork();
  assert.strictEqual(statusSelect(root).value, 'active');
  assert.deepStrictEqual(visibleNames(root), ['Давлатова Мохира', 'Аминов Олим'], 'возвращённые строки в «Активных»');
  assert.strictEqual(svcCount(root), '2');
  assert.strictEqual(tileValue(tileByLabel(root, 'В очереди / готовы к осмотру')), '2', 'плитка считает возвращённые строки');
  assert.strictEqual(tileValue(tileByLabel(root, 'Все')), '7', '«Все» — все строки');
  assert.strictEqual(ASKED.length, 1, 'сервер спрошен не один раз на загрузку списка: ' + ASKED.length);
  assert.deepStrictEqual([...ASKED[0].line_ids].sort((a, b) => a - b), [11, 12, 13, 14, 15, 16, 17], 'спрошены не все строки списка');
  for (const tr of bodyRows(root)) assert.ok(!marked(tr), nameOf(tr) + ': пометка у обычной строки');
});

test('ожидающие («В очереди») и «Идёт приём» — без возвращённых', async () => {
  const root = await openWork();
  pickStatus(root, 'queued');
  assert.deepStrictEqual(visibleNames(root), ['Аминов Олим'], 'возвращённая строка среди ожидающих');
  pickStatus(root, 'in_progress');
  assert.deepStrictEqual(visibleNames(root), ['Давлатова Мохира']);
});

test('«Все статусы»: возвращённые видны с пометкой «Услуга возвращена», после рабочих; неначатую не начинают', async () => {
  const root = await openWork();
  pickStatus(root, 'all');
  assert.deepStrictEqual(visibleNames(root),
    ['Давлатова Мохира', 'Аминов Олим', 'Гаипов Тимур', 'Зокиров Бобур', 'Валиева Дилноза', 'Бакиев Санжар', 'Ибрагимова Нигора']);
  for (const tr of bodyRows(root)) {
    const name = nameOf(tr);
    assert.strictEqual(marked(tr), REFUNDED_NAMES.includes(name), name + ': пометка не там');
    if (marked(tr)) assert.ok(textOf(tr).includes(REFUNDED_LINE_MARK), name + ': ' + textOf(tr));
  }
  for (const name of ['Зокиров Бобур', 'Валиева Дилноза']) {
    const t = textOf(rowOf(root, name));
    assert.ok(!t.includes('Начать') && !t.includes('Ожидает кассу'), name + ': у возвращённой неначатой строки есть действие: ' + t);
  }
  assert.ok(textOf(rowOf(root, 'Гаипов Тимур')).includes('Продолжить'), 'начатую возвращённую строку не открыть — документы приёма не видны');
  assert.ok(textOf(rowOf(root, 'Аминов Олим')).includes('Начать'), 'обычная строка потеряла «Начать»');
  pickStatus(root, 'completed');
  assert.deepStrictEqual(visibleNames(root), ['Бакиев Санжар', 'Ибрагимова Нигора']);
  assert.ok(marked(rowOf(root, 'Бакиев Санжар')), 'в «Завершённых» — с пометкой');
});

test('каждое открытие списка — один новый вопрос; сервер не ответил — список как был', async (t) => {
  ASKED.length = 0;
  await openWork();
  await openWork();
  assert.strictEqual(ASKED.length, 2, 'на две загрузки списка — два вопроса');
  RPC_FAILS = true;
  t.after(() => { RPC_FAILS = false; });
  const root = await openWork();
  assert.deepStrictEqual(visibleNames(root).sort(), ['Аминов Олим', 'Валиева Дилноза', 'Гаипов Тимур', 'Давлатова Мохира', 'Зокиров Бобур'].sort());
  assert.strictEqual(tileValue(tileByLabel(root, 'В очереди / готовы к осмотру')), '5');
  for (const tr of bodyRows(root)) assert.ok(!marked(tr), nameOf(tr));
});

test('возвратов нет — список, плитка и кнопки прежние', async (t) => {
  REFUNDED = new Set();
  t.after(() => { REFUNDED = new Set([11, 13, 14, 15]); });
  const root = await openWork();
  assert.strictEqual(visibleNames(root).length, 5);
  assert.strictEqual(tileValue(tileByLabel(root, 'В очереди / готовы к осмотру')), '5');
  assert.ok(textOf(rowOf(root, 'Валиева Дилноза')).includes('Ожидает кассу'));
});
