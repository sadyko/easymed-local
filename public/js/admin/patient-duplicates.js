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
// PATIENT_DUP_RULE_V3 (3.25.0, решение владельца 2026-11-18) — ВТОРОЙ СПИСОК,
// «Возможные дубликаты — проверьте». Уверенные правила выше НЕ меняются. Случай
// владельца (имена, номер и дата здесь изменены): три карты на +998 97 765 43 21 — «TEST», «Alimov», «Тест 2»; у «Sardor
// Alimov» и «ТЕст 2 Тест 2» одна дата рождения 1991-04-23 — почти наверняка один
// человек, заведённый дважды, а список показывал «Дубликаты · 0»: имена разные,
// значит «семья». Возможным дубликатом считается пара карт, у которых
//   • тот же телефон И та же дата рождения, а имена разные (двойня на номере
//     матери сюда тоже попадёт — поэтому это «проверьте», а не «дубликат»);
//   • то же ФИО (фамилия + имя, отчество — если есть у обеих, должно совпасть)
//     И та же дата рождения, телефон любой.
// Пара, уже стоящая в уверенной группе, вторым списком не повторяется. Пустая
// или мусорная дата рождения (dobKey) и телефон (phoneKey + одна цифра подряд)
// карт не группируют. Пары, отмеченные «Не дубликат» (таблица
// patient_dup_dismissals, мигр. 290), в список не попадают. Считает сервер
// (rpc/patient-duplicates.js) — по всей картотеке, этим же модулем.
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

// PATIENT_DUP_RULE_V3 — скан всей картотеки нормализует одни и те же имена
// десятки тысяч раз («Азиз», «Каримов»…), а регулярное выражение с \p{L} — самая
// дорогая часть нормализации. Запомненная нормализация на один скан даёт тот же
// ответ, что normalizeName, без повторной работы.
export function memoNormalizer() {
    const cache = new Map();
    return (s) => {
        const k = s == null ? '' : String(s);
        let v = cache.get(k);
        if (v === undefined) { v = normalizeName(k); cache.set(k, v); }
        return v;
    };
}

