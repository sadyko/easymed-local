// PATIENT_DUP_RULE_V2 — what makes two patient cards the SAME PERSON.
//
// V1 grouped on «same phone OR same PINFL». That is wrong for a real clinic:
// one phone belongs to a whole FAMILY. A parent registers the children, the
// grandmother and the husband on their own number, so every family surfaced as
// a pile of duplicates (71 flagged cards on one register). The surname does not
// separate them either — a family shares that too. What separates them is the
// FIRST NAME.
//
// The rule:
//   • same PINFL                        → same person (one national id = one human)
//   • same phone AND same first name    → same person
//   • same phone, different first name  → FAMILY, not a duplicate
//
// The surname is deliberately NOT part of the key: «Каримов Азиз» and
// «Каримова Дилноза» on one number are a brother and a sister.
//
// Pure and DOM-free (no supabase, no document) so it can be unit-tested
// directly — same pattern as lab-grouping.js and crm-phone-match.js.

import { digitsOf, uzLocalDigits } from './views/crm-phone-match.js';

// A phone shorter than this is junk («0», «123») and must never group cards.
const MIN_GROUP_DIGITS = 7;
// Likewise for an id document: PINFL is 14 digits, passports «AA1234567».
const MIN_ID_CHARS = 6;
// Below this length a single edit is a DIFFERENT name («Аля» / «Али»), so the
// typo tolerance only applies from here up.
const FUZZY_MIN_LEN = 5;

// Levenshtein edit distance, iterative two-row DP.
export function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a) return b ? b.length : 0;
    if (!b) return a.length;
    const m = a.length, n = b.length;
    let prev = new Array(n + 1), curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

