// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — «ПАЦИЕНТ ОТПРАВЛЕН — ВРАЧ ВИДИТ СРАЗУ».
// Настоящий consultation.js («Мои приёмы», «Мой день») в фальшивом DOM; база — заглушка
// fetch; поток изменений — настоящий клиент live.js на поддельном EventSource и часах.
//   • направили пациента (visit_services) — «Мои приёмы» перечитались, новая строка на экране;
//   • изменение не для кабинета (движение денег в кассе) — нет;
//   • открыт мастер «Направить на услуги» (data-visit-wizard) или окно — ждёт до закрытия;
//   • фильтр «Все статусы» не сброшен; «Мой день» тоже обновляется сам.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, FakeES } from './live-fakes.mjs';

// --- fake DOM (как у cabinet-queue-order.test.mjs) ---------------------------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={setProperty(k,v){this[k]=v;},getPropertyValue(k){return this[k];}};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 contains(n){return this._desc().includes(n);}
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
let busyAs = null;   // что «открыто» сейчас: null | '.modal' | '[data-visit-wizard]'
const asked = [];
globalThis.document = {
  hidden: false, activeElement: null,
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return id === 'toast' ? toastEl : null; },
  querySelector(sel) { asked.push(sel); return busyAs && String(sel).includes(busyAs) ? mk('div') : null; },
  querySelectorAll() { return []; },
};
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage,
  addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: null } }, confirm: () => true, easymedSetTabSub() {},
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState(st) { this.state = st; }, pushState(st) { this.state = st; } };

