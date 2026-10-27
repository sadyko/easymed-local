// REFERRALS_CRM_V1 (2026-10-26) — чистая логика экрана «Реферирование»:
// период по умолчанию, группировка по представителям, поиск, подписи
// динамики и статуса, лист для печати. Без DOM — чтобы её читал тест, а
// вкладки (views/referrals-*.js) занимались только разметкой.
import { dynamics } from '../shared/referral-activity.js';

const pad2 = (n) => String(n).padStart(2, '0');
export function ymdLocal(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** Период по умолчанию — с 1-го числа текущего месяца по сегодня (как на снимке: 01.10 — 26.10). */
export function defaultPeriod(now = new Date()) {
    return { from: ymdLocal(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymdLocal(now) };
}

/** «26.10.2026» из «2026-10-26»; пусто — тире. */
export function dmy(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    return m ? m[3] + '.' + m[2] + '.' + m[1] : (ymd ? String(ymd) : '—');
}

/** Сумма с разрядами: 14 705 000. Нечисло — тире. */
export function fmtSum(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString('ru-RU');
}

/** Подпись пункта «№ 0003 · 998912098887 · ЛОР»: только непустые части. */
export function subline(parts) {
    return (parts || []).map((p) => (p == null ? '' : String(p).trim())).filter(Boolean).join(' · ');
}

/** Простой поиск по нескольким полям без учёта регистра. */
export function matches(row, q, fields) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return true;
    return fields.some((f) => String(row[f] == null ? '' : row[f]).toLowerCase().includes(needle));
}

/**
 * Группы вкладки «Представители»: по одному на представителя в порядке
 * списка, последняя — «Без представителя» (rep: null). Пустые группы
 * представителей остаются — у него пока нет врачей, и это видно; пустая
 * «Без представителя» не показывается. Итоги группы: врачей, сколько из них
 * направляли, визитов, пациентов (сумма по врачам), получено.
 */
export function groupByRepresentative(sources, representatives) {
    const groups = (representatives || []).map((r) => ({ rep: r, rows: [] }));
    const byId = new Map(groups.map((g) => [g.rep.id, g]));
    const none = { rep: null, rows: [] };
    for (const s of sources || []) {
        const g = s.representative_id != null ? byId.get(s.representative_id) : null;
        (g || none).rows.push(s);
    }
    if (none.rows.length) groups.push(none);
    for (const g of groups) g.totals = groupTotals(g.rows);
    return groups;
}

export function groupTotals(rows) {
    const t = { doctors: rows.length, referring: 0, visits: 0, patients: 0, received: 0 };
    for (const r of rows) {
        if (Number(r.visits) > 0) t.referring += 1;
        t.visits += Number(r.visits) || 0;
        t.patients += Number(r.patients) || 0;
        t.received += Number(r.received) || 0;
    }
    return t;
}

export const ACTIVITY_LABELS = Object.freeze({
    active: 'Активный', fading: 'Затихает', passive: 'Пассивный', never: 'Ни разу не направлял',
});
export const ACTIVITY_TAG = Object.freeze({ active: 'ok', fading: 'warn', passive: 'crit', never: '' });

/** Динамика для ячейки: «+3» (ok) / «−2» (crit) / «—». */
export function dynamicsCell(cur, prev) {
    const d = dynamics(cur, prev);
    if (d.kind === 'flat') return { text: '—', kind: '' };
    return { text: (d.delta > 0 ? '+' : '−') + Math.abs(d.delta), kind: d.delta > 0 ? 'ok' : 'crit' };
}

export const RECOMMENDATION_STATUS = Object.freeze({
    pending: 'Ожидает', done: 'Выполнено', cancelled: 'Отменено',
});
export const VISIT_STATUS_RU = Object.freeze({
    scheduled: 'Запланирован', confirmed: 'Подтверждён', arrived: 'Пришёл', cancelled: 'Отменён', no_show: 'Не пришёл',
});

/**
 * Лист для печати в форме, которую понимает reportPrintHtml (views/report-print.js):
 * колонки — подписи, строки — массивы в том же порядке. Числа остаются числами,
 * чтобы печать выровняла их вправо и посчитала «Итого».
 */
export function printSheet({ title, from, to, columns, rows }) {
    return {
        res: { columns: columns.map((c) => c.label), rows: rows.map((r) => columns.map((c) => (typeof c.value === 'function' ? c.value(r) : r[c.key]))) },
        meta: { title, from, to },
    };
}