// Case, ё/е and punctuation must not decide whether two names are the same.
export function normalizeName(s) {
    return String(s == null ? '' : s)
        .toLowerCase()
        .replace(/ё/g, 'е')   // i18n-exempt: константа нормализации ё→е — данные алгоритма, не текст экрана
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

// The first name of a row, however the record happens to carry it. Records
// imported with only full_name follow the same «Фамилия Имя Отчество» reading
// as splitFio() in crm.js: one word IS the first name, two or more put the
// first name second.
export function firstNameOf(row) {
    const explicit = normalizeName(row && row.first_name);
    if (explicit) return explicit;
    const parts = normalizeName(row && row.full_name).split(' ').filter(Boolean);
    if (!parts.length) return '';
    return parts.length === 1 ? parts[0] : parts[1];
}

// Every phone spelling of one number collapses to the same key: «+998 95 076
// 80 08», «998950768008» and «95 076 80 08» are one phone.
export function phoneKey(phone) {
    const local = uzLocalDigits(digitsOf(phone));
    return local.length >= MIN_GROUP_DIGITS ? local : '';
}

// Letters are kept (passport series «AA1234567»), separators dropped.
export function idKey(nationalId) {
    const key = String(nationalId == null ? '' : nationalId).toUpperCase().replace(/[^0-9A-ZА-Я]/g, '');
    return key.length >= MIN_ID_CHARS ? key : '';
}

// Do two first names denote the same person? Exact after normalization, or one
// typo apart once the name is long enough for that to be safe.
export function namesMatch(a, b) {
    const x = normalizeName(a), y = normalizeName(b);
    if (!x || !y) return false;   // a blank name proves nothing either way
    if (x === y) return true;
    if (x.length >= FUZZY_MIN_LEN && y.length >= FUZZY_MIN_LEN && Math.abs(x.length - y.length) <= 1) {
        return levenshtein(x, y) <= 1;
    }
    return false;
}

// Groups of cards that are the same person, per the rule at the top.
// rows: [{ id, phone, national_id, first_name, full_name }]  →  [[id, id], ...]
// Only groups of 2+ are returned; a card matching nobody is not a duplicate.
export function duplicateGroups(rows) {
    const list = (rows || []).filter(r => r && r.id != null);

    // Union-find, so a chain (A≡B by PINFL, B≡C by phone+name) is ONE group
    // rather than two overlapping pairs.
    const parent = new Map(list.map(r => [r.id, r.id]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

    // 1. Same identity document — enough on its own.
    const byId = new Map();
    for (const r of list) {
        const key = idKey(r.national_id);
        if (!key) continue;
        if (byId.has(key)) union(r.id, byId.get(key)); else byId.set(key, r.id);
    }

    // 2. Same phone — only for the members whose FIRST NAME also matches.
    //    Buckets are family-sized, so the pairwise pass is cheap.
    const byPhone = new Map();
    for (const r of list) {
        const key = phoneKey(r.phone);
        if (!key) continue;
        if (!byPhone.has(key)) byPhone.set(key, []);
        byPhone.get(key).push(r);
    }
    for (const bucket of byPhone.values()) {
        if (bucket.length < 2) continue;
        const names = bucket.map(firstNameOf);
        for (let i = 0; i < bucket.length; i++) {
            for (let j = i + 1; j < bucket.length; j++) {
                if (namesMatch(names[i], names[j])) union(bucket[i].id, bucket[j].id);
            }
        }
    }

    const groups = new Map();
    for (const r of list) {
        const root = find(r.id);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(r.id);
    }
    return [...groups.values()].filter(g => g.length > 1);
}

// Flat Set of every id that belongs to some duplicate group.
export function duplicateIdSet(rows) {
    const set = new Set();
    for (const group of duplicateGroups(rows)) for (const id of group) set.add(id);
    return set;
}

// MRN_BEYOND_99999_V1 — which of two cards is OLDER by its number, for the
// merge dialog's default «keep» card. Same rule as the trigger that mints the
// numbers (migration 232): the year is the two digits right after the FIRST
// hyphen, the number is read WHOLE after the second. Text order is wrong past
// 99 999: 'A-26-100000' < 'A-26-99999' because '1' < '9', so the card issued
// LAST was offered as the oldest. The letter is not part of the order: the
// year's counter is shared by every letter (legacy P-26-… and A-26-… are one
// series), so year + number IS the order of issue. Numbers not in that shape
// (typed by hand, imported) sort after the parsed ones, among themselves as
// text with digit runs compared as numbers — under the 'ru' collation, fixed,
// so the order does not change with the browser's or the machine's locale.
const MRN_PARTS = /^[^-]*-(\d\d)-(\d+)/;
export function mrnOrder(a, b) {
    const sa = String(a ?? ''), sb = String(b ?? '');
    const ma = MRN_PARTS.exec(sa), mb = MRN_PARTS.exec(sb);
    if (ma && mb) {
        if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
        // Compared as digit strings, not Number(): no precision limit, and
        // leading zeros ('00042' vs '42') do not decide anything.
        const na = ma[2].replace(/^0+(?=\d)/, ''), nb = mb[2].replace(/^0+(?=\d)/, '');
        if (na.length !== nb.length) return na.length - nb.length;
        if (na !== nb) return na < nb ? -1 : 1;
    } else if (ma || mb) {
        return ma ? -1 : 1;
    }
    return sa.localeCompare(sb, 'ru', { numeric: true });
}

// MRN_BEYOND_99999_V1 (review 1) — the import window's guard against a card
// number that would use up its year's series. The trigger (migration 232)
// counts numbers 0…999 999 999 and, once that is reached, refuses every new
// registration of the year with its own message — so one imported placeholder
// like 'P-26-999999999' would stop the front desk until someone fixes that
// card. Refused here instead, row by row, with the reason: 999 999 000 up to
// 999 999 999 (leading zeros do not count, any year — the placeholder would
// block ITS year). Ten digits and more are left alone: the trigger does not
// count them, so they cannot block anything.
const MRN_SERIES_GUARD_FROM = 999999000;
export function mrnSeriesRefusal(mrn) {
    const m = MRN_PARTS.exec(String(mrn ?? '').trim());
    if (!m) return null;
    const digits = m[2].replace(/^0+(?=\d)/, '');
    if (digits.length !== 9 || Number(digits) < MRN_SERIES_GUARD_FROM) return null;
    return 'номер карты от 999 999 000 до 999 999 999 не принимается: после него у года кончаются номера карт. Проверьте номер или оставьте поле пустым — номер выдастся сам.';
}
