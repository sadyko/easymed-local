// LICENCE_CORE_V1 — how many days are left, and what the clinic should be told.
//
// Pure: no database, no clock, no files. Everything it needs is an argument, so
// every rung of the ladder is a one-line test instead of a fixture.
//
// The `reason` field exists for one reason, and it matters more than the rest of
// this file: a clinic that has paid, whose router died, must NEVER be shown a
// message about money. Same countdown, completely different words.

const DAY_MS = 24 * 60 * 60 * 1000;

const NOTICE_FROM = 7;   // days left when the quiet grey banner starts
const WARN_FROM   = 3;   // days left when it becomes a daily warning

/**
 * @param {object}  args
 * @param {string|null} args.validUntil    ISO date from the signed licence
 * @param {Date}        args.now           already passed through effectiveNow()
 * @param {string}      args.subscription  'active' | 'unpaid' — last known from the vendor
 * @returns {{state:'ok'|'notice'|'warn'|'locked', locked:boolean, daysLeft:number, reason:string}}
 */
export function ladderState({ validUntil, now, subscription = 'active' }) {
  const until = validUntil ? new Date(validUntil) : null;

  // An Invalid Date `now` must not silently unlock the app: every arithmetic
  // comparison against NaN is false, which would otherwise fall through every
  // "still has time" branch and land on the most permissive one. Catch it
  // explicitly and fail closed, the same as a missing licence.
  const nowMs = now instanceof Date ? now.getTime() : NaN;

  if (!until || Number.isNaN(until.getTime()) || Number.isNaN(nowMs)) {
    return { state: 'locked', locked: true, daysLeft: 0, reason: 'unlicensed' };
  }

  const msLeft = until.getTime() - nowMs;
  const daysLeft = Math.max(0, Math.ceil(msLeft / DAY_MS));
  // Only an explicit, known non-payment ('unpaid') gets the money wording.
  // Anything else — a healthy subscription, or a status we don't recognise
  // ('suspended', undefined, a typo from upstream) — defaults to 'offline'.
  // Wrongly telling a payer "you haven't paid" is the worse mistake, so the
  // money message is opt-in, never the fallback.
  const reason = subscription === 'unpaid' ? 'unpaid' : 'offline';

  if (msLeft <= 0)             return { state: 'locked', locked: true,  daysLeft: 0, reason };
  if (daysLeft <= WARN_FROM)   return { state: 'warn',   locked: false, daysLeft, reason };
  if (daysLeft <= NOTICE_FROM) return { state: 'notice', locked: false, daysLeft, reason };
  return { state: 'ok', locked: false, daysLeft, reason };
}
