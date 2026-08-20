// INVOICE_METHOD_COLUMN_V1 — «Способ оплаты» для отчёта «Счета».
//
// One invoice can be settled by SEVERAL payments with DIFFERENT methods
// (record_payment_split / SPLIT_PAY_V1 — часть наличными, часть картой), so the
// column is a set, not a value. Order is fixed by the vocabulary rather than by
// the order rows happen to come back in, so the same invoice always reads the
// same way and the Excel column stays sortable.

import { test } from 'node:test';
import assert from 'node:assert';
import { formatMethods, METHOD_RU, NON_CASH_INFLOW, countsAsInflow } from '../../shared/payment-methods.js';

test('a single method becomes its Russian label', () => {
  assert.strictEqual(formatMethods(['cash']), 'Наличные');
  assert.strictEqual(formatMethods(['card']), 'Карта');
});

test('a split payment lists every method used', () => {
  assert.strictEqual(formatMethods(['cash', 'card']), 'Наличные, Карта');
});

// The order rows arrive in is an accident of the query; the column must not be.
test('order is the vocabulary order, not the arrival order', () => {
  assert.strictEqual(formatMethods(['card', 'cash']), 'Наличные, Карта');
  assert.strictEqual(formatMethods(['acquiring', 'cash', 'transfer']), 'Наличные, Перевод, Эквайринг');
});

test('repeated payments by the same method are listed once', () => {
  assert.strictEqual(formatMethods(['cash', 'cash', 'cash']), 'Наличные');
});

// An unpaid invoice has no payments at all — the cell is simply empty, not '—'
// or 'Наличные' by default. A default here would report money that never moved.
test('no payments means an empty cell', () => {
  for (const empty of [[], null, undefined]) {
    assert.strictEqual(formatMethods(empty), '', JSON.stringify(empty));
  }
});

test('blank and non-string entries are ignored, not printed', () => {
  assert.strictEqual(formatMethods(['cash', '', null, undefined, 0]), 'Наличные');
});

// A method added to the DB before this map learns about it must still be
// visible: showing the raw key beats silently dropping a real payment.
test('an unknown method is shown raw rather than dropped', () => {
  assert.strictEqual(formatMethods(['cash', 'crypto']), 'Наличные, crypto');
  assert.strictEqual(formatMethods(['crypto']), 'crypto');
});

// DEPOSIT_REVENUE_V1 — 'wallet' joined the vocabulary, and it is the odd one
// out: the other four are money the cashier physically takes, while a wallet
// payment moves a balance the patient already paid in as a deposit. It settles
// an invoice but is NOT an inflow — see NON_CASH_INFLOW below, which is what
// keeps the same money out of revenue and the shift total twice.
test('the vocabulary matches what the cashier desk records', () => {
  assert.deepStrictEqual(
    Object.keys(METHOD_RU).sort(),
    ['acquiring', 'card', 'cash', 'transfer', 'wallet'],
    'these are the methods a payment row can carry',
  );
});

test('only the wallet is excluded from money coming in', () => {
  assert.deepStrictEqual(NON_CASH_INFLOW, ['wallet']);
  for (const m of ['cash', 'card', 'transfer', 'acquiring']) {
    assert.strictEqual(countsAsInflow(m), true, m + ' is real money arriving');
  }
  assert.strictEqual(countsAsInflow('wallet'), false, 'already counted when the deposit was taken');
  assert.strictEqual(countsAsInflow('crypto'), true, 'an unknown method is treated as real money, not hidden');
});

test('a non-array argument does not throw', () => {
  for (const bad of ['cash', 42, {}, true]) {
    assert.strictEqual(formatMethods(bad), '', JSON.stringify(bad));
  }
});
