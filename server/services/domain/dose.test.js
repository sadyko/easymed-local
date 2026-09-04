// MED_DOSE_QTY_V1 — «доза врача → количество со склада».
//
// Проверяется в первую очередь то, чего этот модуль НЕ делает: не угадывает.
// Списание наугад дороже несписания — несписанное видно и считается, а лишняя
// списанная штука растворяется в остатке и находится через месяц.
import test from 'node:test';
import assert from 'node:assert/strict';
import { doseQuantity, parseDose, normalizeUnit, UNKNOWN_QTY_MESSAGE } from './dose.js';

test('единицы приводятся к канону, включая аптечные формы', () => {
  for (const [raw, canon] of [
    ['шт', 'pcs'], ['ШТ.', 'pcs'], ['таб.', 'pcs'], ['амп', 'pcs'], ['флакон', 'pcs'], ['pcs', 'pcs'],
    ['г', 'g'], ['мг', 'mg'], ['мкг', 'mcg'], ['мл', 'ml'], ['л', 'l'],
  ]) {
    assert.equal(normalizeUnit(raw), canon, raw);
  }
  // «ЕД»/«МЕ» — единицы ДЕЙСТВИЯ, а не штуки: во флаконе инсулина их сотни, и
  // приравняв их к штукам мы списали бы четыре флакона вместо четырёх единиц.
  assert.equal(normalizeUnit('ЕД'), 'iu');
  assert.equal(normalizeUnit('МЕ'), 'iu');
  assert.equal(normalizeUnit('пшик'), null);
  assert.equal(normalizeUnit(''), null);
  assert.equal(normalizeUnit(null), null);
});

test('доза разбирается только целиком: число и, может быть, единица', () => {
  assert.deepEqual(parseDose('2'), { value: 2, unit: null, raw: '' });
  assert.deepEqual(parseDose('500 мг'), { value: 500, unit: 'mg', raw: 'мг' });
  assert.deepEqual(parseDose('0,5 мл'), { value: 0.5, unit: 'ml', raw: 'мл' });
  // Половина строки количества не даёт — ни «1» из «1 г × 2», ни 0 из «по схеме».
  for (const bad of ['1 г × 2', 'по схеме', '', '1/2 таб', '2 пшика', '0', '-1 мл']) {
    assert.equal(parseDose(bad), null, bad);
  }
});

test('явное количество из назначения главнее любого текста дозы', () => {
  const r = doseQuantity({ dose: 'по схеме', stock_qty: 2, product_unit: 'шт' });
  assert.deepEqual(r, { ok: true, quantity: 2, basis: 'order' });
});

test('доза без единицы — это счёт единиц склада', () => {
  const r = doseQuantity({ dose: '2', product_unit: 'мл' });
  assert.deepEqual(r, { ok: true, quantity: 2, basis: 'count' });
});

test('приведение внутри одной размерности разрешено', () => {
  assert.equal(doseQuantity({ dose: '500 мг', product_unit: 'г' }).quantity, 0.5);
  assert.equal(doseQuantity({ dose: '2 г', product_unit: 'мг' }).quantity, 2000);
  assert.equal(doseQuantity({ dose: '0,5 л', product_unit: 'мл' }).quantity, 500);
  assert.equal(doseQuantity({ dose: '2 таб.', product_unit: 'шт' }).quantity, 2);
});

test('через размерность — ОТКАЗ, а не догадка', () => {
  // Тот самый случай из жизни: «1 г» цефтриаксона при складе в штуках. Один
  // это флакон или два — зависит от фасовки, и здесь этого не знает никто.
  const r = doseQuantity({ dose: '1 г', product_unit: 'шт' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unit');
  assert.match(r.message, /не списано: не удалось определить количество/);
  assert.match(r.message, /1 г/);
  // Единицы действия к штукам тоже не приводятся.
  assert.equal(doseQuantity({ dose: '4 ЕД', product_unit: 'шт' }).ok, false);
  // Единица склада незнакома — сравнивать не с чем.
  assert.equal(doseQuantity({ dose: '1 мл', product_unit: 'банка' }).ok, false);
});

test('нечитаемая доза называет себя одним и тем же текстом', () => {
  const r = doseQuantity({ dose: 'по схеме', product_unit: 'шт' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_dose');
  assert.ok(r.message.startsWith(UNKNOWN_QTY_MESSAGE));
  assert.match(doseQuantity({ dose: '', product_unit: 'шт' }).message, /доза не указана/);
});

test('абсурдные величины не проходят: количество уходит прямо в списание', () => {
  assert.equal(doseQuantity({ stock_qty: 1e9, dose: '1' }).ok, false);
  assert.equal(doseQuantity({ dose: '9999999 л', product_unit: 'мл' }).ok, false);
});
