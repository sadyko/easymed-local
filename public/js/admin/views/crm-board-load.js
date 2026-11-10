// CRM_UNIFY_V1 (2026-10-09) — ЗАГРУЗКА ДОСКИ CRM.
//
// Владелец: «карточки иногда пропадают», «"Показать ещё 20" — убрать, чтобы все
// карточки были в окне». Доска брала 800 последних карточек — две недели
// звонков у клиники, — и всё, что старше, молча исчезало, в том числе живые
// заявки в работе. Теперь (Р12, Р13):
//   • открытые — ВСЕ, без предела. «Открытая» = не в закрытой колонке: так
//     карточка со ступенью, которой нет в запасной воронке (настройки не
//     загрузились), тоже не пропадает;
//   • закрытые («Пришёл», «Отказ», прочие проигрышные) — созданные в периоде;
//     для «Всё время» — последние 300 на колонку (тысячи закрытых в одной
//     колонке делают доску непригодной), а число в заголовке — настоящее, из
//     базы (count того же запроса) под тем же ограничением видимости и
//     фильтром оператора.
// Всё — через /api/db: кто что видит, решает компилятор запросов, как везде.
//
// CRM_PERIOD_ALL_COLUMNS_V1 (3.23.0, решение владельца Q1) — выбранный «Период»
// сужает КАЖДУЮ колонку, открытые тоже, по дате поступления (created_at).
// Владелец: фильтр «не работает» — при «Сегодня» доска грузила и показывала все
// 6 800 открытых карточек клиники, 6 782 из них старше сегодняшнего дня.
// Открытые ВНЕ периода приходят отдельным лёгким запросом (OUTSIDE_SELECT): по
// ним экран называет «Открытых за другие дни: N» с теми же фильтрами. «Всё
// время» — как прежде: все открытые и последние 300 на закрытую колонку.
import { supabase } from '../../supabase.js';

export const CLOSED_ALL_TIME_LIMIT = 300;
export const BOARD_SELECT = '*, patients(id, full_name, mrn), users(full_name), services(id, name, price)';
// CRM_PERIOD_ALL_COLUMNS_V1 — открытые вне периода: только то, по чему экран их
// считает (колонка, источники; метки — из своей таблицы, оператор — в запросе).
export const OUTSIDE_SELECT = 'id, status, source, sources';

// Перенесено из views/crm.js (CRM_PERIOD_WEEK_V1, CRM_PERIOD_CUSTOM_V1) без
// изменения смысла: граница — начало МЕСТНЫХ суток («7 дней» для регистратуры —
// семь календарных дней, а не 168 часов), неделя — с ПОНЕДЕЛЬНИКА, «по» —
// включая весь последний день, даты без 'Z' — местное время.
// CRM_PERIOD_ALL_COLUMNS_V1 — «весь последний день» теперь честный: граница «по» —
// НАЧАЛО СЛЕДУЮЩЕГО дня, исключительно (lt), а не 23:59:59.999 включительно (lte).
// База пишет created_at без долей секунды ('…T18:59:59Z') и сравнивает строки:
// '…59Z' > '…59.999Z' ('Z' после '.'), и карточка последней секунды «по»-дня
// в период не попадала.
export function periodStart(key, now = new Date()) {
    if (!key || key === 'all') return null;
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    if (key === 'today') return d;
    if (key === 'week') { d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
    d.setDate(d.getDate() - (Number(key) - 1));
    return d;
}
export function dayStart(ymd) {
    if (!ymd) return null;
    const d = new Date(ymd + 'T00:00:00');
    return isNaN(d) ? null : d;
}
/** CRM_PERIOD_ALL_COLUMNS_V1 — начало местных суток ПОСЛЕ дня 'YYYY-MM-DD' (граница «по», исключительно). */
export function dayAfter(ymd) {
    const d = dayStart(ymd);
    return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) : null;
}

/**
 * Границы created_at периода доски: ISO (UTC) или null с каждой стороны.
 * from — включительно (gte), to — ИСКЛЮЧИТЕЛЬНО (lt): начало дня после «по»
 * (CRM_PERIOD_ALL_COLUMNS_V1). Одни и те же для запроса и для экрана (crm.js inPeriod).
 */
export function periodBounds(period, customFrom = '', customTo = '', now = new Date()) {
    if (period === 'custom') {
        const f = dayStart(customFrom);
        const t = dayAfter(customTo);
        return { from: f ? f.toISOString() : null, to: t ? t.toISOString() : null };
    }
    const s = periodStart(period || 'all', now);
    return { from: s ? s.toISOString() : null, to: null };
}

/** CRM_PERIOD_ALL_COLUMNS_V1 — запрос в границах периода: from включительно, to исключительно. */
export function withBounds(q, bounds) {
    const b = bounds || {};
    if (b.from) q = q.gte('created_at', b.from);
    if (b.to) q = q.lt('created_at', b.to);
    return q;
}

/** Фильтр «Оператор» (Р15): 'all' | 'me' | 'none' | id сотрудника. */
export function withOperator(q, operator, me) {
    if (operator === 'me') return me != null ? q.eq('assigned_to', Number(me)) : q;
    if (operator === 'none') return q.is('assigned_to', null);
    if (operator != null && operator !== 'all' && Number(operator) > 0) return q.eq('assigned_to', Number(operator));
    return q;
}

