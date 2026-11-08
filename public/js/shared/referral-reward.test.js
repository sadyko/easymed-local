// REFERRAL_CATEGORY_RATES_V1 — правила выбора ставки. Здесь считаются ЧУЖИЕ
// деньги, поэтому проверяется не «функция что-то вернула», а каждая развилка
// таблицы истинности и каждый откат по отдельности.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReferralRate, rewardForLine, parseRates, referralGroupOf, REFERRAL_GROUPS, serviceRateOf, serviceRatesProblem } from './referral-reward.js';   // serviceRatesProblem: REFERRAL_RATE_CAP_V1

// GROUPS_FIVE_REFERRAL_V1 (мигр. 153) — ключ ставки — группа (services.type).
const LAB = 'lab', XRAY = 'imaging';
const rates = (arr) => JSON.stringify(arr);

const CATEGORY = {
  standard_percent: 10,
  rates: rates([{ group: LAB, unit: 'pct', value: 20 },
                { group: XRAY, unit: 'fix', value: 60000 }]),
};

const rate = (source, category, serviceGroup) =>
  resolveReferralRate({ source, category, serviceGroup });

test('по категории: ставка группы перекрывает стандартный процент', () => {
  const src = { reward_mode: 'category' };
  assert.deepEqual(rate(src, CATEGORY, LAB), { unit: 'pct', value: 20 });
  assert.deepEqual(rate(src, CATEGORY, XRAY), { unit: 'fix', value: 60000 });
});

test('по категории: ненастроенная группа откатывается на стандартный процент', () => {
  assert.deepEqual(rate({ reward_mode: 'category' }, CATEGORY, 'procedure'), { unit: 'pct', value: 10 });
});

test('по категории: без категории — ноль, а не чужая ставка', () => {
  // Источник, у которого категорию не выбрали. Молча взять общую ставку
  // было бы хуже нуля: ноль виден в отчёте и чинится выбором категории.
  assert.deepEqual(rate({ reward_mode: 'category' }, null, LAB), { unit: 'pct', value: 0 });
});

test('своя ставка: группа перекрывает свой процент', () => {
  const src = { reward_mode: 'own', own_percent: 5, own_rates: rates([{ group: LAB, unit: 'pct', value: 15 }]) };
  assert.deepEqual(rate(src, CATEGORY, LAB), { unit: 'pct', value: 15 });
});

test('своя ставка: пустая строка группы откатывается на СВОЙ процент, не на категорию', () => {
  // Решение владельца 2026-09-08: карточка источника объясняет выплату целиком.
  const src = { reward_mode: 'own', own_percent: 5, own_rates: rates([{ group: LAB, unit: 'pct', value: 15 }]) };
  assert.deepEqual(rate(src, CATEGORY, XRAY), { unit: 'pct', value: 5 },
    'взята ставка категории вместо своего процента');
});

test('своя ставка: без своего процента — ноль, категория не подглядывается', () => {
  const src = { reward_mode: 'own', own_percent: 0, own_rates: '' };
  assert.deepEqual(rate(src, CATEGORY, LAB), { unit: 'pct', value: 0 });
});

test('незнакомый режим считается «по категории»', () => {
  // CHECK на колонке намеренно нет (мигр. 115); незнакомая строка не должна
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
    const src = { reward_mode: 'own', own_percent: 7, own_rates: rates([{ group: LAB, unit: 'pct', value }]) };
    assert.deepEqual(rate(src, CATEGORY, LAB), { unit: 'pct', value: 7 }, 'на ' + String(value));
  }
});

test('явный ноль в строке группы — это ставка, а не пустота', () => {
  // Обратная сторона предыдущего теста и причина, по которой пустота
  // отсеивается до Number(): «за эту группу не платим» должно быть выразимо и
  // должно перекрывать стандартный процент.
  const src = { reward_mode: 'own', own_percent: 7, own_rates: rates([{ group: LAB, unit: 'pct', value: 0 }]) };
  assert.deepEqual(rate(src, CATEGORY, LAB), { unit: 'pct', value: 0 });
});

