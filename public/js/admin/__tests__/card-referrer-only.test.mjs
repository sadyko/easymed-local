// CARD_REFERRER_ONLY_V1 (3.22.0, ревью) — карандаш «Сменить врача / направившего»
// на строке БЕЗ врача.
//
// Ревью (UI-FLOWS №1, HIGH): у не начатой строки без исполнителя (анализ или
// процедура, добавленные регистратурой, строка из CRM «на дату») в списке врачей
// не было пустого пункта. Браузер показывает выбранным ПЕРВЫЙ пункт, и регистратор,
// поменявший только «Направил» и нажавший «ОК», заодно отправлял
// patient_card_set_doctor с первым врачом списка — строка молча получала
// исполнителя, и этому врачу начислялась доля.
//
// Теперь у строки без врача первый пункт — «— не назначен —», он и выбран, и
// пустое значение означает «врача не меняли». Правило пула исполнителей
// (cardPerformerPool) не тронуто.
//
// <select> здесь ведёт себя как в браузере: value — пункт с отметкой selected,
// а без отметки — первый пункт.
import { test } from 'node:test';
import assert from 'node:assert';

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
const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
globalThis.localStorage = ls; ls.setItem('admin.lang', 'ru');
globalThis.window = { location: { hostname: 'localhost', hash: '' }, localStorage: ls, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }), scrollTo(){}, scrollY: 0, confirm: () => true,
  easymed: { state: { user: { id: 7, full_name: 'Регистратор', role: 'registrar' } } } };
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn(); globalThis.cancelAnimationFrame=()=>{};
globalThis.history={state:null,replaceState(){},pushState(){}};
globalThis.confirm = () => true;

// Не начатая строка (status 'added'); doctor_id задаёт каждый тест.
const lineWith = (doctorId) => ({ id: 21, visit_id: 11, service_id: 5, doctor_id: doctorId, quantity: 1, unit_price: 50000, total: 50000,
  status: 'added', invoice_item_id: null, scheduled_at: null, visit_date: '2026-11-08T09:00:00Z',
  services: { name: 'ЭКГ', is_lab: 0, type: 'diag' }, users: doctorId ? { full_name: 'Каримов Б.' } : null, line_referral: null, visit_referral: null });
let LINE = lineWith(null);
const payload = () => ({
  tabs: { services: 'delete', labs: 'view', docs: 'view', history: 'view', billing: 'view', visits: 'view', details: 'view' },
  caps: {}, patient: { id: 1, mrn: 'M-1', full_name: 'Тест Тестов', active: 1 }, patient_limited: false,
  visits: [{ id: 11, patient_id: 1, visit_date: '2026-11-08T09:00:00Z', status: 'scheduled' }], visit_count: 1,
  services: [LINE], lab_orders: [], lab_results: [], invoices: [], invoice_items: [], payments: [], docs: [], doc_notes: [],
});
const rpcCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (p) => ({ ok: true, status: 200, json: async () => p });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, args: body });
    if (name === 'patient_card') return ok({ data: JSON.parse(JSON.stringify(payload())) });
    return ok({ data: { ok: true } });
  }
  if (u.startsWith('/api/db')) {
    const t = body && body.table;
    if (t === 'users') return ok({ data: [
      { id: 3, full_name: 'Пулатов А.', is_doctor: 1, service_rates: [{ service_id: 5 }] },
      { id: 4, full_name: 'Каримов Б.', is_doctor: 1, service_rates: [{ service_id: 5 }] } ] });
    if (t === 'services') return ok({ data: [{ id: 5, requires_doctor: 1, type: 'diag', is_lab: 0 }] });
    if (t === 'referral_sources') return ok({ data: [{ id: 9, name: 'Доктор Внешний', code: 'D-1' }] });
    return ok({ data: [], count: 0 });
  }
  return ok({ data: null });
};

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const { renderPatientCard } = await import('../views/patient-card.js');
const { setFullAccess } = await import('../permissions.js');
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const labelOf = (b) => walk(b).map((n) => (n._t || '').trim()).join(' ');
const optText = (o) => walk(o).map((n) => n._t || '').join('').trim();

