// VISIT_TIER_PRICING_V1 — which price a service costs THIS time for THIS
// patient: first visit, second visit inside the window, or a repeat.
//
// Owner (2026-09-14): «in the first visit there can be 200000 sum and for
// second visit of this service can be 60000 if patient comes between 1-6 days
// and repeat visit is for example free».
//
// The rule, stated once and cited from every caller (the wizard's quote, the
// doctor's own «add service», the cashier's invoice):
//   • a service with no tier prices at all is priced the old way — one price;
//   • no earlier visit of this service for this patient → PRIMARY;
//   • the earlier visit is counted from its calendar day; if today falls
//     outside the window of days after it, the chain is broken → PRIMARY
//     again («пришёл позже окна — заново»);
//   • the previous line was primary → the candidate is SECONDARY and the
//     window is [secondary_days_from … secondary_days_to]; it was already
//     secondary or repeat → the candidate is REPEAT (third and later) and the
//     window is [repeat_days_from … repeat_days_to] when the service sets
//     either bound (REPEAT_WINDOW_V1, mig 130), else the second-visit window
//     as before;
//   • a tier the service does not price falls back to the nearest one that
//     exists: no repeat price → the secondary price again; no secondary price
//     but a repeat one → straight to repeat; neither → primary.
//
// Pure: takes the service row and the previous line, returns the decision.
// Day arithmetic is on calendar dates in the CLINIC's local time, never on
// timestamps — a visit at 23:50 and the next at 00:10 are one day apart.

export const TIERS = ['primary', 'secondary', 'repeat'];

/** True when the service has at least one tier price configured. */
export function hasTiers(service) {
  return !!service && (numOrNull(service.price_secondary) !== null || numOrNull(service.price_repeat) !== null);
}

export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The window of days (after the previous visit) in which `tier` still counts:
 * { from, to } — `from` defaults to 1 (the next calendar day), `to` null means
 * no upper limit. REPEAT_WINDOW_V1: the repeat tier has its own window when
 * the service sets either bound; otherwise it shares the second-visit window.
 */
export function windowFor(service, tier) {
  let from = numOrNull(service && service.secondary_days_from);
  let to = numOrNull(service && service.secondary_days_to);
  if (tier === 'repeat') {
    const rf = numOrNull(service && service.repeat_days_from);
    const rt = numOrNull(service && service.repeat_days_to);
    if (rf !== null || rt !== null) { from = rf; to = rt; }
  }
  return { from: from === null ? 1 : Math.max(0, Math.floor(from)), to: to === null ? null : Math.floor(to) };
}

/** Whole days from `fromYmd` to `toYmd` ('YYYY-MM-DD' each); negative when reversed. */
export function daysBetween(fromYmd, toYmd) {
  const a = Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(5, 7) - 1, +fromYmd.slice(8, 10));
  const b = Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(5, 7) - 1, +toYmd.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/**
 * The price for a given tier on this service — with the fallbacks above.
 * Returns { tier, price } where `tier` is the tier actually applied.
 */
export function priceForTier(service, wanted) {
  const base = numOrNull(service.price) ?? 0;
  const secondary = numOrNull(service.price_secondary);
  const repeat = numOrNull(service.price_repeat);
  if (wanted === 'repeat') {
    if (repeat !== null) return { tier: 'repeat', price: repeat };
    if (secondary !== null) return { tier: 'secondary', price: secondary };
    return { tier: 'primary', price: base };
  }
  if (wanted === 'secondary') {
    if (secondary !== null) return { tier: 'secondary', price: secondary };
    if (repeat !== null) return { tier: 'repeat', price: repeat };
    return { tier: 'primary', price: base };
  }
  return { tier: 'primary', price: base };
}

/**
 * Decide the tier for a new line.
 * @param {object} service   services row (price, price_secondary, secondary_days_from/to, price_repeat)
 * @param {{day:string, tier?:string}|null} prev  the patient's most recent earlier line of this
 *        service: its local calendar day and the tier it was billed at (null/'' = primary)
 * @param {string} todayYmd  the clinic's local date for the new line
 * @returns {{tier:string, price:number, base_price:number, days_since:number|null, reason:string}}
 */
export function tierFor(service, prev, todayYmd) {
  const base = numOrNull(service && service.price) ?? 0;
  const out = (tier, price, days, reason) => ({ tier, price, base_price: base, days_since: days, reason });
  if (!hasTiers(service)) return out('primary', base, null, 'no_tiers');
  if (!prev || !prev.day) return out('primary', base, null, 'first');

  const days = daysBetween(prev.day, todayYmd);
  const prevTier = prev.tier === 'secondary' || prev.tier === 'repeat' ? prev.tier : 'primary';
  const wanted = prevTier === 'primary' ? 'secondary' : 'repeat';
  const { from, to } = windowFor(service, wanted);
  if (days < from) return out('primary', base, days, 'too_soon');
  if (to !== null && days > to) return out('primary', base, days, 'window_passed');

  const r = priceForTier(service, wanted);
  return out(r.tier, r.price, days, 'in_window');
}

/**
 * The line's unit price once its tier is known — used by the cashier when it
 * builds the invoice from stored lines. A line billed at a tier the service no
 * longer prices falls back the same way tierFor would.
 */
export function tierUnitPrice(service, tier, fallback) {
  if (tier !== 'secondary' && tier !== 'repeat') return fallback;
  if (!hasTiers(service)) return fallback;
  return priceForTier(service, tier).price;
}
