// DIAG_ROUTE_V1 (3.21.0, ревью раунда 1) — КАБИНЕТ: СТРАХОВКА ДЛЯ СТАРЫХ СТРОК И ПРЕДЕЛЫ ЗАПРОСОВ.
//
// Настоящий сервер (все миграции, база в памяти, компилятор /api/db с воротами ролей) и
// настоящий consultation.js в фальшивом DOM. Синтетические данные, имена — коды случаев.
//
// Что закреплено:
//   • «Без исполнителя · N» (ревью M-1, страховка): администратор и регистратура видят
//     открытые строки кабинета без исполнителя — сегодня и вперёд — и назначают исполнителя
//     той же дверью, что «Сменить врача» карты; врач группы не видит;
//   • «Мой день» (ревью L-1): визит, где у врача строка, — по дню визита, а не по 2000
//     новейшим строкам врача;
//   • «Мои приёмы» администратора (ревью L-2): открытая строка на сегодня видна при любом
//     числе устаревших открытых строк прошлых дней и строк лаборатории;
//   • строка не задваивается (ревью L-3); тик не идёт под мастером «Направить на услуги» (I-2).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- fake DOM (как у cabinet-queue-order.test.mjs) ----
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={setProperty(k,v){this[k]=v;},getPropertyValue(k){return this[k];}};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.appendChild(c);}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){} scrollIntoView(){}
 _desc(o=[]){for(const c of this.children||[]){o.push(c);if(c._desc)c._desc(o);}return o;}
 _sel(n,s){ if(s[0]==='#')return (n.attrs&&n.attrs.id)===s.slice(1);
            if(s[0]==='.')return String(n.className||'').split(/\s+/).includes(s.slice(1));
            return String(n.tagName||'').toLowerCase()===s.toLowerCase(); }
 querySelector(s){return this._desc().find((n)=>this._sel(n,s))||null;}
 querySelectorAll(s){return this._desc().filter((n)=>this._sel(n,s));}
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
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { get() { return ''; }, set() {}, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return id === 'toast' ? toastEl : null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
};
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: globalThis.localStorage,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  easymed: { state: { user: null } }, confirm: () => true, easymedSetTabSub() {}, easymedSetTabLabel() {},
  innerWidth: 1440, innerHeight: 900,
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState(st) { this.state = st; }, pushState(st) { this.state = st; } };

// ---- настоящий сервер; fetch экрана идёт к нему с cookie врача ----
const realFetch = globalThis.fetch;
let LIVE = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!LIVE || !u.startsWith('/')) return realFetch(url, opts);
  return realFetch(LIVE.base + u, { ...opts, headers: { ...(opts.headers || {}), Cookie: LIVE.cookie } });
};
const { startCrmApp, localDay, at } = await import('../../../../server/test-helpers/crm-unify-app.js');
const { hashPassword } = await import('../../../../server/services/auth.js');
const perms = await import('../permissions.js');
const cabinet = await import('../views/consultation.js');

