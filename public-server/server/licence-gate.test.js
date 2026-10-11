// PUBLIC_SERVER_V1 — шов 8c: состояние оплаты из подписанной лицензии.
import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionOf, licenceStanding } from './licence-gate.js';

const NOW = Date.parse('2030-03-11T04:00:00Z');

test('слово оплаты: только явное «unpaid» — неоплата; остальное — «active»', () => {
  assert.equal(subscriptionOf({ subscription: 'unpaid' }), 'unpaid');
  for (const p of [{ subscription: 'active' }, {}, { subscription: 'suspended' }, null]) assert.equal(subscriptionOf(p), 'active');
});

test('состояние: срок вышел — lapsed; «не оплачено» в сроке — unpaid; иначе active', () => {
  assert.equal(licenceStanding({ licence_valid_until: '2030-04-01T00:00:00Z', licence_subscription: 'active' }, NOW), 'active');
  assert.equal(licenceStanding({ licence_valid_until: '2030-04-01T00:00:00Z', licence_subscription: 'unpaid' }, NOW), 'unpaid');
  assert.equal(licenceStanding({ licence_valid_until: '2030-03-11T03:59:59Z', licence_subscription: 'active' }, NOW), 'lapsed');
  assert.equal(licenceStanding({ licence_valid_until: null }, NOW), 'lapsed');
  assert.equal(licenceStanding(null, NOW), 'lapsed');
});
