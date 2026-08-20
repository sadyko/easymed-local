import { LICENSED_MODULES } from './licensed-modules.js';

// LICENCE_CORE_V1 — the browser's copy of what the server decided.
//
// Never the source of truth: every write is gated again on the server, because
// the API is reachable with curl from any PC on the clinic's network. This exists
// so the interface can be honest BEFORE the user clicks — a lock marker on the
// sidebar instead of a 402 after filling in a form.

let _licence = null;

/** Called once at boot from the licence_status RPC. */
export function setLicence(licence) { _licence = licence || null; }

// Fallback shape returned when the RPC hasn't answered (or answered with
// something too broken to trust). `locked: false` here is only ever read via
// licenceState() for banners/copy — isLicensed() below has its own, separately
// reasoned default and does NOT go through this object.
const UNKNOWN_STATE = { state: 'ok', locked: false, reason: 'unknown', days_left: 0, modules: [] };

export function licenceState() {
    // Spread over the default rather than returning `_licence` directly: a
    // malformed RPC payload (e.g. `{}`, or a response missing `days_left`)
    // must not surface `undefined` to a banner that does `${days_left} дней
    // осталось` — better a stale-looking-but-valid 0/'ok' than "undefined".
    return _licence ? { ...UNKNOWN_STATE, ..._licence } : { ...UNKNOWN_STATE };
}

/**
 * Nav id → licence key, or null when the module is part of the free core.
 *
 * LICENSED_MODULES is a null-prototype object (see licensed-modules.js), so a
 * lookup of 'constructor', '__proto__', 'toString' etc. returns `undefined`
 * here, not an inherited value — those ids are not real modules and must map
 * to null exactly like any other unlisted nav id.
 */
export function licenceKeyFor(navId) {
    return LICENSED_MODULES[navId]?.key ?? null;
}

/**
 * May this nav id be opened?
 *
 * Two independent reasons it may not, and they must not be conflated: the
 * subscription has lapsed (everything shuts), or this particular module was never
 * bought (only it shuts).
 */
export function isLicensed(navId) {
    const key = licenceKeyFor(navId);

    // Before the RPC answers we know nothing. Treat the free core as open —
    // flashing a lock at a paying clinic on every page load would be its own bug —
    // but treat paid modules as closed, so an unbought module never flickers open.
    //
    // The mistake we choose to make, stated explicitly: a paying clinic might see
    // a false "locked" flicker on a module it actually owns for the one frame
    // before the RPC lands (annoying, self-correcting). The alternative — briefly
    // showing every paid module as open to every clinic on every boot — would let
    // a lapsed or never-paying clinic believe, even for a moment, that a feature
    // it didn't buy works; that is the one this module refuses to make.
    if (!_licence) return key === null;

    // `locked` must be an actual boolean `true` to shut the app down. A
    // malformed RPC response could hand us a string ('false' is truthy in JS,
    // 'true' is also just a string) — comparing with `===` instead of truthiness
    // means only a real, well-formed `true` locks the clinic out, and any other
    // garbage in this field falls through to normal per-module gating instead of
    // silently locking a paying clinic out of the whole app.
    if (_licence.locked === true) return false;

    if (key === null) return true;

    // A paid module unlocks only for a genuine array containing its key. If
    // `modules` is missing, null, or came back as a bare string instead of an
    // array (all seen in the wild from a hand-edited licence file), `includes`
    // must never be called on it — fail closed for the module instead of
    // throwing or, worse, doing a substring-style false match.
    return Array.isArray(_licence.modules) && _licence.modules.includes(key);
}
