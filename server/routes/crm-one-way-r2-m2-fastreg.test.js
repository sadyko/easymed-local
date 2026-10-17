// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r2/zz-m2-fastreg.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL RE-REVIEW round 2 (money) — fast registration «из записи»: harness copied from public/js/admin/__tests__/fast-registration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageCalc } from '../../public/js/shared/package-price.js';   // SERVICES_PACKAGES_V1 — раскладка пакета, как у окна «+Пакеты»

const HERE = path.dirname(fileURLToPath(import.meta.url));
const srcOf = (rel) => fs.readFileSync(path.join(HERE, '../../public/js/admin', rel), 'utf8');

// ---------------------------------------------------------------------------
// Фальшивый DOM — тот же, что в patient-create-modal.test.mjs / patients-hub.
// Отличие одно: <select> отдаёт .options, потому что searchableSelect
// (обёртка поля «Кто направил») читает их при сборке.
// ---------------------------------------------------------------------------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);c.parentNode=this;return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.appendChild(c);}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,target:this,preventDefault(){},stopPropagation(){}});}
 fireInput(){this.dispatchEvent({type:'input',currentTarget:this,target:this});}
 fireChange(){this.dispatchEvent({type:'change',currentTarget:this,target:this});}
 focus(){ focused = this; } blur(){} scrollTo(){} scrollIntoView(){} remove(){ if(this.parentNode) this.parentNode.removeChild(this); } select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 closest(sel){const c=String(sel).replace(/^\./,'');let n=this;
   while(n){if(String(n.className||'').split(/\s+/).includes(c))return n;n=n.parentNode;}return null;}
 getBoundingClientRect(){return {top:0,left:0,width:0,height:0,bottom:0,right:0};}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className||'').split(/\s+/).includes(c),add(c){s.className=(s.className?s.className+' ':'')+c;},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
let focused = null;
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  // SEARCHABLE_SELECT_V1 читает sel.options при сборке обёртки.
  if (el.tagName === 'SELECT') {
    Object.defineProperty(el, 'options', { get() { return el.children.filter((c) => c.tagName === 'OPTION'); } });
  }
  return el;
}
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
const toastEl = mk('div');
// Слушатели документа — НАСТОЯЩИЕ (записывающие), а не заглушки: Escape должен
// дойти и до окна, и до дочернего диалога — ровно как в браузере, где оба
// висят на одном document. Заглушённый addEventListener сделал бы проверку
// «Esc под дочерним диалогом» невозможной (та же техника, что в
// __tests__/template-picker-modal.test.mjs).
const docListeners = {};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),
  head:mk('head'),body:mk('body'),documentElement:mk('html'),
  addEventListener(type, fn){ (docListeners[type] || (docListeners[type] = [])).push(fn); },
  removeEventListener(type, fn){ const a = docListeners[type]; if (!a) return; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); },
  dispatchEvent(e){ for (const fn of (docListeners[e.type] || []).slice()) fn(e); return true; },
  getElementById:(id)=> (id === 'toast' ? toastEl : null),
  querySelector(){return null;},querySelectorAll(){return [];}};
const toasts = [];
// ВАЖНОСТЬ тоста записывается рядом с текстом и по тому же номеру: «тариф не
// спрошен» обязано быть предупреждением, а не рядовым сообщением, которое
// прочитают краем глаза (ui.js: textContent, затем dataset.kind).
const toastKinds = [];
Object.defineProperty(toastEl, 'textContent', { get(){ return toastEl._t; }, set(v){ toastEl._t = String(v); toasts.push(String(v)); toastKinds.push('info'); } });
toastEl.dataset = {
  get kind(){ return toastKinds[toastKinds.length - 1]; },
  set kind(v){ if (toastKinds.length) toastKinds[toastKinds.length - 1] = String(v); },
};
const kindOf = (needle) => toastKinds[toasts.findIndex((t) => t.includes(needle))];

