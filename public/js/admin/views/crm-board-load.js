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
import { supabase } from '../../supabase.js';

export const CLOSED_ALL_TIME_LIMIT = 300;
export const BOARD_SELECT = '*, patients(id, full_name, mrn), users(full_name), services(id, name, price)';

// Перенесено из views/crm.js (CRM_PERIOD_WEEK_V1, CRM_PERIOD_CUSTOM_V1) без
// изменения смысла: граница — начало МЕСТНЫХ суток («7 дней» для регистратуры —
// семь календарных дней, а не 168 часов), неделя — с ПОНЕДЕЛЬНИКА, «по» —
// включая весь последний день, даты без 'Z' — местное время.
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
export function dayEnd(ymd) {
    if (!ymd) return null;
    const d = new Date(ymd + 'T23:59:59.999');
    return isNaN(d) ? null : d;
}

/** Границы created_at для загрузки закрытых карточек: ISO (UTC) или null с каждой стороны. */
export function periodBounds(period, customFrom = '', customTo = '', now = new Date()) {
    if (period === 'custom') {
        const f = dayStart(customFrom);
        const t = dayEnd(customTo);
        return { from: f ? f.toISOString() : null, to: t ? t.toISOString() : null };
    }
    const s = periodStart(period || 'all', now);
    return { from: s ? s.toISOString() : null, to: null };
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
 * @param {{from:string|null, to:string|null}} o.bounds  период для закрытых
 * @param {number} [o.closedLimit]  предел на закрытую колонку при «Всё время»;
 *   0 — без предела (CRM_UNIFY_V1, итоговое ревью: выгрузка Excel — явная просьба
 *   «всё», ей 300 на колонку не годятся)
 * @returns {Promise<{rows: object[], counts: Object<string, number>, capped: Object<string, boolean>, error?: object}>}
 *   counts/capped — только у обрезанных закрытых колонок («Всё время»): число из базы.
 */
export async function loadBoard({ db = supabase, closedKeys = [], bounds = { from: null, to: null }, operator = 'all', me = null,
    closedLimit = CLOSED_ALL_TIME_LIMIT } = {}) {
    const keys = (closedKeys || []).filter(Boolean);
    const counts = {};
    const capped = {};
    const jobs = [];

    // Открытые — всё, что не закрыто, без предела.
    let open = db.from('crm_requests').select(BOARD_SELECT);
    if (keys.length) open = open.not('status', 'in', keys);
    jobs.push(withOperator(open, operator, me).order('id', { ascending: false }));

    if (keys.length && (bounds.from || bounds.to || !closedLimit)) {
        // Период задан (или предел снят) — закрытые одним запросом, без предела.
        let q = db.from('crm_requests').select(BOARD_SELECT).in('status', keys);
        if (bounds.from) q = q.gte('created_at', bounds.from);
        if (bounds.to) q = q.lte('created_at', bounds.to);
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

    const results = await Promise.all(jobs);
    const failed = results.find((r) => !r || r.error);
    if (failed) return { rows: [], counts: {}, capped: {}, error: (failed && failed.error) || { message: 'нет ответа' } };
    const byId = new Map();
    for (const res of results) for (const r of res.data || []) if (r && r.id != null) byId.set(String(r.id), r);
    return { rows: [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id)), counts, capped };
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
