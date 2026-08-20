import { test } from 'node:test';
import assert from 'node:assert';
import { ladderState } from './ladder.js';

// A licence issued on the 20th is valid for 14 days, to the 3rd of September.
const VALID_UNTIL = '2026-09-03T00:00:00Z';
const at = (iso, subscription = 'active') =>
  ladderState({ validUntil: VALID_UNTIL, now: new Date(iso), subscription });

test('plenty of time left shows nothing at all', () => {
  const s = at('2026-08-21T09:00:00Z');
  assert.equal(s.state, 'ok');
  assert.equal(s.daysLeft, 13);
  assert.equal(s.locked, false);
});

test('a week out, a quiet notice appears', () => {
  assert.equal(at('2026-08-27T09:00:00Z').state, 'notice');   // 7 days left
});

test('three days out it escalates to a warning', () => {
  assert.equal(at('2026-08-31T09:00:00Z').state, 'warn');     // 3 days left
});

test('the boundary between notice and warning is exactly three days', () => {
  assert.equal(at('2026-08-30T09:00:00Z').state, 'notice');   // 4 days
  assert.equal(at('2026-08-31T09:00:00Z').state, 'warn');     // 3 days
});

test('on the expiry moment it locks', () => {
  const s = at('2026-09-03T00:00:00Z');
  assert.equal(s.state, 'locked');
  assert.equal(s.locked, true);
  assert.equal(s.daysLeft, 0);
});

test('long past expiry it stays locked and never reports negative days', () => {
  const s = at('2027-01-01T00:00:00Z');
  assert.equal(s.state, 'locked');
  assert.equal(s.daysLeft, 0);
});

// The distinction that protects a paying customer from being insulted.
test('a paid clinic that cannot reach the server is told it is offline', () => {
  assert.equal(at('2026-08-31T09:00:00Z', 'active').reason, 'offline');
});

test('a clinic that stopped paying is told about the subscription', () => {
  assert.equal(at('2026-08-31T09:00:00Z', 'unpaid').reason, 'unpaid');
});

test('no licence at all is locked, not crashed', () => {
  const s = ladderState({ validUntil: null, now: new Date('2026-08-21T00:00:00Z'), subscription: 'active' });
  assert.equal(s.state, 'locked');
  assert.equal(s.reason, 'unlicensed');
});

test('an unparseable date is treated as no licence', () => {
  const s = ladderState({ validUntil: 'not-a-date', now: new Date('2026-08-21T00:00:00Z'), subscription: 'active' });
  assert.equal(s.state, 'locked');
  assert.equal(s.reason, 'unlicensed');
});

// --- extra coverage added after attacking the given implementation ---

// A broken system clock must fail closed. NaN comparisons are all false, so a
// careless implementation could fall through every "still has time" branch
// and land on the most permissive one (`ok`) by accident.
test('an Invalid Date `now` locks rather than failing open', () => {
  const s = ladderState({ validUntil: VALID_UNTIL, now: new Date('not-a-date'), subscription: 'active' });
  assert.equal(s.state, 'locked');
  assert.equal(s.locked, true);
  assert.equal(s.reason, 'unlicensed');
});

// Only a known, explicit non-payment gets the money wording. A status the
// caller has never seen before is closer to "we don't know" than "they owe
// us" — telling a possibly-paying clinic they haven't paid is the worse
// mistake, so unrecognised statuses must fall back to 'offline', not 'unpaid'.
test('an unrecognised subscription status defaults to the offline wording, not unpaid', () => {
  assert.equal(at('2026-08-31T09:00:00Z', 'suspended').reason, 'offline');
  assert.equal(at('2026-08-31T09:00:00Z', null).reason, 'offline');
});

test('a missing subscription argument defaults to the offline wording', () => {
  const s = ladderState({ validUntil: VALID_UNTIL, now: new Date('2026-08-31T09:00:00Z') });
  assert.equal(s.reason, 'offline');
});

// Math.ceil means "one hour past a whole day" rounds UP to the next day, not
// down. Confirm the notice/warn rungs turn on at exactly N days left and not
// a moment before, and that nothing after the boundary jumps two rungs at once.
test('the notice rung engages at exactly 7 days left, not a moment before', () => {
  const oneHourEarlier = at('2026-08-26T23:00:00Z'); // 7 days + 1 hour left
  assert.equal(oneHourEarlier.state, 'ok');
  assert.equal(oneHourEarlier.daysLeft, 8);

  const exactlySevenDays = at('2026-08-27T00:00:00Z'); // exactly 7 days left
  assert.equal(exactlySevenDays.state, 'notice');
  assert.equal(exactlySevenDays.daysLeft, 7);
});

test('the warn rung engages at exactly 3 days left, not a moment before', () => {
  const oneHourEarlier = at('2026-08-30T23:00:00Z'); // 3 days + 1 hour left
  assert.equal(oneHourEarlier.state, 'notice');
  assert.equal(oneHourEarlier.daysLeft, 4);

  const exactlyThreeDays = at('2026-08-31T00:00:00Z'); // exactly 3 days left
  assert.equal(exactlyThreeDays.state, 'warn');
  assert.equal(exactlyThreeDays.daysLeft, 3);
});

// A working, unlocked system must never render "0 days left" — that reads as
// already expired to a clinic that can still use the app.
test('daysLeft is never 0 while unlocked, across an hour-by-hour walk through every rung', () => {
  const startMs = new Date('2026-08-25T00:00:00Z').getTime();
  const endMs = new Date('2026-09-04T00:00:00Z').getTime();
  const rank = { ok: 0, notice: 1, warn: 2, locked: 3 };
  let previous = null;

  for (let t = startMs; t <= endMs; t += 60 * 60 * 1000) {
    const s = at(new Date(t).toISOString());
    assert.ok(!(s.locked === false && s.daysLeft === 0), `unlocked with 0 days left at ${new Date(t).toISOString()}`);
    assert.ok(Number.isInteger(s.daysLeft) && s.daysLeft >= 0, `daysLeft invalid at ${new Date(t).toISOString()}`);
    if (previous !== null) {
      assert.ok(rank[s.state] >= previous, `state moved backwards at ${new Date(t).toISOString()}`);
      assert.ok(rank[s.state] - previous <= 1, `state skipped a rung at ${new Date(t).toISOString()}`);
    }
    previous = rank[s.state];
  }
});

// The instant `now` reaches `until` is the one moment where "offline" reason
// still has to be right, not just the locked/daysLeft fields the base test covers.
test('now exactly equal to until is locked with the correct reason, not a boundary accident', () => {
  const s = at(VALID_UNTIL, 'unpaid');
  assert.equal(s.state, 'locked');
  assert.equal(s.locked, true);
  assert.equal(s.daysLeft, 0);
  assert.equal(s.reason, 'unpaid');
});