// Браузерное значение <select>, у которого никто ещё ничего не выбирал.
function emulateSelect(sel) {
  const opts = sel.children.filter((c) => c.tagName === 'OPTION');
  const chosen = opts.find((o) => 'selected' in o.attrs) || opts[0];
  sel.value = chosen ? (chosen.attrs.value ?? '') : '';
}

/** Открыть карандаш строки; вернуть [список врачей, список направивших, «ОК»]. */
async function openEditor() {
  setFullAccess('Администратор');
  const box = mk('div');
  renderPatientCard(box, { onNavigate() {}, payload: { id: 1 } });
  await tick();
  const tab = buttons(box).find((b) => labelOf(b).includes('Услуги'));
  if (tab) tab.click();
  await tick();
  const edit = buttons(box).find((b) => (b.attrs.title || '').startsWith('Сменить врача'));
  assert.ok(edit, 'нет карандаша «Сменить врача / направившего»: ' + buttons(box).map((b) => b.attrs.title).join(' | '));
  edit.click();
  await tick(120);
  const selects = walk(box).filter((n) => n.tagName === 'SELECT');
  assert.equal(selects.length, 2, 'ожидались два списка: врач и направивший');
  selects.forEach(emulateSelect);
  const okBtn = buttons(box).find((b) => /^\s*(ОК|OK)\s*$/.test(labelOf(b)));
  assert.ok(okBtn, 'нет кнопки «ОК»');
  return [selects[0], selects[1], okBtn];
}
const sent = () => rpcCalls.filter((c) => c.name !== 'patient_card');

test('строка без врача: в списке врачей первым стоит «— не назначен —», и выбран именно он', async () => {
  LINE = lineWith(null);
  const [docSel] = await openEditor();
  const first = docSel.children[0];
  assert.equal(first.attrs.value, '', 'первый пункт списка врачей — не пустой');
  assert.ok('selected' in first.attrs, 'пустой пункт не выбран — браузер покажет первого врача');
  assert.equal(optText(first), '— не назначен —');
  assert.equal(docSel.value, '', 'браузер показал врача у строки, где врача нет');
});

test('строка без врача: поменяли только «Направил» — врач строке НЕ назначается', async () => {
  LINE = lineWith(null);
  const [, refSel, okBtn] = await openEditor();
  refSel.value = '9';                          // меняют только направившего
  rpcCalls.length = 0;
  okBtn.click();
  await tick(120);
  const names = sent().map((c) => c.name);
  assert.ok(!names.includes('patient_card_set_doctor'),
    'вместе с направившим ушёл врач: ' + JSON.stringify((sent().find((c) => c.name === 'patient_card_set_doctor') || {}).args));
  assert.deepEqual(names, ['patient_card_set_line_referrer']);
  assert.equal(sent()[0].args.referral_source_id, 9);
});

test('строка без врача: врача выбрали руками — он назначается, как прежде', async () => {
  LINE = lineWith(null);
  const [docSel, , okBtn] = await openEditor();
  docSel.value = '4';
  rpcCalls.length = 0;
  okBtn.click();
  await tick(120);
  const setDoc = sent().filter((c) => c.name === 'patient_card_set_doctor');
  assert.equal(setDoc.length, 1, 'выбранный врач не сохранился');
  assert.equal(setDoc[0].args.doctor_id, 4);
  assert.ok(!sent().some((c) => c.name === 'patient_card_set_line_referrer'), 'направивший не менялся');
});

test('строка без врача: ничего не меняли — «Ничего не изменилось», на сервер ничего не ушло', async () => {
  LINE = lineWith(null);
  const [, , okBtn] = await openEditor();
  rpcCalls.length = 0;
  okBtn.click();
  await tick(120);
  assert.deepEqual(sent().map((c) => c.name), []);
});

test('строка С врачом: пустого пункта нет, смена только «Направил» врача не трогает', async () => {
  LINE = lineWith(4);
  const [docSel, refSel, okBtn] = await openEditor();
  assert.ok(!docSel.children.some((o) => o.attrs.value === ''), 'у строки с врачом появился пункт «не назначен» — врача можно было бы снять');
  assert.equal(docSel.value, '4');
  refSel.value = '9';
  rpcCalls.length = 0;
  okBtn.click();
  await tick(120);
  assert.deepEqual(sent().map((c) => c.name), ['patient_card_set_line_referrer']);
});
