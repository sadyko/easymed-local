// CRM_LINK_ALL_V1 (2026-10-16, повторное ревью денег S1) — СТРОКИ «ИЗ ЗАПИСИ» НА НАСТОЯЩЕМ СЕРВЕРЕ.
//
// Экранные проверки быстрой регистрации (fast-registration.test.mjs) идут через фальшивый
// транспорт: он не знает ни сети R7b (crm/booked-twin.js — вставка строки той же услуги убирает
// строку записи), ни кассы. Здесь те же экраны — быстрая регистрация и registerWalkIn — ходят
// на НАСТОЯЩЕЕ приложение (стенд crm-unify-app.js: /api/db, зеркало, R7b, касса), и сверяется
// то, что видит экран, с тем, что легло в базу:
//   • S1 — «та же услуга» у экрана и у сервера — одно правило (shared/same-service.js): набор
//     «строка записи + строка той же услуги» отказывается до первой записи; экран прицепляет
//     такую строку к строке записи, и счёт выставляется на неё — она цела;
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
// НАСТОЯЩИЙ СЕРВЕР. Экран зовёт относительные адреса (/api/db, /api/rpc/…) — они уходят на
// стенд crm-unify-app.js (настоящее приложение: дверь /api/db с сетью R7b и зеркалом, реестр
// RPC, касса) с куки регистратора. Абсолютные адреса (вход стенда) — как есть.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let LIVE = null;            // { base, cookie }
const sent = [];            // что экран отправил: { kind: 'rpc'|op, name|table, body }
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!LIVE || !u.startsWith('/')) return realFetch(url, opts);
  let body = null;
  try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch { body = null; }
  if (u.startsWith('/api/rpc/')) sent.push({ kind: 'rpc', name: decodeURIComponent(u.slice('/api/rpc/'.length)), body });
  else if (u.startsWith('/api/db')) sent.push({ kind: (body && body.op) || 'select', table: body && body.table, body });
  return realFetch(LIVE.base + u, { ...opts, headers: { ...(opts.headers || {}), Cookie: LIVE.cookie } });
};

const { startCrmApp, localDay } = await import('../../../../server/test-helpers/crm-unify-app.js');
const { callcenterBook, vsOf } = await import('../../../../server/test-helpers/crm-link-all.js');
const { openFastRegistrationDialog } = await import('../views/fast-registration.js');
const { registerWalkIn } = await import('../views/walk-in-booking.js');
const { setFullAccess } = await import('../permissions.js');

const TODAY = localDay(0);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const btnByText = (root, text) => buttons(root).find((b) => textOf(b).replace(/\s+/g, ' ').trim().includes(text));
const digits = (s) => Number(String(s).replace(/[^\d]/g, '')) || 0;

async function live(seed) {
  const t = await startCrmApp(seed);
  const base = `http://127.0.0.1:${t.server.address().port}`;
  const res = await realFetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reg', password: 'password1' }) });
  assert.equal(res.status, 200, 'вход регистратора');
  LIVE = { base, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
  globalThis.window.easymed.state.user = { id: 2, full_name: 'Регистратура', role: 'registrar' };
  sent.length = 0; toasts.length = 0; toastKinds.length = 0;
  document.body.children.length = 0;
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  setFullAccess('Admin');
  return { ...t, close: () => { LIVE = null; t.close(); } };
}

const seedEkg = (db) => {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'nurse', 'x', 'Петрова', 'doctor', 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, requires_doctor, duration_minutes) VALUES (50, 'ЭКГ', 50000, 'procedure', 0, 15)").run();
};
const writesOf = () => sent.filter((s) => s.kind !== 'select' && !(s.kind === 'rpc' && /quote|price/.test(s.name)));
const moneySnap = (t, vid) => JSON.stringify({
  vs: t.db.prepare('SELECT * FROM visit_services WHERE visit_id = ? ORDER BY id').all(vid),
  visits: t.db.prepare('SELECT id, status FROM visits ORDER BY id').all(),
  invoices: t.db.prepare('SELECT id FROM invoices ORDER BY id').all(),
});

