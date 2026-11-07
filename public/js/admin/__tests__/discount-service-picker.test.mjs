// DISCOUNT_V2 (решение владельца 2026-11-07, п. 5) — «Только на эти услуги»: окно выбора
// вместо длинного списка галочек. Поиск, услуги по категориям (без категории — по
// группе), «Выбрать всю категорию», счётчик, фишки выбранного с крестиком. Сохраняется
// прежний формат — массив id услуг.
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
  fire(t) { for (const fn of this._l[t] || []) fn({ type: t, currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  click() { this.fire('click'); }
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
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage };
const TABLES = {
  services: [
    { id: 1, name: 'ОАК', type: 'lab', type_id: 2, category_id: 10 },
    { id: 2, name: 'Биохимия', type: 'lab', type_id: 2, category_id: 10 },
    { id: 3, name: 'УЗИ печени', type: 'imaging', type_id: 3, category_id: 11 },
    { id: 4, name: 'Приём терапевта', type: 'consultation', type_id: 1, category_id: null },
  ],
  service_types: [{ id: 1, name: 'Консультации' }, { id: 2, name: 'Лаборатория' }, { id: 3, name: 'Диагностика' }],
  service_categories: [{ id: 10, name: 'Анализы крови' }, { id: 11, name: 'УЗИ' }],
};
globalThis.fetch = async (url, opts = {}) => {
  const body = JSON.parse(opts.body || '{}');
  return { ok: true, status: 200, json: async () => ({ data: TABLES[body.table] || [] }), headers: { getSetCookie: () => [] } };
};

const { groupServicesForPicker, filterPickerGroups, toggleGroupIds, discountServicesField } = await import('../views/discount-service-picker.js');
const walk = (e, o = []) => { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; };
const textOf = (e) => [e, ...walk(e)].map((n) => n._t || '').join(' ');
const byAttr = (root, k, v) => walk(root).find((n) => n.attrs && n.attrs[k] !== undefined && (v === undefined || n.attrs[k] === String(v)));
const allByAttr = (root, k) => walk(root).filter((n) => n.attrs && n.attrs[k] !== undefined);

test('разделы окна: категория услуги, без категории — группа услуги; по алфавиту', () => {
  const g = groupServicesForPicker(TABLES.services, { types: TABLES.service_types, categories: TABLES.service_categories });
  assert.deepEqual(g.map((x) => [x.name, x.items.map((i) => i.id)]), [['Анализы крови', [2, 1]], ['Консультации', [4]], ['УЗИ', [3]]]);
});

test('поиск — по услуге и по разделу; «Выбрать всю категорию» — выбрать все, второй раз — снять', () => {
  const g = groupServicesForPicker(TABLES.services, { types: TABLES.service_types, categories: TABLES.service_categories });
  assert.deepEqual(filterPickerGroups(g, 'биохим').map((x) => [x.name, x.items.map((i) => i.id)]), [['Анализы крови', [2]]]);
  assert.deepEqual(filterPickerGroups(g, 'узи').map((x) => x.name), ['УЗИ']);
  const sel = new Set([1]);
  toggleGroupIds(sel, g[0].items);
  assert.deepEqual([...sel].sort(), [1, 2]);
  toggleGroupIds(sel, g[0].items);
  assert.deepEqual([...sel], []);
});

test('поле формы: фишки выбранного, крестик убирает, окно выбирает категорию целиком; .value — массив id (прежний формат)', async () => {
  document.body.children.length = 0;
  const el = discountServicesField([3]);
  await el.load();
  assert.deepEqual(el.value, [3]);
  assert.ok(textOf(el).includes('Выбрано услуг: 1'), textOf(el));
  assert.ok(textOf(byAttr(el, 'data-discount-chip', 3)).includes('УЗИ печени'));
  byAttr(el, 'data-discount-services-open').click();
  const dlg = byAttr(document.body, 'data-discount-services-picker');
  assert.ok(dlg, 'окно не открылось');
  assert.ok(textOf(byAttr(dlg, 'data-picker-count')).includes('Выбрано: 1'));
  byAttr(dlg, 'data-picker-group', 'c:10').click();   // ревью S5 L-4 — раздел категории — по id («Анализы крови»)
  const dlg2 = byAttr(document.body, 'data-discount-services-picker');
  assert.ok(textOf(byAttr(dlg2, 'data-picker-count')).includes('Выбрано: 3'));
  byAttr(dlg2, 'data-picker-apply').click();
  assert.deepEqual([...el.value].sort(), [1, 2, 3]);
  assert.equal(allByAttr(el, 'data-discount-chip').length, 3);
  byAttr(el, 'data-discount-chip-remove', 1).click();
  assert.deepEqual([...el.value].sort(), [2, 3]);
});

test('ничего не выбрано — подсказка «на весь счёт»', async () => {
  const el = discountServicesField([]);
  await el.load();
  assert.deepEqual(el.value, []);
  assert.ok(textOf(el).includes('скидка действует на весь счёт'), textOf(el));
});

test('«Скидки и сертификаты» и «Группы пациентов»: переключатель «Скидка уменьшает долю врача» (по умолчанию включён — как всегда), «Только на эти услуги» — окно выбора', async () => {
  const { LOOKUP_CONFIG } = await import('../views/settings-hub.js');
  for (const key of ['patient_discounts', 'patient_categories']) {
    const f = (LOOKUP_CONFIG[key].fields || []).find((x) => x.key === 'reduces_doctor_share');
    assert.ok(f, key + ': нет переключателя');
    assert.deepEqual([f.type, f.label, f.checkedValue, f.uncheckedValue, f.default], ['checkbox', 'Скидка уменьшает долю врача', 1, 0, 1]);
  }
  const svc = LOOKUP_CONFIG.patient_discounts.fields.find((x) => x.key === 'service_ids');
  assert.equal(svc.type, 'services');
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../views/settings-hub.js', import.meta.url), 'utf8');
  assert.match(src, /control = discountServicesField\(/, 'поле услуг скидки — не окно выбора');
  assert.ok(!/function servicesPicker\(/.test(src), 'прежний длинный список галочек остался');
});
