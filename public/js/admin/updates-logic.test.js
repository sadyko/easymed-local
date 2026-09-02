import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRuDate, formatRuHour, isWorkingHour, isValidHour, nextRunAtLocal,
  resolveHour, scheduleChoices, offerIsCurrent, formatScheduled,
  updateOutcomeMessage, whatsNewState, pendingRestartMessage, compareVersions,
  fill, upToDateMessage, progressView, formatMb, PROGRESS_STALL_MS,
} from './updates-logic.js';

// UPDATES_I18N_V1 (2026-08-30) — the message functions no longer return a
// finished Russian string; they return {template, params(, extra)} so tr()
// can translate the WHOLE phrase before the version/date go back in. These
// helpers render a descriptor the way views/updates.js's say() does, so every
// assertion below still reads as the sentence a clinic sees.
const render = (msg) => (msg ? fill(msg.template, msg.params) + (msg.extra ? ' ' + msg.extra : '') : msg);

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
  const msg = render(formatScheduled({ hour: 3, scheduled_at: new Date(2026, 7, 21, 3, 0, 0).toISOString() }));
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
  const msg = render(formatScheduled({ hour: 0, scheduled_at: new Date(2026, 7, 21, 0, 0, 0).toISOString() }));
  assert.match(msg, /00:00/);
});

// --- updateOutcomeMessage -------------------------------------------------------

test('updateOutcomeMessage: a failed-and-rolled-back attempt is said plainly, with version and date', () => {
  const msg = render(updateOutcomeMessage({ version: '2.4.0', ok: false, at: '2026-08-21T02:10:00.000Z', db: 'untouched' }, '2.3.0'));
  assert.equal(msg, 'Обновление до 2.4.0 не удалось 21.08.2026 — система вернулась к 2.3.0 и работает. Мы попробуем снова после следующего одобрения.');
});

test('updateOutcomeMessage: a restored database gets its own extra, explicit sentence', () => {
  const msg = render(updateOutcomeMessage({ version: '2.4.0', ok: false, at: '2026-08-21T02:10:00.000Z', db: 'restored' }, '2.3.0'));
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
  const msg = render(updateOutcomeMessage({ version: '2.4.0', ok: false }, '2.3.0'));
  assert.equal(msg, 'Обновление до 2.4.0 не удалось — система вернулась к 2.3.0 и работает. Мы попробуем снова после следующего одобрения.');
  assert.doesNotMatch(msg, /Invalid Date/);
});

