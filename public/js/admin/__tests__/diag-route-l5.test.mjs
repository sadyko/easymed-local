// DIAG_ROUTE_V1 (3.22.0, ревью L-5) — ОСТАВШИЕСЯ МЕСТА РЕШАЮТ МАРШРУТ ОБЩИМ ПРАВИЛОМ
// (shared/service-route.js serviceRoute): каталог записи (service-picker-modal.js
// isCabinetRouted / isProcedureRouted), исполнитель по умолчанию (visit-line-row.js
// visitDoctorMayPerform), «новый анализ» в «Платежах» (cashier-line-fix.js isLabService).
//
// Для всех групп, кроме «Консультаций», ответ ПРЕЖНИЙ — проверяется таблицей против прежних
// выражений, при любых подсказках (отделение «Лаборатория» / «Процедурный», тип каталога
// «Лабораторная диагностика»). Группа «Консультации» (умолчание колонки, под которым клиники
// держат анализы) теперь идёт отделением и типом — как лаборатория, очередь и кабинет.
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

const { visitDoctorMayPerform } = await import('../views/visit-line-row.js');
const { pickerIsCabinetRouted, pickerIsProcedureRouted } = await import('../views/service-picker-modal.js?v=ownrep4');
const { cashierIsLabService } = await import('../views/cashier-line-fix.js');

// Прежние выражения (3.21.1) — эталон для групп, кроме «Консультаций».
const OLD = {
  cabinet: (svc) => { const t = (svc && svc.type || '').trim(); return t !== 'lab' && t !== 'procedure'; },
  procedure: (svc) => String((svc && svc.type) || '').trim() === 'procedure',
  mayPerform: (svc) => {
    if (!svc) return false;
    if (svc.__consult) return true;
    if (svc.requires_doctor === false || svc.requires_doctor === 0 || svc.requires_doctor === '0') return false;
    if (svc.is_lab === true || svc.is_lab === 1) return false;
    const t = String(svc.type || '').toLowerCase();
    return t !== 'lab' && t !== 'procedure';
  },
  lab: (s) => !!s && (Number(s.is_lab) === 1 || s.type === 'lab'),
};
const HINTS = [
  {},
  { departments: { kind: 'laboratory' } },
  { departments: { kind: 'procedure' } },
  { service_types: { name: 'Лабораторная диагностика' } },
];
const cases = [];
for (const type of ['lab', 'procedure', 'imaging', 'radiology', 'other']) {
  for (const hint of HINTS) {
    for (const rd of [undefined, 0, 1]) {
      cases.push({ id: 1, type, is_lab: type === 'lab' ? 1 : 0, requires_doctor: rd, ...hint });
    }
  }
}

test('ревью L-5: группы кроме «Консультаций» — ответы прежние (каталог, исполнитель по умолчанию, «Платежи»)', () => {
  for (const svc of cases) {
    const tag = JSON.stringify(svc);
    assert.strictEqual(pickerIsCabinetRouted(svc), OLD.cabinet(svc), 'каталог/кабинет ' + tag);
    assert.strictEqual(pickerIsProcedureRouted(svc), OLD.procedure(svc), 'каталог/процедуры ' + tag);
    assert.strictEqual(visitDoctorMayPerform(svc), OLD.mayPerform(svc), 'исполнитель ' + tag);
    assert.strictEqual(cashierIsLabService(svc), OLD.lab(svc), 'Платежи/анализ ' + tag);
  }
  assert.strictEqual(visitDoctorMayPerform({ __consult: true, type: 'lab' }), true, 'консультация из каталога — врач визита');
  assert.strictEqual(visitDoctorMayPerform(null), false);
  assert.strictEqual(cashierIsLabService(null), false);
});

test('ревью L-5: «Консультации» из отделения «Лаборатория» — анализ везде; из «Процедурного» — процедура; без подсказок — кабинет', () => {
  const labLike = { id: 2, type: 'consultation', is_lab: 0, departments: { kind: 'laboratory' } };
  assert.strictEqual(pickerIsCabinetRouted(labLike), false);
  assert.strictEqual(visitDoctorMayPerform(labLike), false, 'врач визита ставился исполнителем анализа');
  assert.strictEqual(cashierIsLabService(labLike), true);
  const typeLab = { id: 3, type: 'consultation', service_types: { name: 'Laboratoriya' } };
  assert.strictEqual(cashierIsLabService(typeLab), true);
  const procLike = { id: 4, type: 'consultation', departments: { kind: 'procedure' } };
  assert.strictEqual(pickerIsProcedureRouted(procLike), true);
  assert.strictEqual(pickerIsCabinetRouted(procLike), false);
  const plain = { id: 5, type: 'consultation' };
  assert.strictEqual(pickerIsCabinetRouted(plain), true);
  assert.strictEqual(visitDoctorMayPerform(plain), true);
  assert.strictEqual(cashierIsLabService(plain), false);
});

test('ревью L-5: каталог записи берёт правило в замыкании, а не своё выражение', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'views', 'service-picker-modal.js'), 'utf8');
  assert.match(src, /function isCabinetRouted\(svc\) \{\s*return pickerIsCabinetRouted\(svc\);/);
  assert.match(src, /function isProcedureRouted\(svc\) \{\s*return pickerIsProcedureRouted\(svc\);/);
  const fix = fs.readFileSync(path.join(HERE, '..', 'views', 'cashier-line-fix.js'), 'utf8');
  assert.match(fix, /const isLabService = cashierIsLabService;/);
});
