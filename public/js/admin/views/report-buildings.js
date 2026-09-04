// BUILDING_REPORTS_V1 — ЗДАНИЕ как измерение отчёта. Модуль ЧИСТЫЙ: ни DOM, ни
// сети, ни одной русской строки — его читают и браузер, и сервер (тот же приём,
// что у lab-scope.js, lab-service.js и record-origin.js).
//
// В системе ДВА разных «филиала», и до этого модуля их путали:
//
//   1. `branches` + `*.branch_id` — филиал ВНУТРИ одной базы. Модель одной
//      установки: клиника, которая ведёт два адреса в одной программе,
//      проставляет счёту branch_id. Все отчёты фильтровали только это.
//   2. ЗДАНИЕ — отдельная установка со своей базой, соединённая
//      branch-sync'ом. Признак строки — `sync_origin` (миграция 083): NULL —
//      заведена здесь, буква — приехала оттуда.
//
// Это РАЗНЫЕ измерения, и второе до сих пор не умел ни один отчёт: выборка
// филиалов грузилась с `.eq('active', 1)`, а соседние здания заводятся в
// `branches` именно как `active = 0` (branch-sync/catalogue.js, «строка
// заводится, чтобы была ИЗВЕСТНА БУКВА соседа»). То есть отчёт не мог даже
// НАЗВАТЬ второе здание, не то что посчитать его.
//
// Здесь живёт только логика «какие здания существуют и как они называются
// ключом». Подписи («Филиал B») делает тот, кто показывает: браузер через
// словарь i18n, сервер — своей русской картой (как INV_STATUS_RU).

// Буква узла: одна или несколько заглавных латинских. Та же форма, что у
// ROSTER_LETTER_RE в branch-sync/catalogue.js и у CHECK'а миграции 080 —
// кириллическая «С» или пустая строка не буква и здесь.
const LETTER_RE = /^[A-Z]+$/;

// Ключ «это здание», когда буква ещё не выдана (branch_identity пуст — такого
// не бывает после миграции 080, но отчёт не должен падать на пустой базе).
// Не буква, поэтому с настоящей буквой не столкнётся.
export const OWN_KEY = '~';

/**
 * Привести значение к букве узла или null.
 * @param {unknown} v
 * @returns {string|null}
 */
export function normalizeLetter(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim().toUpperCase();
    return LETTER_RE.test(s) ? s : null;
}

/** Ключ здания в выборке отчёта. */
export function buildingKey(opt) {
    if (!opt) return OWN_KEY;
    if (opt.letter) return opt.letter;
    return OWN_KEY;
}

/**
 * Список ЗДАНИЙ клиники: это здание + каждое, о котором вообще известно.
 *
 * Источников три, и ни один нельзя выкинуть:
 *   branches   — перечень с именами. Берётся ЦЕЛИКОМ, включая `active = 0`:
 *                именно так лежит соседнее здание, и фильтр по active был
 *                причиной, по которой отчёт его не видел;
 *   ownLetter  — буква этой установки (branch_identity). Своё здание обязано
 *                быть в списке, даже если строки в branches нет;
 *   seen       — буквы, реально встреченные в данных. Здание, приславшее
 *                записи, но не попавшее в перечень, всё равно обязано быть
 *                названо: молча свалить его строки в «своё» — это ровно та
 *                ошибка, ради которой всё это пишется.
 *
 * Порядок: своё здание первым, остальные по букве. Отчёт читают сверху вниз,
 * и первым должно стоять то, за что человек отвечает.
 *
 * @param {{branches?: Array, ownLetter?: unknown, seen?: Array}} input
 * @returns {Array<{key: string, letter: string|null, name: string|null, own: boolean}>}
 */
export function buildingOptions({ branches = [], ownLetter = null, seen = [] } = {}) {
    const own = normalizeLetter(ownLetter);
    const names = new Map();
    for (const b of Array.isArray(branches) ? branches : []) {
        const letter = normalizeLetter(b && b.letter);
        if (!letter || names.has(letter)) continue;
        const name = b && typeof b.name === 'string' ? b.name.trim() : '';
        names.set(letter, name || null);
    }

    const letters = new Set(names.keys());
    for (const s of Array.isArray(seen) ? seen : []) {
        const letter = normalizeLetter(s);
        if (letter) letters.add(letter);
    }
    if (own) letters.add(own);

    const list = [...letters].sort().map((letter) => ({
        key: letter,
        letter,
        name: names.get(letter) || null,
        own: own != null && letter === own,
    }));

    // База без выданной буквы: своё здание всё равно существует и обязано быть
    // выбираемым — иначе «все здания» означало бы «все, кроме этого».
    if (!own) list.unshift({ key: OWN_KEY, letter: null, name: null, own: true });

    list.sort((a, b) => (a.own === b.own ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : (a.own ? -1 : 1)));
    return list;
}

/** Ключ своего здания в этом списке. */
export function ownKeyOf(options) {
    const own = (options || []).find((o) => o.own);
    return own ? own.key : OWN_KEY;
}

/**
 * Выбор покрывает ВСЕ здания? Тогда фильтровать нечем — и это не мелочь:
 * «выбрано всё» обязано вести себя как «фильтра нет», иначе строка здания, о
 * котором список ещё не знает, тихо выпала бы из отчёта.
 */
export function coversAll(keys, options) {
    const set = new Set((keys || []).map((k) => (normalizeLetter(k) || (k === OWN_KEY ? OWN_KEY : null))).filter(Boolean));
    if (set.size === 0) return true;
    const all = (options || []).map((o) => o.key);
    return all.length > 0 && all.every((k) => set.has(k));
}
