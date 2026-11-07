// DISCOUNT_RATES_V1 (3.22.0, владелец 2026-11-07) — НАСТРОЙКА СКИДКИ ПО УСЛУГАМ.
// «Группы пациентов» и «Скидки и сертификаты»: пять групп услуг прямо в форме (поле «%»,
// быстрые «100 %» / «0 %»), категории и отдельные услуги — в окне «Услуги скидки» / «Скидка
// по услугам». «Консультации — 100 %, остальное — 20 %» — два нажатия. Сводка у строки скидки.
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

const { discountServicesField, discountRatesField, ratesSummaryText, groupServicesForPicker } = await import('../views/discount-service-picker.js');
const walk = (e, o = []) => { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; };
const textOf = (e) => [e, ...walk(e)].map((n) => n._t || '').join(' ');
const byAttr = (root, k, v) => walk(root).find((n) => n.attrs && n.attrs[k] !== undefined && (v === undefined || n.attrs[k] === String(v)));
const typeInto = (inp, v) => { inp.value = String(v); inp.fire('input'); };

test('группа пациентов: «Консультации — 100 %» — одно нажатие в форме; .value — ставки для записи', async () => {
  const el = discountRatesField({});
  await el.load();
  assert.deepEqual(el.value, {});
  assert.ok(textOf(el).includes('Своих ставок нет'), textOf(el));
  byAttr(el, 'data-rate-quick', 'consultation:100').click();
  assert.deepEqual(el.value, { g: { consultation: 100 } });
  assert.ok(textOf(byAttr(el, 'data-rates-summary')).includes('Консультации 100 %'));
  typeInto(byAttr(el, 'data-rate-group', 'lab'), '');
  typeInto(byAttr(el, 'data-rate-group', 'imaging'), '30');
  assert.deepEqual(el.value, { g: { consultation: 100, imaging: 30 } });
  typeInto(byAttr(el, 'data-rate-group', 'imaging'), '');
  assert.deepEqual(el.value, { g: { consultation: 100 } }, 'пустое поле — ставка снята');
});

test('окно «Скидка по услугам»: ставка категории и услуги; «Отмена» — без изменений; «Применить» — в поле', async () => {
  document.body.children.length = 0;
  const el = discountRatesField('{"g":{"consultation":100}}');
  await el.load();
  byAttr(el, 'data-rates-open').click();
  let dlg = byAttr(document.body, 'data-discount-services-picker');
  assert.ok(dlg, 'окно не открылось');
  assert.ok(!byAttr(dlg, 'data-picker-service'), 'у группы пациентов нет «только на эти услуги» — галочек нет');
  typeInto(byAttr(dlg, 'data-rate-category', 10), '50');
  typeInto(byAttr(dlg, 'data-rate-service', 3), '0');
  byAttr(dlg, 'data-picker-apply').click();
  assert.deepEqual(el.value, { g: { consultation: 100 }, c: { 10: 50 }, s: { 3: 0 } });
  assert.equal(textOf(byAttr(el, 'data-rates-summary')), 'Консультации 100 %, категорий со своей ставкой: 1, услуг со своей ставкой: 1');
  byAttr(el, 'data-rates-open').click();
  dlg = byAttr(document.body, 'data-discount-services-picker');
  typeInto(byAttr(dlg, 'data-rate-service', 3), '');
  dlg.remove();   // «Отмена» — окно закрыто без «Применить»
  assert.deepEqual(el.value, { g: { consultation: 100 }, c: { 10: 50 }, s: { 3: 0 } });
});

