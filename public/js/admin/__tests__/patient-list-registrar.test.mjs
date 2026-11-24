// PATIENT_LIST_REGISTRAR_V1 (2026-11-24) — колонка «Регистратор» картотеки.
//
// Владелец: у многих пациентов в колонке стоит «Не указан». Колонка показывала
// того, кто ЗАВЁЛ КАРТУ (patients.created_by), а у импортированных карт автора
// нет. Решение: колонка показывает того, кто ОФОРМИЛ ПОСЛЕДНИЙ ВИЗИТ. Имя
// приезжает в том же ответе, что дата последнего визита и «визитов: N»
// (RPC patient_base_aggregates: registrar — первый по правилу «Записей CRM»,
// registrars — все). Нет визита или у него никто не записан — кто завёл карту,
// как прежде; нет и его — «Не указан», как прежде.
//
// Проверяется текст ячейки для каждого случая, подсказка со всеми именами и то,
// что на страницу по-прежнему уходит ОДИН вызов сводки — без запроса на строку.
// Имена — заведомо выдуманные.

import { test } from 'node:test';
import assert from 'node:assert';

// ---------------------------------------------------------------------------
// Fake-DOM harness — copied from __tests__/patient-row.test.mjs.
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
globalThis.CustomEvent=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
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

globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: fakeLocalStorage,
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo(){}, scrollY: 0,
  easymed: { state: { user: { id: 'u-1', full_name: 'Регистратор', company_id: 'c-1', role: 'registrar' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => true,
  easymedSetTabSub: () => {},
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.IntersectionObserver = class { observe(){} unobserve(){} disconnect(){} };
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.cancelAnimationFrame=()=>{};
globalThis.history = { state: null, replaceState(){}, pushState(){} };

// ---------------------------------------------------------------------------
// DATA
// ---------------------------------------------------------------------------
const A = 'Тест Регистратор А';
const B = 'Тест Создатель Б';
const C = 'Тест Регистратор В';

const card = (id, name, createdBy) => ({
  id, company_id: 'c-1', mrn: 'T-' + id, full_name: 'Тест Пациент ' + name,
  last_name: 'Тест', first_name: 'Пациент ' + name, date_of_birth: '1990-01-01', gender: 'male',
  phone: '+99890000000' + id, registration_date: '2026-01-0' + id, created_by: createdBy,
});
const PATIENTS = [
  card(1, 'Импорт', null),        // ① импортирована, автора нет; последний визит оформил А
  card(2, 'Без визитов', 12),     // ② визитов нет — сервер называет создателя карты Б
  card(3, 'Два визита', 12),      // ③ карту завёл Б, последний визит оформила В
  card(4, 'Никто', null),         // ④ ни автора, ни оформившего
  card(5, 'Двое', null),          // ⑤ визит оформили двое: первым — А
  card(6, 'Без сводки', 12),      // ⑥ сводка про неё не ответила — создатель карты, как прежде
];
const USERS = [{ id: 12, full_name: B }];
const AGGS = [
  { patient_id: 1, visit_count: 1, last_visit_day: '2026-02-01', registrar: A, registrars: [A] },
  { patient_id: 2, visit_count: 0, last_visit_day: null, registrar: B, registrars: [B] },
  { patient_id: 3, visit_count: 2, last_visit_day: '2026-03-01', registrar: C, registrars: [C] },
  { patient_id: 4, visit_count: 1, last_visit_day: '2026-03-02', registrar: '', registrars: [] },
  { patient_id: 5, visit_count: 1, last_visit_day: '2026-03-03', registrar: A, registrars: [A, C] },
];

let dbCalls = [];
let rpcCalls = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push(name);
    if (name === 'patient_list_page') return ok({ data: { rows: JSON.parse(JSON.stringify(PATIENTS)), total: PATIENTS.length } });
    if (name === 'patient_base_aggregates') return ok({ data: JSON.parse(JSON.stringify(AGGS)) });
    if (name === 'patient_bot_status') return ok({ data: { bot: false, sms_ready: false, linked: [] } });
    return ok({ data: null });
  }
  if (u.startsWith('/api/db')) {
    dbCalls.push(body);
    const table = body && body.table;
    if (table === 'users') {
      const f = (body.filters || []).find((x) => x.op === 'in');
      const want = new Set((f ? f.val : []).map(String));
      return ok({ data: USERS.filter((x) => want.has(String(x.id))), count: USERS.length });
    }
    const rows = { patients: PATIENTS }[table] || [];
    return ok({ data: JSON.parse(JSON.stringify(rows)), count: rows.length });
  }
  return ok({ data: null });
};

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const { setFullAccess } = await import('../permissions.js');
const { setLang } = await import('../i18n.js');

let coldN = 0;
const coldView = () => import('../views/patients.js?reg=' + (++coldN));

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const rowsOf = (root) => walk(root).filter((n) => n.tagName === 'TR' && hasClass(n, 'row-click'));
const regCell = (row) => { const c = byClass(row, 'reg-by'); assert.equal(c.length, 1, 'в строке не одна ячейка регистратора'); return c[0]; };
const regText = (row) => walk(regCell(row)).filter((n) => n.tagName !== 'SVG').map((n) => n._t || '').join('').trim();   // без разметки значка

async function paint(lang = 'ru') {
  dbCalls = []; rpcCalls = [];
  document.body.children.length = 0;
  setFullAccess('Admin');
  setLang(lang);
  const box = mk('div');
  const { renderPatients } = await coldView();
  await renderPatients(box, { onNavigate: () => {}, embedded: true });
  await tick();
  return rowsOf(box);
}

test('PATIENT_LIST_REGISTRAR_V1: в ячейке — кто оформил последний визит; нет такого — кто завёл карту; нет и его — «Не указан»', async () => {
  const rows = await paint();
  assert.equal(rows.length, 6);
  assert.equal(regText(rows[0]), A, 'импортированная карта: не показан оформивший визит');
  assert.equal(regText(rows[1]), B, 'без визитов: не показан создатель карты');
  assert.equal(regText(rows[2]), C, 'два визита: показан создатель карты, а не оформивший последний визит');
  assert.equal(regText(rows[3]), 'Не указан', 'никто не записан: ячейка не сказала об этом словом');
  assert.equal(regText(rows[4]), A, 'двое оформивших: первым должен стоять первый по правилу');
  assert.equal(regText(rows[5]), B, 'сводка не ответила про карту: создатель карты должен остаться');
});

test('PATIENT_LIST_REGISTRAR_V1: подсказка называет всех оформивших визит, а у одного — его самого', async () => {
  const rows = await paint();
  const title = (row) => byClass(row, 'pt-reg-nm')[0].getAttribute('title');
  assert.equal(title(rows[4]), A + ', ' + C);
  assert.equal(title(rows[0]), A);
  assert.equal(title(rows[5]), B);
  assert.equal(byClass(rows[3], 'pt-reg-nm').length, 0, 'у «Не указан» нет имени');
});

test('PATIENT_LIST_REGISTRAR_V1: имя приезжает одним вызовом сводки на страницу, без запроса на строку', async () => {
  await paint();
  assert.equal(rpcCalls.filter((n) => n === 'patient_base_aggregates').length, 1, 'сводка страницы спрошена не один раз');
  const userQueries = dbCalls.filter((b) => b && b.table === 'users');
  assert.ok(userQueries.length <= 1, 'имена сотрудников спрошены больше одного раза: ' + userQueries.length);
});

test('PATIENT_LIST_REGISTRAR_V1: «Не указан» переведён на узбекский и английский, имена не переводятся', async () => {
  for (const lang of ['uz', 'en']) {
    const rows = await paint(lang);
    assert.equal(regText(rows[0]), A, lang + ': имя сотрудника изменилось');
    const none = regText(rows[3]);
    assert.ok(none && !/[А-Яа-яЁё]/.test(none), lang + ': в ячейке без регистратора кириллица: ' + none);
  }
  await paint('ru');
});
