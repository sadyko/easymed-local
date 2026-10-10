// SERVICES_PACKAGES_V1 — экран «Пакеты услуг» (views/packages-editor.js; макет
// screen-packages.js): список только пакетов с ценой без скидки, скидкой, ценой
// пакета, сроком и показом; окно пакета — названия на трёх языках, услуги с ценой
// каждой в пакете, скидка процентом / суммой / ценой, срок, показ. Числа — одна
// функция с сервером (shared/package-price.js packageCalc).
//
// Стенд — api-harness.mjs (поддельный DOM, RPC, русский язык до импорта видов);
// /api/db — здесь: service_templates и services.
import { test } from 'node:test';
import assert from 'node:assert';
import { reset, textOf, byAttr, buttonByText, tick, walk, lastToast } from './api-harness.mjs';

const SERVICES = [
  { id: 1, name: 'Общий анализ крови', name_uz: 'Umumiy qon tahlili', price: 45000, type: 'lab', is_lab: 1, active: 1, online_booking: 1 },
  { id: 2, name: 'Глюкоза крови', name_uz: 'Qondagi glyukoza', price: 25000, type: 'lab', is_lab: 1, active: 1, online_booking: 1 },
  { id: 6, name: 'Общий анализ мочи', name_uz: 'Siydik tahlili', price: 35000, type: 'lab', is_lab: 1, active: 1, online_booking: 1 },
  { id: 8, name: 'ЭКГ', name_uz: 'EKG', price: 60000, type: 'imaging', is_lab: 0, active: 1, online_booking: 1 },
  { id: 7, name: 'УЗИ брюшной полости', name_uz: 'Qorin UTT', price: 180000, type: 'imaging', is_lab: 0, active: 1, online_booking: 1 },
  { id: 13, name: 'Перевязка', name_uz: 'Bog‘lash', price: 50000, type: 'procedure', is_lab: 0, active: 1, online_booking: 0 },
  { id: 20, name: 'Старая услуга', name_uz: 'Eski', price: 1000, type: 'lab', is_lab: 1, active: 0, online_booking: 0 },
];
const CHECKUP = { id: 4, name: 'Check-up базовый', name_uz: 'Check-up asosiy', name_en: 'Basic check-up', service_ids: [1, 2, 6, 8, 7],
  is_package: 1, discount_mode: 'percent', discount_value: 15, discount_percent: 15, show_public: 1, active: 1, valid_from: null, valid_until: '2099-06-03' };
const HIDDEN = { id: 5, name: 'Перевязки', name_uz: 'Bog‘lashlar', name_en: '', service_ids: [13], is_package: 1, discount_mode: 'price', discount_value: 40000,
  show_public: 1, active: 1, valid_from: null, valid_until: null };
const RETIRED = { id: 6, name: 'Осень', name_uz: '', name_en: '', service_ids: [1], is_package: 1, discount_mode: 'percent', discount_value: 20,
  show_public: 0, active: 0, valid_from: null, valid_until: null };

let packages = [];
const writes = [];
let writeError = null;
const base = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url) !== '/api/db') return base(url, opts);
  const d = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (d.table === 'services') return ok(SERVICES.map((s) => ({ ...s })));
  if (d.table === 'service_templates') {
    if ((d.op || 'select') === 'select') {
      const onlyPkg = (d.filters || []).some((f) => f.col === 'is_package' && String(f.val) === '1');
      assert.ok(onlyPkg, '«Пакеты услуг» спрашивают только пакеты (is_package = 1)');
      return ok(packages.map((p) => ({ ...p })));
    }
    writes.push({ op: d.op, values: d.values, filters: d.filters || [] });
    if (writeError) return { ok: false, status: 400, json: async () => ({ error: writeError }) };
    return ok({ id: 99, ...d.values });
  }
  return ok([]);
};

const { renderPackagesEditor, draftFromRow, switchMode, draftPayload, draftCalc, pickList, PACKAGE_STATE_TEXT } = await import('../views/packages-editor.js');

async function mount(rows = [CHECKUP, HIDDEN, RETIRED], opts = {}) {
  reset();
  packages = rows; writes.length = 0; writeError = null;
  const box = document.createElement('div');
  const api = await renderPackagesEditor(box, opts);
  await tick(30);
  return { box, api };
}
const dialog = () => document.body.children.find((n) => n.attrs && n.attrs['data-dialog'] === 'package') || null;
const cellsOf = (tr) => tr.children.map((td) => textOf(td).replace(/\s+/g, ' ').trim());
const typeIn = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input', target: el, currentTarget: el }); };