function makeLocalStorage() {
  const store = new Map();
  return { getItem:(k)=>(store.has(k)?store.get(k):null), setItem:(k,v)=>{store.set(k,String(v));},
           removeItem:(k)=>{store.delete(k);}, clear:()=>store.clear() };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — i18n.js выбирает язык ОДИН раз при загрузке модуля.
fakeLocalStorage.setItem('admin.lang', 'ru');

globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: fakeLocalStorage,
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo(){}, scrollY: 0,
  easymed: { state: { user: { id: 3, full_name: 'Регистратор', role: 'registrar' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => true, prompt: () => null,
  open: () => null,
  easymedSetTabSub(){}, easymedSetTabLabel(){},
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.cancelAnimationFrame=()=>{};
globalThis.history = { state: null, replaceState(){}, pushState(){} };
try { Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: null }, configurable: true }); } catch (e) { /* node уже дал свой navigator */ }

// ---------------------------------------------------------------------------
// Фальшивый транспорт. Записываем ВСЁ: имя и тело каждого rpc и каждую вставку
// в /api/db — порядок вызовов и есть предмет проверки.
// ---------------------------------------------------------------------------
const calls = [];            // { kind: 'rpc'|'insert'|'select', name/table, body }
let ensureAnswer = null;     // CRM_REAL_BOOKING_V1 — что ответит ensure_visit (null = завёл и записал)
let patientRows = [];        // чем отвечает выборка по patients (страж дублей)
// CRM_LINKS_V1 — заявка колл-центра на СЕГОДНЯ у этого пациента: окно
// оформляет услуги само, минуя подстановку, и обязано её закрыть.
let crmRequests = [];
let crmLines = [];
// CRM_LINK_ALL_V1 (R7a) — запись пациента на сегодня: чем отвечают выборки visits и visit_services.
let visitRows = [];
let vsRows = [];
// { table, message, nth? } — отказ вставки. nth — номер вставки В ЭТУ таблицу
// (1 — первая): цепочка вставляет строки услуг по одной, и «упала ВТОРАЯ» —
// это отдельный случай, где часть строк уже лежит в базе.
let insertFail = null;
// Отказы двух НЕобязательных шагов цепочки: тариф визита и номера очереди.
// Регистрацию они не срывают, и именно поэтому о них надо сказать вслух.
let quoteFail = null;        // текст отказа service_price_quote
let queueFail = null;        // текст отказа issue_queue_numbers
// Деньги: чем отвечают тариф и счёт. По умолчанию — цена каталога и сумма,
// которую видит окно; проверки «цена после сохранения» ставят сюда своё,
// потому что расхождение каталога и счёта и есть их предмет.
let quotes = null;           // { [serviceId]: { price, tier } } | null — цена каталога
let invoiceTotal = 152000;   // total_amount ответа create_invoice_for_visit
let queueTickets = null;     // (ids) => [ticket] | null — талоны по умолчанию
// Задержка одного rpc: { name, promise } — цепочка встаёт на нём, и в этот миг
// проверяется поведение окна «пока идёт запись».
let holdRpc = null;
// Печать открывает окно и пишет в него документ: ловим написанное (та же
// техника, что в case-file-tabs.test.mjs).
let printed = [];
globalThis.window.open = () => ({
  document: { open() {}, write(html) { printed.push(String(html)); }, close() {} },
  focus() {}, print() {},
});

const SERVICES = [
  { id: 1, name: 'Приём терапевта', price: 112000, tax_rate: 12, requires_doctor: 1, type: 'consultation', active: 1 },
  { id: 2, name: 'Общий анализ крови', price: 40000, tax_rate: 0, requires_doctor: 0, type: 'lab', active: 1 },
];
const DOCTORS = [
  { id: 7, full_name: 'Петров Пётр', service_rates: JSON.stringify([{ service_id: 1, pct: 40 }]) },
  { id: 8, full_name: 'Сидорова Анна', service_rates: null },
];
const SOURCES = [{ id: 5, name: 'Сайт клиники', code: '0007', category_id: null, doctor_id: null, active: 1 }];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });

  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });

  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    calls.push({ kind: 'rpc', name, body });
    if (holdRpc && holdRpc.name === name) await holdRpc.promise;
    // CRM_REAL_BOOKING_V1 — ответ ensure_visit подменяется целиком: перенос и
    // занятый день — те же три исхода, что у карточки заявки и мастера.
    if (name === 'ensure_visit') return ok({ data: ensureAnswer || { visit: { id: 77 }, created: true } });
    if (name === 'service_price_quote') {
      if (quoteFail) return { ok: false, status: 400, json: async () => ({ error: { message: quoteFail } }) };
      return ok({ data: { quotes: quotes || { 1: { price: 112000, tier: 'primary' }, 2: { price: 40000, tier: 'primary' } } } });
    }
    if (name === 'create_invoice_for_visit') {
      return ok({ data: { invoice: { id: 9, invoice_number: 'INV-9', total_amount: invoiceTotal }, items: [] } });
    }
    if (name === 'issue_queue_numbers') {
      if (queueFail) return { ok: false, status: 400, json: async () => ({ error: { message: queueFail } }) };
      const ids = (body && body.p_ids) || [];
      if (queueTickets) return ok({ data: queueTickets(ids) });
      return ok({ data: ids.map((id, i) => ({ visit_service_id: id, label: 'A-' + (i + 1), number: i + 1, queue_key: 'k' })) });
    }
    return ok({ data: null });
  }

  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    const op = (body && body.op) || 'select';
    if (op === 'insert') {
      calls.push({ kind: 'insert', table, body: body.values });
      const nth = calls.filter((c) => c.kind === 'insert' && c.table === table).length;
      if (insertFail && insertFail.table === table && (!insertFail.nth || insertFail.nth === nth)) {
        return { ok: false, status: 409, json: async () => ({ error: { message: insertFail.message } }) };
      }
      let row;
      if (table === 'patients') row = { id: 501, mrn: 'P-501', ...body.values };
      else if (table === 'visit_services') row = { id: 900 + calls.filter((c) => c.table === 'visit_services').length, ...body.values };
      else row = { id: 1, ...body.values };
      return ok({ data: body.single ? row : [row] });
    }
    calls.push({ kind: 'select', table, body });
    const rows = table === 'patients' ? patientRows
      : table === 'crm_requests' ? crmRequests
      : table === 'crm_request_services' ? crmLines
      : table === 'visits' ? visitRows
      : table === 'visit_services' ? vsRows
      : table === 'services' ? SERVICES
      : table === 'users' ? DOCTORS
      : table === 'referral_sources' ? SOURCES
      : table === 'branches' ? [{ id: 1 }]
      : table === 'service_templates' ? [{ id: 3, name: 'Первичный приём', service_ids: [1, 2] }]
      : [];
    return ok({ data: body && body.single ? (rows[0] || null) : JSON.parse(JSON.stringify(rows)), count: rows.length });
  }
  return ok({ data: null });
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const { openFastRegistrationDialog } = await import('../../public/js/admin/views/fast-registration.js');
const { setFullAccess, setEffectiveFromRole, canCreatePatient, isRouteAllowed } = await import('../../public/js/admin/permissions.js');

