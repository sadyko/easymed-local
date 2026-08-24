// TELEPHONY_V1 (docs/plans/2026-08-23-binotel-telephony.md, Task 2) — every
// display/validation DECISION behind Settings → «Телефония»
// (views/telephony-settings.js), as pure functions: no DOM, no clock of their
// own, no network — the same contract as system-logic.js next door, and for
// the same reason: these are the parts worth unit-testing without a fake DOM
// (see telephony-logic.test.js).
//
// The server side (server/services/telephony/ + the four RPCs) is being built
// in parallel to the SAME plan, so every function here treats its input as
// possibly-thinner than the contract promises: a missing timestamp, a call
// row without numbers, a disposition nobody taught it — all degrade to an
// em-dash or a calm fallback, never a throw and never "undefined" on a
// clinic's screen.
//
// Labels are static Russian literals: they render through h(), whose
// text-child path runs tr(), so the ru/uz/en entries live in i18n-strings.js.

import { formatRuDateTime, DASH } from './system-logic.js';
// TELEPHONY_ROUTING_V1 — «15 звонков» needs a Russian plural form, and this
// codebase has exactly ONE (1 анализ / 2 анализа / 5 анализов). Re-exported,
// not re-implemented: views/patient-card.js already keeps a private copy and
// that is the wart, not the pattern — the server itself imports a browser
// helper (crm-phone-match.js in crm/lead-from-call.js) rather than owning a
// second version of a rule. lab-grouping.js is pure: no DOM, no network.
import { pluralRu } from './views/lab-grouping.js';

export { DASH, pluralRu };

function pad2(n) { return String(n).padStart(2, '0'); }

/** Non-empty string → itself; everything else → em-dash. The RPC contract says "render absent fields as an em-dash". */
export function textOrDash(v) {
    return (typeof v === 'string' && v.trim() !== '') ? v : DASH;
}

/**
 * The secret input's placeholder. The secret NEVER travels to the browser —
 * the RPC only says api_secret_set true/false (same posture as the Telegram
 * token's token_hint) — so the placeholder is the only place the admin learns
 * whether one is stored without seeing it.
 */
export function secretPlaceholder(secretSet) {
    return secretSet
        ? 'сохранён — введите новый, чтобы заменить'
        : 'secret из письма Binotel';
}

/**
 * billsec/waitsec → «м:сс» (2:14, 0:42 — the shape the call-center screens
 * already use). Minutes are not padded: a clinic reads "2:14", not "02:14",
 * and hour-long calls simply keep counting minutes (61:05) rather than
 * switching format mid-table. Garbage/negative/missing → em-dash, never
 * "NaN:NaN" — the parallel-built server may omit the field entirely.
 */
export function formatDuration(sec) {
    const v = typeof sec === 'number' ? sec
        : (typeof sec === 'string' && sec.trim() !== '' ? Number(sec) : NaN);
    if (!Number.isFinite(v) || v < 0) return DASH;
    const total = Math.floor(v);
    return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

// Binotel's documented disposition vocabulary → human Russian words. ONLINE
// is a call still in progress (it appears when a webhook lands before the
// call ends). Kept UPPER-CASE-keyed exactly as the API sends them.
const DISPOSITION_LABELS = {
    ANSWER:   'Отвечен',
    TRANSFER: 'Переведён',
    // NOT the bare «Занято»: that source string is already in i18n-strings.js
    // as the bed-board's "Occupied", and tr() is keyed by the source string —
    // a busy phone line would translate as an occupied bed in EN/UZ.
    BUSY:     'Абонент занят',
    NOANSWER: 'Без ответа',
    CANCEL:   'Отменён',
    ONLINE:   'Идёт разговор',
    VM:       'Голосовая почта',
};

/**
 * disposition → label. An UNKNOWN disposition shows its raw string rather
 * than the em-dash: Binotel may add a vocabulary word this client has not
 * learned, and the raw word ("CONGESTION") at least identifies the outcome,
 * while an em-dash would hide information the admin can act on. Lookup is
 * case-insensitive because the docs show upper-case but a proxy or a future
 * API version may not preserve it.
 */
export function dispositionLabel(d) {
    if (typeof d !== 'string' || d.trim() === '') return DASH;
    return DISPOSITION_LABELS[d.trim().toUpperCase()] || d;
}

/**
 * Binotel callType (0 = incoming, 1 = outgoing; sometimes a numeric string)
 * → the icon + word the table renders. The icons are icons.js's PhoneIn /
 * PhoneOut — they carry the direction arrow the plan asks for. Unknown →
 * a plain Phone icon and an em-dash, never a wrong direction.
 */
export function callDirection(callType) {
    const v = typeof callType === 'number' ? callType
        : (typeof callType === 'string' && callType.trim() !== '' ? Number(callType) : NaN);
    if (v === 0) return { icon: 'PhoneIn',  label: 'Входящий' };
    if (v === 1) return { icon: 'PhoneOut', label: 'Исходящий' };
    return { icon: 'Phone', label: DASH };
}

/**
 * The poll-interval rule: a whole number of seconds, minimum 10 (the
 * migration's own floor — polling Binotel more often than that is abuse of
 * their API and of the clinic's uplink). Returns the integer, or null when
 * the input must not be saved. Null — not a clamped value: silently turning
 * "5" into 10 would save something the admin did not type.
 */
export function normalizeInterval(input) {
    const s = typeof input === 'string' ? input.trim() : input;
    if (s === '' || s == null || typeof s === 'boolean') return null;
    const v = Number(s);
    if (!Number.isInteger(v) || v < 10) return null;
    return v;
}

/**
 * public_base_url → the exact URL the clinic gives Binotel support, or null
 * when it cannot be built. Requires an absolute http(s) origin: Binotel's
 * servers dial this from THEIR network, so a bare hostname or a LAN path
 * would produce a URL that looks right and never receives a single request —
 * better no URL and the hint to fill the field in.
 */
export function webhookUrl(publicBaseUrl) {
    if (typeof publicBaseUrl !== 'string') return null;
    const base = publicBaseUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(base)) return null;
    return base + '/api/telephony/binotel';
}

