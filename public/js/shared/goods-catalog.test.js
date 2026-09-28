// SUPPLIERS_VAT_V1 — типы товаров, ставки НДС и срок годности импорта: один
// список на сервер и экран. Здесь — что список один (база, сервер, экран), и
// что разбор «руками набранного» принимает ровно допустимое.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOODS_CATEGORIES, GOODS_CATEGORY_RU, parseGoodsCategory, parseVatRate, vatLabel, vatOnNet, grossOfNet,
  parseExpiryDmy, dmyOfDate,
} from './goods-catalog.js';
import { PROCUREMENT_CATEGORIES } from '../../../server/services/rpc/expiry.js';
import { openDb } from '../../../server/db/connection.js';
import { migrate } from '../../../server/db/migrate.js';

test('восемь типов — те же, что в CHECK базы и в фильтре сроков годности', () => {
  assert.deepEqual([...GOODS_CATEGORIES], PROCUREMENT_CATEGORIES);
  assert.deepEqual(Object.keys(GOODS_CATEGORY_RU), [...GOODS_CATEGORIES]);
  const db = openDb(':memory:'); migrate(db);
  const ins = db.prepare("INSERT INTO products (name, procurement_category) VALUES ('x', ?)");
  for (const c of GOODS_CATEGORIES) assert.doesNotThrow(() => ins.run(c), c);
  assert.throws(() => ins.run('drugs'), /CHECK/);
  db.close();
});

test('тип — по ключу или русскому названию, без учёта регистра, «ё» и пробелов; чужое — null', () => {
  assert.equal(parseGoodsCategory('medicines'), 'medicines');
  assert.equal(parseGoodsCategory('Медикаменты'), 'medicines');
  assert.equal(parseGoodsCategory('  медикаменты '), 'medicines');
  assert.equal(parseGoodsCategory('ЛАБ. МАТЕРИАЛЫ'), 'lab_supplies');
  assert.equal(parseGoodsCategory('Лаб.материалы'), 'lab_supplies');
  assert.equal(parseGoodsCategory('Офис/IT'), 'office_it');
  assert.equal(parseGoodsCategory('Хозяйство'), 'facility');
  for (const bad of ['Лекарства', 'drugs', '', '  ', null, undefined, 5]) assert.equal(parseGoodsCategory(bad), null, String(bad));
});

test('НДС: 12, 0 и «без НДС» — в любом виде, как их набирают; остальное — ошибка', () => {
  for (const v of [12, '12', '12%', '12 %', ' 12 % ', 0.12]) assert.deepEqual(parseVatRate(v), { rate: 12 }, String(v));
  for (const v of [0, '0', '0%', '0 %']) assert.deepEqual(parseVatRate(v), { rate: 0 }, String(v));
  for (const v of [null, 'без НДС', 'Без ндс', 'БЕЗ  НДС', 'none']) assert.deepEqual(parseVatRate(v), { rate: null }, String(v));
  for (const v of [undefined, '', '   ']) assert.deepEqual(parseVatRate(v), { empty: true }, JSON.stringify(v));
  for (const v of [15, '15%', '12,5', '12.5', 'да', -12, NaN, {}, [12]]) assert.deepEqual(parseVatRate(v), { error: true }, String(v));
  assert.equal(vatLabel(12), '12 %');
  assert.equal(vatLabel(0), '0 %');
  assert.equal(vatLabel(null), 'без НДС');
  assert.equal(vatOnNet(1000, 12), 120);
  assert.equal(vatOnNet(333.33, 12), 40);
  assert.equal(vatOnNet(1000, null), 0);
  assert.equal(grossOfNet(1000, 12), 1120);
  assert.equal(grossOfNet(1000, null), 1000);
});

test('срок годности: ровно ДД.ММ.ГГГГ, настоящая дата, не в прошлом', () => {
  const today = '2026-09-28';
  assert.deepEqual(parseExpiryDmy('31.12.2027', today), { iso: '2027-12-31' });
  assert.deepEqual(parseExpiryDmy(' 28.09.2026 ', today), { iso: '2026-09-28' }, 'сегодня — ещё не прошло');
  assert.deepEqual(parseExpiryDmy('29.02.2028', today), { iso: '2028-02-29' }, 'високосный год');
  for (const v of [undefined, null, '', '  ']) assert.deepEqual(parseExpiryDmy(v, today), { empty: true });
  // другой формат — отказ, а не догадка
  for (const v of ['2027-12-31', '31/12/2027', '31.12.27', '1.12.2027', '31-12-2027', '31.12.2027г', 'декабрь 2027', 46387, 31122027])
    assert.deepEqual(parseExpiryDmy(v, today), { error: 'format' }, String(v));
  // формат верный, даты нет
  for (const v of ['31.02.2027', '29.02.2027', '00.01.2027', '32.01.2027', '15.13.2027', '15.00.2027'])
    assert.deepEqual(parseExpiryDmy(v, today), { error: 'nodate' }, v);
  // прошлое
  assert.deepEqual(parseExpiryDmy('27.09.2026', today), { error: 'past' });
  assert.deepEqual(parseExpiryDmy('01.01.2020', today), { error: 'past' });
});

test('дата-ячейка Excel → ДД.ММ.ГГГГ при любой полуночи (местной и UTC)', () => {
  assert.equal(dmyOfDate(new Date(2027, 11, 31)), '31.12.2027');
  assert.equal(dmyOfDate(new Date(Date.UTC(2027, 11, 31))), '31.12.2027');
  assert.equal(dmyOfDate(new Date(2027, 0, 5, 0, 0, 43)), '05.01.2027', 'секундная поправка старого пояса');
  assert.equal(dmyOfDate(new Date('x')), null);
  assert.equal(dmyOfDate('31.12.2027'), null);
});