test('промокод: «Услуги скидки» — галочки и ставки в одном окне; .value — услуги (прежний формат), .rates — ставки', async () => {
  document.body.children.length = 0;
  const el = discountServicesField([3], undefined, { rates: { s: { 3: 50 } } });
  await el.load();
  byAttr(el, 'data-rate-quick', 'lab:0').click();
  byAttr(el, 'data-discount-services-open').click();
  const dlg = byAttr(document.body, 'data-discount-services-picker');
  assert.equal(byAttr(dlg, 'data-rate-service', 3).value, '50');
  byAttr(dlg, 'data-picker-group', 'c:10').click();   // ревью S5 L-4 — раздел категории — по id («Анализы крови»)
  const dlg2 = byAttr(document.body, 'data-discount-services-picker');
  typeInto(byAttr(dlg2, 'data-rate-service', 1), '100');
  byAttr(dlg2, 'data-picker-apply').click();
  assert.deepEqual([...el.value].sort(), [1, 2, 3]);
  assert.deepEqual(el.rates, { g: { lab: 0 }, s: { 1: 100, 3: 50 } });
  const plain = discountServicesField([3]);
  assert.equal(plain.rates, undefined, 'без ставок — поле как прежде');
});

test('сводка у строки скидки: «По умолчанию 20 %, Консультации 100 %, услуг со своей ставкой: 3»; без ставок — пусто', () => {
  assert.equal(ratesSummaryText(20, { g: { consultation: 100 }, s: { 1: 0, 2: 5, 3: 50 } }), 'По умолчанию 20 %, Консультации 100 %, услуг со своей ставкой: 3');
  assert.equal(ratesSummaryText(20, {}), '');
  assert.equal(ratesSummaryText(20, '{"g":{"other":0}}'), 'По умолчанию 20 %, Хирургия 0 %');
});

test('разделы окна несут id категории — ставка категории пишется по id', () => {
  const g = groupServicesForPicker(TABLES.services, { types: TABLES.service_types, categories: TABLES.service_categories });
  assert.deepEqual(g.map((x) => [x.name, x.categoryId ?? null]), [['Анализы крови', 10], ['Консультации', null], ['УЗИ', 11]]);
});

test('настройки: поле «Скидка по услугам» у группы пациентов и ставки в окне услуг промокода; сводка в списке', async () => {
  const { LOOKUP_CONFIG } = await import('../views/settings-hub.js');
  const cat = LOOKUP_CONFIG.patient_categories;
  assert.deepEqual(cat.fields.find((x) => x.key === 'discount_rates').type, 'discount_rates');
  const col = cat.columns.find((x) => x.key === 'discount_rates');
  assert.equal(col.format({ discount_percent: 20, discount_rates: { g: { consultation: 100 } } }), 'По умолчанию 20 %, Консультации 100 %');
  assert.equal(col.format({ discount_percent: 10, discount_rates: {} }), '—');
  const disc = LOOKUP_CONFIG.patient_discounts;
  assert.equal(disc.fields.find((x) => x.key === 'service_ids').ratesKey, 'discount_rates');
  assert.equal(disc.columns.find((x) => x.key === 'discount_rates').format({ percent: 10, discount_rates: { c: { 7: 50 } } }), 'По умолчанию 10 %, категорий со своей ставкой: 1');
});