// --- база-заглушка -------------------------------------------------------------
const DOC = { id: 'u-doc', full_name: 'Каримова Азиза', specialty: 'Терапевт', is_doctor: true, active: true, role: 'doctor' };
const SVC = { name: 'Приём терапевта', type: 'consultation', duration_minutes: 30, service_types: { name: 'Консультация' }, departments: { kind: 'consultation' } };
const TODAY = (() => { const d = new Date(); d.setHours(9, 0, 0, 0); return d.toISOString(); })();
let seq = 0;
const vs = (id, status, name) => ({
  id, status, quantity: 1, unit_price: 100000, total: 100000,
  created_at: (() => { const d = new Date(); d.setHours(8, 59 - (seq++ % 50), 0, 0); return d.toISOString(); })(),
  invoice_item_id: null, visit_id: 'v-' + id, service_id: 's-1', doctor_id: 'u-doc',
  consultation_type_id: null, sync_origin: null, services: SVC, consultation_types: null,
  users: { full_name: DOC.full_name, specialty: DOC.specialty, rooms: null },
  visits: { visit_date: TODAY, patient_id: 'p-' + id, status: 'arrived',
            patients: { full_name: name, last_name: name, first_name: '', mrn: 'MRN-' + id, phone: '' } },
});
let ROWS = [vs('q1', 'queued', 'Направленный-Первый'), vs('c1', 'completed', 'Осмотренный-Первый')];
const VISITS = [];
const dbCalls = [];
let onVs = null;   // подглядеть/вмешаться в миг чтения списка
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
globalThis.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (String(url).startsWith('/api/db')) {
    dbCalls.push(body.table);
    if (body.table === 'visit_services' && onVs) onVs();
    const tables = { users: [DOC], visit_services: ROWS, invoice_items: [], visits: VISITS, recommended_services: [], admissions: [], patients: [] };
    let rows = tables[body.table] || [];
    for (const f of (body.filters || [])) rows = rows.filter((r) => matches(r, f));
    if (body.limit) rows = rows.slice(0, body.limit);
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

// --- поток изменений ------------------------------------------------------------
const clock = fakeClock();
const live = await import('../live.js');
const client = live.createLiveClient({
  EventSource: FakeES, fetch: async () => ({ ok: true, status: 200, json: async () => ({ v: 1, tables: [], rpc: [] }) }),
  document: globalThis.document, window: globalThis.window,
  setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, random: () => 0.5,
});
live.__setLiveClientForTests(client);

const cabinet = await import('../views/consultation.js');
const perms = await import('../permissions.js');
perms.setFullAccess('test');
window.easymed.state.user = { ...DOC, is_admin: false, is_super_admin: false };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const vsReads = () => dbCalls.filter((t) => t === 'visit_services').length;
let version = 1;
const emit = (tables) => FakeES.live()[0].emit('change', { v: ++version, tables });
// Ревью M3 (3.22.0) — тишина live.js + разброс экрана (random = 0,5 → 1 с); перед каждым
// случаем — пауза дольше предела частоты экрана (2–3 с), чтобы он не мешал проверке.
const WAIT = live.DEBOUNCE_MS + live.LIVE_SPREAD_MS + 10;
const pause = () => clock.advance(3500);
async function settle(ms) { await clock.advance(ms); await tick(80); }

const root = mk('div');
await cabinet.renderConsultation(root, { onNavigate() {}, tabId: 'consultation', payload: { sub: 'work' } });
await tick(80);
FakeES.live()[0].open();
FakeES.live()[0].emit('hello', { v: version });
const statusSelect = () => walk(root).find((n) => n.tagName === 'SELECT');

test('«Мои приёмы» подписаны: один поток, первая строка на экране', () => {
  assert.equal(FakeES.live().length, 1);
  assert.equal(client.status().subscribers, 2, 'две подписки кабинета (ревью M3): «Мои приёмы» и «Мой день»');
  assert.match(textOf(root), /Направленный-Первый/);
});

test('направили пациента — «Мои приёмы» перечитались сами, фильтр «Все статусы» на месте', async () => {
  await pause();
  const sel = statusSelect();
  sel.dispatchEvent({ type: 'change', target: { value: 'all' }, currentTarget: sel });
  await tick(40);
  const before = vsReads();
  ROWS = [vs('q2', 'queued', 'Направленный-Второй'), ...ROWS];
  emit(['visit_services', 'visits']);
  await settle(WAIT);
  assert.ok(vsReads() > before, 'список перечитан');
  assert.match(textOf(root), /Направленный-Второй/, 'новый пациент в списке без «Обновить»');
  assert.match(textOf(root), /Осмотренный-Первый/, '«Все статусы» не сброшены в «Активные»');
  assert.equal(statusSelect().value, 'all');
  assert.equal(TOASTS.length, 0);
});

test('изменение не для кабинета (движение денег в кассе) — список не перечитывается', async () => {
  await pause();
  const before = vsReads();
  emit(['cash_movements']);
  await settle(live.DEBOUNCE_MS + live.RECHECK_MS);
  assert.equal(vsReads(), before);
});

test('открыт мастер «Направить на услуги» — ждёт; закрыли — перечиталось (то же правило 3.22.0)', async () => {
  await pause();
  const before = vsReads();
  busyAs = '[data-visit-wizard]';
  ROWS = [vs('q3', 'queued', 'Направленный-Третий'), ...ROWS];
  emit(['visit_services']);
  await settle(live.DEBOUNCE_MS + live.RECHECK_MS * 3);
  assert.equal(vsReads(), before, 'под мастером не перечитывается');
  assert.doesNotMatch(textOf(root), /Направленный-Третий/);
  busyAs = null;
  await settle(live.RECHECK_MS + 10);
  assert.ok(vsReads() > before);
  assert.match(textOf(root), /Направленный-Третий/);
});

test('открыто окно (.modal) — ждёт; закрыли — перечиталось', async () => {
  await pause();
  const before = vsReads();
  busyAs = '.modal';
  ROWS = [vs('q4', 'queued', 'Направленный-Четвёртый'), ...ROWS];
  emit(['payments']);   // касса приняла оплату — строка готова к осмотру
  await settle(live.DEBOUNCE_MS + live.RECHECK_MS * 2);
  assert.equal(vsReads(), before);
  busyAs = null;
  await settle(live.RECHECK_MS + 10);
  assert.match(textOf(root), /Направленный-Четвёртый/);
});

test('таймер кабинета спрашивает то же правило (мастер — data-visit-wizard)', async () => {
  await pause();
  asked.length = 0;
  busyAs = '[data-visit-wizard]';
  try {
    assert.equal(await cabinet.autoFreshTick(), false, 'тик под мастером пропущен');
    assert.ok(asked.some((q) => q === live.BUSY_SELECTOR), 'спрошено общее правило live.js');
  } finally { busyAs = null; cabinet.stopAutoFresh(); }
});

test('ревью M3: результат анализатора «Мои приёмы» не будит (их правило без lab_results)', async () => {
  await pause();
  const before = vsReads();
  emit(['lab_results']);
  await settle(WAIT + live.RECHECK_MS);
  assert.equal(vsReads(), before);
});

test('ревью M4: окно открыли, пока шло чтение, — список не перерисован; закрыли — встало прочитанное, без нового чтения', async () => {
  await pause();
  ROWS = [vs('q5', 'queued', 'Направленный-Пятый'), ...ROWS];
  onVs = () => { busyAs = '.modal'; };
  emit(['visit_services']);
  await settle(WAIT);
  onVs = null;
  const reads = vsReads();
  assert.doesNotMatch(textOf(root), /Направленный-Пятый/, 'под окном список не перерисован');
  await settle(live.RECHECK_MS * 2);
  assert.doesNotMatch(textOf(root), /Направленный-Пятый/);
  busyAs = null;
  await settle(live.RECHECK_MS + 10);
  assert.match(textOf(root), /Направленный-Пятый/, 'окно закрыли — прочитанное встало');
  assert.equal(vsReads(), reads, 'без нового чтения');
});

let dash = null;
const visitsReads = () => dbCalls.filter((t) => t === 'visits').length;
test('«Мой день»: изменение для кабинета перечитывает дашборд (визиты дня)', async () => {
  await pause();
  dash = mk('div');
  await cabinet.renderConsultation(dash, { onNavigate() {}, tabId: 'consultation', payload: {} });
  await tick(80);
  assert.equal(client.status().subscribers, 2, 'новое открытие кабинета — снова две подписки, не четыре');
  const visitsBefore = visitsReads();
  emit(['visit_services']);
  await settle(WAIT);
  assert.ok(visitsReads() > visitsBefore, '«Мой день» перечитан');
  cabinet.stopAutoFresh();
});

test('ревью M3: «Мой день» — результат анализатора не будит; не чаще раза в 20 с, отложенное выполняется', async () => {
  await clock.advance(21_000);
  const before = visitsReads();
  emit(['lab_results']);
  await settle(WAIT + live.RECHECK_MS);
  assert.equal(visitsReads(), before, 'lab_results — не правило «Моего дня»');
  emit(['payments']);
  await settle(WAIT);
  const first = visitsReads();
  assert.ok(first > before, 'оплата — перечитан');
  emit(['visit_services']);
  await settle(WAIT + 5000);
  assert.equal(visitsReads(), first, 'через 6 с — ещё нет: предел 20 с');
  await settle(15_000);
  assert.ok(visitsReads() > first, 'после 20 с — отложенное выполнено');
  cabinet.stopAutoFresh();
});

test('ревью M5: «Мой день» — прокрутка колонки дня на месте после тихого обновления', async () => {
  await clock.advance(21_000);
  const dayList = () => walk(dash).find((n) => String(n.className || '').split(/\s+/).includes('dd-day-list'));
  const old = dayList();
  assert.ok(old, 'колонка дня на экране');
  old.scrollTop = 120;
  emit(['visit_services']);
  await settle(WAIT);
  const fresh = dayList();
  assert.notEqual(fresh, old, 'колонка пересобрана');
  assert.equal(fresh.scrollTop, 120, 'прокрутка на месте');
  cabinet.stopAutoFresh();
});