const TODAY = localDay(0);
const DOC = 12, OTHER = 10;   // 12 — синтетический сонолог; 10 — терапевт «Иванов» стенда

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** Стенд: сонолог + услуги/визиты от `add`. Возвращает { t, codes } — коды случаев. */
async function stand(build, { login = 'uzi', user = null } = {}) {
  const codes = [];
  const t = await startCrmApp((db) => {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty) VALUES (?,?,?,?,?,?,?)")
      .run(DOC, 'uzi', hashPassword('password1'), 'Сонолог Синтетический', 'doctor', 1, 'УЗИ');
    let n = 0;
    const add = (code, svc, line = {}, visit = {}) => {
      n++;
      const sid = 1000 + n, pid = 5000 + n;
      db.prepare(`INSERT INTO services (id, name, price, type, requires_doctor, type_id, department_id, duration_minutes)
                  VALUES (?,?,?,?,?,?,?,20)`).run(sid, 'Svc-' + code, 100000, svc.type || 'imaging', svc.req ?? 0, svc.type_id ?? null, svc.department_id ?? null);
      db.prepare('INSERT INTO patients (id, full_name, last_name, first_name) VALUES (?,?,?,?)').run(pid, 'Тест-' + code, 'Тест-' + code, '');
      const vid = Number(db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (?,?,?,?)')
        .run(pid, visit.doctor === undefined ? DOC : visit.doctor, at(visit.day || TODAY, 10), visit.status || 'arrived').lastInsertRowid);
      db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, unit_price, total, status${line.created ? ', created_at' : ''})
                  VALUES (?,?,?,100000,100000,?${line.created ? ', ?' : ''})`)
        .run(...[vid, sid, line.doctor === undefined ? DOC : line.doctor, line.status || 'queued', ...(line.created ? [line.created] : [])]);
      codes.push(code);
      return { sid, pid, vid };
    };
    build(db, add);
  });
  const base = `http://127.0.0.1:${t.server.address().port}`;
  const res = await realFetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: login, password: 'password1' }) });
  assert.equal(res.status, 200, 'вход ' + login);
  LIVE = { base, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
  window.easymed.state.user = user || { id: DOC, full_name: 'Сонолог Синтетический', role: 'doctor', is_doctor: true, is_admin: false, is_super_admin: false };
  perms.setFullAccess('test');
  return { t, codes, close: () => { LIVE = null; t.close(); } };
}
const shownCodes = (root, codes) => { const s = textOf(root); return codes.filter((c) => s.includes('Тест-' + c)); };

/** «Мои приёмы»: { active, all } — коды, видные в «Активных» и в «Все статусы». */
async function myServices(codes) {
  const root = mk('div');
  await cabinet.renderConsultation(root, { onNavigate() {}, tabId: 'consultation', payload: { sub: 'work' } });
  for (let i = 0; i < 50 && !walk(root).some((n) => n.tagName === 'TBODY'); i++) await tick(60);
  await tick(150);
  const active = shownCodes(root, codes);
  const sel = walk(root).find((n) => n.tagName === 'SELECT');
  sel.dispatchEvent({ type: 'change', target: { value: 'all' }, currentTarget: sel });
  await tick(150);
  return { root, active, all: shownCodes(root, codes) };
}

/** «Мой день» (дашборд — кабинет открывается им): коды, видные на странице. */
async function myDay(codes) {
  const root = mk('div');
  await cabinet.renderConsultation(root, { onNavigate() {}, tabId: 'consultation', payload: {} });
  for (let i = 0; i < 30 && !codes.some((c) => textOf(root).includes('Тест-' + c)); i++) await tick(60);
  await tick(200);
  return shownCodes(root, codes);
}

// DIAG_ROUTE_V1 (D2) — «Мой день» строился по ВИЗИТАМ врача (visits.doctor_id), а визит

const ADMIN = { id: 1, full_name: 'Админ', role: 'admin', is_doctor: false, is_admin: true, is_super_admin: false };
const REG = { id: 2, full_name: 'Регистратура', role: 'registrar', is_doctor: false, is_admin: false, is_super_admin: false };

/** «Мои приёмы» на «Активных»: корень экрана. */
async function workTab() {
  const root = mk('div');
  await cabinet.renderConsultation(root, { onNavigate() {}, tabId: 'consultation', payload: { sub: 'work' }, onShow() {} });
  for (let i = 0; i < 50 && !walk(root).some((n) => n.tagName === 'TBODY' || (n.attrs && 'data-unassigned-group' in n.attrs)); i++) await tick(60);
  await tick(150);
  return root;
}
const byAttr = (root, attr, val) => walk(root).find((n) => n.attrs && attr in n.attrs && (val === undefined || n.attrs[attr] === String(val))) || null;

// ═══ ревью M-1, страховка — «БЕЗ ИСПОЛНИТЕЛЯ · N» ═══
// Строка кабинета без исполнителя не видна ни одному врачу. Строки, записанные до 3.21 (и
// дверями вне записи: касса «Без врача», CRM, бот, импорт), администратор и регистратура
// находят в кабинете группой «Без исполнителя · N» и назначают исполнителя.
const seedUnassigned = (db, add) => {
  add('U01', {}, { doctor: null, status: 'added' });                                 // сегодня, УЗИ — в группе
  add('U02', {}, { doctor: null, status: 'queued' }, { day: localDay(1) });          // завтра — в группе
  add('U03', {}, { doctor: null, status: 'added' }, { day: localDay(-1) });          // вчера — не сегодня и не вперёд
  add('U04', { type: 'lab' }, { doctor: null, status: 'added' });                    // анализ — лаборатория
  add('U05', { type: 'procedure' }, { doctor: null, status: 'added' });              // процедура — процедуры
  add('U06', {}, { doctor: null, status: 'added' }, { status: 'cancelled' });        // визит отменён
  add('U07', {}, { doctor: null, status: 'completed' });                             // сделано
  add('U08', {}, { status: 'queued' });                                              // у строки исполнитель — обычный список
};