// ---------------------------------------------------------------------------
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const dialogs = (name) => walk(document.body).filter((n) => n.attrs['data-dialog'] === name);
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const btnByText = (root, text) => buttons(root).find((b) => textOf(b).replace(/\s+/g, ' ').trim().includes(text));

function reset() {
  calls.length = 0; toasts.length = 0; toastKinds.length = 0; printed.length = 0;
  ensureAnswer = null;
  patientRows = []; insertFail = null; quoteFail = null; queueFail = null; focused = null;
  crmRequests = []; crmLines = [];
  visitRows = []; vsRows = [];
  quotes = null; invoiceTotal = 152000; queueTickets = null; holdRpc = null;
  document.body.children.length = 0;
  // Окна прошлой проверки с экрана сняты — их слушатели Escape тоже.
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  setFullAccess('Admin');
}

const escapeKeydown = () => document.dispatchEvent({ type: 'keydown', key: 'Escape' });

// Нажатие Enter приходит НА КАРТОЧКУ окна (обработчик висит там), а `target` —
// поле, в котором стоял курсор: фальшивый DOM события не всплывает, поэтому
// цель задаём явно, как её увидел бы браузер (та же техника, что в
// __tests__/patient-create-modal.test.mjs).
function pressEnter(dlg, target) {
  dlg.card.dispatchEvent({
    type: 'keydown', key: 'Enter', target,
    preventDefault() {}, stopPropagation() {},
  });
}

