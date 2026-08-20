// MONEY_INPUT_V2 — регрессия: поле «Сумма» в кассе схлопывалось на пятой цифре.

import test from 'node:test';
import assert from 'node:assert/strict';
import { digitsOf, groupThousands, moneyDisplay, moneyNumber } from './money-input.js';

test('ввод по одной цифре: 500000 набирается до конца', () => {
  // Именно этот сценарий и ломался: после «5 000» следующая цифра давала «0».
  const steps = [];
  let field = '';
  for (const ch of '500000') { field = moneyDisplay(field + ch); steps.push(field); }
  assert.deepEqual(steps, ['5', '50', '500', '5 000', '50 000', '500 000']);
});

test('уже отформатированная сумма читается как число, а не как ноль', () => {
  assert.equal(moneyNumber('40 000'), 40000);
  assert.equal(moneyNumber('500 000'), 500000);
  assert.equal(moneyNumber('1 234 567'), 1234567);
});

test('digitsOf выбрасывает всё, кроме цифр', () => {
  assert.equal(digitsOf('40 000'), '40000');
  assert.equal(digitsOf('40 000'), '40000', 'неразрывный пробел тоже');
  assert.equal(digitsOf('1 234,56 сум'), '123456');
  assert.equal(digitsOf('DDD'), '', 'буква D — не цифра (на ней и погорели)');
  assert.equal(digitsOf(null), '');
  assert.equal(digitsOf(undefined), '');
});

test('пустое поле остаётся пустым, а не превращается в 0', () => {
  assert.equal(moneyDisplay(''), '');
  assert.equal(moneyDisplay('абв'), '');
  assert.equal(moneyNumber(''), 0);
});

test('ведущие нули не копятся', () => {
  assert.equal(moneyDisplay('007'), '7');
  assert.equal(moneyDisplay('0'), '0');
});

test('группировка разрядов', () => {
  assert.equal(groupThousands('1'), '1');
  assert.equal(groupThousands('999'), '999');
  assert.equal(groupThousands('1000'), '1 000');
  assert.equal(groupThousands('1234567'), '1 234 567');
});

test('удаление символов работает в обе стороны', () => {
  assert.equal(moneyDisplay('500 000'), '500 000');
  assert.equal(moneyDisplay('50 000'), '50 000', 'стёрли цифру — формат пересобрался');
  assert.equal(moneyDisplay('5'), '5');
});

test('нелепо длинный ввод не даёт мусорного числа', () => {
  const huge = '9'.repeat(25);
  assert.equal(moneyNumber(huge), 0, 'лучше ноль, чем неточное число с плавающей точкой');
});
