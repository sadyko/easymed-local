import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STALE_THRESHOLD_MS,
  SELLABLE_MODULES,
  lastSeenSeverity,
  formatLastSeen,
  moduleToggles,
  hasUnmanageableMarketingGrant,
  isGrantable,
  subscriptionBadge,
  codeGroups,
  subscriptionUntilPayload,
} from './panel-logic.js';

// --- lastSeenSeverity --------------------------------------------------------

test('lastSeenSeverity: null/undefined last_seen_at is "never"', () => {
  assert.equal(lastSeenSeverity(null, new Date()), 'never');
  assert.equal(lastSeenSeverity(undefined, new Date()), 'never');
  assert.equal(lastSeenSeverity('', new Date()), 'never');
});

test('lastSeenSeverity: an unparsable string is also "never", not a crash', () => {
  assert.equal(lastSeenSeverity('not-a-date', new Date()), 'never');
});

test('lastSeenSeverity: within 3 days is "ok"', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  const oneHourAgo = new Date(now.getTime() - 3600_000).toISOString();
  assert.equal(lastSeenSeverity(oneHourAgo, now), 'ok');
});

test('lastSeenSeverity: exactly 3 days ago is still "ok" (boundary is exclusive)', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  const exactly3d = new Date(now.getTime() - STALE_THRESHOLD_MS).toISOString();
  assert.equal(lastSeenSeverity(exactly3d, now), 'ok');
});

test('lastSeenSeverity: one millisecond past 3 days is "stale"', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  const justOver = new Date(now.getTime() - STALE_THRESHOLD_MS - 1).toISOString();
  assert.equal(lastSeenSeverity(justOver, now), 'stale');
});

test('lastSeenSeverity: a week ago is "stale"', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  assert.equal(lastSeenSeverity(weekAgo, now), 'stale');
});

// --- formatLastSeen -----------------------------------------------------------

test('formatLastSeen: never checked in', () => {
  assert.equal(formatLastSeen(null, new Date()), 'never');
});

test('formatLastSeen: seconds ago reads as "just now"', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  const secondsAgo = new Date(now.getTime() - 30_000).toISOString();
  assert.equal(formatLastSeen(secondsAgo, now), 'just now');
});

test('formatLastSeen: minutes ago', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  const minutesAgo = new Date(now.getTime() - 5 * 60_000).toISOString();
  assert.equal(formatLastSeen(minutesAgo, now), '5 min ago');
});

test('formatLastSeen: hours ago', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  const hoursAgo = new Date(now.getTime() - 2 * 3600_000).toISOString();
  assert.equal(formatLastSeen(hoursAgo, now), '2 h ago');
});

test('formatLastSeen: days ago, plural', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  const daysAgo = new Date(now.getTime() - 5 * 24 * 3600_000).toISOString();
  assert.equal(formatLastSeen(daysAgo, now), '5 days ago');
});

test('formatLastSeen: exactly one day ago is singular', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  const oneDayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
  assert.equal(formatLastSeen(oneDayAgo, now), '1 day ago');
});

// --- moduleToggles --------------------------------------------------------------

test('moduleToggles: marketing is never offered, even though it is in the sellable vocabulary', () => {
  const chips = moduleToggles(SELLABLE_MODULES, []);
  assert.ok(!chips.some((c) => c.key === 'marketing'), 'no marketing chip should ever be rendered');
});

test('moduleToggles: real sellable modules appear with their granted state', () => {
  const chips = moduleToggles(SELLABLE_MODULES, ['crm']);
  assert.deepEqual(chips, [
    { key: 'crm', label: 'CRM', granted: true },
    { key: 'telegram', label: 'Telegram', granted: false },
  ]);
});

test('moduleToggles: none granted', () => {
  const chips = moduleToggles(SELLABLE_MODULES, []);
  assert.deepEqual(chips, [
    { key: 'crm', label: 'CRM', granted: false },
    { key: 'telegram', label: 'Telegram', granted: false },
  ]);
});