/**
 * Timestamp → «DD.MM.YYYY HH:mm» or em-dash. Accepts what the parallel
 * server may realistically store: unix SECONDS (Binotel's own startTime
 * unit), unix milliseconds, or an ISO string. The 1e12 split tells them
 * apart: unix seconds stay below it until the year 33658, milliseconds
 * crossed it in 2001 — no live call can sit in the ambiguous band.
 */
export function timeLabel(v) {
    let x = v;
    if (typeof x === 'string' && x.trim() !== '' && /^\d+$/.test(x.trim())) x = Number(x.trim());
    if (typeof x === 'number') {
        // 0 and negatives are "no timestamp", not January 1970 — Date would
        // happily render them and the table would claim a call before the
        // clinic existed.
        if (!Number.isFinite(x) || x <= 0) return DASH;
        if (x < 1e12) x = x * 1000;
    }
    return formatRuDateTime(x) || DASH;
}

/**
 * Is this RPC error the "server is older than this screen" case? The rpc
 * route answers 501 {code:'rpc_not_implemented'} for a name it has no
 * handler for — which is exactly what happens while the parallel server task
 * is unmerged. The screen must show a calm «недоступно» line for it, never
 * crash. The message fallback catches the shim's own 'RPC failed (501)'
 * wording, produced when the 501 body was not JSON.
 */
export function isNotImplemented(error) {
    if (!error) return false;
    if (error.code === 'rpc_not_implemented') return true;
    return /\(501\)/.test(String(error.message || ''));
}

/**
 * telephony_recent_calls' reply → at most 20 safe display rows. The contract
 * promises {calls:[...]}, but a bare array is accepted too, and anything
 * else — including the {} an older server answers — degrades to an empty
 * list. Every display decision (time, direction, duration, disposition,
 * dashes) is made HERE so the view stays DOM-only; patient_id/patient_name
 * pass through untouched for the card link (name only when it is a real
 * non-empty string — the RPC marks it optional).
 */
export function shapeCalls(data) {
    const arr = Array.isArray(data) ? data
        : (data && Array.isArray(data.calls)) ? data.calls
            : [];
    return arr
        .filter((r) => r && typeof r === 'object')
        .slice(0, 20)
        .map((r) => ({
            time:        timeLabel(r.started_at),
            direction:   callDirection(r.call_type),
            external:    textOrDash(r.external_number),
            internal:    textOrDash(r.internal_number),
            duration:    formatDuration(r.billsec),
            disposition: dispositionLabel(r.disposition),
            patient_id:  r.patient_id ?? null,
            patient_name: (typeof r.patient_name === 'string' && r.patient_name.trim() !== '') ? r.patient_name : null,
        }));
}

/**
 * TELEPHONY_ROUTING_V1 — telephony_dispositions' reply → safe rows for the
 * «Звонки → заявки» card (docs/plans/2026-08-24-telephony-owns-its-routing.md).
 *
 * The contract is a bare array; {dispositions:[...]} is accepted too, and
 * anything else — including the {} an older server answers — degrades to an
 * empty list, exactly as shapeCalls does and for the same reason.
 *
 * Every field is re-derived rather than trusted: `action` is one of two words
 * or it is 'ignore' (silence is what leadFromCall does with a rule it cannot
 * read, so the screen must not show a friendlier lie), a `stage_key` that is
 * not a real string is null, and seen_count is a whole non-negative number so
 * the count line can never say «-1 звонок» or «1.5 звонка».
 *
 * `documented` false carries BOTH facts the card needs: the vendor never
 * documented this outcome, and no rule row exists for it yet — one is the
 * other, because the documented list IS the seeded routing table.
 */
export function shapeDispositions(data) {
    const arr = Array.isArray(data) ? data
        : (data && Array.isArray(data.dispositions)) ? data.dispositions
            : [];
    return arr
        .filter((r) => r && typeof r === 'object'
            && typeof r.disposition === 'string' && r.disposition.trim() !== '')
        .map((r) => {
            const n = Math.floor(Number(r.seen_count));
            return {
                disposition: r.disposition.trim(),
                seen_count: Number.isFinite(n) && n > 0 ? n : 0,
                last_seen_at: (typeof r.last_seen_at === 'string' && r.last_seen_at.trim() !== '') ? r.last_seen_at : null,
                documented: !!r.documented,
                action: r.action === 'create' ? 'create' : 'ignore',
                stage_key: (typeof r.stage_key === 'string' && r.stage_key) ? r.stage_key : null,
            };
        });
}

/** last_poll_at / last_call_at status values — one door for the view, same tolerant parsing as the call table. */
export function statusTime(v) {
    return timeLabel(v);
}
