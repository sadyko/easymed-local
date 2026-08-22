import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRunAt, isInWindow, consentAppliesTo, WINDOW_MS } from './update-schedule.js';

// --- nextRunAt ---------------------------------------------------------------

test('nextRunAt: hour still ahead today picks today', () => {
  const now = new Date(2026, 0, 1, 1, 0, 0); // 01:00, hour 3 hasn't happened yet
  const r = nextRunAt(3, now);
  assert.equal(r.getFullYear(), 2026);
  assert.equal(r.getMonth(), 0);
  assert.equal(r.getDate(), 1);
  assert.equal(r.getHours(), 3);
  assert.equal(r.getMinutes(), 0);
  assert.equal(r.getSeconds(), 0);
  assert.equal(r.getMilliseconds(), 0);
});

test('nextRunAt: hour already passed today rolls to tomorrow', () => {
  const now = new Date(2026, 0, 1, 14, 30, 0); // 14:30, hour 3 is long gone
  const r = nextRunAt(3, now);
  assert.equal(r.getDate(), 2);
  assert.equal(r.getHours(), 3);
});

test('nextRunAt: exact boundary instant counts as already arrived, rolls to tomorrow', () => {
  const now = new Date(2026, 0, 1, 3, 0, 0, 0); // exactly 03:00:00.000
  const r = nextRunAt(3, now);
  assert.equal(r.getDate(), 2, 'the exact millisecond of the hour is "arrived", not "still ahead"');
  assert.equal(r.getHours(), 3);
});

test('nextRunAt: one millisecond before the hour is still today', () => {
  const now = new Date(2026, 0, 1, 2, 59, 59, 999);
  const r = nextRunAt(3, now);
  assert.equal(r.getDate(), 1);
});

test('nextRunAt: midnight boundary — hour 0 exactly at midnight rolls to tomorrow midnight', () => {
  const now = new Date(2026, 0, 1, 0, 0, 0, 0);
  const r = nextRunAt(0, now);
  assert.equal(r.getDate(), 2);
  assert.equal(r.getHours(), 0);
});

test('nextRunAt: midnight boundary — hour 23 the moment after midnight is still today', () => {
  const now = new Date(2026, 0, 1, 0, 0, 0, 1);
  const r = nextRunAt(23, now);
  assert.equal(r.getDate(), 1);
  assert.equal(r.getHours(), 23);
});

test('nextRunAt: crossing a month boundary lands on the 1st of the next month', () => {
  const now = new Date(2026, 0, 31, 23, 30, 0); // Jan 31, hour 3 long gone
  const r = nextRunAt(3, now);
  assert.equal(r.getMonth(), 1); // February
  assert.equal(r.getDate(), 1);
});

test('nextRunAt: rejects an out-of-range or non-numeric hour', () => {
  for (const bad of [-1, 24, 24.5, NaN, 'три', null, undefined, {}]) {
    assert.throws(() => nextRunAt(bad, new Date()), /hour must be an integer 0-23/);
  }
});

test('nextRunAt: default now() is usable (no crash calling with just an hour)', () => {
  const r = nextRunAt(3);
  assert.ok(r instanceof Date && !Number.isNaN(r.getTime()));
});

// --- isInWindow ----------------------------------------------------------------

test('isInWindow: the opening instant counts as in the window', () => {
  const sched = new Date(2026, 0, 1, 3, 0, 0, 0);
  assert.equal(isInWindow(sched, new Date(2026, 0, 1, 3, 0, 0, 0)), true);
});

test('isInWindow: one millisecond before opening is not yet in the window', () => {
  const sched = new Date(2026, 0, 1, 3, 0, 0, 0);
  assert.equal(isInWindow(sched, new Date(2026, 0, 1, 2, 59, 59, 999)), false);
});

test('isInWindow: 59 minutes 59.999s later is still in the window', () => {
  const sched = new Date(2026, 0, 1, 3, 0, 0, 0);
  const almostClosed = new Date(sched.getTime() + WINDOW_MS - 1);
  assert.equal(isInWindow(sched, almostClosed), true);
});

test('isInWindow: exactly one hour later has closed (exclusive end)', () => {
  const sched = new Date(2026, 0, 1, 3, 0, 0, 0);
  const closed = new Date(sched.getTime() + WINDOW_MS);
  assert.equal(isInWindow(sched, closed), false, 'missed — must recompute the next occurrence, not run late');
});

test('isInWindow: well after the window (PC was off) is false', () => {
  const sched = new Date(2026, 0, 1, 3, 0, 0, 0);
  assert.equal(isInWindow(sched, new Date(2026, 0, 1, 9, 15, 0)), false, 'never run immediately on a late boot');
});

test('isInWindow: accepts an ISO string for scheduledAt, same as a Date', () => {
  const sched = new Date(2026, 0, 1, 3, 0, 0, 0);
  assert.equal(isInWindow(sched.toISOString(), new Date(sched.getTime() + 1000)), true);
});

test('isInWindow: a malformed scheduledAt never throws, always answers false', () => {
  for (const bad of [null, undefined, '', 'not a date', {}, NaN]) {
    assert.equal(isInWindow(bad, new Date()), false);
  }
});

// --- consentAppliesTo ----------------------------------------------------------

test('consentAppliesTo: matching versions applies', () => {
  assert.equal(consentAppliesTo({ version: '2.4.0' }, { version: '2.4.0', hour: 3 }), true);
});

test('consentAppliesTo: a superseded offer voids the old consent', () => {
  assert.equal(consentAppliesTo({ version: '2.5.0' }, { version: '2.4.0', hour: 3 }), false);
});

test('consentAppliesTo: no offer, no consent, or either malformed — never applies', () => {
  assert.equal(consentAppliesTo(null, { version: '2.4.0' }), false);
  assert.equal(consentAppliesTo({ version: '2.4.0' }, null), false);
  assert.equal(consentAppliesTo(undefined, undefined), false);
  assert.equal(consentAppliesTo({ version: '2.4.0' }, { version: '' }), false);
  assert.equal(consentAppliesTo({}, { version: '2.4.0' }), false, 'an offer with no version string can never be consented to');
});
