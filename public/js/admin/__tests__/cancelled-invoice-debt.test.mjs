// REFUND_ANY_V1 (2026-10-30) — ОТМЕНЁННЫЙ СЧЁТ — НЕ ДОЛГ.
//
// Вкладка «Счёт» карты пациента считала долг как «выставлено минус оплачено»
// по ВСЕМ счетам: отменённый счёт ('void' / 'refunded') на 100 000, по которому
// ничего не платили, давал «Долг: 100 000» и остаток 100 000 в своей строке.
// Регистратура повторяла это пациенту. Шапка карты (клетка «Долг») и окно
// визита отменённый счёт долгом уже не считали — здесь то же правило: долг —
// только по неоплаченным, частичным и долговым счетам; остаток отменённого
// счёта — «—». Выгрузка кассы в Excel (столбец «Долг») — так же.

import { test } from 'node:test';
import assert from 'node:assert';

// --- Fake DOM (копия харнесса из __tests__/patient-card-tabs.test.mjs) ------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.disabled=false;}
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

const store = new Map();
const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1
globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: fakeLocalStorage,
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo(){}, scrollY: 0, confirm: () => true, open: () => null,
  easymed: { state: { user: { id: 1, full_name: 'Админ', role: 'admin' } } },
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.cancelAnimationFrame=()=>{};
globalThis.history={state:null,replaceState(){},pushState(){}};
globalThis.confirm = () => true;

// Отменённый счёт на 100 000 (ничего не платили), счёт «Возврат» на 60 000
// (деньги вернули) и частичный на 50 000, из которых оплачено 20 000.
const VOID_INV = { id: 41, patient_id: 1, invoice_number: 'INV-VOID-1', total_amount: 100000, paid_amount: 0,
  status: 'void', created_at: '2026-08-10T09:30:00Z' };
const REFUNDED_INV = { id: 42, patient_id: 1, invoice_number: 'INV-REF-1', total_amount: 60000, paid_amount: 0,
  status: 'refunded', created_at: '2026-08-11T09:30:00Z' };
const PARTIAL_INV = { id: 43, patient_id: 1, invoice_number: 'INV-PART-1', total_amount: 50000, paid_amount: 20000,
  status: 'partial', created_at: '2026-08-12T09:30:00Z' };

function payload() {
  return {
    tabs: { services: 'delete', labs: 'view', docs: 'delete', history: 'view', billing: 'view', visits: 'edit', details: 'edit' },
    caps: { services: { edit: true, del: true }, labs: { edit: false, del: false }, docs: { edit: true, del: true }, history: { edit: false, del: false },
            billing: { edit: false, del: false }, visits: { edit: true, del: false }, details: { edit: true, del: false } },
    patient: { id: 1, mrn: 'MRN-1', full_name: 'Пациент Тестовый', gender: 'male', date_of_birth: '1990-04-01', phone: '+998901112233', active: 1 },
    patient_limited: false, payer_name: 'Наличные',
    visits: [], visit_count: 0, last_visit_date: null,
    services: [], lab_orders: [], lab_results: [],
    invoices: [PARTIAL_INV, REFUNDED_INV, VOID_INV], invoice_items: [], payments: [],
    docs: [], doc_notes: [],
  };
}

globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (p) => ({ ok: true, status: 200, json: async () => p });
  if (u.startsWith('/api/rpc/patient_card')) return ok({ data: payload() });
  if (u.startsWith('/api/db')) return ok({ data: [], count: 0 });
  return ok({ data: null });
};

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const { renderPatientCard } = await import('../views/patient-card.js');
const { setFullAccess } = await import('../permissions.js');
const { __test_invoicesExportAoa } = await import('../views/cashier-desk.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const ownText = (el) => (el.children || []).filter((c) => c.tagName === '#TEXT').map((c) => c._t).join('');
const TAB_LABELS = ['Услуги', 'Лаборатория', 'Документы', 'История', 'Счёт', 'Визиты', 'Деталь'];
const labelOfTab = (b) => walk(b).map((n) => (n._t || '').trim()).find((t) => TAB_LABELS.includes(t)) || null;
const openTab = (root, label) => {
  const b = walk(root).filter((n) => n.tagName === 'BUTTON').find((x) => labelOfTab(x) === label);
  assert.ok(b, 'нет вкладки ' + label); b.click();
};

async function billingTab() {
  setFullAccess('Администратор');
  const box = mk('div');
  renderPatientCard(box, { onNavigate() {}, payload: { id: 1 } });
  await tick();
  openTab(box, 'Счёт');
  return box;
}

test('карта пациента, «Счёт»: отменённый счёт — не долг; долг — только остаток частичного', async () => {
  const box = await billingTab();
  const debtSpan = walk(box).find((n) => n.tagName === 'SPAN' && ownText(n).startsWith('Долг: '));
  assert.ok(debtSpan, 'нет строки «Долг:» во вкладке «Счёт»');
  assert.equal(ownText(debtSpan).replace(/\s+/g, ' ').trim(), 'Долг: 30 000 сум',
    'долг считает отменённые счета: ' + ownText(debtSpan));
});

test('карта пациента, «Счёт»: остаток отменённого счёта — «—», частичного — сумма', async () => {
  const box = await billingTab();
  const rows = walk(box).filter((n) => n.tagName === 'TR');
  const rowOf = (num) => rows.find((r) => textOf(r).includes(num));
  // Столбцы: № / Услуги / Врач / Сумма / Оплачено / Остаток / Статус.
  const balanceOf = (num) => { const r = rowOf(num); assert.ok(r, 'нет строки счёта ' + num); return textOf(r.children[5]).trim(); };
  assert.equal(balanceOf('INV-VOID-1'), '—', 'у отменённого счёта остаток — не долг');
  assert.equal(balanceOf('INV-REF-1'), '—', 'у счёта «Возврат» остаток — не долг');
  assert.equal(balanceOf('INV-PART-1'), '30 000');
});

test('выгрузка кассы в Excel: «Долг» отменённого счёта — 0, частичного — остаток', () => {
  const aoa = __test_invoicesExportAoa([
    { ...VOID_INV, patient_name: 'Пациент', items_count: 1, first_item: 'Приём' },
    { ...REFUNDED_INV, patient_name: 'Пациент', items_count: 1, first_item: 'УЗИ' },
    { ...PARTIAL_INV, patient_name: 'Пациент', items_count: 1, first_item: 'ОАК' },
  ]);
  const debtCol = aoa[0].indexOf('Долг');
  assert.ok(debtCol > -1, 'в выгрузке нет столбца «Долг»');
  assert.equal(aoa.length, 4, 'шапка и три строки');
  const debtOf = (num) => aoa.find((r) => r[0] === num)[debtCol];
  assert.equal(debtOf('INV-VOID-1'), 0, 'отменённый счёт выгружен долгом');
  assert.equal(debtOf('INV-REF-1'), 0, 'счёт «Возврат» выгружен долгом');
  assert.equal(debtOf('INV-PART-1'), 30000);
});
