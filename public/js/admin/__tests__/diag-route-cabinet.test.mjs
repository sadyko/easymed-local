// DIAG_ROUTE_V1 (2026-11-03) — «ПАЦИЕНТЫ, НАПРАВЛЕННЫЕ НА ДИАГНОСТИКУ, НЕ ВИДНЫ
// В КАБИНЕТЕ ВРАЧА». Кабинет диагноста — настоящим сервером (все миграции, база
// в памяти, компилятор /api/db с воротами ролей) и настоящим consultation.js
// в фальшивом DOM, вход — синтетическим врачом-сонологом. Имена — коды случаев.
//
// Что закреплено (решение владельца: «маршрут решает ГРУППА услуги, а не
// название»): услуга группы «Диагностика» остаётся в «Моих приёмах» при любом
// типе каталога и любом отделении (A09–A13 прежде уходили в лабораторию или в
// процедуры); группа «Процедуры» — по-прежнему в процедурах (A14).
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
async function stand(build) {
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
  const res = await realFetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'uzi', password: 'password1' }) });
  assert.equal(res.status, 200, 'вход сонолога');
  LIVE = { base, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
  window.easymed.state.user = { id: DOC, full_name: 'Сонолог Синтетический', role: 'doctor', is_doctor: true, is_admin: false, is_super_admin: false };
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

test('«Мои приёмы»: группа «Диагностика» видна врачу при любом типе каталога и отделении (A01–A13); «Процедуры» — нет (A14)', async () => {
  const s = await stand((db, add) => {
    const typ = (name) => Number(db.prepare('INSERT INTO service_types (name) VALUES (?)').run(name).lastInsertRowid);
    const dep = (name, kind) => Number(db.prepare('INSERT INTO departments (name, kind) VALUES (?, ?)').run(name, kind).lastInsertRowid);
    const diagT = db.prepare("SELECT id FROM service_types WHERE name = 'Диагностика'").get().id;
    const labT = db.prepare("SELECT id FROM service_types WHERE name = 'Лаборатория'").get().id;
    const labD = db.prepare("SELECT id FROM departments WHERE kind = 'laboratory' LIMIT 1").get().id;
    add('A01', { type_id: diagT });
    add('A02', { type_id: typ('УЗИ-исследования') });
    add('A03', {});
    add('A09', { type_id: typ('Лабораторная диагностика') });
    add('A10', { type_id: typ('Laboratoriya va diagnostika') });
    add('A11', { type_id: labT });
    add('A12', { type_id: diagT, department_id: dep('Кабинет функциональной диагностики', 'procedure') });
    add('A13', { type_id: diagT, department_id: labD });
    add('A14', { type: 'procedure', type_id: diagT });
    add('A15', { type: 'radiology' });
    add('A16', { type: 'other' });
    add('A17', { type_id: diagT, req: 1 });
  });
  try {
    const got = await myServices(s.codes);
    const want = ['A01', 'A02', 'A03', 'A09', 'A10', 'A11', 'A12', 'A13', 'A15', 'A16', 'A17'];
    assert.deepEqual(got.active, want, '«Активные»');
    assert.deepEqual(got.all, want, '«Все статусы»');
  } finally { s.close(); }
});
