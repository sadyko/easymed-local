// DIAG_ROUTE_V1 (D1, решение владельца 2026-11-03) — БЫСТРАЯ РЕГИСТРАЦИЯ НЕ
// СОХРАНЯЕТ УСЛУГУ КАБИНЕТА ВРАЧА БЕЗ ИСПОЛНИТЕЛЯ.
//
// Расследование (#1, пробы FR1/FR2): УЗИ «без врача» с двумя исполнителями
// сохранялось с пустым «— выберите врача —», а без отмеченных исполнителей у
// строки не было и выбора («—») — строка без исполнителя, которую не видит ни
// один кабинет. Теперь сохранение отказывает, пока исполнитель не выбран; список
// — отмеченные услуге, иначе все врачи (is_doctor); один кандидат — сам.
//
// Настоящий сервер (crm-unify-app: все миграции, база в памяти), настоящее окно,
// вход — регистратурой. Синтетические данные.
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
 focus(){} blur(){} scrollTo(){} scrollIntoView(){} remove(){ if(this.parentNode) this.parentNode.removeChild(this); } select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 closest(sel){const c=String(sel).replace(/^\./,'');let n=this;while(n){if(String(n.className||'').split(/\s+/).includes(c))return n;n=n.parentNode;}return null;}
 getBoundingClientRect(){return {top:0,left:0,width:0,height:0,bottom:0,right:0};}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className||'').split(/\s+/).includes(c),add(c){s.className=(s.className?s.className+' ':'')+c;},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') { el.content = { firstChild: null }; Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } }); }
  if (el.tagName === 'SELECT') Object.defineProperty(el, 'options', { get() { return el.children.filter((c) => c.tagName === 'OPTION'); } });
  return el;
}
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
const toastEl = mk('div'); const toasts = [];
Object.defineProperty(toastEl, 'textContent', { get(){ return toastEl._t; }, set(v){ toastEl._t = String(v); toasts.push(String(v)); } });
toastEl.dataset = {};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  getElementById:(id)=> (id === 'toast' ? toastEl : null), querySelector(){return null;},querySelectorAll(){return [];}};
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem:(k)=>(store.has(k)?store.get(k):null), setItem:(k,v)=>store.set(k,String(v)), removeItem:(k)=>store.delete(k), clear:()=>store.clear() };
globalThis.window = { location: { hostname: 'localhost', hash: '' }, localStorage: globalThis.localStorage, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }), scrollTo(){}, scrollY: 0,
  easymed: { state: { user: { id: 2, full_name: 'Регистратура', role: 'registrar' } } }, CLINIC: { id: 'c-1' }, confirm: () => true, prompt: () => null, open: () => null,
  easymedSetTabSub(){}, easymedSetTabLabel(){} };
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}}; globalThis.requestAnimationFrame=(fn)=>fn(); globalThis.cancelAnimationFrame=()=>{};
globalThis.history = { state: null, replaceState(){}, pushState(){} };
try { Object.defineProperty(globalThis, 'navigator', { value: { ...(globalThis.navigator || {}), language: (globalThis.navigator && globalThis.navigator.language) || 'ru-RU', mediaDevices: null }, configurable: true }); } catch (e) { /* без navigator — не беда */ }

const realFetch = globalThis.fetch;
let LIVE = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!LIVE || !u.startsWith('/')) return realFetch(url, opts);
  return realFetch(LIVE.base + u, { ...opts, headers: { ...(opts.headers || {}), Cookie: LIVE.cookie } });
};
const { startCrmApp } = await import('../../../../server/test-helpers/crm-unify-app.js');
const { openFastRegistrationDialog } = await import('../views/fast-registration.js');
const { setFullAccess } = await import('../permissions.js');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const btnByText = (root, text) => walk(root).filter((n) => n.tagName === 'BUTTON').find((b) => textOf(b).replace(/\s+/g, ' ').trim().includes(text));

