import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRuDate, formatRuHour, isWorkingHour, isValidHour, nextRunAtLocal,
  resolveHour, scheduleChoices, offerIsCurrent, formatScheduled,
  updateOutcomeMessage, whatsNewState,
} from './updates-logic.js';

// --- formatRuDate / formatRuHour ---------------------------------------------

test('formatRuDate: DD.MM.YYYY, zero-padded', () => {
  assert.equal(formatRuDate(new Date(2026, 7, 20)), '20.08.2026');
  assert.equal(formatRuDate(new Date(2026, 0, 1)), '01.01.2026');
});

test('formatRuHour: HH:00, zero-padded, this system only schedules on the hour', () => {
  assert.equal(formatRuHour(3), '03:00');
  assert.equal(formatRuHour(19), '19:00');
  assert.equal(formatRuHour('7'), '07:00');
});

// --- isWorkingHour -------------------------------------------------------------

test('isWorkingHour: 08-19 inclusive is working, outside it is not', () => {
  assert.equal(isWorkingHour(7), false);
  assert.equal(isWorkingHour(8), true);
  assert.equal(isWorkingHour(19), true);
  assert.equal(isWorkingHour(20), false);
  assert.equal(isWorkingHour(3), false, 'the default night hour is never a working hour');
  assert.equal(isWorkingHour(0), false);
});

test('isWorkingHour: non-integer/garbage is never "working" (fail calm, not throw)', () => {
  assert.equal(isWorkingHour('десять'), false);
  assert.equal(isWorkingHour(null), false);
  assert.equal(isWorkingHour(9.5), false);
});

// --- isValidHour ---------------------------------------------------------------

test('isValidHour: accepts 0-23 as a number or a numeric string', () => {
  assert.equal(isValidHour(0), true);
  assert.equal(isValidHour(23), true);
  assert.equal(isValidHour('5'), true);
});

test('isValidHour: refuses out-of-range, non-numeric, blank, or missing input', () => {
  for (const bad of [-1, 24, 3.5, 'три', '', '  ', null, undefined, {}]) {
    assert.equal(isValidHour(bad), false, `hour=${JSON.stringify(bad)} must be invalid`);
  }
});

// --- nextRunAtLocal — mirrors update-schedule.js's nextRunAt() 1:1 -------------
// Same boundary cases as server/services/control/update-schedule.test.js, on
// purpose: if the two ever disagree, one of these two test files should fail.

test('nextRunAtLocal: hour still ahead today picks today', () => {
  const now = new Date(2026, 0, 1, 1, 0, 0);
  const r = nextRunAtLocal(3, now);
  assert.equal(r.getDate(), 1);
  assert.equal(r.getHours(), 3);
  assert.equal(r.getMinutes(), 0);
});

test('nextRunAtLocal: hour already passed today rolls to tomorrow', () => {
  const now = new Date(2026, 0, 1, 14, 30, 0);
  const r = nextRunAtLocal(3, now);
  assert.equal(r.getDate(), 2);
  assert.equal(r.getHours(), 3);
});

test('nextRunAtLocal: exact boundary instant counts as already arrived, rolls to tomorrow', () => {
  const now = new Date(2026, 0, 1, 3, 0, 0, 0);
  const r = nextRunAtLocal(3, now);
  assert.equal(r.getDate(), 2);
});

test('nextRunAtLocal: one millisecond before the hour is still today', () => {
  const now = new Date(2026, 0, 1, 2, 59, 59, 999);
  assert.equal(nextRunAtLocal(3, now).getDate(), 1);
});

test('nextRunAtLocal: ATTACK — 23:59 the hour has long passed, "tonight" resolves into tomorrow\'s calendar date, never a lie', () => {
  const now = new Date(2026, 0, 1, 23, 59, 0);
  const r = nextRunAtLocal(3, now);
  assert.equal(r.getDate(), 2, 'the only sane reading of "tonight, 3am" at 23:59 is a few minutes from now, on the next calendar date');
  assert.equal(r.getHours(), 3);
});

test('nextRunAtLocal: crossing a month boundary lands on the 1st of the next month', () => {
  const now = new Date(2026, 0, 31, 23, 30, 0);
  const r = nextRunAtLocal(3, now);
  assert.equal(r.getMonth(), 1);
  assert.equal(r.getDate(), 1);
});

