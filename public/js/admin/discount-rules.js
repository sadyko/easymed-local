// DISCOUNT_RULES_V1 — which of the clinic's discounts (patient_discounts) a
// given patient can use today, on a given смета, and how much one is worth.
//
// Owner (2026-09-14): «discounts: the expiration date / apply to the selected
// group / apply to the selected services / apply until. also the discounts can
// be available as a dropdown». Pure functions, shared by both wizards
// (visit-wizard.js and service-picker-modal.js) so the two never disagree on
// whether a discount applies. No DOM, no network.
//
// A discount row: { id, name, kind, percent, amount, active, valid_from,
// valid_until, category_id, service_ids: number[] }. Empty/absent limits mean
// «no limit» — exactly how the settings editor labels them.

/** 'YYYY-MM-DD' of a local Date — the clinic's calendar day. */
export function localYmd(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function serviceScope(row) {
    const ids = Array.isArray(row && row.service_ids) ? row.service_ids : [];
    return ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Why a discount does NOT apply — or '' when it does.
 * @param {object} row       patient_discounts row
 * @param {object} ctx       { today: 'YYYY-MM-DD', categoryId: number|null, serviceIds: number[] }
 */
export function discountBlockReason(row, ctx = {}) {
    if (!row) return 'missing';
    if (row.active === 0 || row.active === false) return 'inactive';
    const today = ctx.today || localYmd();
    const from = String(row.valid_from || '').slice(0, 10);
    const until = String(row.valid_until || '').slice(0, 10);
    if (from && from > today) return 'not_yet';
    if (until && until < today) return 'expired';
    if (row.category_id != null && row.category_id !== '' && Number(row.category_id) !== Number(ctx.categoryId)) return 'other_group';
    const scope = serviceScope(row);
    if (scope.length) {
        const cart = (ctx.serviceIds || []).map(Number);
        if (!scope.some((id) => cart.includes(id))) return 'no_matching_service';
    }
    return '';
}

export function discountEligible(row, ctx) {
    return discountBlockReason(row, ctx) === '';
}

/** The rows a patient may pick from today, in the settings' order. */
export function eligibleDiscounts(rows, ctx) {
    return (rows || []).filter((r) => discountEligible(r, ctx));
}

/**
 * The money a discount takes off. `lines` are { service_id, total } (already
 * after the loyalty discount when the caller wants it so). A scoped discount
 * counts only its services; a percent is of that base, an amount is capped by
 * it. Rounded to whole сум.
 */
export function discountValue(row, lines) {
    if (!row) return 0;
    const scope = serviceScope(row);
    const base = (lines || []).reduce((s, l) => {
        if (scope.length && !scope.includes(Number(l && l.service_id))) return s;
        return s + Math.max(0, Number((l && l.total) || 0));
    }, 0);
    if (base <= 0) return 0;
    const pct = Number(row.percent) || 0;
    if (pct > 0) return Math.round(base * Math.min(100, pct) / 100);
    const amount = Number(row.amount) || 0;
    return Math.round(Math.min(base, Math.max(0, amount)));
}

/**
 * Parts of a dropdown option: the name, the value («−10%» / «−50 000») and
 * whether the discount is limited to some services. The view glues them with
 * its own translated word for the scope — this module carries no UI text.
 */
export function discountOptionParts(row, fmtMoney) {
    const pct = Number(row && row.percent) || 0;
    const amount = Number(row && row.amount) || 0;
    const value = pct > 0 ? `−${pct}%` : (amount > 0 ? '−' + (typeof fmtMoney === 'function' ? fmtMoney(amount) : String(amount)) : '');
    return { name: (row && row.name) || '', value, scoped: serviceScope(row).length > 0 };
}
