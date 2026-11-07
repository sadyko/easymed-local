// DIAG_ROUTE_V1 (3.22.0) — остатки 3.21.2 кабинета врача (ревью L-1, L-2, L-3, I-2), настоящим сервером
// и настоящим consultation.js в фальшивом DOM (харнесс — как у diag-route-cabinet.test.mjs).
//
//   L-1 — «Мой день»: визит дня, где у врача своя строка, записанная давно, виден и после 2000
//         более новых строк врача (окно — день визита, а не 2000 новейших строк);
//   L-2 — «Мои приёмы» администратора: предел 5000 открытых строк не тратится на анализы,
//         процедуры и строки отменённых визитов — их отсекает SQL; запись, сделанная заранее,
//         на месте;
//   L-3 — строка, пришедшая и открытой, и завершённой (её завершили между двумя чтениями), —
//         одна, завершённая;
//   I-2 — тик автообновления пропускается и под полноэкранным мастером «Направить на услуги»
//         (у его подложки нет класса .modal).
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
async function stand(build, { as = 'uzi' } = {}) {
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
  const res = await realFetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: as, password: 'password1' }) });
  assert.equal(res.status, 200, 'вход сонолога');
  LIVE = { base, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
  window.easymed.state.user = as === 'boss'
    ? { id: 1, full_name: 'Админ', role: 'admin', is_doctor: false, is_admin: true, is_super_admin: false }
    : { id: DOC, full_name: 'Сонолог Синтетический', role: 'doctor', is_doctor: true, is_admin: false, is_super_admin: false };
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

const old = (days) => new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');

test('ревью L-1: «Мой день» — визит дня с моей давней строкой виден и после 2100 более новых моих строк', async () => {
  const s = await stand((db, add) => {
    add('D2X', {}, { created: old(40) }, { doctor: OTHER });   // визит терапевта сегодня, моя строка — 40 дней назад
    const sid = db.prepare("SELECT id FROM services WHERE name = 'Svc-D2X'").get().id;
    db.prepare("INSERT INTO patients (id, full_name, last_name, first_name) VALUES (6101, 'История', 'История', '')").run();
    const vid = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (6101, ?, ?, 'arrived')").run(DOC, old(20)).lastInsertRowid);
    const S = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, status, created_at) VALUES (?, ?, ?, 'completed', ?)");
    db.transaction(() => { for (let i = 0; i < 2100; i++) S.run(vid, sid, DOC, old(30 - i / 100)); })();
  });
  try {
    assert.deepEqual(await myDay(['D2X']), ['D2X']);
  } finally { s.close(); }
});

test('ревью L-2: «Мои приёмы» администратора — 5000 открытых анализов, процедур и строк отменённых визитов не вытесняют запись, сделанную заранее', async () => {
  const s = await stand((db, add) => {
    add('L02', {}, { status: 'added', created: old(100) });   // запись на сегодня, сделана 100 дней назад
    add('LABX', { type: 'lab' }, { status: 'queued' });       // анализ — не кабинет
    const lab = db.prepare("SELECT id FROM services WHERE name = 'Svc-LABX'").get().id;
    db.prepare("INSERT INTO services (id, name, price, type, duration_minutes) VALUES (6299, 'Svc-PROC', 1, 'procedure', 20)").run();
    db.prepare("INSERT INTO patients (id, full_name, last_name, first_name) VALUES (6201, 'Шум', 'Шум', '')").run();
    const live = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (6201, ?, ?, 'arrived')").run(DOC, at(TODAY, 9)).lastInsertRowid);
    const gone = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (6201, ?, ?, 'cancelled')").run(DOC, at(TODAY, 9)).lastInsertRowid);
    const svcUzi = db.prepare("SELECT id FROM services WHERE name = 'Svc-L02'").get().id;
    const S = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, status, created_at) VALUES (?, ?, ?, 'queued', ?)");
    db.transaction(() => {
      for (let i = 0; i < 2600; i++) S.run(live, lab, DOC, old(i / 1000));
      for (let i = 0; i < 1300; i++) S.run(live, 6299, DOC, old(i / 1000));
      for (let i = 0; i < 1300; i++) S.run(gone, svcUzi, DOC, old(i / 1000));
    })();
  }, { as: 'boss' });
  try {
    const { all } = await myServices(['L02', 'LABX']);
    assert.deepEqual(all, ['L02'], 'запись, сделанная заранее, пропала у администратора (или анализ попал в кабинет)');
  } finally { s.close(); }
});

test('ревью L-3: строка и открытая, и завершённая — одна, завершённая (mergeOpenDone)', () => {
  const open = [{ id: 1, status: 'queued' }, { id: 2, status: 'in_progress' }];
  const done = [{ id: 2, status: 'completed' }, { id: 3, status: 'completed' }];
  assert.deepEqual(cabinet.mergeOpenDone(open, done).map((r) => [r.id, r.status]), [[1, 'queued'], [2, 'completed'], [3, 'completed']]);
  assert.deepEqual(cabinet.mergeOpenDone(null, undefined), []);
  assert.deepEqual(cabinet.mergeOpenDone([{ id: 4 }, { id: 4 }], []).map((r) => r.id), [4], 'строка из двух запросов открытых — одна');
});

test('ревью I-2: под полноэкранным мастером «Направить на услуги» тик пропускается', async () => {
  const s = await stand((db, add) => { add('T11', {}); });
  const prevQS = document.querySelector;
  try {
    const root = mk('div');
    await cabinet.renderConsultation(root, { onNavigate() {}, tabId: 'consultation', payload: { sub: 'work' } });
    for (let i = 0; i < 50 && !walk(root).some((n) => n.tagName === 'TBODY'); i++) await tick(60);
    const asked = [];
    document.querySelector = (q) => { asked.push(q); return /\[data-visit-wizard\]/.test(q) ? mk('div') : null; };
    assert.equal(await cabinet.autoFreshTick(), false, 'тик под мастером не пропущен');
    assert.ok(asked.some((q) => /\[data-visit-wizard\]/.test(q)), 'мастер не спрошен: ' + asked.join(' | '));
  } finally { document.querySelector = prevQS; cabinet.stopAutoFresh(); s.close(); }
});

test('ревью I-2: у подложки мастера записи есть метка data-visit-wizard', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../views/visit-wizard.js', import.meta.url), 'utf8');
  assert.match(src, /const overlay = h\('div', \{\s*'data-visit-wizard': '',/);
});