function fillMinimum(dlg) {
  dlg.fields.last_name.value = 'Каримова';
  dlg.fields.first_name.value = 'Азиза';
  dlg.fields.date_of_birth.value = '1990-04-01';
  dlg.setGender('F');
}

const rowsOf = (dlg) => walk(dlg.table).filter((n) => n.tagName === 'TR' && walk(n).some((c) => c.tagName === 'TD'));
const cellsOf = (tr) => (tr.children || []).filter((c) => c.tagName === 'TD');

// Подписи формы по порядку, без звёздочки обязательности.
const frLabels = (form) => (form.children || []).filter((n) => hasClass(n, 'fr-label'))
  .map((n) => textOf(n).replace(/\*/g, '').replace(/\s+/g, ' ').trim());
const headOf = (block) => walk(block).find((n) => hasClass(n, 'fr-block-head'));
const titleOf = (node) => textOf(walk(node).find((n) => n.tagName === 'H3') || node)
  .replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/\s+/g, ' ').trim();
/** Кнопки узла, названные коротко и В ПОРЯДКЕ разметки. */
const btnNames = (root, names) => buttons(root)
  .map((b) => names.find((t) => textOf(b).includes(t)))
  .filter(Boolean);

// ===========================================================================
// FAST_REG_LAYOUT_V1 (2026-09-20) — ОКНО ВО ВСЮ ШИРИНУ, ФОРМА ГОРИЗОНТАЛЬНАЯ.
//

const KARIMOVA = { id: 42, mrn: 'P-42', full_name: 'Каримова Азиза', last_name: 'Каримова', first_name: 'Азиза', middle_name: '', phone: '+998901112233', date_of_birth: '1990-04-01' };
const todayAt = (hh) => { const d = new Date(); d.setHours(hh, 0, 0, 0); return d.toISOString(); };
async function pickKarimova(dlg) {
  dlg.searchInput.value = 'Кари';
  dlg.searchInput.fireInput();
  await tick(600);
  walk(dlg.card).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt')).click();
  await tick(80);
}
const LAB_BOOKED = { id: 556, service_id: 2, consultation_type_id: null, doctor_id: 8, quantity: 1, unit_price: 40000, status: 'added', invoice_item_id: null, clinic_item_id: null, scheduled_at: null, services: { id: 2, name: 'Общий анализ крови', price: 40000 } };
const CONSULT_BOOKED = { id: 555, service_id: 1, consultation_type_id: null, doctor_id: 7, quantity: 1, unit_price: 112000, status: 'added', invoice_item_id: null, clinic_item_id: null, scheduled_at: null, services: { id: 1, name: 'Приём терапевта', price: 112000 } };
const OSEN = (pct) => ({ id: 12, name: 'Осень', service_ids: [1], discount_percent: pct, valid_from: null, valid_until: null,
  is_package: 1, discount_mode: 'percent', discount_value: pct,
  package_calc: packageCalc({ mode: 'percent', value: pct }, [{ service_id: 1, price: SERVICES[0].price }]) });