test('черновик: новый пакет — процент 10 и показ включён (макет); строка базы — её условия', () => {
  assert.deepEqual(draftFromRow(null), { id: null, name: { ru: '', uz: '', en: '' }, items: [], mode: 'percent', value: 10, from: '', to: '', pub: true, active: true });
  const d = draftFromRow(CHECKUP);
  assert.deepEqual([d.id, d.name, d.items, d.mode, d.value, d.to, d.pub, d.active],
    [4, { ru: 'Check-up базовый', uz: 'Check-up asosiy', en: 'Basic check-up' }, [1, 2, 6, 8, 7], 'percent', 15, '2099-06-03', true, true]);
});

test('переключение способа скидки сохраняет цену пакета; тело записи — только колонки роли', () => {
  const d = draftFromRow(CHECKUP);
  assert.equal(draftCalc(d, SERVICES).price, 293000);
  const byPrice = switchMode(d, 'price', SERVICES);
  assert.deepEqual([byPrice.mode, byPrice.value, draftCalc(byPrice, SERVICES).price], ['price', 293000, 293000]);
  const byAmount = switchMode(d, 'amount', SERVICES);
  assert.deepEqual([byAmount.value, draftCalc(byAmount, SERVICES).price], [52000, 293000]);
  const all = draftPayload(draftFromRow(null), draftCalc(d, SERVICES), null);
  assert.equal(all.is_package, 1, 'новый — пакет');
  assert.deepEqual([all.discount_mode, all.discount_value, all.show_public], ['percent', 10, 1]);
  const edit = draftPayload(d, draftCalc(d, SERVICES), null);
  assert.equal('is_package' in edit, false, 'правка отметку не трогает');
  assert.equal(edit.discount_percent, 15.1, 'прежняя колонка — процент на день сохранения');
  const noMoney = draftPayload(d, draftCalc(d, SERVICES), ['name', 'service_ids', 'valid_from', 'valid_until', 'active', 'is_package', 'name_uz', 'name_en', 'show_public']);
  assert.deepEqual(Object.keys(noMoney).sort(), ['name', 'name_en', 'name_uz', 'service_ids', 'show_public', 'valid_from', 'valid_until']);
});

test('поиск «Добавить услугу»: действующие, не в пакете, по названию, не больше восьми', () => {
  const d = { items: [1] };
  assert.deepEqual(pickList(SERVICES, d, 'анализ').map((s) => s.id), [6]);
  assert.equal(pickList(SERVICES, d, '').some((s) => s.id === 20), false, 'отключённой нет');
  assert.ok(pickList(Array.from({ length: 20 }, (_, i) => ({ id: i + 100, name: 'Услуга ' + i, active: 1 })), { items: [] }, '').length === 8);
});

test('список — только пакеты: без скидки, скидка, цена пакета, срок, показ с причиной; снятый — в конце', async () => {
  const { box } = await mount();
  const rows = walk(box).filter((n) => n.tagName === 'TR' && n.attrs && 'data-package-id' in n.attrs);
  assert.deepEqual(rows.map((r) => r.attrs['data-package-id']), ['4', '5', '6']);
  const c = cellsOf(rows[0]);
  assert.match(c[0], /^Check-up базовый/);
  assert.equal(c[1], '5');
  assert.deepEqual([c[2], c[3], c[4]], ['345 000', '−52 000 15,1%', '293 000']);
  assert.match(c[5], /действует до 03\.06\.2099/);
  assert.match(c[6], /На сайте/);
  assert.match(cellsOf(rows[1])[6], /Скрыт с сайта.*в пакете скрытая услуга.*Перевязка/, 'В10: скрытая услуга прячет пакет');
  assert.match(cellsOf(rows[2])[6], /Снят с учёта/);
  assert.ok(byAttr(rows[0], 'title', 'Есть перевод').length >= 3, 'метки RU / UZ / EN');
  assert.equal(PACKAGE_STATE_TEXT.shown[0], 'На сайте');
});

