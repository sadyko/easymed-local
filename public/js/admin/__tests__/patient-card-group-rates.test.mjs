// Ревью S5 L-3 (3.22.0) — ГРУППА СО СТАВКАМИ ПО УСЛУГАМ В ШАПКЕ КАРТЫ ПАЦИЕНТА.
//
// Ярлык группы у имени называл только процент по умолчанию («Сотрудники −20%»), а группа
// с 0 % по умолчанию и ставкой «Консультации 100 %» шла вовсе без отметки скидки — будто
// скидки нет. Прежний редактор групп (sections.js) ставок не показывает. Теперь ярлык
// группы со ставками говорит «по услугам» (и процент по умолчанию, если он есть); сервер
// отдаёт в карте признак rated (patient-card.js), сами ставки — нет.
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


let CATEGORY = null;
function payload() {
  return {
    tabs: { services: 'delete', labs: 'view', docs: 'delete', history: 'view', billing: 'view', visits: 'edit', details: 'edit' },
    caps: { services: { edit: true, del: true }, labs: { edit: false, del: false }, docs: { edit: true, del: true }, history: { edit: false, del: false },
            billing: { edit: false, del: false }, visits: { edit: true, del: false }, details: { edit: true, del: false } },
    patient: { id: 1, mrn: 'MRN-1', full_name: 'Пациент Тестовый', gender: 'male', date_of_birth: '1990-04-01', phone: '+998901112233', active: 1, category_id: 5 },
    patient_limited: false, payer_name: 'Наличные', category: CATEGORY,
    visits: [], visit_count: 0, last_visit_date: null,
    services: [], lab_orders: [], lab_results: [],
    invoices: [], invoice_items: [], payments: [],
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
const { setLang } = await import('../i18n.js');
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).filter((n) => n.tagName !== 'SVG').map((n) => n._t || '').join('');   // без значка

const norm = (el) => textOf(el).replace(/\s+/g, ' ').trim();

async function chip(category) {
  CATEGORY = category;
  setFullAccess('Администратор');
  const box = mk('div');
  renderPatientCard(box, { onNavigate() {}, payload: { id: 1 } });
  await tick();
  return walk(box).find((n) => n.tagName === 'SPAN' && String(n.className).split(/\s+/).includes('pc-cat')) || null;
}

test('ревью S5 L-3: группа со ставками — «по услугам» у ярлыка; 0 % по умолчанию — тоже скидка', async () => {
  const a = await chip({ id: 5, name: 'Сотрудники', discount_percent: 20, active: true, rated: true });
  assert.ok(a, 'нет ярлыка группы');
  assert.equal(norm(a), 'Сотрудники −20%, по услугам');
  assert.ok(String(a.className).includes('has-discount'));
  const b = await chip({ id: 5, name: 'Сотрудники', discount_percent: 0, active: true, rated: true });
  assert.equal(norm(b), 'Сотрудники по услугам', 'группа 0 % со ставками выглядит как группа без скидки');
  assert.ok(String(b.className).includes('has-discount'));
  assert.match(b.attrs.title || '', /по услугам/);
});

test('ревью S5 L-3: без ставок — ярлык как прежде; снятая группа — без скидки', async () => {
  const a = await chip({ id: 5, name: 'VIP', discount_percent: 10, active: true });
  assert.equal(norm(a), 'VIP −10%');
  const b = await chip({ id: 5, name: 'Сотрудники', discount_percent: 20, active: false, rated: true });
  assert.equal(norm(b), 'Сотрудники');
  const c = await chip({ id: 5, name: 'Без скидки', discount_percent: 0, active: true });
  assert.ok(!String(c.className).includes('has-discount'));
});

test('ревью S5 L-3: en/uz — «по услугам» переведено', async () => {
  try {
    // имя группы — своё у клиники (не слово словаря), остаётся как ввели
    setLang('en');
    const a = await chip({ id: 5, name: 'Группа А7', discount_percent: 20, active: true, rated: true });
    assert.equal(norm(a), 'Группа А7 −20%, by service');
    setLang('uz');
    const b = await chip({ id: 5, name: 'Группа А7', discount_percent: 0, active: true, rated: true });
    assert.ok(!/[А-Яа-яЁё]/.test(norm(b).replace('Группа А7', '')), 'кириллица в узбекском ярлыке: ' + norm(b));
    assert.match(norm(b), /xizmatlar bo‘yicha/);
  } finally { setLang('ru'); }
});
