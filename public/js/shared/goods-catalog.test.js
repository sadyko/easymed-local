// SUPPLIERS_VAT_V1 — типы товаров, ставки НДС и срок годности импорта: один
// список на сервер и экран. Здесь — что список один (база, сервер, экран), и
// что разбор «руками набранного» принимает ровно допустимое.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOODS_CATEGORIES, GOODS_CATEGORY_RU, parseGoodsCategory, parseVatRate, vatLabel, vatOnNet, grossOfNet,
  parseExpiryDmy, dmyOfDate, dmyOfParts, packOf, linkPackOf, linkPriceFor, priceInLinkPack,
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

// SUPPLIERS_VAT_V1 (ревью F2) — цена связи — за единицу закупки СВЯЗИ.
test('ревью F2: цена связи переводится через упаковку связи, а не товара', () => {
  const product = { pack_factor: 10 };                       // уп = 10 таб
  const link = { last_price: 9000, pack_factor: 100 };       // кор = 100 таб
  assert.equal(linkPackOf(link, product), 100);
  assert.equal(linkPackOf({ last_price: 1 }, product), 10, 'у связи нет упаковки — упаковка товара');
  assert.equal(linkPackOf({}, {}), 1);
  assert.equal(linkPriceFor(link, product, 1), 90, 'за таблетку');
  assert.equal(linkPriceFor(link, product, 10), 900, 'за упаковку товара');
  assert.equal(linkPriceFor({ last_price: null, pack_factor: 100 }, product), null);
  assert.equal(linkPriceFor(null, product), null);
  assert.equal(priceInLinkPack(90, 1, 100), 9000);
  assert.equal(priceInLinkPack(950, 10, 100), 9500);
  assert.equal(priceInLinkPack(1000, 3, 3), 1000, 'та же упаковка — та же цена');
  for (const v of [0, -1, 'x', null, undefined]) assert.equal(packOf(v), null, String(v));
});

// SUPPLIERS_VAT_V1 (ревью M4) — дата со временем: SheetJS 0.20.3 отдаёт
// дату-ячейку Excel как Date, у которой UTC-часы — ровно то, что написано в
// ячейке. Прежние «+12 часов» переносили на следующий день всё, что написано
// с 12:00 и позже: «28.09.2026 18:00» становилось 29.09, «31.12.2027 23:59»
// получало лишний день срока. Берётся календарная дата, как её написали.
test('ревью M4: дата-ячейка со временем — тот же календарный день, что в ячейке', () => {
  assert.equal(dmyOfDate(new Date(Date.UTC(2026, 8, 28, 18, 0))), '28.09.2026');
  assert.equal(dmyOfDate(new Date(Date.UTC(2027, 11, 31, 23, 59))), '31.12.2027');
  assert.equal(dmyOfDate(new Date(Date.UTC(2027, 11, 31, 0, 30))), '31.12.2027');
  assert.equal(dmyOfDate(new Date(Date.UTC(2027, 11, 31, 12, 0))), '31.12.2027');
  // Полночь — и местная, и UTC — как прежде.
  assert.equal(dmyOfDate(new Date(2027, 11, 31)), '31.12.2027');
  assert.equal(dmyOfDate(new Date(Date.UTC(2027, 11, 31))), '31.12.2027');
});

test('ревью M4: дата из частей Excel (SSF.parse_date_code) — как написано, при любом поясе', () => {
  assert.equal(dmyOfParts({ y: 2026, m: 9, d: 28, H: 18, M: 0 }), '28.09.2026');
  assert.equal(dmyOfParts({ y: 2027, m: 12, d: 31, H: 23, M: 59 }), '31.12.2027');
  assert.equal(dmyOfParts(null), null);
  assert.equal(dmyOfParts({ y: 2027, m: 13, d: 1 }), null);
});
