// CRM_MULTI_SOURCE_V1 (2026-09-29) — ИСТОЧНИКИ ЗАЯВКИ: ОДНО ПРАВИЛО ЧТЕНИЯ.
//
// Владелец: «can we setup multiple source selection in the crm» → «Both»: и
// фильтр доски по нескольким источникам, и несколько источников у одной заявки
// («пришла из Instagram и по совету знакомых»). Отчёты считают заявку в каждом
// её источнике.
//
// Данные (миграция 231): crm_requests.sources — JSON-массив ключей справочника
// crm_sources в порядке выбора; crm_requests.source остаётся и всегда равен
// ПЕРВОМУ ключу — «главный» источник. Старые места и соседи, которые пишут
// заявку сами (звонок → заявка, зеркало записи), пишут только source.
//
// ПРАВИЛО ЧТЕНИЯ ОДНО: источники заявки = sources, если это непустой массив,
// иначе [source], иначе ['other']. Этим модулем читают и экран (views/crm.js),
// и сервер (проверка записи, слияние дублей, выгрузка отчёта колл-центра —
// server/services/crm/sources.js). SQL-запись того же правила для json_each —
// leadSourcesSql() там же; обе проверяет одна таблица примеров
// (server/services/crm/sources.test.js).
//
// Модуль чистый: ни DOM, ни сети — его импортирует и Node.

/** Больше источников у одной заявки не бывает (сервер отказывает 400). */
export const MAX_LEAD_SOURCES = 10;
/** Заявка без единого источника читается как «Другое» (сидовый ключ, мигр. 077). */
export const FALLBACK_SOURCE = 'other';

/**
 * Источники заявки по правилу чтения.
 *
 * `sources` приходит массивом (/api/db разбирает JSON-колонку) или строкой
 * (сырые строки базы: RPC поиска, отчёт, слияние). В счёт идут только непустые
 * строки, повтор — один раз; если не осталось ни одной — [source], а без
 * source — ['other'].
 * @param {{source?: string, sources?: string[]|string|null}|null} r
 * @returns {string[]} непустой список ключей, главный — первый
 */
export function leadSources(r) {
    let s = r ? r.sources : null;
    if (typeof s === 'string') {
        try { s = JSON.parse(s); } catch (e) { s = null; }
    }
    if (Array.isArray(s)) {
        const out = [];
        for (const k of s) if (typeof k === 'string' && k !== '' && !out.includes(k)) out.push(k);
        if (out.length) return out;
    }
    const one = r && r.source != null ? String(r.source) : '';
    return one !== '' ? [one] : [FALLBACK_SOURCE];
}

/**
 * Нажатие чипа источника в карточке заявки: не выбран — встаёт В КОНЕЦ (порядок
 * выбора сохраняется, первый — главный), выбран — снимается. Последний не
 * снимается — у заявки обязан быть хотя бы один источник; больше
 * MAX_LEAD_SOURCES не добавляется. Входной список не меняется.
 * @returns {{list: string[], refused: null|'last'|'max'}}
 */
export function toggleLeadSource(list, key) {
    const cur = Array.isArray(list) ? list.slice() : [];
    const at = cur.indexOf(key);
    if (at < 0) {
        if (cur.length >= MAX_LEAD_SOURCES) return { list: cur, refused: 'max' };
        return { list: [...cur, key], refused: null };
    }
    if (cur.length <= 1) return { list: cur, refused: 'last' };
    cur.splice(at, 1);
    return { list: cur, refused: null };
}

/**
 * Фильтр доски: ничего не отмечено — видны все; иначе заявка видна, если ХОТЯ
 * БЫ ОДИН её источник отмечен.
 */
export function leadHasAnySource(r, keys) {
    if (!Array.isArray(keys) || !keys.length) return true;
    return leadSources(r).some((k) => keys.includes(k));
}

/**
 * Счёт по источникам: заявка — в КАЖДОМ своём источнике (с двумя — в обоих),
 * поэтому сумма по источникам бывает больше числа заявок; итог считают по
 * заявкам, не по сумме строк. `won` — сколько из них подходит под isWon
 * («пришли»). Порядок ключей — первого появления.
 * @returns {Map<string, {total: number, won: number}>}
 */
export function sourceTally(rows, isWon = null) {
    const m = new Map();
    for (const r of (Array.isArray(rows) ? rows : [])) {
        const won = typeof isWon === 'function' && !!isWon(r);
        for (const k of leadSources(r)) {
            const s = m.get(k) || { total: 0, won: 0 };
            s.total++;
            if (won) s.won++;
            m.set(k, s);
        }
    }
    return m;
}