test('nextRunAtLocal: rejects an out-of-range or non-numeric hour', () => {
  for (const bad of [-1, 24, 24.5, NaN, 'три', null, undefined, {}]) {
    assert.throws(() => nextRunAtLocal(bad, new Date()), /hour must be an integer 0-23/);
  }
});

// --- resolveHour -----------------------------------------------------------------

test('resolveHour: bundles the resolved instant with its Russian-style labels', () => {
  const now = new Date(2026, 7, 20, 10, 0, 0);
  const r = resolveHour(14, now);
  assert.equal(r.hour, 14);
  assert.equal(r.dateLabel, '20.08.2026');
  assert.equal(r.hourLabel, '14:00');
  assert.equal(r.isWorking, true, '14:00 is inside the 08-19 working heuristic');
});

// --- scheduleChoices ---------------------------------------------------------

test('scheduleChoices: before the default hour, "tonight" is today and "tomorrow" is the next day', () => {
  const now = new Date(2026, 7, 20, 1, 0, 0);   // 01:00 — 03:00 hasn't happened yet
  const c = scheduleChoices(now);
  assert.equal(c.defaultHour, 3);
  assert.equal(c.tonight.dateLabel, '20.08.2026');
  assert.equal(c.tomorrow.dateLabel, '21.08.2026');
  assert.equal(c.tonight.hourLabel, '03:00');
  assert.equal(c.tomorrow.hourLabel, '03:00');
});

test('scheduleChoices: ATTACK — in the afternoon, "tonight" has already rolled to the next calendar date, and "tomorrow" is one day past THAT, never a second independent computation', () => {
  const now = new Date(2026, 7, 20, 14, 0, 0);   // 14:00 — today's 03:00 is long gone
  const c = scheduleChoices(now);
  assert.equal(c.tonight.dateLabel, '21.08.2026', '"tonight" already means tomorrow\'s calendar date by 14:00');
  assert.equal(c.tomorrow.dateLabel, '22.08.2026', 'tomorrow is exactly one day after whatever tonight resolved to');
  // Exactly 24h apart, not "some drift" — proves tomorrow was derived from
  // tonight.at (setDate), not from a second, independently-rounded nextRunAtLocal call.
  assert.equal(c.tomorrow.at.getTime() - c.tonight.at.getTime(), 24 * 60 * 60 * 1000);
});

test('scheduleChoices: a custom default hour is honoured (not hardcoded to 3 everywhere)', () => {
  const now = new Date(2026, 7, 20, 1, 0, 0);
  const c = scheduleChoices(now, 5);
  assert.equal(c.defaultHour, 5);
  assert.equal(c.tonight.hourLabel, '05:00');
});

// --- offerIsCurrent -----------------------------------------------------------

test('offerIsCurrent: true only when the offer names the version already running', () => {
  assert.equal(offerIsCurrent({ version: '2.4.0' }, '2.4.0'), true);
  assert.equal(offerIsCurrent({ version: '2.4.0' }, '2.3.0'), false);
  assert.equal(offerIsCurrent(null, '2.3.0'), false);
  assert.equal(offerIsCurrent({ version: '2.4.0' }, null), false);
});

// --- formatScheduled -----------------------------------------------------------

test('formatScheduled: the load-bearing confirmation sentence, date and hour spliced in', () => {
  const msg = formatScheduled({ hour: 3, scheduled_at: new Date(2026, 7, 21, 3, 0, 0).toISOString() });
  assert.equal(msg, 'Обновление установится 21.08.2026 в 03:00. Компьютер должен быть включён.');
  assert.match(msg, /Компьютер должен быть включён/, 'the load-bearing last sentence must be present');
});

test('formatScheduled: null when nothing is actually scheduled', () => {
  assert.equal(formatScheduled({ hour: null, scheduled_at: null }), null);
  assert.equal(formatScheduled({ hour: 3, scheduled_at: null }), null);
  assert.equal(formatScheduled({ hour: null, scheduled_at: '2026-08-21T03:00:00.000Z' }), null);
  assert.equal(formatScheduled(null), null);
  assert.equal(formatScheduled({ hour: 3, scheduled_at: 'not a date' }), null);
});