// Ревью S5 L-2 — ставки по услугам действуют только у промокода С ПРОЦЕНТОМ (сервер:
// domain/discount-rates.js promoRateSource). У подарочной карты, сертификата и промокода
// суммой их поле не показывается — что бы там ни поставили, счёт их не видит.
test('ревью S5 L-2: ставки — только у промокода с процентом; карта, сертификат, сумма — без поля ставок', async () => {
  const { promoRatesApply } = await import('../discount-rates.js');
  assert.equal(promoRatesApply({ kind: 'promo', percent: '10' }), true);
  assert.equal(promoRatesApply({ kind: '', percent: 5 }), true, 'вид не выбран — промокод');
  assert.equal(promoRatesApply({ kind: 'promo', percent: '0', amount: '50000' }), false, 'промокод суммой');
  assert.equal(promoRatesApply({ kind: 'promo', percent: '' }), false);
  assert.equal(promoRatesApply({ kind: 'gift_card', percent: '10' }), false);
  assert.equal(promoRatesApply({ kind: 'certificate', percent: '10' }), false);

  const { LOOKUP_CONFIG } = await import('../views/settings-hub.js');
  const disc = LOOKUP_CONFIG.patient_discounts;
  const f = disc.fields.find((x) => x.key === 'service_ids');
  assert.equal(typeof f.ratesWhen, 'function', 'поле услуг промокода не знает, когда ставки действуют');
  assert.equal(f.ratesWhen({ kind: 'gift_card', percent: '10' }), false);
  assert.equal(f.ratesWhen({ kind: 'promo', percent: '15' }), true);
  const col = disc.columns.find((x) => x.key === 'discount_rates');
  assert.equal(col.format({ kind: 'certificate', percent: 10, discount_rates: { c: { 7: 50 } } }), '—', 'сводка ставок у сертификата');
  assert.equal(col.format({ kind: 'promo', percent: 0, amount: 50000, discount_rates: { c: { 7: 50 } } }), '—', 'сводка ставок у промокода суммой');

  document.body.children.length = 0;
  const el = discountServicesField([3], undefined, { rates: { s: { 3: 50 } } });
  await el.load();
  assert.equal(typeof el.setRatesShown, 'function');
  el.setRatesShown(false);
  assert.equal(byAttr(el, 'data-rate-groups').parentNode.hidden, true, 'пять групп видны у карты');
  assert.equal(byAttr(el, 'data-rates-summary').hidden, true);
  assert.equal(el.rates, undefined, 'скрытые ставки не уходят в запись — сохранённые остаются как есть');
  byAttr(el, 'data-discount-services-open').click();
  const dlg = byAttr(document.body, 'data-discount-services-picker');
  assert.equal(byAttr(dlg, 'data-rate-service', 3), undefined, 'в окне — поля ставок у карты');
  byAttr(dlg, 'data-picker-apply').click();
  el.setRatesShown(true);
  assert.equal(byAttr(el, 'data-rate-groups').parentNode.hidden, false);
  assert.deepEqual(el.rates, { s: { 3: 50 } }, 'ставки вернулись, когда снова промокод с процентом');
});

// Ревью S5 L-4 — разделы окна по категории ключом были по НАЗВАНИЮ: две категории с одним
// названием сливались в один раздел, и ставка категории писалась только первой по id.
test('ревью S5 L-4: две категории с одним названием — два раздела, у каждой своя ставка по своему id', async () => {
  const services = [
    { id: 1, name: 'ОАК', type: 'lab', category_id: 10 },
    { id: 5, name: 'УЗИ почек', type: 'imaging', category_id: 11 },
    { id: 6, name: 'УЗИ сердца', type: 'imaging', category_id: 12 },
  ];
  const categories = [{ id: 10, name: 'Анализы крови' }, { id: 11, name: 'УЗИ' }, { id: 12, name: 'УЗИ' }];
  const g = groupServicesForPicker(services, { types: [], categories });
  assert.deepEqual(g.map((x) => [x.name, x.categoryId, x.items.map((i) => i.id)]), [['Анализы крови', 10, [1]], ['УЗИ', 11, [5]], ['УЗИ', 12, [6]]]);
  assert.equal(new Set(g.map((x) => x.key)).size, 3, 'ключи разделов совпали');

  const { openDiscountServicePicker } = await import('../views/discount-service-picker.js');
  document.body.children.length = 0;
  let got = null;
  openDiscountServicePicker({ selected: [], groups: g, rates: {}, withScope: false, onApply: (_ids, r) => { got = r; } });
  const dlg = byAttr(document.body, 'data-discount-services-picker');
  const second = walk(dlg).filter((n) => n.attrs && n.attrs['data-rate-category'] !== undefined);
  assert.deepEqual(second.map((n) => n.attrs['data-rate-category']), ['10', '11', '12']);
  typeInto(second[2], '50');
  byAttr(dlg, 'data-picker-apply').click();
  assert.deepEqual(got, { c: { 12: 50 } }, 'ставка второй «УЗИ» ушла не своей категории');
});
