// REFERRAL_CATEGORY_RATES_V1 — правила выбора ставки. Здесь считаются ЧУЖИЕ
// деньги, поэтому проверяется не «функция что-то вернула», а каждая развилка
// таблицы истинности и каждый откат по отдельности.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReferralRate, rewardForLine, parseRates } from './referral-reward.js';

const LAB = 3, XRAY = 7;
const rates = (arr) => JSON.stringify(arr);

const CATEGORY = {
  standard_percent: 10,
  rates: rates([{ type_id: LAB, unit: 'pct', value: 20 },
                { type_id: XRAY, unit: 'fix', value: 60000 }]),
};

const rate = (source, category, serviceTypeId) =>
  resolveReferralRate({ source, category, serviceTypeId });

test('по категории: ставка группы перекрывает стандартный процент', () => {
  const src = { reward_mode: 'category' };
  assert.deepEqual(rate(src, CATEGORY, LAB), { unit: 'pct', value: 20 });
  assert.deepEqual(rate(src, CATEGORY, XRAY), { unit: 'fix', value: 60000 });
});

test('по категории: ненастроенная группа откатывается на стандартный процент', () => {
  assert.deepEqual(rate({ reward_mode: 'category' }, CATEGORY, 99), { unit: 'pct', value: 10 });
});

test('по категории: без категории — ноль, а не чужая ставка', () => {
  // Источник, у которого категорию не выбрали. Молча взять общую ставку
  // было бы хуже нуля: ноль виден в отчёте и чинится выбором категории.
  assert.deepEqual(rate({ reward_mode: 'category' }, null, LAB), { unit: 'pct', value: 0 });
});

test('своя ставка: группа перекрывает свой процент', () => {
  const src = { reward_mode: 'own', own_percent: 5, own_rates: rates([{ type_id: LAB, unit: 'pct', value: 15 }]) };
  assert.deepEqual(rate(src, CATEGORY, LAB), { unit: 'pct', value: 15 });
});

test('своя ставка: пустая строка группы откатывается на СВОЙ процент, не на категорию', () => {
  // Решение владельца 2026-09-08: карточка источника объясняет выплату целиком.
  const src = { reward_mode: 'own', own_percent: 5, own_rates: rates([{ type_id: LAB, unit: 'pct', value: 15 }]) };
  assert.deepEqual(rate(src, CATEGORY, XRAY), { unit: 'pct', value: 5 },
    'взята ставка категории вместо своего процента');
});

test('своя ставка: без своего процента — ноль, категория не подглядывается', () => {
  const src = { reward_mode: 'own', own_percent: 0, own_rates: '' };
  assert.deepEqual(rate(src, CATEGORY, LAB), { unit: 'pct', value: 0 });
});

test('незнакомый режим считается «по категории»', () => {
  // CHECK на колонке намеренно нет (мигр. 109); незнакомая строка не должна
  // включать чужие ставки.
  assert.deepEqual(rate({ reward_mode: 'странное' }, CATEGORY, LAB), { unit: 'pct', value: 20 });
});

test('мусор в JSON читается как «ставок нет», а не роняет расчёт', () => {
  for (const bad of ['{не json', '{"type_id":3}', 'null', '42', '']) {
    const src = { reward_mode: 'own', own_percent: 7, own_rates: bad };
    assert.deepEqual(rate(src, CATEGORY, LAB), { unit: 'pct', value: 7 }, 'на ' + bad);
  }
});

test('запись без числа и с отрицательным числом пропускается', () => {
  for (const value of [null, 'десять', -5, Infinity]) {
    const src = { reward_mode: 'own', own_percent: 7, own_rates: rates([{ type_id: LAB, unit: 'pct', value }]) };
    assert.deepEqual(rate(src, CATEGORY, LAB), { unit: 'pct', value: 7 }, 'на ' + String(value));
  }
});

test('явный ноль в строке группы — это ставка, а не пустота', () => {
  // Обратная сторона предыдущего теста и причина, по которой пустота
  // отсеивается до Number(): «за эту группу не платим» должно быть выразимо и
  // должно перекрывать стандартный процент.
  const src = { reward_mode: 'own', own_percent: 7, own_rates: rates([{ type_id: LAB, unit: 'pct', value: 0 }]) };
  assert.deepEqual(rate(src, CATEGORY, LAB), { unit: 'pct', value: 0 });
});

test('позиция без группы услуг откатывается на процент', () => {
  // Свободная позиция счёта (ii.description без service_id) — type_id null.
  assert.deepEqual(rate({ reward_mode: 'category' }, CATEGORY, null), { unit: 'pct', value: 10 });
});

test('процент берётся ПОСЛЕ скидки', () => {
  const r = rewardForLine({ unit: 'pct', value: 10 }, { amount: 100000, discount: 20000, qty: 1 });
  assert.equal(r, 8000, 'посчитано от прайса, а не от того, что взяли с пациента');
});

test('фиксированная сумма умножается на количество', () => {
  // Решение владельца: «три снимка по 60 000» — это 180 000.
  assert.equal(rewardForLine({ unit: 'fix', value: 60000 }, { amount: 300000, discount: 0, qty: 3 }), 180000);
});

test('количество, которого нет, считается за одну услугу', () => {
  // Как COALESCE(ii.quantity, 1) в расчёте доли врача. Ноль — это по-прежнему
  // ноль: отличать «не указано» от «нисколько» обязательно.
  assert.equal(rewardForLine({ unit: 'fix', value: 60000 }, { amount: 60000, qty: null }), 60000);
  assert.equal(rewardForLine({ unit: 'fix', value: 60000 }, { amount: 60000 }), 60000);
  assert.equal(rewardForLine({ unit: 'fix', value: 60000 }, { amount: 0, qty: 0 }), 0);
});

test('фиксированная сумма не зависит от скидки', () => {
  assert.equal(rewardForLine({ unit: 'fix', value: 60000 }, { amount: 300000, discount: 100000, qty: 1 }), 60000);
});

test('нулевая ставка даёт ноль, а не NaN', () => {
  assert.equal(rewardForLine({ unit: 'pct', value: 0 }, { amount: 100000 }), 0);
  assert.equal(rewardForLine(null, { amount: 100000 }), 0);
});

test('parseRates принимает и строку, и уже разобранный массив', () => {
  // Маршрут /api/db разбирает JSON-колонки сам (meta.json), а миграция и
  // прямой SQL отдают строку — читатель обязан пережить оба.
  assert.deepEqual(parseRates('[{"type_id":1,"unit":"pct","value":5}]'), [{ type_id: 1, unit: 'pct', value: 5 }]);
  assert.deepEqual(parseRates([{ type_id: 1 }]), [{ type_id: 1 }]);
  assert.deepEqual(parseRates(null), []);
});
