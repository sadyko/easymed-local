// DISCOUNT_V2 (решение владельца 2026-11-07, п. 4) — выбор ОДНОЙ скидки в окнах
// регистрации: варианты, выбор по умолчанию, аргументы счёта, причина рядом с итогом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupOf, discountChoiceOptions, defaultChoiceKey, keepChoice, choiceArgs, choiceFloorPct, choiceReason, promoLabel, choiceToSend, fallbackChoiceKey } from '../discount-choice.js';

const TODAY = '2026-11-07';
const VIP = groupOf('VIP', 10);
const ROWS = [
  { id: 1, name: 'ЛЕТО', kind: 'promo', percent: 15, amount: 0, active: 1, service_ids: [] },
  { id: 2, name: 'УЗИ-5000', kind: 'promo', percent: 0, amount: 5000, active: 1, service_ids: [31] },
  { id: 3, name: 'Истёк', kind: 'promo', percent: 20, active: 1, valid_until: '2026-10-01', service_ids: [] },
  { id: 4, name: 'Подарок', kind: 'gift_card', amount: 100000, remaining: 100000, active: 1, service_ids: [] },
  { id: 5, name: 'Только VIP', kind: 'promo', percent: 30, active: 1, category_id: 9, service_ids: [] },
];

test('варианты: «Без скидки», группа, подходящие промокоды (без карт, просроченных и чужой группы), «Своя скидка»', () => {
  const opts = discountChoiceOptions({ group: VIP, discounts: ROWS, ctx: { today: TODAY, categoryId: 2, serviceIds: [31, 40] }, fmtMoney: (n) => String(n) });
  assert.deepEqual(opts.map((o) => o.key), ['none', 'group', 'promo:1', 'promo:2', 'manual']);
  assert.deepEqual(opts[1].label, { text: 'Скидка группы «{name}» — {pct}%', params: { name: 'VIP', pct: '10' } });
  assert.deepEqual(opts[2].label, { text: 'Промокод «{name}» — −{value}%', params: { name: 'ЛЕТО', value: '15' } });
  assert.deepEqual(opts[3].label, { text: 'Промокод «{name}» — −{value} сум · на выбранные услуги', params: { name: 'УЗИ-5000', value: '5000' } });
  const noGroup = discountChoiceOptions({ group: null, discounts: [], ctx: { today: TODAY } });
  assert.deepEqual(noGroup.map((o) => o.key), ['none', 'manual']);
  assert.deepEqual(discountChoiceOptions({ group: VIP, discounts: [], ctx: {}, manual: false }).map((o) => o.key), ['none', 'group']);
});

test('по умолчанию — скидка группы (как в 3.21); без группы — «Без скидки»; пропавший промокод — обратно к умолчанию', () => {
  assert.equal(defaultChoiceKey(VIP), 'group');
  assert.equal(defaultChoiceKey(null), 'none');
  const opts = discountChoiceOptions({ group: VIP, discounts: ROWS, ctx: { today: TODAY, categoryId: 2, serviceIds: [40] } });
  assert.equal(keepChoice('promo:2', opts, VIP), 'group', 'промокод на УЗИ без УЗИ в смете');
  assert.equal(keepChoice('promo:1', opts, VIP), 'promo:1');
});

test('аргументы счёта и пол группы: группа и «вручную» — с полом; «Без скидки» и промокод — без', () => {
  assert.deepEqual(choiceArgs('group'), { discount_choice: 'group' });
  assert.deepEqual(choiceArgs('none'), { discount_choice: 'none' });
  assert.deepEqual(choiceArgs('manual'), { discount_choice: 'manual' });
  assert.deepEqual(choiceArgs('promo:7'), { discount_choice: 'promo', discount_id: 7 });
  assert.deepEqual(choiceArgs(null), {});
  assert.equal(choiceFloorPct('group', VIP), 10);
  assert.equal(choiceFloorPct('manual', VIP), 10);
  assert.equal(choiceFloorPct('none', VIP), 0);
  assert.equal(choiceFloorPct('promo:1', VIP), 0);
  assert.equal(choiceFloorPct('group', null), 0);
});

test('причина рядом с итогом: группа, промокод, «вручную» (не больше пола — это группа), нет скидки — нет причины', () => {
  assert.deepEqual(choiceReason('group', { group: VIP, applied: 10000, floor: 10000 }), { text: 'Скидка группы «{name}» — {pct}%', params: { name: 'VIP', pct: '10' } });
  assert.deepEqual(choiceReason('promo:1', { group: VIP, promo: ROWS[0], applied: 15000 }), promoLabel(ROWS[0]));
  assert.deepEqual(choiceReason('manual', { group: VIP, applied: 10000, floor: 10000 }).params, { name: 'VIP', pct: '10' });
  assert.deepEqual(choiceReason('manual', { group: VIP, applied: 20000, floor: 10000 }), { text: 'Своя скидка (вручную)', params: {} });
  assert.equal(choiceReason('none', { group: VIP, applied: 0 }), null);
});

// DISCOUNT_V2 (ревью S1 L-3) — группа пациента не прочиталась: «Без скидки» по умолчанию — не выбор
// человека и в счёт не уходит (сервер кладёт пол группы, как в 3.21); выбор человека уходит всегда.
test('ревью S1 L-3: группа не известна — выбор по умолчанию не шлётся; выбор человека — шлётся', () => {
  assert.equal(choiceToSend('none', { groupKnown: false }), null);
  assert.deepEqual(choiceArgs(choiceToSend('none', { groupKnown: false })), {});
  assert.equal(choiceToSend('none', { groupKnown: false, picked: true }), 'none');
  assert.equal(choiceToSend('promo:3', { groupKnown: false, picked: true }), 'promo:3');
  assert.equal(choiceToSend('none', { groupKnown: true }), 'none');
  assert.equal(choiceToSend('group'), 'group');
  // калькулятор услуг: без явного выбора — промокод, «вручную», группа, «Без скидки»; группа не прочиталась — null
  assert.equal(fallbackChoiceKey({ promoId: 4, manualPct: 5, groupPct: 10 }), 'promo:4');
  assert.equal(fallbackChoiceKey({ manualPct: 5, groupPct: 10 }), 'manual');
  assert.equal(fallbackChoiceKey({ groupPct: 10 }), 'group');
  assert.equal(fallbackChoiceKey({ groupPct: 0 }), 'none');
  assert.equal(fallbackChoiceKey({ groupPct: 0, groupKnown: false }), null);
  assert.equal(fallbackChoiceKey({ manualPct: 5, groupKnown: false }), 'manual');
  // DISCOUNT_RATES_V1 — группа со ставками по услугам при 0 % по умолчанию — тоже скидка группы.
  assert.equal(fallbackChoiceKey({ groupPct: 0, groupHasRates: true }), 'group');
  assert.equal(fallbackChoiceKey({ groupPct: 0, groupHasRates: true, groupKnown: false }), 'group');
});