// The first name of a row, however the record happens to carry it. Records
// imported with only full_name follow the same «Фамилия Имя Отчество» reading
// as splitFio() in crm.js: one word IS the first name, two or more put the
// first name second.
export function firstNameOf(row, norm = normalizeName) {
    const explicit = norm(row && row.first_name);
    if (explicit) return explicit;
    const parts = norm(row && row.full_name).split(' ').filter(Boolean);
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

// PATIENT_DUP_RULE_V3 — «не дальше одной правки» без полной таблицы Левенштейна:
// то же самое, что levenshtein(x, y) <= 1 (по тем же кодовым единицам), но за
// один проход и без двух массивов на каждую пару — скан сравнивает десятки тысяч
// пар имён на семейных номерах (patient-duplicates.test.js сверяет с levenshtein).
export function withinOneEdit(x, y) {
    if (x === y) return true;
    const m = x.length, n = y.length;
    if (Math.abs(m - n) > 1) return false;
    if (m === n) {
        let diff = 0;
        for (let i = 0; i < m; i++) if (x.charCodeAt(i) !== y.charCodeAt(i) && ++diff > 1) return false;
        return true;
    }
    const s = m < n ? x : y, l = m < n ? y : x;
    let i = 0;
    while (i < s.length && s.charCodeAt(i) === l.charCodeAt(i)) i++;
    for (let j = i; j < s.length; j++) if (s.charCodeAt(j) !== l.charCodeAt(j + 1)) return false;
    return true;
}

// The same test on names that are ALREADY normalized (normalizeName is
// idempotent, so this answers exactly what namesMatch answers).
function namesMatchNormalized(x, y) {
    if (!x || !y) return false;   // a blank name proves nothing either way
    if (x === y) return true;
    if (x.length >= FUZZY_MIN_LEN && y.length >= FUZZY_MIN_LEN && Math.abs(x.length - y.length) <= 1) {
        return withinOneEdit(x, y);
    }
    return false;
}

// Do two first names denote the same person? Exact after normalization, or one
// typo apart once the name is long enough for that to be safe.
export function namesMatch(a, b) {
    return namesMatchNormalized(normalizeName(a), normalizeName(b));
}

// Groups of cards that are the same person, per the rule at the top.
// rows: [{ id, phone, national_id, first_name, full_name }]  →  [[id, id], ...]
// Only groups of 2+ are returned; a card matching nobody is not a duplicate.
// opts.norm — запомненная нормализация скана (memoNormalizer), ответ тот же.
export function duplicateGroups(rows, { norm = normalizeName } = {}) {
    const list = (rows || []).filter(r => r && r.id != null);

    // Union-find, so a chain (A≡B by PINFL, B≡C by phone+name) is ONE group
    // rather than two overlapping pairs.
    // PATIENT_DUP_RULE_V3 — узлы заводятся ЛЕНИВО, только у карт, которые с кем-то
    // связались: на 70 000 карт прежний Map «каждая карта — сама себе корень» и
    // 70 000 массивов-групп по одной карте были половиной времени скана. Правило и
    // ответ те же (группы — в порядке первой карты в списке, карты — в порядке списка).
    const parent = new Map();
    const find = (x) => {
        if (!parent.has(x)) return x;
        while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
        return x;
    };
    const union = (a, b) => {
        if (!parent.has(a)) parent.set(a, a);
        if (!parent.has(b)) parent.set(b, b);
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
    };

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
        const names = bucket.map((r) => firstNameOf(r, norm));
        for (let i = 0; i < bucket.length; i++) {
            for (let j = i + 1; j < bucket.length; j++) {
                if (namesMatchNormalized(names[i], names[j])) union(bucket[i].id, bucket[j].id);
            }
        }
    }

    const groups = new Map();
    for (const r of list) {
        if (!parent.has(r.id)) continue;   // ни с кем не связана — не дубликат
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

// ---------------------------------------------------------------------------
// PATIENT_DUP_RULE_V3 — «Возможные дубликаты — проверьте» (шапка файла).
// ---------------------------------------------------------------------------

// Почему пара попала во второй список. Коды, а не текст: экран переводит их
// сам (views/patients.js), сервер отдаёт их как есть.
export const POSSIBLE_REASONS = Object.freeze({ PHONE_DOB: 'phone_dob', NAME_DOB: 'name_dob' });
const REASON_ORDER = [POSSIBLE_REASONS.PHONE_DOB, POSSIBLE_REASONS.NAME_DOB];

// Больше карт с одним ключом «телефон + дата» или «ФИО + дата» — это заглушка
// (номер клиники, дата «по умолчанию», учебные карты), а не один человек,
// заведённый много раз. Такая корзина не группируется вовсе, а заодно не даёт
// попарному проходу стать квадратичным на 70 000 картах.
const MAX_POSSIBLE_BUCKET = 20;
// Раньше этого года дата рождения — заглушка («1900-01-01», «0000-00-00»).
const MIN_DOB_YEAR = 1901;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Дата рождения как ключ: 'YYYY-MM-DD' (хвост со временем отрезается) или
// 'ДД.ММ.ГГГГ' из импорта. Пусто, не дата, несуществующий день или заглушка —
// ключа нет, и карта по дате ни с кем не группируется.
export function dobKey(dob) {
    const s = String(dob == null ? '' : dob).trim();
    let y, m, d;
    let mt = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(s);
    if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
    else if ((mt = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
    else return '';
    if (y < MIN_DOB_YEAR || m < 1 || m > 12 || d < 1) return '';
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (d > (m === 2 ? (leap ? 29 : 28) : DAYS_IN_MONTH[m - 1])) return '';   // 30 февраля и т.п.
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Телефон для ВТОРОГО списка: ключ уверенного правила (phoneKey) и вдобавок не
// одна цифра подряд («000000000», «+998 00 000 00 00»). Уверенное правило эту
// проверку не получает — оно не меняется по решению владельца.
export function possiblePhoneKey(phone) {
    const key = phoneKey(phone);
    return key && !/^(\d)\1*$/.test(key) ? key : '';
}

// Фамилия, имя и отчество карты. Колонки, если в карте есть фамилия или имя;
// иначе full_name тем же чтением «Фамилия Имя Отчество», что у firstNameOf.
export function nameParts(row, norm = normalizeName) {
    const last = norm(row && row.last_name);
    const first = norm(row && row.first_name);
    if (last || first) return { last, first, middle: norm(row && row.middle_name) };
    const parts = norm(row && row.full_name).split(' ').filter(Boolean);
    if (!parts.length) return { last: '', first: '', middle: '' };
    if (parts.length === 1) return { last: '', first: parts[0], middle: '' };
    return { last: parts[0], first: parts[1], middle: parts.slice(2).join(' ') };
}

// ФИО как ключ: «фамилия имя». Без фамилии или без имени ключа нет — одно имя
// с датой рождения в картотеке на десятки тысяч карт людей не различает.
export function fullNameKey(row) {
    const p = nameParts(row);
    return p.last && p.first ? p.last + ' ' + p.first : '';
}

// Ключ пары карт — порядок не важен; числовые id сравниваются как числа.
export function pairKey(a, b) {
    const x = Number(a), y = Number(b);
    const numeric = Number.isSafeInteger(x) && Number.isSafeInteger(y);
    const aFirst = numeric ? x <= y : String(a) <= String(b);
    return aFirst ? a + ':' + b : b + ':' + a;
}

const idOrder = (a, b) => {
    const x = Number(a), y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};
// Новые группы — сверху: регистратору важнее карта, заведённая дважды вчера.
const newestFirst = (ga, gb) => idOrder(gb[gb.length - 1], ga[ga.length - 1]);

/**
 * Возможные дубликаты (шапка файла, PATIENT_DUP_RULE_V3).
 * rows: [{ id, phone, national_id, first_name, last_name, middle_name, full_name, date_of_birth }]
 * opts.sure — уверенные группы (duplicateGroups), если уже посчитаны;
 * opts.dismissed — Set ключей pairKey пар «Не дубликат»;
 * opts.norm — запомненная нормализация скана (memoNormalizer), ответ тот же.
 * → [{ ids: [id…] (по возрастанию), reasons: ['phone_dob' | 'name_dob', …] }], новые сверху.
 */
export function possibleDuplicateGroups(rows, { sure = null, dismissed = null, norm = memoNormalizer() } = {}) {
    const list = (rows || []).filter(r => r && r.id != null);
    const sureOf = new Map();
    (sure || duplicateGroups(list, { norm })).forEach((g, i) => { for (const id of g) sureOf.set(id, i); });
    const isDismissed = (a, b) => !!(dismissed && dismissed.size && dismissed.has(pairKey(a, b)));

    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const reasonsOf = new Map();   // id → Set(причин), сводится к корню в конце
    const link = (a, b, reason) => {
        for (const x of [a, b]) {
            if (!parent.has(x)) parent.set(x, x);
            if (!reasonsOf.has(x)) reasonsOf.set(x, new Set());
            reasonsOf.get(x).add(reason);
        }
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
    };

    // Пара годится во второй список: не уверенный дубликат и не «Не дубликат».
    const consider = (a, b, reason) => {
        if (a === b) return;
        const sa = sureOf.get(a);
        if (sa !== undefined && sa === sureOf.get(b)) return;   // уже уверенный дубликат
        if (isDismissed(a, b)) return;
        link(a, b, reason);
    };
    // Отчество, записанное у обеих карт, должно совпасть; пустое совместимо с любым.
    const middleOk = (x, y) => !x.middle || !y.middle || x.middle === y.middle;
    // Обе причины требуют одной даты рождения, поэтому сначала — корзины по дате
    // (одна строка-ключ на карту, а не две склейки «ключ|дата» на 70 000 карт), и
    // ключи телефона и ФИО считаются только у карт, чья дата встретилась дважды.
    // В Map лежит сама карта, массив — со второй.
    const byDob = new Map();
    for (const r of list) {
        const dob = dobKey(r.date_of_birth);
        if (!dob) continue;
        const b = byDob.get(dob);
        if (b === undefined) byDob.set(dob, r); else if (Array.isArray(b)) b.push(r); else byDob.set(dob, [b, r]);
    }
    const keysOf = (r) => {
        const p = nameParts(r, norm);
        return { id: r.id, phone: possiblePhoneKey(r.phone), name: p.last && p.first ? p.last + ' ' + p.first : '', middle: p.middle };
    };
    const pairUp = (keys, reason, same) => {
        for (let i = 0; i < keys.length; i++) {
            for (let j = i + 1; j < keys.length; j++) if (same(keys[i], keys[j])) consider(keys[i].id, keys[j].id, reason);
        }
    };
    // Телефон + дата: с тем же именем пара уже в уверенной группе (правило
    // «телефон + имя»), и consider её пропускает — остаются разные имена.
    const samePhone = (x, y) => !!x.phone && x.phone === y.phone;
    // ФИО + дата.
    const sameName = (x, y) => !!x.name && x.name === y.name && middleOk(x, y);
    for (const bucket of byDob.values()) {
        if (!Array.isArray(bucket)) continue;
        const keys = bucket.map(keysOf);
        if (keys.length <= MAX_POSSIBLE_BUCKET) {
            // Корзина ключа внутри даты не больше самой даты — предел соблюдён.
            pairUp(keys, POSSIBLE_REASONS.PHONE_DOB, samePhone);
            pairUp(keys, POSSIBLE_REASONS.NAME_DOB, sameName);
            continue;
        }
        // Частая дата (заглушка «01-01» или просто многолюдный день): по ключам;
        // корзина «телефон + дата» или «ФИО + дата» больше предела не группируется.
        const byPhone = new Map(), byName = new Map();
        for (const k of keys) {
            if (k.phone) { const b = byPhone.get(k.phone); if (b) b.push(k); else byPhone.set(k.phone, [k]); }
            if (k.name) { const b = byName.get(k.name); if (b) b.push(k); else byName.set(k.name, [k]); }
        }
        for (const b of byPhone.values()) if (b.length > 1 && b.length <= MAX_POSSIBLE_BUCKET) pairUp(b, POSSIBLE_REASONS.PHONE_DOB, samePhone);
        for (const b of byName.values()) if (b.length > 1 && b.length <= MAX_POSSIBLE_BUCKET) pairUp(b, POSSIBLE_REASONS.NAME_DOB, sameName);
    }

    const groups = new Map();
    for (const id of parent.keys()) {
        const root = find(id);
        let g = groups.get(root);
        if (!g) { g = { ids: [], reasons: new Set() }; groups.set(root, g); }
        g.ids.push(id);
        for (const why of reasonsOf.get(id) || []) g.reasons.add(why);
    }
    return [...groups.values()]
        .filter(g => g.ids.length > 1)
        .map(g => ({ ids: g.ids.sort(idOrder), reasons: REASON_ORDER.filter(x => g.reasons.has(x)) }))
        .sort((a, b) => newestFirst(a.ids, b.ids));
}

/**
 * Оба списка разом — то, что отдаёт сервер экрану «Дубликаты».
 * dismissed — Set ключей pairKey пар «Не дубликат» (действует только на второй список).
 * → { sure: [[id…]…], possible: [{ ids, reasons }…] }; id в группе по возрастанию, новые группы сверху.
 */
export function duplicateScan(rows, dismissed = null) {
    const list = (rows || []).filter(r => r && r.id != null);
    const norm = memoNormalizer();   // одна на оба списка
    const sure = duplicateGroups(list, { norm });
    const possible = possibleDuplicateGroups(list, { sure, dismissed, norm });
    return { sure: sure.map(g => [...g].sort(idOrder)).sort(newestFirst), possible };
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