test('M-1 страховка: администратор видит «Без исполнителя · 2» — только сегодня и вперёд, только кабинет, только открытые', async () => {
  const s = await stand(seedUnassigned, { login: 'boss', user: ADMIN });
  try {
    const root = await workTab();
    const grp = byAttr(root, 'data-unassigned-group');
    assert.ok(grp, 'группы «Без исполнителя» нет');
    assert.equal(grp.attrs['data-unassigned-group'], '2');
    assert.match(textOf(grp), /Без исполнителя · 2/);
    assert.deepEqual(shownCodes(grp, s.codes), [], 'свёрнутая группа показывает пациентов');
    byAttr(root, 'data-unassigned-toggle').click();
    await tick(60);
    assert.deepEqual(shownCodes(byAttr(root, 'data-unassigned-group'), s.codes), ['U01', 'U02']);
    assert.ok(textOf(root).includes('Тест-U08'), 'обычный список пропал');
  } finally { s.close(); }
});

test('M-1 страховка: «Назначить» — пул записи (никому не отмечена — все врачи), строка получает исполнителя и уходит из группы в список', async () => {
  const s = await stand(seedUnassigned, { login: 'boss', user: ADMIN });
  try {
    const root = await workTab();
    byAttr(root, 'data-unassigned-toggle').click();
    await tick(60);
    const vsId = s.t.db.prepare("SELECT vs.id FROM visit_services vs JOIN services sv ON sv.id = vs.service_id WHERE sv.name = 'Svc-U01'").get().id;
    byAttr(root, 'data-unassigned-assign', vsId).click();
    for (let i = 0; i < 30 && !byAttr(root, 'data-unassigned-select', vsId); i++) await tick(40);
    const sel = byAttr(root, 'data-unassigned-select', vsId);
    assert.ok(sel, 'нет выбора исполнителя');
    const ids = sel.children.filter((o) => o.tagName === 'OPTION').map((o) => o.attrs.value).filter(Boolean).map(Number).sort((a, b) => a - b);
    assert.deepEqual(ids, [OTHER, DOC], 'кандидаты — все врачи клиники (is_doctor)');
    assert.equal(sel.value, '', 'выбран сам при двух кандидатах');
    sel.value = String(DOC);
    byAttr(root, 'data-unassigned-save', vsId).click();
    for (let i = 0; i < 40 && s.t.db.prepare('SELECT doctor_id FROM visit_services WHERE id = ?').get(vsId).doctor_id == null; i++) await tick(50);
    assert.equal(s.t.db.prepare('SELECT doctor_id FROM visit_services WHERE id = ?').get(vsId).doctor_id, DOC);
    await tick(300);
    assert.equal(byAttr(root, 'data-unassigned-group').attrs['data-unassigned-group'], '1', 'группа не перечитана');
    assert.ok(textOf(root).includes('Тест-U01'), 'назначенная строка не в списке');
  } finally { s.close(); }
});

test('M-1 страховка: регистратура видит группу; врач — нет (его кабинет показывает только своё)', async () => {
  let s = await stand(seedUnassigned, { login: 'reg', user: REG });
  try {
    const root = await workTab();
    assert.equal(byAttr(root, 'data-unassigned-group') && byAttr(root, 'data-unassigned-group').attrs['data-unassigned-group'], '2', 'у регистратуры нет группы');
  } finally { s.close(); }
  s = await stand(seedUnassigned);
  try {
    const root = await workTab();
    assert.equal(byAttr(root, 'data-unassigned-group'), null, 'врач видит чужие строки без исполнителя');
  } finally { s.close(); }
});
