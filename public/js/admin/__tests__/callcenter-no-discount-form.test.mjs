// CALLCENTER_NO_DISCOUNT_V1 (3.25.0) — владелец о колл-центре: «they create
// booking only, they cannot set the discount».
//
// Окно «Пациент из заявки» (CRM → openQuickPatientModal → buildPatientFields,
// компактная раскладка) показывало оператору «Тип скидки» со всеми категориями
// клиники — «Сотрудники (−100%)» тоже, — а дата рождения сама подставляла
// «Взрослый» / «Ребёнок» / «Новорождённый», какой бы ни была их скидка.
// Теперь только-колл-центру (роль callcenter без администратора и регистратуры)
// категории со скидкой не предлагаются; не осталось ни одной без скидки — поля
// нет вовсе; подстановка по возрасту такие категории не выбирает (их нет в
// списке). Регистратура видит всё, как прежде. Сервер отказывает сам
// (server/routes/callcenter-no-discount.test.js) — здесь только экран.
//
// Фальшивый DOM — тот же, что в quick-patient-modal.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Фальшивый DOM — тот же, что в fast-registration.test.mjs.
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
  if (el.tagName === 'SELECT') {
    Object.defineProperty(el, 'options', { get() { return el.children.filter((c) => c.tagName === 'OPTION'); } });
  }
  return el;
}
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
const toastEl = mk('div');
// Слушатели документа НАСТОЯЩИЕ: Escape должен доходить и до окна, и до
// дочернего диалога — как в браузере, где оба висят на одном document.
const docListeners = {};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),
  head:mk('head'),body:mk('body'),documentElement:mk('html'),
  addEventListener(type, fn){ (docListeners[type] || (docListeners[type] = [])).push(fn); },
  removeEventListener(type, fn){ const a = docListeners[type]; if (!a) return; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); },
  dispatchEvent(e){ for (const fn of (docListeners[e.type] || []).slice()) fn(e); return true; },
  getElementById:(id)=> (id === 'toast' ? toastEl : null),
  querySelector(){return null;},querySelectorAll(){return [];}};