async function saveAndCalls(dlg) {
  calls.length = 0;
  btnByText(dlg.card, 'Сохранить').click();
  await tick(150);
  const ins = calls.filter((c) => c.kind === 'insert' && c.table === 'visit_services').map((c) => c.body);
  const inv = calls.find((c) => c.kind === 'rpc' && c.name === 'create_invoice_for_visit');
  return { ins, invIds: inv ? inv.body.visit_service_ids : null };
}

// M2-S1 (screen side) — booked lab (executor 8) + same lab added with executor 7: the screen lets
// the second row through (isBookedTwin: doctors differ) and the save inserts it AND invoices the
// booked line; the server net (sameService ignores the doctor of a no-doctor service) deletes the
// booked line → «Строка услуги №556 не найдена» (server repro: zz-m2-twin.test.js M2-S1).
for (const order of ['patient-first', 'service-first']) {
  test(`CRM_ONE_WAY_V1 (повтор r2) — M2-S1-screen (${order}): booked lab + same lab with another executor — the screen never invoices a booked line next to a same-service insert`, async () => {
    reset();
    patientRows = [KARIMOVA];
    visitRows = [{ id: 77, status: 'scheduled', visit_date: todayAt(23) }];
    vsRows = [LAB_BOOKED];
    const dlg = openFastRegistrationDialog({});
    await tick(40);
    if (order === 'service-first') dlg.state.addLine(SERVICES[1], { id: 7 });
    await pickKarimova(dlg);
    if (order === 'patient-first') dlg.state.addLine(SERVICES[1], { id: 7 });
    console.log(order, 'rows', JSON.stringify(dlg.state.rows.map((r) => ({ svc: r.service.id, doc: r.doctorId, booked: r.booked && r.booked.vsId }))));
    const { ins, invIds } = await saveAndCalls(dlg);
    console.log(order, 'inserts', JSON.stringify(ins.map((b) => ({ svc: b.service_id, doc: b.doctor_id }))), 'invoice ids', JSON.stringify(invIds), 'toasts', JSON.stringify(toasts.slice(-2)));
    const twinInsert = ins.some((b) => Number(b.service_id) === 2);
    assert.ok(!(twinInsert && invIds && invIds.includes(556)), 'same-service insert + booked line 556 in one invoice (R7b deletes 556 → invoice refused)');
    dlg.close();
  });
}

// M2-S3 — a package applied to a booked service: the row shows the package ("в пакете 90 000"), but
// the booked line is not re-inserted, so package_id never reaches the visit → billed 112 000.
for (const order of ['patient-first', 'package-first']) {
  test(`CRM_ONE_WAY_V1 (повтор r2) — M2-S3 (${order}): package price promised on a booked row reaches the bill (package_id on the line)`, async () => {
    reset();
    patientRows = [KARIMOVA];
    visitRows = [{ id: 77, status: 'scheduled', visit_date: todayAt(23) }];
    vsRows = [CONSULT_BOOKED];
    const dlg = openFastRegistrationDialog({});
    await tick(40);
    if (order === 'package-first') dlg.state.applyTemplate(OSEN(20));
    await pickKarimova(dlg);
    if (order === 'patient-first') dlg.state.applyTemplate(OSEN(20));
    const row = dlg.state.rows.find((r) => r.service.id === 1);
    const table = textOf(dlg.table).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/\s+/g, ' ');
    console.log(order, 'row', JSON.stringify({ booked: row && row.booked, package: row && row.package && { id: row.package.id, price: row.package.price } }), 'table:', table.slice(0, 400));
    const { ins, invIds } = await saveAndCalls(dlg);
    console.log(order, 'inserts', JSON.stringify(ins), 'invoice ids', JSON.stringify(invIds));
    const promised = !!(row && row.package && row.package.id === 12);
    const carried = ins.some((b) => Number(b.package_id) === 12) || calls.some((c) => c.kind !== 'insert' && JSON.stringify(c.body || {}).includes('"package_id":12'));
    assert.ok(!promised || carried, 'row promises package «Осень» (90 000) but the save bills the booked line without package_id (112 000)');
    dlg.close();
  });
}
