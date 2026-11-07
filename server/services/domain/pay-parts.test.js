// REPORTS_TAX_PAY_V1 — способ оплаты и НДС в отчётах: чистые правила.
import test from 'node:test';
import assert from 'node:assert/strict';
import { payParts, splitMoney, vatCells, methodLabel, payMethodArgOk, PAY_FILTER_VALUES } from './pay-parts.js';

const pay = (method, amount, cashier_id = 1) => ({ method, amount, cashier_id });

test('смешанная оплата 60 000 наличными + 40 000 картой — две части, доли 0,6 и 0,4', () => {
  const parts = payParts(100000, [pay('card', 40000, 2), pay('cash', 60000, 1)]);
  assert.deepEqual(parts.map((p) => [p.method, p.share]), [['cash', 0.6], ['card', 0.4]]);
  assert.deepEqual(parts.map((p) => p.cashier_ids), [[1], [2]]);
});

test('фильтр «Карта» — одна часть 0,4; «Наличные» — 0,6; «Перевод» — ничего', () => {
  const pays = [pay('cash', 60000), pay('card', 40000)];
  assert.deepEqual(payParts(100000, pays, { method: 'card' }).map((p) => [p.method, p.share]), [['card', 0.4]]);
  assert.deepEqual(payParts(100000, pays, { method: 'cash' }).map((p) => [p.method, p.share]), [['cash', 0.6]]);
  assert.deepEqual(payParts(100000, pays, { method: 'transfer' }), []);
});

test('частичная оплата: остаток — часть «Не оплачено»; фильтр «Не оплачено» — только он', () => {
  const pays = [pay('cash', 60000)];
  assert.deepEqual(payParts(100000, pays).map((p) => [p.method, p.share]), [['cash', 0.6], ['unpaid', 0.4]]);
  assert.deepEqual(payParts(100000, pays, { method: 'unpaid' }).map((p) => [p.method, p.share]), [['unpaid', 0.4]]);
  assert.deepEqual(payParts(100000, []).map((p) => [p.method, p.share]), [['unpaid', 1]]);
});

test('кассир: только его платежи, по способам; кассир + способ — пересечение', () => {
  const pays = [pay('cash', 30000, 1), pay('card', 20000, 1), pay('cash', 50000, 2)];
  assert.deepEqual(payParts(100000, pays, { cashierId: 1 }).map((p) => [p.method, p.share]), [['cash', 0.3], ['card', 0.2]]);
  assert.deepEqual(payParts(100000, pays, { cashierId: 2, method: 'cash' }).map((p) => [p.method, p.share]), [['cash', 0.5]]);
  assert.deepEqual(payParts(100000, pays, { cashierId: 2, method: 'card' }), []);
  // «Не оплачено» у кассира не бывает — неоплаченное никто не принимал.
  assert.deepEqual(payParts(100000, [pay('cash', 10000, 1)], { cashierId: 1, method: 'unpaid' }), []);
});

test('возврат тем же способом уменьшает его часть; переплата делится в той же доле', () => {
  assert.deepEqual(payParts(100000, [pay('card', 100000), pay('card', -20000)]).map((p) => [p.method, p.share]),
    [['card', 0.8], ['unpaid', 0.2]]);
  const over = payParts(100000, [pay('cash', 100000), pay('card', 25000)]);
  assert.deepEqual(over.map((p) => p.method), ['cash', 'card']);
  assert.ok(Math.abs(over.reduce((n, p) => n + p.share, 0) - 1) < 1e-9);
});

test('бесплатный счёт (итог 0) — одна часть без способа; любой фильтр по оплате его убирает', () => {
  assert.deepEqual(payParts(0, []).map((p) => [p.method, p.share]), [[null, 1]]);
  assert.deepEqual(payParts(0, [], { method: 'cash' }), []);
  assert.deepEqual(payParts(0, [], { cashierId: 1 }), []);
});

test('кошелёк и подарочная карта — свои способы, как в итоге смены', () => {
  const parts = payParts(100000, [pay('wallet', 50000), pay('gift_card', 50000)]);
  assert.deepEqual(parts.map((p) => p.method), ['wallet', 'gift_card']);
});

test('splitMoney: части в сумме дают ровно округлённое целое', () => {
  assert.deepEqual(splitMoney(100000, [1 / 3, 1 / 3, 1 / 3]), [33333.33, 33333.33, 33333.34]);
  assert.deepEqual(splitMoney(100000, [0.6, 0.4]), [60000, 40000]);
  assert.deepEqual(splitMoney(100000, [0.4]), [40000]);
  assert.deepEqual(splitMoney(0, [0.5, 0.5]), [0, 0]);
});

test('vatCells: без НДС = с НДС − НДС, оба округлены до копеек', () => {
  assert.deepEqual(vatCells(112000, 13440), [98560, 13440, 112000]);
  assert.deepEqual(vatCells(100, 0), [100, 0, 100]);
  assert.deepEqual(vatCells(10.006, 1.2004), [8.81, 1.2, 10.01]);
});

test('подписи способов и проверка значения фильтра', () => {
  assert.equal(methodLabel('cash'), 'Наличные');
  assert.equal(methodLabel('card'), 'Карта');
  assert.equal(methodLabel('unpaid'), 'Не оплачено');
  assert.equal(methodLabel(null), '—');
  assert.equal(methodLabel('online'), 'online');
  for (const v of PAY_FILTER_VALUES) assert.equal(payMethodArgOk(v), true, v);
  assert.equal(payMethodArgOk('bitcoin'), false);
});