async function pickPatient(dlg) {
  dlg.searchInput.value = 'Пациент';
  dlg.searchInput.fireInput();
  for (let i = 0; i < 60 && !walk(dlg.card).some((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt')); i++) await tick(50);
  walk(dlg.card).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt')).click();
  for (let i = 0; i < 60 && !dlg.state.rows.some((r) => r.booked); i++) await tick(50);
}
async function waitCatalog(dlg) {
  for (let i = 0; i < 60 && !(dlg.state.catalog && dlg.state.catalog.length); i++) await tick(50);
  assert.ok(dlg.state.catalog && dlg.state.catalog.length, 'каталог окна не загрузился');
}
async function save(dlg) {
  btnByText(dlg.card, 'Сохранить').click();
  for (let i = 0; i < 100 && !(dlg.state.result && dlg.state.result.invoice); i++) {
    if (toastKinds.includes('fail')) break;
    await tick(50);
  }
  assert.ok(dlg.state.result && dlg.state.result.invoice, 'сохранение не дошло до счёта: ' + JSON.stringify(toasts));
  return dlg.state.result;
}

// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (повторное ревью денег, S1) — НАБОР «СТРОКА ЗАПИСИ + СТРОКА ТОЙ ЖЕ УСЛУГИ»
// ОТКАЗЫВАЕТСЯ ДО ПЕРВОЙ ЗАПИСИ — НА НАСТОЯЩЕМ СЕРВЕРЕ. Колл-центр записал ЭКГ (врач не
// обязателен) к исполнителю 10; вторая строка ЭКГ у исполнителя 11 для сети R7b — та же услуга
// (её вставка убрала бы строку записи, которую набор выставляет в счёт). Правило одно
// (shared/same-service.js): registerWalkIn отказывает словами, ничего не записав.
// ═══════════════════════════════════════════════════════════════════════════
test('CRM_LINK_ALL_V1 (ревью денег S1, настоящий сервер): строка записи ЭКГ (исполнитель 10) + ЭКГ у исполнителя 11 — отказ до визита, в базе ничего не изменилось', async () => {
  const t = await live(seedEkg);
  try {
    const vid = await callcenterBook(t, TODAY, { hour: 23, svc: 50, doctor: 10 });
    const x = vsOf(t, vid).find((r) => r.service_id === 50);
    assert.ok(x, 'нет строки записи');
    const ekg = { id: 50, name: 'ЭКГ', price: 50000, requires_doctor: 0, type: 'procedure', tax_rate: 0 };
    const before = moneySnap(t, vid);
    sent.length = 0;
    await assert.rejects(
      registerWalkIn({ patientId: 77, actorRole: 'registrar', createdBy: 2, bookedVisitId: vid,
        lines: [{ service: ekg, doctorId: 10, bookedVsId: x.id, bookedUnitPrice: 50000 }, { service: ekg, doctorId: 11 }] }),
      /уже из записи/);
    assert.deepEqual(writesOf().map((s) => s.name || s.table), [], 'до отказа ушла запись');
    assert.equal(moneySnap(t, vid), before, 'база изменилась');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 (ревью денег S1, настоящий сервер): быстрая регистрация — ЭКГ «из записи» и та же ЭКГ у другого исполнителя: одна строка, счёт на строку записи, она цела', async () => {
  const t = await live(seedEkg);
  try {
    const vid = await callcenterBook(t, TODAY, { hour: 23, svc: 50, doctor: 10 });
    const x = vsOf(t, vid).find((r) => r.service_id === 50);
    const dlg = openFastRegistrationDialog({});
    await waitCatalog(dlg);
    await pickPatient(dlg);
    toasts.length = 0;
    dlg.state.addLine(dlg.state.catalog.find((s) => Number(s.id) === 50), { id: 11 });
    assert.equal(dlg.state.rows.filter((r) => Number(r.service.id) === 50).length, 1, 'ЭКГ стоит двумя строками');
    assert.ok(toasts.some((m) => m.includes('уже из записи')), 'нет подсказки: ' + JSON.stringify(toasts));
    const res = await save(dlg);
    const lines = vsOf(t, vid).filter((r) => r.service_id === 50);
    assert.deepEqual(lines.map((r) => r.id), [x.id], 'строка записи ушла или ЭКГ вставлена второй раз');
    const inv = t.db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(res.invoice.id);
    assert.equal(Number(inv.total_amount), 50000, 'счёт не на одну ЭКГ');
    dlg.close();
  } finally { t.close(); }
});