test('moduleToggles: marketing stays excluded even if the clinic somehow already has it granted', () => {
  const chips = moduleToggles(SELLABLE_MODULES, ['crm', 'marketing']);
  assert.deepEqual(chips, [
    { key: 'crm', label: 'CRM', granted: true },
    { key: 'telegram', label: 'Telegram', granted: false },
  ]);
});

test('moduleToggles: tolerates a granted list that is undefined', () => {
  const chips = moduleToggles(SELLABLE_MODULES, undefined);
  assert.deepEqual(chips.map((c) => c.granted), [false, false]);
});

// --- hasUnmanageableMarketingGrant ----------------------------------------------

test('hasUnmanageableMarketingGrant: true only when marketing is actually present', () => {
  assert.equal(hasUnmanageableMarketingGrant(['crm', 'marketing']), true);
  assert.equal(hasUnmanageableMarketingGrant(['crm']), false);
  assert.equal(hasUnmanageableMarketingGrant([]), false);
  assert.equal(hasUnmanageableMarketingGrant(undefined), false);
});

// --- isGrantable (requests inbox) ------------------------------------------------

test('isGrantable: marketing is never grantable from the requests inbox', () => {
  assert.equal(isGrantable('marketing'), false);
});

test('isGrantable: real sellable modules are grantable', () => {
  assert.equal(isGrantable('crm'), true);
  assert.equal(isGrantable('telegram'), true);
});

// --- subscriptionBadge -----------------------------------------------------------

test('subscriptionBadge: unpaid is always a danger badge, regardless of subscription_until', () => {
  assert.deepEqual(subscriptionBadge('unpaid', null, new Date('2026-08-22')), { label: 'Unpaid', tone: 'danger' });
  assert.deepEqual(subscriptionBadge('unpaid', '2027-01-01', new Date('2026-08-22')), { label: 'Unpaid', tone: 'danger' });
});

test('subscriptionBadge: active with no end date', () => {
  assert.deepEqual(subscriptionBadge('active', null, new Date('2026-08-22')), { label: 'Active', tone: 'ok' });
});

test('subscriptionBadge: active with a future paid-until date', () => {
  assert.deepEqual(
    subscriptionBadge('active', '2027-01-01', new Date('2026-08-22T00:00:00Z')),
    { label: 'Active · paid until 2027-01-01', tone: 'ok' },
  );
});

test('subscriptionBadge: active with paid-until being today is still fine (inclusive)', () => {
  assert.deepEqual(
    subscriptionBadge('active', '2026-08-22', new Date('2026-08-22T23:00:00Z')),
    { label: 'Active · paid until 2026-08-22', tone: 'ok' },
  );
});

test('subscriptionBadge: active but paid-until has passed reads as a problem, not as active', () => {
  const badge = subscriptionBadge('active', '2026-08-01', new Date('2026-08-22T00:00:00Z'));
  assert.equal(badge.tone, 'danger', 'a lapsed paid-until must never read as a healthy/ok state');
  assert.match(badge.label, /expired/i);
});

// --- codeGroups ------------------------------------------------------------------

test('codeGroups: splits the server-formatted code on its own hyphens', () => {
  assert.deepEqual(codeGroups('EM-AB3D-9XQZ'), ['EM', 'AB3D', '9XQZ']);
  assert.deepEqual(codeGroups('ABCDE-FGHIJ'), ['ABCDE', 'FGHIJ']);
});

test('codeGroups: empty/missing input is an empty array, never a crash', () => {
  assert.deepEqual(codeGroups(''), []);
  assert.deepEqual(codeGroups(null), []);
  assert.deepEqual(codeGroups(undefined), []);
});

// --- subscriptionUntilPayload ------------------------------------------------------

test('subscriptionUntilPayload: an empty date input means "no end date" (null), never today', () => {
  assert.equal(subscriptionUntilPayload(''), null);
  assert.equal(subscriptionUntilPayload('   '), null);
  assert.equal(subscriptionUntilPayload(undefined), null);
  assert.equal(subscriptionUntilPayload(null), null);
});

test('subscriptionUntilPayload: a real date passes through untouched', () => {
  assert.equal(subscriptionUntilPayload('2026-08-22'), '2026-08-22');
});
