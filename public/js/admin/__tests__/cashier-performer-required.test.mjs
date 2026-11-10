// DIAG_ROUTE_V1 (I-4, 3.22.0) — КАССА: «ДОБАВИТЬ УСЛУГУ» И ЗАМЕНА В «ПЛАТЕЖАХ» ТРЕБУЮТ
// ИСПОЛНИТЕЛЯ У УСЛУГИ КАБИНЕТА.
//
// Строка кабинета без исполнителя не видна ни одному кабинету (SERVICE_SCOPE_V3).
// Регистратура исполнителя уже требует (needsPerformer — shared/service-route.js); касса
// предлагала «Без врача». Теперь у услуги кабинета «Без врача» нет, единственный
// исполнитель выбирается сам; анализу и процедуре — как прежде.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.value = ''; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  click() { for (const fn of this._l.click || []) fn({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  querySelector() { return null; } querySelectorAll() { return []; }
  get textContent() { return this._t; }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { return { add() {}, remove() {}, contains: () => false, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => { const e = new F(t); if (e.tagName === 'TEMPLATE') { e.content = { firstChild: null }; Object.defineProperty(e, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); e.content.firstChild = s; }, get() { return ''; } }); } return e; };
globalThis.Node = F;
globalThis.document = { createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t), head: mk('head'), body: mk('body'), documentElement: mk('html'), addEventListener() {}, removeEventListener() {}, getElementById: () => null };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, easymed: { state: { user: { id: 9, role: 'cashier' } } } };
let PERFORMERS = [];
globalThis.fetch = async (url) => {
  const data = String(url).includes('cashier_line_performers') ? { performers: PERFORMERS, requires_doctor: false, catalog_price: 50000 } : [];
  return { ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
};
const { pickPerformer } = await import('../views/cashier-line-fix.js?v=refbill4');
const walk = (e, o = []) => { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; };
const tick = () => new Promise((r) => setTimeout(r, 20));
const performerButtons = () => walk(document.body).filter((n) => n.attrs && n.attrs['data-performer'] !== undefined).map((n) => n.attrs['data-performer']);

const DOC = { id: 20, full_name: 'Врач УЗИ', unit_price: 50000 };
const DOC2 = { id: 21, full_name: 'Второй врач', unit_price: 60000 };

test('услуга кабинета (УЗИ), один исполнитель — выбран сам, «Без врача» не предлагается', async () => {
  document.body.children.length = 0;
  PERFORMERS = [DOC];
  const got = await Promise.race([
    pickPerformer('Кто оказывает услугу', { service_id: 31, visit_id: 1 }, { allowNone: true, service: { id: 31, type: 'imaging' } }),
    new Promise((r) => setTimeout(() => r('timeout'), 500)),
  ]);
  assert.notEqual(got, 'timeout', 'единственный исполнитель не выбран сам: ' + JSON.stringify(performerButtons()));
  assert.deepEqual([got.id, got.full_name], [20, 'Врач УЗИ']);
});

test('услуга кабинета, два исполнителя — выбор из двух, «Без врача» нет', async () => {
  document.body.children.length = 0;
  PERFORMERS = [DOC, DOC2];
  const p = pickPerformer('Кто оказывает услугу', { service_id: 31, visit_id: 1 }, { allowNone: true, service: { id: 31, type: 'imaging' } });
  await tick();
  assert.deepEqual(performerButtons(), ['20', '21']);
  walk(document.body).find((n) => n.attrs && n.attrs['data-performer'] === '21').click();
  assert.equal((await p).id, 21);
});

test('анализ — как прежде: «Без врача» есть, сам не выбирается', async () => {
  document.body.children.length = 0;
  PERFORMERS = [DOC];
  const p = pickPerformer('Кто оказывает услугу', { service_id: 40, visit_id: 1 }, { allowNone: true, service: { id: 40, type: 'lab', is_lab: 1 } });
  await tick();
  assert.deepEqual(performerButtons(), ['none', '20']);
  walk(document.body).find((n) => n.attrs && n.attrs['data-performer'] === 'none').click();
  assert.equal((await p).id, null);
});

// LAB_NO_DOCTOR_V1 (ревью, решение координатора b) — анализ, оставленный в группе «Консультации»
// с requires_doctor = 0, исполнителя не требует и у кассы: «Без врача» есть, сам не выбирается.
test('LAB_NO_DOCTOR_V1: анализ в группе «Консультации» (requires_doctor = 0) — «Без врача» есть, один исполнитель сам не выбирается', async () => {
  document.body.children.length = 0;
  PERFORMERS = [DOC];
  let settled = false;
  const p = pickPerformer('Кто оказывает услугу', { service_id: 41, visit_id: 1 }, { allowNone: true, service: { id: 41, type: 'consultation', requires_doctor: 0 } })
    .then((v) => { settled = true; return v; });
  await tick(); await tick();
  assert.equal(settled, false, 'исполнитель выбран сам у анализа без врача');
  assert.deepEqual(performerButtons(), ['none', '20'], '«Без врача» не предложен');
  walk(document.body).find((n) => n.attrs && n.attrs['data-performer'] === 'none').click();
  assert.equal((await p).id, null);
  const { cashierNeedsPerformer } = await import('../views/cashier-line-fix.js?v=refbill4');
  assert.equal(cashierNeedsPerformer({ id: 41, type: 'consultation', requires_doctor: 0 }), false);
  assert.equal(cashierNeedsPerformer({ id: 31, type: 'imaging', requires_doctor: 0 }), true, 'УЗИ — исполнитель нужен (D1)');
});