test('formatScheduled: hour 0 is a real value, not "missing" (Number(null)===0 trap)', () => {
  const msg = formatScheduled({ hour: 0, scheduled_at: new Date(2026, 7, 21, 0, 0, 0).toISOString() });
  assert.match(msg, /00:00/);
});

// --- updateOutcomeMessage -------------------------------------------------------

test('updateOutcomeMessage: a failed-and-rolled-back attempt is said plainly, with version and date', () => {
  const msg = updateOutcomeMessage({ version: '2.4.0', ok: false, at: '2026-08-21T02:10:00.000Z', db: 'untouched' }, '2.3.0');
  assert.equal(msg, 'Обновление до 2.4.0 не удалось 21.08.2026 — система вернулась к 2.3.0 и работает. Мы попробуем снова после следующего одобрения.');
});

test('updateOutcomeMessage: a restored database gets its own extra, explicit sentence', () => {
  const msg = updateOutcomeMessage({ version: '2.4.0', ok: false, at: '2026-08-21T02:10:00.000Z', db: 'restored' }, '2.3.0');
  assert.match(msg, /восстановлена из резервной копии/, 'a clinic must be told plainly when its DATA, not just the code, was rolled back');
});

test('updateOutcomeMessage: null for a successful last_result — that is whatsNewState\'s job, not this one\'s', () => {
  assert.equal(updateOutcomeMessage({ version: '2.4.0', ok: true }, '2.4.0'), null);
});

test('updateOutcomeMessage: null when there is no last_result at all, never throws', () => {
  assert.equal(updateOutcomeMessage(null, '2.3.0'), null);
  assert.equal(updateOutcomeMessage(undefined, '2.3.0'), null);
});

test('updateOutcomeMessage: a missing/unparseable `at` degrades to no date fragment, never "Invalid Date"', () => {
  const msg = updateOutcomeMessage({ version: '2.4.0', ok: false }, '2.3.0');
  assert.equal(msg, 'Обновление до 2.4.0 не удалось — система вернулась к 2.3.0 и работает. Мы попробуем снова после следующего одобрения.');
  assert.doesNotMatch(msg, /Invalid Date/);
});

test('updateOutcomeMessage: a missing currentVersion/failed version degrades to "?", never "undefined"', () => {
  const msg = updateOutcomeMessage({ ok: false }, null);
  assert.doesNotMatch(msg, /undefined/);
  assert.match(msg, /\?/);
});

// --- whatsNewState ---------------------------------------------------------------

test('whatsNewState: version changed and notes are cached — shows, with notes', () => {
  const s = whatsNewState('2.4.0', '2.3.0', { '2.4.0': 'Ускорен список чатов.' });
  assert.deepEqual(s, { show: true, version: '2.4.0', notes: 'Ускорен список чатов.' });
});

test('whatsNewState: version changed but no cached notes for it — still shows, notes null', () => {
  const s = whatsNewState('2.4.0', '2.3.0', {});
  assert.equal(s.show, true);
  assert.equal(s.notes, null);
});

test('whatsNewState: version unchanged — calm, no note', () => {
  const s = whatsNewState('2.3.0', '2.3.0', { '2.3.0': 'x' });
  assert.equal(s.show, false);
});

test('whatsNewState: no lastSeenVersion (first-ever run on this browser) — not shown', () => {
  const s = whatsNewState('2.3.0', null, {});
  assert.equal(s.show, false);
  assert.equal(s.version, '2.3.0', 'still reports the current version so the caller can start tracking it');
});

test('whatsNewState: no currentVersion at all — never throws, never shows', () => {
  assert.deepEqual(whatsNewState(null, '2.3.0', {}), { show: false, version: null, notes: null });
  assert.deepEqual(whatsNewState(undefined, undefined, undefined), { show: false, version: null, notes: null });
});

test('whatsNewState: a malformed notes map (array, string, null) never throws, degrades to no notes', () => {
  for (const bad of [null, undefined, [], 'x', 42]) {
    const s = whatsNewState('2.4.0', '2.3.0', bad);
    assert.equal(s.show, true);
    assert.equal(s.notes, null, `bad map ${JSON.stringify(bad)} must degrade to null notes, not throw`);
  }
});
