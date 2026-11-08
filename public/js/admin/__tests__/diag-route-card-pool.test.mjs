// DIAG_ROUTE_V1 (3.22.0, ревью L-6) — «Сменить врача» карты пациента: пул — как у записи.
//
// Прежде: users.role = 'doctor' и только отмеченные услуге — без запасного. Главного врача,
// администратора-врача и медсестру, отмеченных услуге, выбрать было нельзя; услуге кабинета без
// отметок отвечало «не назначен ни один врач» — а это и есть дверь, которой клиника чинит строки
// без исполнителя (выпуск 3.21: «найти открытые строки без исполнителя»).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;}
 addEventListener(){} removeEventListener(){} querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){return{contains(){return false;},add(){},remove(){},toggle(){}};}}
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node = F;
globalThis.document = { createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => { const n = new F('#text'); n._t = String(t); return n; },
  head: mk('head'), body: mk('body'), documentElement: mk('html'), addEventListener() {}, removeEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } };
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = { location: { hostname: 'localhost', hash: '' }, localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }), easymed: { state: { user: null } } };
globalThis.location = globalThis.window.location;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.history = { state: null, replaceState() {}, pushState() {} };

const { cardPerformerPool } = await import('../views/patient-card.js');

const USERS = [
  { id: 1, full_name: 'Врач Терапевт', is_doctor: 1, service_rates: '' },
  { id: 2, full_name: 'Главный Врач', is_doctor: 1, service_rates: '' },          // роль admin, флаг врача
  { id: 3, full_name: 'Медсестра ЭКГ', is_doctor: 0, service_rates: JSON.stringify([{ service_id: 30, pct: 10 }]) },
  { id: 4, full_name: 'Кассир', is_doctor: 0, service_rates: '' },
  { id: 5, full_name: 'Сонолог', is_doctor: 1, service_rates: [{ service_id: 20, pct: 20 }] },
];
const SERVICES = {
  10: { id: 10, type: 'imaging', requires_doctor: 0 },      // УЗИ без отметок — все врачи
  20: { id: 20, type: 'imaging', requires_doctor: 0 },      // УЗИ, отмечено сонологу
  30: { id: 30, type: 'imaging', requires_doctor: 0 },      // ЭКГ, отмечено медсестре
  40: { id: 40, type: 'lab', is_lab: 1 },                   // анализ без отметок — никого
};
const serviceOf = async (id) => SERVICES[id];
const ids = (list) => list.map((u) => u.id);

test('ревью L-6: услуга кабинета без отметок — все врачи по флагу (и администратор-врач), не роль', async () => {
  assert.deepStrictEqual(ids(await cardPerformerPool({ serviceId: 10 }, { users: USERS, serviceOf })), [1, 2, 5]);
});

test('ревью L-6: отмеченные услуге — только они, медсестра тоже', async () => {
  assert.deepStrictEqual(ids(await cardPerformerPool({ serviceId: 20 }, { users: USERS, serviceOf })), [5]);
  assert.deepStrictEqual(ids(await cardPerformerPool({ serviceId: 30 }, { users: USERS, serviceOf })), [3]);
});

test('ревью L-6: анализ без отметок — пусто (исполнитель не нужен); консультация по виду приёма — все врачи', async () => {
  assert.deepStrictEqual(ids(await cardPerformerPool({ serviceId: 40 }, { users: USERS, serviceOf })), []);
  assert.deepStrictEqual(ids(await cardPerformerPool({ serviceId: null, consultTypeId: 7 }, { users: USERS, serviceOf })), [1, 2, 5]);
  assert.deepStrictEqual(ids(await cardPerformerPool({ serviceId: null }, { users: USERS, serviceOf })), []);
});

test('ревью L-6: «Сменить врача» берёт пул через cardPerformerPool, без role = doctor', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'views', 'patient-card.js'), 'utf8');
  assert.doesNotMatch(src, /\.eq\('role', 'doctor'\)/);
  // CARD_REFERRER_ONLY_V1 (3.22.0, ревью) — после слияния с работой партнёра (врач и
  // «Направил» одной правкой) сотрудники берутся заранее (docPool = svcDoctorPool()),
  // а пул — по-прежнему cardPerformerPool.
  assert.match(src, /editable \? svcDoctorPool\(\)/);
  assert.match(src, /const pool = editable \? await cardPerformerPool\(s, \{ users: docPool, serviceOf: svcRouteRow \}\)/);
  assert.match(src, /select\('id, full_name, is_doctor, service_rates'\)\.eq\('is_active', true\)/);
});