const toasts = [];
Object.defineProperty(toastEl, 'textContent', { get(){ return toastEl._t; }, set(v){ toastEl._t = String(v); toasts.push(String(v)); } });

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
// Фальшивый транспорт: справочник категорий клиники — то, что задаёт тест.
// ---------------------------------------------------------------------------
let categoryRows = [];
const inserts = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
  if (u.startsWith('/api/rpc/')) return ok({ data: null });
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    const op = (body && body.op) || 'select';
    if (op === 'insert') {
      inserts.push({ table, values: body.values });
      const row = { id: 501, mrn: 'P-501', ...body.values };
      return ok({ data: body.single ? row : [row] });
    }
    const rows = table === 'patient_categories' ? categoryRows : [];
    return ok({ data: body && body.single ? (rows[0] || null) : JSON.parse(JSON.stringify(rows)), count: rows.length });
  }
  return ok({ data: null });
};

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const { openQuickPatientModal } = await import('../views/quick-patient-modal.js');
const { setFullAccess, setActorRoles } = await import('../permissions.js');
const { categoryCarriesDiscount, callcenterOnly } = await import('../../shared/patient-category-discount.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const optionNames = (sel) => (sel.children || []).filter((o) => o.tagName === 'OPTION')
  .map((o) => o.getAttribute('data-name')).filter(Boolean);
// Ряд «Тип скидки» компактной формы: подпись и поле — соседние дети формы.
function categoryRow(dlg) {
  const kids = dlg.formEl.children;
  const i = kids.findIndex((n) => hasClass(n, 'fr-label') && textOf(n).includes('Тип скидки'));
  return i < 0 ? null : { label: kids[i], ctl: kids[i + 1] };
}
const shown = (el) => el && el.style.display !== 'none';

// Справочник клиники: возрастные группы — одна из них со скидкой, — группа со
// ставками по услугам и группа сотрудников.
const CATS = [
  { id: 1, name: 'Взрослый', discount_percent: 0, discount_rates: {} },
  { id: 2, name: 'Ребёнок', discount_percent: 20, discount_rates: {} },
  { id: 3, name: 'Новорождённый', discount_percent: 0, discount_rates: { g: { consultation: 100 } } },
  { id: 4, name: 'Сотрудники', discount_percent: 100, discount_rates: {} },
  { id: 5, name: 'Без скидки по ставкам', discount_percent: 0, discount_rates: '{"g":{"lab":0}}' },
];

function as(role, extra = []) {
  inserts.length = 0;
  document.body.children.length = 0;
  setFullAccess('Admin');
  globalThis.window.easymed.state.user = { id: 3, full_name: 'Оператор', role, extra_roles: extra };
  setActorRoles([role, ...extra]);
}

const ageDob = (years) => { const y = new Date().getFullYear() - years; return y + '-01-01'; };
function typeDob(dlg, dob) {
  const f = dlg.state.api.fields.date_of_birth;
  f.value = dob;
  f.fireInput();
}

test('правило одно на экран и сервер: что такое «со скидкой» и кто «только колл-центр»', () => {
  assert.deepEqual(CATS.map(categoryCarriesDiscount), [false, true, true, true, false]);
  assert.equal(callcenterOnly(['callcenter']), true);
  assert.equal(callcenterOnly(['callcenter', 'doctor']), true);
  assert.equal(callcenterOnly(['callcenter', 'registrar']), false);
  assert.equal(callcenterOnly(['callcenter', 'admin']), false);
  assert.equal(callcenterOnly(['registrar']), false);
  assert.equal(callcenterOnly([]), false, 'роли неизвестны — экран не сужает, решает сервер');
});

test('колл-центр: в «Типе скидки» только группы без скидки, и дата рождения выбирает только их', async () => {
  as('callcenter');
  categoryRows = CATS;
  const dlg = openQuickPatientModal({ title: 'Пациент из заявки' });
  assert.ok(dlg, 'окно открылось');
  await tick();
  const sel = dlg.state.api.fields.category_id;
  assert.deepEqual(optionNames(sel), ['Взрослый', 'Без скидки по ставкам']);
  assert.ok(!(sel.children || []).some((o) => /−\d/.test(textOf(o))), 'ни одной подписи «(−N%)»');
  const row = categoryRow(dlg);
  assert.ok(shown(row.label) && shown(row.ctl), 'поле на месте — выбрать есть что');

  typeDob(dlg, ageDob(7));     // ребёнок: «Ребёнок» со скидкой — не подставляется
  assert.equal(sel.value, '');
  typeDob(dlg, ageDob(0));     // новорождённый: ставки по услугам — не подставляется
  assert.equal(sel.value, '');
  typeDob(dlg, ageDob(30));    // взрослый, 0 % — подставляется
  assert.equal(sel.value, '1');
  dlg.close();
});

test('колл-центр: групп без скидки нет — поля «Тип скидки» нет', async () => {
  as('callcenter');
  categoryRows = CATS.filter((c) => categoryCarriesDiscount(c));
  const dlg = openQuickPatientModal({});
  await tick();
  const row = categoryRow(dlg);
  assert.ok(row, 'ряд строится');
  assert.ok(!shown(row.label) && !shown(row.ctl), 'поле спрятано');
  typeDob(dlg, ageDob(7));
  assert.equal(dlg.state.api.fields.category_id.value, '');
  dlg.close();
});

test('регистратура и колл-центр с ролью регистратуры видят все группы, как прежде', async () => {
  for (const [role, extra] of [['registrar', []], ['callcenter', ['registrar']], ['admin', []]]) {
    as(role, extra);
    categoryRows = CATS;
    const dlg = openQuickPatientModal({});
    await tick();
    const sel = dlg.state.api.fields.category_id;
    assert.deepEqual(optionNames(sel), CATS.map((c) => c.name), role + ' + ' + extra.join(','));
    assert.ok(shown(categoryRow(dlg).ctl));
    typeDob(dlg, ageDob(7));
    assert.equal(sel.value, '2', 'возрастная подстановка регистратуры — как прежде');
    dlg.close();
  }
});
