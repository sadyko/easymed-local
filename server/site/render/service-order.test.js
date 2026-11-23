// CONSULT_FIRST_V1 — платные консультации, потом бесплатные, потом остальное.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sortServices, serviceRank, isConsultation, isPaid } from './service-order.js';

const S = (id, o = {}) => ({ id, price: 0, type: '', type_name: '', ...o });
const paidC = (id) => S(id, { type: 'consultation', price: 80000 });
const freeC = (id) => S(id, { type: 'consultation', price: 0 });
const other = (id) => S(id, { type: 'procedure', price: 200000 });
const ids = (l) => sortServices(l).map((x) => x.id).join(',');

test('порядок ступеней: платная консультация, бесплатная, остальное', () => {
  assert.equal(ids([other(1), freeC(2), paidC(3)]), '3,2,1');
});

// Признаков консультации ДВА, и на боевой базе они расходятся. Услуга с
// группой, но без type — тоже консультация.
test('консультация опознаётся по любому из двух признаков', () => {
  assert.equal(isConsultation(S(1, { type: 'consultation' })), true, 'по старому полю type');
  assert.equal(isConsultation(S(2, { type_name: 'Консультации' })), true, 'по группе каталога');
  assert.equal(isConsultation(S(3, { type: 'procedure', type_name: 'Процедуры' })), false);
});

// Ровно случай #518 и #837 с боевой базы: type есть, группы НЕТ, цена 0.
// По группе они бы провалились в общую массу — то есть правило не сработало бы
// на тех самых строках, которые владелец проверит первыми.
test('бесплатная консультация без группы всё равно во второй ступени', () => {
  const s = S(518, { type: 'consultation', type_name: '', price: 0 });
  assert.equal(serviceRank(s), 1);
  assert.equal(ids([other(1), s]), '518,1');
});

test('платность — это цена строго больше нуля', () => {
  assert.equal(isPaid(S(1, { price: 80000 })), true);
  assert.equal(isPaid(S(2, { price: 0 })), false, 'у бесплатных price = 0, а не NULL');
  for (const bad of [null, undefined, '', NaN, -100]) {
    assert.equal(isPaid(S(3, { price: bad })), false, JSON.stringify(bad));
  }
});

// Внутри ступени порядок обязан остаться прежним: он задан sort_order,
// и пересортировка перемешала бы привычный персоналу список без причины.
test('внутри ступени прежний порядок сохраняется', () => {
  assert.equal(ids([paidC(5), paidC(1), paidC(3)]), '5,1,3', 'ничего не пересортировано');
  assert.equal(ids([other(9), other(2), freeC(7), paidC(4)]), '4,7,9,2');
});

test('список без консультаций не меняется вовсе', () => {
  assert.equal(ids([other(3), other(1), other(2)]), '3,1,2');
});

test('мусор на входе не роняет сортировку', () => {
  assert.deepEqual(sortServices(null), []);
  assert.deepEqual(sortServices([]), []);
  assert.equal(serviceRank(null), 2, 'ничего не знаем — значит «остальное»');
});

// Регистр и падеж в названии группы клиника заводит руками.
test('группа опознаётся независимо от регистра и окончания', () => {
  for (const n of ['Консультации', 'КОНСУЛЬТАЦИИ', 'консультация', ' Консультации ']) {
    assert.equal(isConsultation(S(1, { type_name: n })), true, JSON.stringify(n));
  }
});
