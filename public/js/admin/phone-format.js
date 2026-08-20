// PHONE_INPUT_V1 — country codes and formatting rules, with NO DOM imports so
// they can be unit-tested under `node --test` (same split as crm-phone-match.js).
// The widget that uses them lives in phone-input.js.

// Longest matching code wins in detectCountry(), so shared codes (RU/KZ = 7)
// resolve to the first entry listed here. UZ is first: it is the default.
export const PHONE_COUNTRIES = [
    { iso: 'UZ', name: 'Узбекистан',   code: '998', groups: [2, 3, 2, 2] },
    { iso: 'KZ', name: 'Казахстан',    code: '7',   groups: [3, 3, 2, 2] },
    { iso: 'RU', name: 'Россия',       code: '7',   groups: [3, 3, 2, 2] },
    { iso: 'KG', name: 'Кыргызстан',   code: '996', groups: [3, 3, 3] },
    { iso: 'TJ', name: 'Таджикистан',  code: '992', groups: [2, 3, 4] },
    { iso: 'TM', name: 'Туркменистан', code: '993', groups: [2, 2, 2, 2] },
    { iso: 'TR', name: 'Турция',       code: '90',  groups: [3, 3, 2, 2] },
    { iso: 'AE', name: 'ОАЭ',          code: '971', groups: [2, 3, 4] },
    { iso: 'AF', name: 'Афганистан',   code: '93',  groups: [2, 3, 4] },
    { iso: 'US', name: 'США / Канада', code: '1',   groups: [3, 3, 4] },
];

export const DEFAULT_ISO = 'UZ';
export const DEFAULT_COUNTRY = PHONE_COUNTRIES.find(c => c.iso === DEFAULT_ISO);

export function countryByIso(iso) { return PHONE_COUNTRIES.find(c => c.iso === iso) || null; }

export function detectCountry(digits) {
    let best = null;
    for (const c of PHONE_COUNTRIES) {
        if (String(digits || '').startsWith(c.code) && (!best || c.code.length > best.code.length)) best = c;
    }
    return best;
}

function groupNat(nat, groups) {
    const out = []; let i = 0;
    for (const g of groups) { if (i >= nat.length) break; out.push(nat.slice(i, i + g)); i += g; }
    if (i < nat.length) out.push(nat.slice(i));
    return out.join(' ');
}

export function fmtPhone(c, nat) { return nat ? `+${c.code} ${groupNat(nat, c.groups)}` : `+${c.code}`; }

/** Digits only, country code included: '+998 90 961 00 04' -> '998909610004'. */
export function phoneDigits(value) { return String(value == null ? '' : value).replace(/\D/g, ''); }

/**
 * True when the field holds nothing but a dialling code — i.e. nobody typed a
 * number. Callers that read the raw <input> (form scrapers) use this so a
 * pre-filled «+998» is never persisted as somebody's phone number.
 */
export function isCodeOnly(value) {
    const d = phoneDigits(value);
    if (!d) return true;
    const c = detectCountry(d);
    return !!c && d.length <= c.code.length;
}

/** Display form of anything typed or stored; '' when there is no number. */
export function formatPhone(value) {
    const d = phoneDigits(value);
    if (!d) return '';
    const c = detectCountry(d);
    if (!c) return '+' + d;
    const nat = d.slice(c.code.length);
    return nat ? fmtPhone(c, nat) : '';
}
