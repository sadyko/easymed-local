// VISIT_TIER_PRICING_V1 — the screen's side of «цена по счёту визита»: pure
// helpers for the booking wizard's смета and the doctor's «добавить услугу».
//
// The RULE lives on the server (server/services/domain/visit-tier.js) and is
// asked through service_price_quote; this module only carries the answer onto
// cart lines and names the tier in words. No second implementation of the
// window arithmetic here — a screen that guessed would disagree with the till.

const TIER_LABELS = {
    secondary: 'Второй визит',
    repeat:    'Повторный визит',
};

/** Tier word for a chip next to the price; '' for a first visit (nothing to say). */
export function tierLabel(tier) {
    return TIER_LABELS[tier] || '';
}

/** True when the quote lowers or changes the price against the catalog — worth a chip. */
export function tierApplies(quote) {
    return !!quote && (quote.tier === 'secondary' || quote.tier === 'repeat');
}

/**
 * Which cart lines can be quoted: real catalog services (not consultation
 * pseudo-services, which are priced per doctor) — deduplicated ids.
 */
export function quotableIds(items) {
    const ids = [];
    for (const a of items || []) {
        const s = a && a.service;
        if (!s || s.__consult || s.id == null) continue;
        const id = Number(s.id);
        if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

/**
 * Put the quotes onto the cart. Each quoted line gets `tier` (the quote) and
 * its service price replaced by the quoted one; the catalog price is kept in
 * `__base_price` so detaching the patient can restore it. Lines the answer
 * does not mention are left as they are. Returns the number of lines whose
 * price changed.
 */
export function applyQuotes(items, quotes) {
    let changed = 0;
    for (const a of items || []) {
        const s = a && a.service;
        if (!s || s.__consult || s.id == null) continue;
        const q = quotes && quotes[s.id];
        if (!q) continue;
        const base = s.__base_price != null ? Number(s.__base_price) : Number(s.price || 0);
        const next = Number(q.price);
        if (!Number.isFinite(next)) continue;
        a.tier = { tier: q.tier, price: next, base_price: base, days_since: q.days_since ?? null, prev_day: q.prev_day || null };
        if (Number(s.price || 0) !== next) changed++;
        a.service = { ...s, price: next, __base_price: base };
    }
    return changed;
}

/** Undo applyQuotes — the patient was detached, prices are catalog prices again. */
export function resetQuotes(items) {
    for (const a of items || []) {
        const s = a && a.service;
        if (!s || s.__base_price == null) { if (a) delete a.tier; continue; }
        a.service = { ...s, price: Number(s.__base_price) };
        delete a.service.__base_price;
        delete a.tier;
    }
}

/** The value to store on the line: the tier word, or null for a first visit / no quote. */
export function priceTierOf(item) {
    const t = item && item.tier && item.tier.tier;
    return t === 'secondary' || t === 'repeat' ? t : (t === 'primary' ? 'primary' : null);
}

// SVC_TIER_COLUMN_V1 (2026-09-14) — owner: «add into the settings of the
// services the secondary visit until (show in the days)» and «repeat days, it
// should have the range too». The catalogue column needs each window in words;
// the numbers are the service's own, the defaults are the server rule's
// (visit-tier.js windowFor: from unset → 1, to unset → no limit; the repeat
// tier without its own bounds shares the second-visit window).
const numOrNull = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

/** True when the service prices a second or repeat visit at all. */
export function hasTierPrices(service) {
    return !!service && (numOrNull(service.price_secondary) !== null || numOrNull(service.price_repeat) !== null);
}

/** The window for `tier` ('secondary' | 'repeat') as {from, to}; mirrors the server's windowFor. */
export function tierWindow(service, tier) {
    let from = numOrNull(service && service.secondary_days_from);
    let to = numOrNull(service && service.secondary_days_to);
    if (tier === 'repeat') {
        const rf = numOrNull(service && service.repeat_days_from);
        const rt = numOrNull(service && service.repeat_days_to);
        if (rf !== null || rt !== null) { from = rf; to = rt; }
    }
    return { from: from === null ? 1 : Math.max(0, Math.floor(from)), to: to === null ? null : Math.floor(to) };
}

/**
 * Window in words for a list cell: 'to' when only the upper bound matters
 * («до 6 дн.»), 'range' for both («2–6 дн.»), 'from' when open-ended («от 1 дн.»).
 * Returns null for a service without tier prices — nothing to show.
 */
export function tierWindowParts(service, tier = 'secondary') {
    if (!hasTierPrices(service)) return null;
    const { from, to } = tierWindow(service, tier);
    if (to === null) return { kind: 'from', from, to };
    if (from <= 1) return { kind: 'to', from, to };
    return { kind: 'range', from, to };
}
