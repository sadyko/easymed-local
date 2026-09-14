// VISIT_TIER_PRICING_V1 — the owner's example, as a table: 200 000 first,
// 60 000 for a second visit 1–6 days later, free for the third in the window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tierFor, tierUnitPrice, hasTiers, daysBetween, priceForTier } from './visit-tier.js';

const SVC = { price: 200000, price_secondary: 60000, secondary_days_from: 1, secondary_days_to: 6, price_repeat: 0 };

test('daysBetween counts calendar days, not hours', () => {
  assert.equal(daysBetween('2026-09-14', '2026-09-14'), 0);
  assert.equal(daysBetween('2026-09-14', '2026-09-15'), 1);
  assert.equal(daysBetween('2026-09-30', '2026-10-06'), 6);
  assert.equal(daysBetween('2026-09-15', '2026-09-14'), -1);
});

test('the owner\'s example: first 200 000, second within 1–6 days 60 000, third free, after the window — first again', () => {
  assert.deepEqual(tierFor(SVC, null, '2026-09-14'), { tier: 'primary', price: 200000, base_price: 200000, days_since: null, reason: 'first' });
  const second = tierFor(SVC, { day: '2026-09-14', tier: 'primary' }, '2026-09-17');
  assert.equal(second.tier, 'secondary'); assert.equal(second.price, 60000); assert.equal(second.days_since, 3);
  const third = tierFor(SVC, { day: '2026-09-17', tier: 'secondary' }, '2026-09-20');
  assert.equal(third.tier, 'repeat'); assert.equal(third.price, 0, 'repeat is free — a stored 0 is a price, not an absence');
  const fourth = tierFor(SVC, { day: '2026-09-20', tier: 'repeat' }, '2026-09-22');
  assert.equal(fourth.tier, 'repeat');
  const late = tierFor(SVC, { day: '2026-09-14', tier: 'primary' }, '2026-09-21');
  assert.equal(late.tier, 'primary'); assert.equal(late.reason, 'window_passed'); assert.equal(late.days_since, 7);
  const sameDay = tierFor(SVC, { day: '2026-09-14', tier: 'primary' }, '2026-09-14');
  assert.equal(sameDay.tier, 'primary'); assert.equal(sameDay.reason, 'too_soon');
  const edge = tierFor(SVC, { day: '2026-09-14', tier: 'primary' }, '2026-09-20');
  assert.equal(edge.tier, 'secondary', 'day 6 is inside a 1–6 window');
});

test('an old line without a recorded tier counts as primary — the next one is secondary', () => {
  assert.equal(tierFor(SVC, { day: '2026-09-14', tier: null }, '2026-09-16').tier, 'secondary');
  assert.equal(tierFor(SVC, { day: '2026-09-14', tier: '' }, '2026-09-16').tier, 'secondary');
});

test('a service without tier prices is priced the old way — one price, always primary', () => {
  const plain = { price: 150000, price_secondary: null, secondary_days_from: null, secondary_days_to: null, price_repeat: null };
  assert.equal(hasTiers(plain), false);
  assert.deepEqual(tierFor(plain, { day: '2026-09-14', tier: 'secondary' }, '2026-09-15'),
    { tier: 'primary', price: 150000, base_price: 150000, days_since: null, reason: 'no_tiers' });
  assert.equal(tierUnitPrice(plain, 'secondary', 150000), 150000);
});

test('fallbacks: no repeat price → the secondary price again; no secondary but a repeat → straight to repeat; «до» empty → no upper limit', () => {
  const noRepeat = { ...SVC, price_repeat: null };
  assert.deepEqual(priceForTier(noRepeat, 'repeat'), { tier: 'secondary', price: 60000 });
  assert.equal(tierFor(noRepeat, { day: '2026-09-14', tier: 'secondary' }, '2026-09-16').tier, 'secondary');
  const onlyRepeat = { ...SVC, price_secondary: null, price_repeat: 10000 };
  assert.deepEqual(tierFor(onlyRepeat, { day: '2026-09-14', tier: 'primary' }, '2026-09-16').tier, 'repeat');
  const open = { ...SVC, secondary_days_to: null };
  assert.equal(tierFor(open, { day: '2026-01-01', tier: 'primary' }, '2026-09-16').tier, 'secondary', 'no upper bound → still the second visit');
  const fromZero = { ...SVC, secondary_days_from: 0 };
  assert.equal(tierFor(fromZero, { day: '2026-09-14', tier: 'primary' }, '2026-09-14').tier, 'secondary', '«от 0» lets a same-day second visit count');
});

test('tierUnitPrice: the cashier re-prices a stored line by its recorded tier', () => {
  assert.equal(tierUnitPrice(SVC, 'secondary', 200000), 60000);
  assert.equal(tierUnitPrice(SVC, 'repeat', 200000), 0);
  assert.equal(tierUnitPrice(SVC, 'primary', 200000), 200000);
  assert.equal(tierUnitPrice(SVC, null, 200000), 200000);
});