test('окно: услуги добавляются поиском, цена каждой в пакете, итоги; способ «Цена пакета» — та же цена', async () => {
  const { box } = await mount([]);
  buttonByText(box, /Добавить/).click();
  await tick();
  const dlg = dialog();
  assert.ok(dlg, 'окно не открылось');
  assert.match(textOf(dlg), /Новый пакет услуг/);
  assert.match(textOf(dlg), /Добавьте услуги — цена пакета посчитается сама\./);
  for (const name of ['Общий анализ крови', 'Глюкоза крови', 'Общий анализ мочи', 'ЭКГ', 'УЗИ брюшной полости']) {
    const pick = walk(dlg).find((n) => n.tagName === 'BUTTON' && n.className === 'pkg-pick-row' && textOf(n).startsWith(name));
    assert.ok(pick, 'нет в поиске: ' + name);
    pick.click();
  }
  // 10 % (по умолчанию) от 345 000 = 310 500 → 311 000.
  const value = walk(dlg).find((n) => n.tagName === 'INPUT' && n.className.includes('pkg-value'));
  typeIn(value, '15');
  const txt = textOf(dlg).replace(/\s+/g, ' ');
  for (const p of ['38 200', '21 200', '29 700', '51 000', '152 900', '345 000 сум', '−52 000', '293 000 сум']) assert.ok(txt.includes(p), 'нет ' + p + ': ' + txt);
  buttonByText(dlg, /^Цена пакета$/).click();
  const v2 = walk(dlg).find((n) => n.tagName === 'INPUT' && n.className.includes('pkg-value'));
  assert.equal(v2.value, '293000', 'цена пакета та же после переключения');
});

test('сохранение: показ без узбекского названия — отказ под полем, ничего не записано; с названием — запись пакета', async () => {
  const { box } = await mount([]);
  buttonByText(box, /Добавить/).click();
  await tick();
  const dlg = dialog();
  const ru = walk(dlg).find((n) => n.tagName === 'INPUT' && n.className === 'docprof-in' && n.attrs.id && /pkg-name-ru/.test(n.attrs.id));
  typeIn(ru, 'Check-up');
  walk(dlg).find((n) => n.className === 'pkg-pick-row' && textOf(n).startsWith('ЭКГ')).click();
  buttonByText(dlg, /^Добавить$/).click();
  await tick();
  assert.equal(writes.length, 0, 'записал без узбекского названия');
  assert.match(textOf(dlg), /Чтобы показывать пакет, нужно название на узбекском\./);
  const uz = walk(dlg).find((n) => n.tagName === 'INPUT' && n.attrs.id && /pkg-name-uz/.test(n.attrs.id));
  typeIn(uz, 'Check-up');
  buttonByText(dlg, /^Добавить$/).click();
  await tick(30);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].op, 'insert');
  const v = writes[0].values;
  assert.deepEqual([v.name, v.name_uz, v.is_package, v.service_ids, v.discount_mode, v.discount_value, v.show_public], ['Check-up', 'Check-up', 1, [8], 'percent', 10, 1]);
  assert.equal(lastToast(), 'Пакет сохранён');
});

test('отказ сервера с полем — под этим полем; «Снять с учёта» — правка active', async () => {
  const { box } = await mount([CHECKUP]);
  walk(box).find((n) => n.tagName === 'TR' && n.attrs && n.attrs['data-package-id'] === '4').click();
  await tick();
  const dlg = dialog();
  assert.match(textOf(dlg), /Check-up базовый/);
  writeError = { code: 'bad_request', message: 'Скидка больше суммы цен услуг пакета.', field: 'discount_value' };
  buttonByText(dlg, /^Сохранить$/).click();
  await tick(30);
  assert.match(textOf(dlg), /Скидка больше суммы цен услуг пакета\./);
  writeError = null;
  buttonByText(dlg, /^Снять с учёта$/).click();
  await tick(30);
  assert.deepEqual(writes[writes.length - 1].values, { active: 0 });
});

test('только просмотр: нет «Добавить», поля окна закрыты', async () => {
  const { box } = await mount([CHECKUP], { readOnly: true });
  assert.equal(buttonByText(box, /^ Добавить$|^Добавить$/), null);
  assert.match(textOf(box), /Только просмотр/);
  walk(box).find((n) => n.tagName === 'TR' && n.attrs && n.attrs['data-package-id'] === '4').click();
  await tick();
  const dlg = dialog();
  const save = buttonByText(dlg, /^Сохранить$/);
  assert.ok(save && 'disabled' in save.attrs, 'сохранить в просмотре');
});