/**
 * Карточки доски.
 * @param {object} o
 * @param {string[]} o.closedKeys  ключи закрытых колонок (won + lost)
 * @param {{from:string|null, to:string|null}} o.bounds  период (periodBounds): to — исключительно
 * @param {number} [o.closedLimit]  предел на закрытую колонку при «Всё время»;
 *   0 — без предела (CRM_UNIFY_V1, итоговое ревью: выгрузка Excel — явная просьба
 *   «всё», ей 300 на колонку не годятся)
 * @param {boolean} [o.outside]  CRM_PERIOD_ALL_COLUMNS_V1 — спросить и открытые ВНЕ
 *   периода (лёгкие строки OUTSIDE_SELECT) для строки «Открытых за другие дни»
 * @returns {Promise<{rows: object[], counts: Object<string, number>, capped: Object<string, boolean>,
 *   outside: object[]|null, error?: object}>}
 *   counts/capped — только у обрезанных закрытых колонок («Всё время»): число из базы.
 *   outside — открытые вне периода; null — не просили, периода нет или запрос не удался
 *   (доска от этого не страдает: строка над ней просто без числа).
 */
export async function loadBoard({ db = supabase, closedKeys = [], bounds = { from: null, to: null }, operator = 'all', me = null,
    closedLimit = CLOSED_ALL_TIME_LIMIT, outside = false } = {}) {
    const keys = (closedKeys || []).filter(Boolean);
    const b = bounds || { from: null, to: null };
    const counts = {};
    const capped = {};
    const jobs = [];

    // Открытые — всё, что не закрыто, без предела. CRM_PERIOD_ALL_COLUMNS_V1 — в
    // границах выбранного периода (при «Всё время» границ нет — все, как прежде).
    let open = db.from('crm_requests').select(BOARD_SELECT);
    if (keys.length) open = open.not('status', 'in', keys);
    jobs.push(withOperator(withBounds(open, b), operator, me).order('id', { ascending: false }));

    if (keys.length && (b.from || b.to || !closedLimit)) {
        // Период задан (или предел снят) — закрытые одним запросом, без предела.
        const q = withBounds(db.from('crm_requests').select(BOARD_SELECT).in('status', keys), b);   // CRM_PERIOD_ALL_COLUMNS_V1 — «по» исключительно
        jobs.push(withOperator(q, operator, me).order('id', { ascending: false }));
    } else {
        // «Всё время» — последние 300 на колонку; число той же колонки — из базы.
        for (const k of keys) {
            jobs.push(withOperator(db.from('crm_requests').select(BOARD_SELECT, { count: 'exact' }).eq('status', k), operator, me)
                .order('id', { ascending: false }).limit(closedLimit)
                .then((res) => {
                    const total = Number(res && res.count);
                    const got = (res && Array.isArray(res.data)) ? res.data.length : 0;
                    if (res && !res.error && Number.isFinite(total) && total > got) { counts[k] = total; capped[k] = true; }
                    return res;
                }));
        }
    }

    // CRM_PERIOD_ALL_COLUMNS_V1 — открытые ВНЕ периода: до «с» и с «по» (у своего
    // периода — два запроса; строка, попавшая в оба при перевёрнутых датах, — одна).
    // Тот же фильтр «Оператор» и та же видимость, что у доски; без предела.
    const outsideJobs = [];
    if (outside && (b.from || b.to)) {
        const lite = (edge) => {
            let q = db.from('crm_requests').select(OUTSIDE_SELECT);
            if (keys.length) q = q.not('status', 'in', keys);
            return withOperator(edge(q), operator, me);
        };
        if (b.from) outsideJobs.push(lite((q) => q.lt('created_at', b.from)));
        if (b.to) outsideJobs.push(lite((q) => q.gte('created_at', b.to)));
    }

    const [results, outsideRes] = await Promise.all([Promise.all(jobs), Promise.all(outsideJobs)]);
    const failed = results.find((r) => !r || r.error);
    if (failed) return { rows: [], counts: {}, capped: {}, outside: null, error: (failed && failed.error) || { message: 'нет ответа' } };
    const byId = new Map();
    for (const res of results) for (const r of res.data || []) if (r && r.id != null) byId.set(String(r.id), r);
    let outsideRows = null;
    if (outsideJobs.length && !outsideRes.some((r) => !r || r.error)) {
        const seen = new Map();
        for (const res of outsideRes) for (const r of res.data || []) if (r && r.id != null) seen.set(String(r.id), r);
        outsideRows = [...seen.values()];
    }
    return { rows: [...byId.values()].sort((x, y) => Number(y.id) - Number(x.id)), counts, capped, outside: outsideRows };
}

// CRM_UNIFY_V1 (задача 8) — СТРОКИ «ОТЧЁТА» (Р14). Отчёт считал state.rows — то,
// что загрузила доска (раньше 800 последних, теперь закрытые только за период
// доски), и его числа зависели от того, что открыто на экране. Теперь у отчёта
// свой лёгкий запрос: только нужные для подсчёта колонки, за его собственный
// период и с фильтром оператора. Видимость — та же, что у доски (компилятор).
export const REPORT_SELECT = 'id, status, source, sources, created_at, assigned_to';
/**
 * @param {object} o
 * @param {number} o.days  период отчёта в днях (0 — всё время)
 * @returns {Promise<object[]|null>}  null — сервер не ответил
 */
export async function loadReportRows({ db = supabase, days = 30, operator = 'all', me = null, now = new Date() } = {}) {
    let q = db.from('crm_requests').select(REPORT_SELECT);
    if (days) q = q.gte('created_at', new Date(now.getTime() - days * 86400000).toISOString());
    const { data, error } = await withOperator(q, operator, me);
    return error ? null : (data || []);
}