test('updateOutcomeMessage: a missing currentVersion/failed version degrades to "?", never "undefined"', () => {
  const msg = render(updateOutcomeMessage({ ok: false }, null));
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

// ── formatScheduled: the «Обновить сейчас» branch ───────────────────────────

test('formatScheduled: immediate consent says "устанавливается", never a wall-clock hour', () => {
  const msg = render(formatScheduled({ hour: null, scheduled_at: '2026-08-23T15:30:00.000Z', immediate: true }));
  assert.ok(msg.includes('устанавливается'));
  assert.ok(!msg.includes('в 15'));
});

test('formatScheduled: immediate WITHOUT scheduled_at is nothing scheduled — null, not a promise', () => {
  assert.equal(formatScheduled({ hour: null, scheduled_at: null, immediate: true }), null);
});

test('formatScheduled: hour-based consent unchanged by the new field defaulting off', () => {
  const msg = render(formatScheduled({ hour: 3, scheduled_at: '2026-08-24T03:00:00' }));
  assert.ok(msg.includes('03:00'));
});

// ── pendingRestartMessage: installed but not yet running ────────────────────

test('pendingRestartMessage: a newer version applied while the old one still runs asks for a window restart', () => {
  const msg = render(pendingRestartMessage({ ok: true, version: '0.3.2' }, '0.3.1'));
  assert.ok(msg.includes('0.3.2'));
  assert.ok(msg.includes('закройте окно Easy-Med'));
});

test('pendingRestartMessage: nothing to say once the running version caught up', () => {
  assert.equal(pendingRestartMessage({ ok: true, version: '0.3.2' }, '0.3.2'), null);
});

test('pendingRestartMessage: a STALE result the clinic has moved past never claims a restart is pending', () => {
  // The 0.2.2 result file can outlive several updates; running 0.3.1 already
  // includes it. Requiring strictly-newer is what stops a permanent nag.
  assert.equal(pendingRestartMessage({ ok: true, version: '0.2.2' }, '0.3.1'), null);
});

test('pendingRestartMessage: a FAILED result is updateOutcomeMessage’s job, not this one’s', () => {
  assert.equal(pendingRestartMessage({ ok: false, version: '0.3.2' }, '0.3.1'), null);
});

test('pendingRestartMessage: missing/garbage input is silent, never a thrown error on the screen', () => {
  assert.equal(pendingRestartMessage(null, '0.3.1'), null);
  assert.equal(pendingRestartMessage({ ok: true }, '0.3.1'), null);
  assert.equal(pendingRestartMessage({ ok: true, version: '0.3.2' }, null), null);
});

test('compareVersions: numeric per segment — 0.10.0 is newer than 0.9.0, which a string compare gets backwards', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('0.3.1', '0.3.2') < 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

// ── upToDateMessage — THE line from the owner's 2026-08-29 screenshot ───────

test('upToDateMessage: the version is a {version} hole in one whole phrase, never concatenated on', () => {
  const m = upToDateMessage('0.4.5');
  assert.equal(m.template, 'У вас последняя версия — {version}.');
  assert.deepEqual(m.params, { version: '0.4.5' });
  assert.equal(render(m), 'У вас последняя версия — 0.4.5.');
  // The whole point: the SAME template translated first still reads correctly.
  assert.equal(fill('Sizda eng soʻnggi versiya — {version}.', m.params), 'Sizda eng soʻnggi versiya — 0.4.5.');
});

test('upToDateMessage: no version yet — a different whole phrase, never "версия —  ."', () => {
  const m = upToDateMessage(null);
  assert.equal(render(m), 'У вас последняя версия.');
  assert.doesNotMatch(render(m), /—/);
});

// ── formatMb ────────────────────────────────────────────────────────────────

test('formatMb: megabytes with one decimal, and a dot — no locale-specific comma to get wrong in three languages', () => {
  assert.equal(formatMb(0), '0.0');
  assert.equal(formatMb(1024 * 1024), '1.0');
  assert.equal(formatMb(40 * 1024 * 1024), '40.0');
  assert.equal(formatMb(1536 * 1024), '1.5');
});

test('formatMb: garbage never becomes NaN on a clinic screen', () => {
  for (const bad of [null, undefined, 'x', -5, NaN]) assert.equal(formatMb(bad), '0.0', `bytes=${JSON.stringify(bad)}`);
});

// ── progressView — UPDATE_PROGRESS_V1 ──────────────────────────────────────

test('progressView: nothing to say when there is no record, or a malformed one', () => {
  for (const bad of [null, undefined, {}, [], 'x', 42, { phase: null }]) {
    assert.equal(progressView(bad).show, false, `record=${JSON.stringify(bad)}`);
  }
});

test('progressView: downloading with a Content-Length gives a real percentage and both byte counts', () => {
  const v = progressView({ version: '0.4.6', phase: 'downloading', bytes: 10 * 1024 * 1024, total: 40 * 1024 * 1024, age_ms: 500 });
  assert.equal(v.show, true);
  assert.equal(v.tone, 'busy');
  assert.equal(v.percent, 25);
  assert.equal(render(v.detail), 'Загружено 10.0 МБ из 40.0 МБ');
  assert.equal(render(v.title), 'Устанавливается обновление 0.4.6');
});

test('progressView: NO Content-Length — an honest byte count and NO percentage, never an invented bar', () => {
  const v = progressView({ version: '0.4.6', phase: 'downloading', bytes: 3 * 1024 * 1024, total: null, age_ms: 500 });
  assert.equal(v.percent, null, 'a percentage of an unknown whole cannot exist and must not be shown');
  assert.equal(render(v.detail), 'Загружено 3.0 МБ');
});

test('progressView: a Content-Length that undercounts what actually arrived is clamped, never 143%', () => {
  const v = progressView({ version: '0.4.6', phase: 'downloading', bytes: 60 * 1024 * 1024, total: 40 * 1024 * 1024, age_ms: 0 });
  assert.equal(v.percent, 100);
});

test('progressView: each later phase says what it is doing, as one complete sentence', () => {
  const expect = {
    verifying: 'Проверка подписи обновления…',
    unpacking: 'Распаковка файлов…',
    snapshot: 'Резервная копия базы данных…',
    switching: 'Переключение на новую версию…',
  };
  for (const [phase, sentence] of Object.entries(expect)) {
    const v = progressView({ version: '0.4.6', phase, bytes: 0, total: null, age_ms: 0 });
    assert.equal(v.show, true, phase);
    assert.equal(render(v.detail), sentence);
    assert.equal(v.percent, null, `${phase} has no percentage to show`);
  }
});

test('progressView: THE owner question — a stalled download is told apart from a slow one', () => {
  const slow = progressView({ version: '0.4.6', phase: 'downloading', bytes: 1024, total: null, age_ms: 5000 });
  assert.equal(slow.stalled, false);
  assert.equal(slow.note, null);
  assert.equal(slow.tone, 'busy');

  const stuck = progressView({ version: '0.4.6', phase: 'downloading', bytes: 1024, total: null, age_ms: PROGRESS_STALL_MS + 1 });
  assert.equal(stuck.stalled, true);
  assert.equal(stuck.tone, 'warn');
  assert.match(render(stuck.note), /возможно, пропала связь/);
  // Still says how far it got: "stuck at 0.0 MB" and "stuck at 39 of 40" are
  // very different problems to whoever has to act on it.
  assert.match(render(stuck.detail), /Загружено/);
});

test('progressView: a record with no age_ms at all is never called stalled on a guess', () => {
  const v = progressView({ version: '0.4.6', phase: 'downloading', bytes: 1024, total: null });
  assert.equal(v.stalled, false);
});

test('progressView: an interrupted record (a restart killed the install) says so instead of freezing at 40%', () => {
  const v = progressView({ version: '0.4.6', phase: 'interrupted', bytes: 16 * 1024 * 1024, total: 40 * 1024 * 1024, age_ms: 60 * 60 * 1000 });
  assert.equal(v.show, true);
  assert.equal(v.tone, 'warn');
  assert.equal(v.percent, null, 'a dead download must not keep showing a bar');
  assert.equal(render(v.title), 'Обновление 0.4.6 не завершилось');
  assert.match(render(v.note), /прервалась/);
});

// UPDATE_FAILURE_REASON_V1 - the note names the actual cause.
//
// Раньше здесь проверялось слово «интернет» — и оно печаталось на ВСЕ
// одиннадцать причин отказа. Владелец 2026-09-02 читал совет проверить
// интернет на машине, которая в ту же минуту ходила на сервер каждую минуту:
// совет, который нельзя выполнить, отправляет чинить исправное.
test('progressView: a failed download names the real cause, and shows no bar', () => {
  const v = progressView({ version: '0.4.6', phase: 'failed', reason: 'network', bytes: 0, total: null, age_ms: 1000 });
  assert.equal(v.tone, 'warn');
  assert.equal(v.percent, null);
  assert.match(render(v.note), /связь прервалась/);
});

test('progressView: a full disk is not blamed on the internet', () => {
  const v = progressView({ version: '0.4.6', phase: 'failed', reason: 'disk', bytes: 0, total: null, age_ms: 1000 });
  const note = render(v.note);
  assert.match(note, /места/, 'сказано про место на диске: ' + note);
  assert.doesNotMatch(note, /интернет/, 'и НЕ предложено чинить исправную сеть');
});

test('progressView: a refused bundle tells the clinic to call Easy-Med, not to check cables', () => {
  const v = progressView({ version: '0.4.6', phase: 'failed', reason: 'bundle_refused', bytes: 0, total: null, age_ms: 1000 });
  const note = render(v.note);
  assert.match(note, /подлинности/);
  assert.match(note, /Easy-Med/, 'это не чинится в клинике: ' + note);
});

test('progressView: an unrecognised reason falls back instead of inventing one', () => {
  const v = progressView({ version: '0.4.6', phase: 'failed', reason: 'something_new', bytes: 0, total: null, age_ms: 1000 });
  const note = render(v.note);
  assert.match(note, /Не удалось установить обновление/);
  assert.doesNotMatch(note, /интернет|диск/, 'выдумывать причину опаснее, чем признать, что её не знаем');
});

test('progressView: an unknown phase from a newer server says nothing rather than something wrong', () => {
  assert.equal(progressView({ version: '9.9.9', phase: 'teleporting', bytes: 0, age_ms: 0 }).show, false);
});