test('позиция без группы услуг откатывается на процент', () => {
  // Свободная позиция счёта (ii.description без service_id) — группы нет.
  assert.deepEqual(rate({ reward_mode: 'category' }, CATEGORY, null), { unit: 'pct', value: 10 });
});

// REFERRAL_FULL_PRICE_V1 (3.22.0, владелец 2026-11-08: «discount not applied to the
// partners share — full price, always») — было «процент берётся ПОСЛЕ скидки» (8 000
// от 100 000 − 20 000); правило заменено решением владельца: скидка пациенту долю
// направившего не уменьшает.
test('REFERRAL_FULL_PRICE_V1: процент — от цены строки ДО скидки (УЗИ 200 000, скидка 20 %, партнёр 10 % → 20 000)', () => {
  assert.equal(rewardForLine({ unit: 'pct', value: 10 }, { amount: 200000, discount: 40000, qty: 1 }), 20000);
  assert.equal(rewardForLine({ unit: 'pct', value: 10 }, { amount: 100000, discount: 20000, qty: 1 }), 10000);
});

test('REFERRAL_FULL_PRICE_V1: скидка 100 % (услуга бесплатна для пациента) — партнёру 10 % от 200 000 = 20 000', () => {
  assert.equal(rewardForLine({ unit: 'pct', value: 10 }, { amount: 200000, discount: 200000, qty: 1 }), 20000);
  assert.equal(rewardForLine({ unit: 'fix', value: 70000 }, { amount: 200000, discount: 200000, qty: 1 }), 70000);
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

test('GROUPS_FIVE_REFERRAL_V1: групп ровно пять, «radiology» — это «Диагностика»', () => {
  assert.deepEqual(REFERRAL_GROUPS, ['consultation', 'lab', 'imaging', 'procedure', 'other']);
  assert.equal(referralGroupOf('radiology'), 'imaging');
  assert.equal(referralGroupOf(' Lab '), 'lab');
  for (const bad of [null, undefined, '', 'surgery', 6]) assert.equal(referralGroupOf(bad), null, String(bad));
  // Запись со старым именем группы читается той же группой.
  const cat = { standard_percent: 10, rates: rates([{ group: 'radiology', unit: 'pct', value: 25 }]) };
  assert.deepEqual(rate({ reward_mode: 'category' }, cat, 'imaging'), { unit: 'pct', value: 25 });
});

test('GROUPS_FIVE_REFERRAL_V1: запись со старым ключом type_id не платит наугад', () => {
  // Миграция 153 переводит type_id в группы; если такая запись всё же
  // осталась, число не угадывается как группа — действует процент выше.
  const src = { reward_mode: 'own', own_percent: 7, own_rates: rates([{ type_id: 3, unit: 'pct', value: 50 }]) };
  assert.deepEqual(rate(src, null, LAB), { unit: 'pct', value: 7 });
});

// REFERRAL_SERVICE_RATES_V1 (мигр. 282) — особая ставка за ОТДЕЛЬНУЮ услугу
// стоит выше обоих режимов: это исключение «за эту услугу платим больше», и
// оно обязано действовать и поверх категории, и поверх своих групп.
const SPECIAL = rates([{ service_id: 7, unit: 'pct', value: 25 },
                       { service_id: 8, unit: 'fix', value: 50000 },
                       { service_id: 9, unit: 'pct', value: '' }]);

test('особая ставка услуги: перекрывает ставку категории в режиме «по категории»', () => {
  const src = { reward_mode: 'category', service_rates: SPECIAL };
  assert.deepEqual(resolveReferralRate({ source: src, category: CATEGORY, serviceGroup: LAB, serviceId: 7 }), { unit: 'pct', value: 25 });
  assert.deepEqual(resolveReferralRate({ source: src, category: CATEGORY, serviceGroup: LAB, serviceId: 8 }), { unit: 'fix', value: 50000 });
});

test('особая ставка услуги: перекрывает свои группы и свой процент в режиме «своя»', () => {
  const src = { reward_mode: 'own', own_percent: 5, own_rates: rates([{ group: LAB, unit: 'pct', value: 15 }]), service_rates: SPECIAL };
  assert.deepEqual(resolveReferralRate({ source: src, category: CATEGORY, serviceGroup: LAB, serviceId: 7 }), { unit: 'pct', value: 25 });
});

test('особая ставка услуги: другая услуга той же группы — по общему правилу', () => {
  const src = { reward_mode: 'category', service_rates: SPECIAL };
  assert.deepEqual(resolveReferralRate({ source: src, category: CATEGORY, serviceGroup: LAB, serviceId: 123 }), { unit: 'pct', value: 20 });
  // Строка без услуги (свободный текст) особой ставки не имеет; «7» строкой —
  // та же услуга 7 (id из /api/db приходит числом, из формы — строкой).
  assert.deepEqual(resolveReferralRate({ source: src, category: CATEGORY, serviceGroup: null, serviceId: null }), { unit: 'pct', value: 10 });
  assert.deepEqual(resolveReferralRate({ source: src, category: CATEGORY, serviceGroup: LAB, serviceId: '7' }), { unit: 'pct', value: 25 });
});

test('особая ставка услуги: запись без числа — как будто её нет; испорченный JSON — тоже', () => {
  const src = { reward_mode: 'category', service_rates: SPECIAL };
  assert.deepEqual(resolveReferralRate({ source: src, category: CATEGORY, serviceGroup: LAB, serviceId: 9 }), { unit: 'pct', value: 20 });
  const broken = { reward_mode: 'category', service_rates: '{oops' };
  assert.deepEqual(resolveReferralRate({ source: broken, category: CATEGORY, serviceGroup: LAB, serviceId: 7 }), { unit: 'pct', value: 20 });
  // Источник без колонки вовсе (старый снимок строки) — прежнее правило.
  assert.deepEqual(resolveReferralRate({ source: { reward_mode: 'category' }, category: CATEGORY, serviceGroup: LAB, serviceId: 7 }), { unit: 'pct', value: 20 });
});

test('serviceRateOf: особая ставка или null — для подписи «Режим» в отчёте', () => {
  const src = { service_rates: SPECIAL };
  assert.deepEqual(serviceRateOf(src, 7), { unit: 'pct', value: 25 });
  assert.equal(serviceRateOf(src, 123), null);
  assert.equal(serviceRateOf(src, null), null);
  assert.equal(serviceRateOf(null, 7), null);
});

// REFERRAL_RATE_CAP_V1 (3.22.0, ревью) — особая ставка за услугу: процент — от 0 до 100,
// сумма — не меньше нуля. Одно правило на форму («Особые ставки по отдельным услугам») и
// на запись сервера (/api/db referral_sources): «250» вместо «25» платило в десять раз больше.
test('serviceRatesProblem: процент 0…100, сумма ≥ 0; пустая ставка и не-массив — не ошибка', () => {
  const ok = [
    [], '', null, undefined, '{oops', '[]',
    [{ service_id: 1, unit: 'pct', value: 0 }, { service_id: 2, unit: 'pct', value: 100 }, { service_id: 3, unit: 'pct', value: 25.5 }],
    [{ service_id: 4, unit: 'fix', value: 0 }, { service_id: 5, unit: 'fix', value: 999999 }],
    [{ service_id: 6, unit: 'pct', value: '' }, { service_id: 7, unit: 'pct', value: null }],   // записи нет — читатель её пропускает
    JSON.stringify([{ service_id: 8, unit: 'pct', value: 40 }]),
  ];
  for (const v of ok) assert.equal(serviceRatesProblem(v), null, JSON.stringify(v));
  const pct = serviceRatesProblem([{ service_id: 1, unit: 'pct', value: 250 }]);
  assert.equal(pct, 'Особая ставка в процентах — от 0 до 100.');
  assert.equal(serviceRatesProblem([{ service_id: 1, value: 100.01 }]), pct, 'без единицы — процент');
  assert.equal(serviceRatesProblem([{ service_id: 1, unit: 'pct', value: -1 }]), pct);
  assert.equal(serviceRatesProblem(JSON.stringify([{ service_id: 1, unit: 'pct', value: '150' }])), pct, 'строка JSON и число строкой');
  assert.equal(serviceRatesProblem([{ service_id: 1, unit: 'fix', value: -5000 }]), 'Особая ставка суммой не может быть меньше нуля.');
});
