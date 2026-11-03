// DOCTOR_REFERRAL_DESK_V1 · REFERRAL_LINE_V1 — НАПРАВЛЕНИЯ ВРАЧА В ОКНЕ РЕГИСТРАЦИИ НА НАСТОЯЩЕМ
// СЕРВЕРЕ. Стенд — тот же, что у booked-rows-live.test.mjs (скопирован ниже без изменений):
// быстрая регистрация и registerWalkIn ходят в настоящее приложение (crm-unify-app.js) под
// сессией регистратора, врач №10 «Иванов» (у него свой внутренний источник) заводит строки
// дверью /api/db под своей сессией.
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
const { attachPackagePrices } = await import('../views/service-templates.js');
const { supabase } = await import('../../supabase.js');
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

const srcOf = (db, doctorId) => db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(doctorId).id;
const seedDoc = (db) => {
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'УЗИ',80000,'imaging'), (60,'ЭКГ',50000,'procedure')").run();
  db.prepare("INSERT INTO referral_sources (id, name) VALUES (900, 'Клиника Партнёр')").run();
};
const visitToday = (t, status = 'arrived') => Number(t.db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (77, ?, ?)')
  .run(new Date().toISOString(), status).lastInsertRowid);
async function doctorLine(t, values) {
  const r = await t.dbq('doc', { table: 'visit_services', op: 'insert', values: { quantity: 1, unit_price: 80000, total: 80000, status: 'added', ...values } });
  assert.equal(r.status, 200, r.text);
  return t.db.prepare('SELECT MAX(id) id FROM visit_services').get().id;
}
async function recOf(t, values) {
  const r = await t.dbq('doc', { table: 'recommended_services', op: 'insert',
    values: { patient_id: 77, service_name: 'ЭКГ', recommended_by: 10, status: 'pending', ...values } });
  assert.equal(r.status, 200, r.text);
  return t.db.prepare('SELECT MAX(id) id FROM recommended_services').get().id;
}

test('REFERRAL_LINE_V1 (настоящий сервер): «Код отправителя» стойки ложится и в строку — визит дня уже был без источника', async () => {
  const t = await live(seedDoc);
  try {
    const vid = visitToday(t);
    const out = await registerWalkIn({ patientId: 77, actorRole: 'registrar', createdBy: 2, referralSourceId: 900,
      lines: [{ service: { id: 40, name: 'Анализ крови', price: 40000, requires_doctor: 0 }, doctorId: null }] });
    assert.equal(out.visit.id, vid, 'визит дня не тот');
    assert.equal(t.db.prepare('SELECT referral_source_id s FROM visits WHERE id = ?').get(vid).s, null, 'визиту источник дописан — проверяется не то');
    assert.equal(t.db.prepare('SELECT referred_by_source_id s FROM visit_services WHERE id = ?').get(out.lines[0].visitServiceId).s, 900);
  } finally { t.close(); }
});

test('DOCTOR_REFERRAL_DESK_V1 (настоящий сервер): строка по рекомендации — рекомендация закрыта, направивший — врач, а не «Код отправителя»', async () => {
  const t = await live(seedDoc);
  try {
    const rec = await recOf(t, { service_id: 60, notes: 'к 9:00' });
    const out = await registerWalkIn({ patientId: 77, actorRole: 'registrar', createdBy: 2, referralSourceId: 900,
      lines: [{ service: { id: 60, name: 'ЭКГ', price: 50000, requires_doctor: 0 }, doctorId: null, recommendationId: rec }] });
    assert.ok(!out.attachError, out.attachError);
    const vs = out.lines[0].visitServiceId;
    assert.deepEqual(t.db.prepare('SELECT status, visit_service_id FROM recommended_services WHERE id = ?').get(rec), { status: 'done', visit_service_id: vs });
    assert.deepEqual(t.db.prepare('SELECT referred_by_source_id, referral_note FROM visit_services WHERE id = ?').get(vs),
      { referred_by_source_id: srcOf(t.db, 10), referral_note: 'к 9:00' });
  } finally { t.close(); }
});