/** Услуга 60 «Svc-УЗИ» (Диагностика, «без врача»); perf — кому отмечена; extraDoctor — ещё врач клиники. */
const seedWith = (perf, { extraDoctor = true } = {}) => (db) => {
  const rates = JSON.stringify([{ service_id: 60, percentage: 0 }]);
  db.prepare("INSERT INTO services (id, name, price, type, requires_doctor, duration_minutes) VALUES (60, 'Svc-УЗИ', 100000, 'imaging', 0, 20)").run();
  for (const p of perf) db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates) VALUES (?,?,?,?,?,?,?)')
    .run(p.id, 'p' + p.id, 'x', 'Исполнитель-' + p.id, p.role || 'doctor', p.is_doctor ?? 1, rates);
  if (extraDoctor) db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (31, 'd31', 'x', 'Врач-31', 'doctor', 1)").run();
};

async function openDialog(seed) {
  const t = await startCrmApp(seed);
  const base = `http://127.0.0.1:${t.server.address().port}`;
  const res = await realFetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reg', password: 'password1' }) });
  assert.equal(res.status, 200);
  LIVE = { base, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
  toasts.length = 0; document.body.children.length = 0;
  setFullAccess('Admin');
  const dlg = openFastRegistrationDialog({});
  for (let i = 0; i < 60 && !(dlg.state.catalog && dlg.state.catalog.length && dlg.state.doctors); i++) await tick(50);
  dlg.searchInput.value = 'Пациент'; dlg.searchInput.fireInput();
  for (let i = 0; i < 60 && !walk(dlg.card).some((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt')); i++) await tick(50);
  walk(dlg.card).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt')).click();
  await tick(300);
  dlg.state.addLine(dlg.state.catalog.find((s) => Number(s.id) === 60), null);
  const row = () => dlg.state.rows.find((r) => Number(r.service.id) === 60);
  const save = async () => {
    btnByText(dlg.card, 'Сохранить').click();
    for (let i = 0; i < 60 && !(dlg.state.result && dlg.state.result.invoice); i++) await tick(50);
  };
  const line = () => t.db.prepare('SELECT doctor_id FROM visit_services WHERE service_id = 60').get();
  return { t, dlg, row, save, line, close: () => { try { dlg.close(); } catch (e) { /* закрыто */ } LIVE = null; t.close(); } };
}

test('FR1 / FR2: два исполнителя или никто не отмечен — сохранение отказывает, пока исполнитель не выбран; выбранный ложится в строку', async () => {
  for (const [label, perf, want] of [['FR1 два отмеченных', [{ id: 21 }, { id: 22 }], [21, 22]], ['FR2 никто не отмечен — все врачи', [], [10, 31]]]) {
    const s = await openDialog(seedWith(perf));
    try {
      const r = s.row();
      assert.ok(r && r.sel, label + ': у строки нет выбора исполнителя');
      const ids = r.sel.children.filter((o) => o.tagName === 'OPTION').map((o) => o.attrs.value).filter(Boolean).map(Number).sort((a, b) => a - b);
      assert.deepEqual(ids, want, label + ': кандидаты');
      assert.equal(r.sel.value, '', label + ': выбран сам при двух кандидатах');
      await s.save();
      assert.equal(s.line(), undefined, label + ': строка сохранена без исполнителя');
      assert.ok(toasts.some((x) => /Укажите врача для услуги «Svc-УЗИ»/.test(x)), label + ': отказ не сказан: ' + JSON.stringify(toasts.slice(-3)));
      r.sel.value = String(want[1]);
      r.sel.dispatchEvent({ type: 'change', target: r.sel, currentTarget: r.sel });
      await s.save();
      assert.equal(s.line() && s.line().doctor_id, want[1], label + ': выбранный исполнитель не в строке');
    } finally { s.close(); }
  }
});

test('единственный кандидат — сам: отмеченная медсестра (не врач) становится исполнителем', async () => {
  const s = await openDialog(seedWith([{ id: 25, role: 'nurse', is_doctor: 0 }]));
  try {
    assert.equal(s.row().doctorId, 25);
    await s.save();
    assert.equal(s.line() && s.line().doctor_id, 25);
  } finally { s.close(); }
});
