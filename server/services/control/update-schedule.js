// UPDATE_DELIVERY_V1 (docs/plans/2026-08-20-update-delivery.md, Task 4) — pure
// scheduling decisions for the clinic-chosen install window.
//
// THE RULE THAT OUTRANKS EVERYTHING HERE: the clinic picks the hour, and the
// vendor never overrides it — there is no fixed 03:00, and nothing in this
// file may reach for the real clock or the network. Every function takes
// `now` as an argument so the caller (updater.js, its tests, and the RPC
// layer) controls time completely; that is what makes "test around midnight
// boundaries with injected clocks, not the real one" possible at all.
//
// Everything here operates on the HOST'S LOCAL time (Date's local getters/
// setters), never UTC — "03:00" means three in the morning where the clinic
// physically is, not an instant fixed at build time. A stored `scheduled_at`
// is therefore only ever compared against a local `now` on the SAME machine;
// it is never shipped anywhere that would reinterpret it in another zone.

/** Width of the install window. Miss it — the PC was off, asleep, whatever — and it waits for the next occurrence. */
export const WINDOW_MS = 60 * 60 * 1000;

/**
 * The next moment `hour:00` local time occurs, at or after `now`.
 *
 * "Today if still ahead" — if today's occurrence of that hour has not
 * happened yet, use today; otherwise roll to tomorrow. The comparison is
 * strict (`>`), not `>=`: the boundary instant itself (now landing exactly on
 * today's hour, to the millisecond) is treated as "already arrived" rather
 * than "still ahead", so this function never hands back a moment that is
 * not, even by one tick, in the future relative to when it was asked. In
 * practice this only matters at the exact millisecond of the hour, which a
 * human clicking "approve" will never hit — it is decided here, once, rather
 * than left as an unstated assumption a future caller could get wrong.
 *
 * @param {number} hour  0-23, local
 * @param {Date} [now]
 * @returns {Date}
 */
export function nextRunAt(hour, now = new Date()) {
  // Number(null) is 0 and Number('') is also 0 — both would otherwise pass
  // Number.isInteger() and silently schedule hour 0 for a caller that passed
  // nothing at all. Only a real number, or a non-blank numeric string (the
  // shape an hour picker's form field arrives as), is coerced; everything
  // else becomes NaN and is refused below by the same range check.
  const h = typeof hour === 'number'
    ? hour
    : (typeof hour === 'string' && hour.trim() !== '' ? Number(hour) : NaN);
  if (!Number.isInteger(h) || h < 0 || h > 23) {
    throw new Error(`hour must be an integer 0-23, got ${JSON.stringify(hour)}`);
  }
  // Built from now's own local Y/M/D — never `now`'s UTC fields — so a
  // clinic in any timezone gets ITS midnight-to-midnight, not the server's.
  const todayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0, 0);
  if (todayAt.getTime() > now.getTime()) return todayAt;

  // setDate (not "+24h in milliseconds") deliberately: a spring-forward DST
  // transition skips an hour of wall-clock time, so adding exactly 86400000ms
  // to a Date can land on the WRONG hour after the jump. setDate asks the
  // engine for "the same local wall-clock time, one calendar day later",
  // which is what "tomorrow night" means to a clinic manager and is exactly
  // what the JS Date/timezone machinery is designed to get right.
  const tomorrowAt = new Date(todayAt.getTime());
  tomorrowAt.setDate(tomorrowAt.getDate() + 1);
  return tomorrowAt;
}

/**
 * Is `now` inside the one-hour install window that started at `scheduledAt`?
 *
 * Inclusive of the start, exclusive of the end (`[scheduledAt, +1h)`) — the
 * instant the window opens counts as "in it"; the instant it would close
 * does not, so a window never overlaps the next day's if someone chose an
 * hour close to another approval.
 *
 * A malformed `scheduledAt` (missing, unparseable) answers `false` rather
 * than throwing: this is read back from disk by updater.js on every tick,
 * and a corrupt or hand-edited value must never crash the timer loop — it
 * must just mean "nothing to do right now", exactly like every other
 * defensive parse in this codebase (clock.js's own `isValidDate` guard is
 * the same idea).
 *
 * @param {Date|string} scheduledAt
 * @param {Date} [now]
 */
export function isInWindow(scheduledAt, now = new Date()) {
  const sched = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(sched.getTime())) return false;
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) return false;
  const t = nowDate.getTime();
  return t >= sched.getTime() && t < sched.getTime() + WINDOW_MS;
}

/**
 * Does a stored consent record still speak to the offer currently on file?
 *
 * Consent names a VERSION, not "whatever the vendor offers next" — the shape
 * is `{version, approved_by, approved_at, hour}` (updates.js writes it,
 * updater.js reads it back). If the control plane replaces the offer with a
 * newer release after an admin approved the old one, that approval must not
 * silently carry over: nobody consented to THIS bundle, only to the one they
 * saw notes_ru for. Both update_status (so the approval screen shows
 * "not approved" the moment the offer changes underneath it) and
 * tickUpdater (so the install pipeline never runs off a stale consent) ask
 * this same question, which is why it lives here rather than being
 * duplicated in each caller.
 *
 * @param {object|null} offer
 * @param {object|null} consent
 */
export function consentAppliesTo(offer, consent) {
  if (!offer || typeof offer !== 'object') return false;
  if (!consent || typeof consent !== 'object') return false;
  return typeof offer.version === 'string' && offer.version.length > 0 && consent.version === offer.version;
}