async function pickPatientOrders(dlg) {
  dlg.searchInput.value = 'Пациент';
  dlg.searchInput.fireInput();
  for (let i = 0; i < 60 && !walk(dlg.card).some((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt')); i++) await tick(50);
  walk(dlg.card).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt')).click();
  for (let i = 0; i < 60 && !dlg.state.doctorOrders; i++) await tick(50);
  assert.ok(dlg.state.doctorOrders, 'направления врача не загрузились: ' + JSON.stringify(toasts));
}
const node = (dlg, attr, val) => walk(dlg.card).find((n) => n.attrs && n.attrs[attr] === String(val));

test('DOCTOR_REFERRAL_DESK_V1 (настоящий сервер): сегодняшнее направление без счёта — готовая строка «от врача»; сохранение выставляет её, второй строки нет', async () => {
  const t = await live(seedDoc);
  try {
    const vid = visitToday(t);
    const a = await doctorLine(t, { visit_id: vid, service_id: 50, referral_note: 'натощак' });
    const dlg = openFastRegistrationDialog({});
    await waitCatalog(dlg);
    await pickPatientOrders(dlg);
    const row = dlg.state.rows.find((r) => r.booked && r.booked.vsId === a);
    assert.ok(row && row.booked.doctorOrder, 'направление не встало готовой строкой: ' + JSON.stringify(dlg.state.rows.map((r) => r.booked)));
    assert.ok(/от врача · Иванов/.test(textOf(dlg.table)), 'нет пометки «от врача»: ' + textOf(dlg.table));
    assert.ok(/натощак/.test(textOf(dlg.table)), 'рекомендация врача не видна регистратору');
    await save(dlg);
    assert.deepEqual(t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 50').all(vid).map((r) => r.id), [a], 'вставлена вторая строка');
    assert.ok(t.db.prepare('SELECT invoice_item_id i FROM visit_services WHERE id = ?').get(a).i != null, 'направление не выставлено');
    dlg.close();
  } finally { t.close(); }
});

test('DOCTOR_REFERRAL_DESK_V1 (настоящий сервер): убранная из таблицы строка направления остаётся в визите и возвращается кнопкой «Добавить»', async () => {
  const t = await live(seedDoc);
  try {
    const vid = visitToday(t);
    const a = await doctorLine(t, { visit_id: vid, service_id: 50 });
    const dlg = openFastRegistrationDialog({});
    await waitCatalog(dlg);
    await pickPatientOrders(dlg);
    const i = dlg.state.rows.findIndex((r) => r.booked && r.booked.vsId === a);
    assert.ok(i >= 0, 'направление не встало строкой');
    dlg.state.removeLine(i);
    assert.deepEqual(dlg.state.dropBooked, [], 'строку врача сняли бы с визита');
    const add = node(dlg, 'data-doctor-order-add', a);
    assert.ok(add, 'нет «Добавить» у убранного направления: ' + textOf(dlg.card));
    add.click();
    assert.ok(dlg.state.rows.some((r) => r.booked && r.booked.vsId === a), 'направление не вернулось строкой');
    assert.ok(!node(dlg, 'data-doctor-order', a), 'вернувшаяся строка осталась и в группе');
    dlg.close();
  } finally { t.close(); }
});

test('DOCTOR_REFERRAL_DESK_V1 (настоящий сервер): выставленное направление — только чтение «ждёт оплаты в кассе, счёт № …», строкой не встаёт', async () => {
  const t = await live(seedDoc);
  try {
    const vid = visitToday(t);
    const b = await doctorLine(t, { visit_id: vid, service_id: 50 });
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: [b], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const no = inv.json.data.invoice.invoice_number;
    const dlg = openFastRegistrationDialog({});
    await waitCatalog(dlg);
    await pickPatientOrders(dlg);
    assert.ok(!dlg.state.rows.some((r) => r.booked && r.booked.vsId === b), 'выставленное направление встало строкой — выставилось бы второй раз');
    const grp = node(dlg, 'data-doctor-order', b);
    assert.ok(grp, 'выставленного направления нет в группе «Направления врача»');
    assert.ok(textOf(grp).includes('ждёт оплаты в кассе, счёт № ' + no), textOf(grp));
    assert.ok(!/По записи уже в счёте/.test(textOf(dlg.card)), 'направление врача названо записью');
    dlg.close();
  } finally { t.close(); }
});

test('DOCTOR_REFERRAL_DESK_V1 (настоящий сервер): рекомендация врача — «Добавить»; после сохранения рекомендация закрыта, у строки направивший', async () => {
  const t = await live(seedDoc);
  try {
    const rec = await recOf(t, { service_id: 60, notes: 'к 9:00' });
    const dlg = openFastRegistrationDialog({});
    await waitCatalog(dlg);
    await pickPatientOrders(dlg);
    const add = node(dlg, 'data-doctor-rec-add', rec);
    assert.ok(add, 'нет кнопки «Добавить» у рекомендации: ' + textOf(dlg.card));
    add.click();
    assert.ok(dlg.state.rows.some((x) => x.fromRec === rec), 'рекомендация не встала строкой');
    assert.ok(!node(dlg, 'data-doctor-rec', rec), 'добавленная рекомендация осталась в группе');
    const res = await save(dlg);
    const vs = res.lines.find((l) => Number(l.serviceId) === 60).visitServiceId;
    assert.deepEqual(t.db.prepare('SELECT status, visit_service_id FROM recommended_services WHERE id = ?').get(rec), { status: 'done', visit_service_id: vs });
    assert.equal(t.db.prepare('SELECT referred_by_source_id s FROM visit_services WHERE id = ?').get(vs).s, srcOf(t.db, 10));
    dlg.close();
  } finally { t.close(); }
});

test('DOCTOR_REFERRAL_DESK_V1 (настоящий сервер): направление на другой день — в группе с подсказкой, в сегодняшнюю регистрацию не встаёт', async () => {
  const t = await live(seedDoc);
  try {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0);
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (77, ?, 'scheduled')").run(d.toISOString()).lastInsertRowid);
    const c = await doctorLine(t, { visit_id: vid, service_id: 50 });
    const dlg = openFastRegistrationDialog({});
    await waitCatalog(dlg);
    await pickPatientOrders(dlg);
    assert.ok(!dlg.state.rows.some((r) => r.booked && r.booked.vsId === c));
    const grp = node(dlg, 'data-doctor-order', c);
    assert.ok(grp && /оформляется в мастере визита/.test(textOf(grp)), grp ? textOf(grp) : 'нет в группе');
    dlg.close();
  } finally { t.close(); }
});
