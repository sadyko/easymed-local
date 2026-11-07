// MY_REFERRALS_V1 (3.22.0, решение владельца 2026-11-07, п. 11) — ВКЛАДКА «МОИ НАПРАВЛЕНИЯ»
// КАБИНЕТА ВРАЧА.
//
// Всё, что этот врач направил («Направить на услуги», рекомендации, запись к коллеге), по всем
// пациентам: дата, пациент, услуга, группа, статус (не выставлено / ждёт оплаты / оплачено /
// в работе / готово / отменено / возвращено), исполнитель. Период (по умолчанию последние 30
// дней) читает сервер (rpc my_referrals); группа и поиск — здесь, по ответу.
//
// «Результат» — у готового, у чего есть документ, и только если карта пациента открывает роли
// нужную вкладку (решает сервер, rpc my_referrals → result). Документ читается тем же окном
// данных, что «Вставить результаты» (rpc patient_doc_sources — правило карты пациента), и
// показывается теми же разметками (paste-sources.js docInsertHtml / labInsertHtml): прав шире
// прежних нет. Не нашёлся (пределы окна у пациента с очень длинной историей) — так и сказано.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast, fmtDate } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { isOn } from '../../shared/flags.js';
import { todayIso } from '../../shared/month-grid.js?v=mg1';   // местный день, а не UTC (DATE_LIMITS_V1)
import { docInsertHtml, labInsertHtml, docTitle, insertDay } from './paste-sources.js';

export const REFERRAL_GROUPS = Object.freeze([
    { key: 'consult',   label: 'Консультации' },
    { key: 'diag',      label: 'Диагностика' },
    { key: 'lab',       label: 'Лаборатория' },
    { key: 'procedure', label: 'Процедуры' },
    { key: 'other',     label: 'Хирургия' },
]);
export const REFERRAL_STATUS = Object.freeze({
    not_billed:       { label: 'Не выставлено', kind: '' },
    awaiting_payment: { label: 'Ждёт оплаты',   kind: 'warn' },
    paid:             { label: 'Оплачено',      kind: 'info' },
    in_work:          { label: 'В работе',      kind: 'info' },
    done:             { label: 'Готово',        kind: 'ok' },
    cancelled:        { label: 'Отменено',      kind: '' },
    refunded:         { label: 'Возвращено',    kind: 'crit' },
});
const DEFAULT_DAYS = 30;
const DOC_LIMIT = 100;

const txt = (s) => document.createTextNode(String(s == null ? '' : s));   // данные пациента — мимо словаря

/** Вкладка видна врачу: флаг is_doctor (ADMIN_DOCTOR_V1) или роль врача / главного врача. */
export function canSeeMyReferrals(u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null) {
    if (!u) return false;
    if (isOn(u.is_doctor)) return true;
    const roles = [u.role, ...(Array.isArray(u.extra_roles) ? u.extra_roles : [])].map((r) => String(r == null ? '' : r).trim().toLowerCase());
    return roles.includes('doctor') || roles.includes('head_doctor');
}

/** Местный день «ГГГГ-ММ-ДД» n дней назад. */
function daysAgoYmd(n) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return todayIso(d);
}

export const state = { loaded: false, loading: false, rows: [], truncated: false, error: null,
    from: '', to: '', group: '', search: '' };

/** Каждое открытие кабинета — последние 30 дней, без группы и поиска. */
export function resetMyReferrals() {
    state.loaded = false; state.loading = false; state.rows = []; state.truncated = false; state.error = null;
    state.from = daysAgoYmd(DEFAULT_DAYS - 1); state.to = daysAgoYmd(0); state.group = ''; state.search = '';
}

/** Прочитать направления за период с сервера. */
export async function loadMyReferrals() {
    if (!state.from || !state.to) resetMyReferrals();
    state.loading = true;
    const { data, error } = await supabase.rpc('my_referrals', { from: state.from, to: state.to });
    state.loading = false;
    if (error) { state.error = error.message || String(error); state.rows = []; state.loaded = true; return false; }
    state.error = null;
    state.rows = (data && Array.isArray(data.rows)) ? data.rows : [];
    state.truncated = !!(data && data.truncated);
    state.loaded = true;
    return true;
}

/** Строки после группы и поиска (пациент, номер карты, услуга, исполнитель). */
export function shownRows(rows = state.rows, { group = state.group, search = state.search } = {}) {
    const q = String(search || '').trim().toLowerCase();
    return (rows || []).filter((r) => (!group || r.group === group)
        && (!q || [r.patient_name, r.patient_mrn, r.service, r.performer].some((v) => String(v || '').toLowerCase().includes(q))));
}

const groupLabel = (key) => { const g = REFERRAL_GROUPS.find((x) => x.key === key); return g ? tr(g.label) : ''; };
function statusTag(status) {
    const s = REFERRAL_STATUS[status] || { label: status || '—', kind: '' };
    return h('span', { 'data-ref-status': status }, Tag(tr(s.label), { kind: s.kind, dot: true }));
}

/** Документ строки в ответе patient_doc_sources или null. */
export function findResultDoc(data, row) {
    const g = (data && data.groups) || {};
    const id = Number(row && row.visit_service_id);
    if (!id) return null;
    if (row.result === 'labs') {
        for (const d of g.labs || []) if ((d.panels || []).some((p) => Number(p.visit_service_id) === id)) return d;
        return null;
    }
    for (const k of ['diag', 'consult']) for (const d of g[k] || []) if (Number(d.visit_service_id) === id) return d;
    return null;
}

/** Разметка документа строки: текст — все разделы; анализы — только показатели этой строки. */
export function resultHtml(doc, row) {
    if (!doc) return '';
    if (doc.kind === 'labs') {
        const keys = [];
        (doc.panels || []).forEach((p, pi) => {
            if (Number(p.visit_service_id) === Number(row.visit_service_id)) (p.rows || []).forEach((_, ri) => keys.push(pi + ':' + ri));
        });
        return labInsertHtml(doc, keys);
    }
    return docInsertHtml(doc, (doc.sections || []).map((s) => s.key));
}

// Отказ сервера: сначала шаблон, потом значения (I18N_COVERAGE_V1).
function errorText(error) {
    const params = {};
    for (const [k, v] of Object.entries((error && error.params) || {})) params[k] = typeof v === 'string' ? tr(v) : v;
    return trf((error && error.message) || 'нет ответа', params);
}

/* i18n-exempt-start: лист печати — документ пациента (как бланки), не текст экрана */
/* type-scale-exempt-start: лист печати результата — бумага, не экран */
function printResult(title, patient, html) {
    const w = window.open('', '_blank');
    if (!w) { toast(tr('Для печати разрешите всплывающие окна.'), 'warn'); return; }
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    w.document.open();
    w.document.write('<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>' + esc(title) + '</title><style>'
        + 'body{font-family:Arial,sans-serif;font-size:13px;color:#111;margin:18mm 16mm;line-height:1.45}'
        + 'h1{font-size:16px;margin:0 0 4px}.p{color:#444;margin-bottom:12px}'
        + 'table{border-collapse:collapse;width:100%;margin:6px 0 12px}td,th{border:1px solid #bbb;padding:4px 8px;text-align:left}'
        + '</style></head><body><h1>' + esc(title) + '</h1><div class="p">' + esc(patient) + '</div>' + html + '</body></html>');
    w.document.close();
    try { w.focus(); w.print(); } catch (_) { /* окно печатают вручную */ }
}
/* type-scale-exempt-end */
/* i18n-exempt-end */

/** «Результат»: документ строки окном просмотра (rpc patient_doc_sources — правило карты пациента). */
export async function openReferralResult(row) {
    const { data, error } = await supabase.rpc('patient_doc_sources', { patient_id: row.patient_id, limit: DOC_LIMIT });
    if (error) { toast(errorText(error), 'fail'); return null; }
    const doc = findResultDoc(data, row);
    const html = resultHtml(doc, row);
    if (!doc || !html) { toast(tr('Документ не найден — откройте карту пациента.'), 'warn'); return null; }
    const title = docTitle(doc) || row.service || '';
    const day = insertDay(doc);
    const overlay = h('div', { class: 'modal', 'data-ref-result': String(row.visit_service_id), style: { zIndex: '140' } });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', role: 'dialog', style: { width: '720px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Doc', { size: 16 }), ' ', txt(title)),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        h('div', { class: 'muted', style: { padding: '8px 16px 0', fontSize: '12.5px' } },
            txt([row.patient_name, row.patient_mrn, day, doc.doctor].filter(Boolean).join(' · '))),
        h('div', { class: 'modal-body', 'data-ref-result-body': '', style: { padding: '12px 16px', maxHeight: '62vh', overflowY: 'auto', fontSize: '13.5px' }, html }),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '12px 16px', borderTop: '1px solid var(--ink-100, #eee)' } },
            h('button', { class: 'btn btn-outline', type: 'button', onclick: close }, tr('Закрыть')),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => printResult(title, [row.patient_name, row.patient_mrn, day].filter(Boolean).join(' · '), html) },
                Icon('Print', { size: 14 }), ' ', tr('Печать')))));
    document.body.appendChild(overlay);
    return overlay;
}

/**
 * Вкладка «Мои направления». onChange — перерисовать вкладку (после чтения с сервера).
 */
export function myReferralsView(onChange = () => {}) {
    if (!state.from || !state.to) resetMyReferrals();
    const reload = async () => { await loadMyReferrals(); onChange(); };
    const dateInput = (key) => h('input', { type: 'date', value: state[key], 'data-ref-period': key,
        style: { height: '34px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', fontFamily: 'inherit' },
        onchange: (e) => { const v = String(e.target.value || ''); if (!v) return; state[key] = v; reload(); } });
    const groupSel = h('select', { 'data-ref-group': '', title: 'Группа',
        style: { height: '34px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', fontFamily: 'inherit' },
        onchange: (e) => { state.group = e.target.value || ''; paintList(); } },
        h('option', { value: '' }, tr('Все группы')),
        ...REFERRAL_GROUPS.map((g) => h('option', { value: g.key }, tr(g.label))));
    groupSel.value = state.group;
    const search = h('input', { type: 'search', value: state.search, 'data-ref-search': '', placeholder: 'Поиск: пациент, услуга, исполнитель…',
        style: { height: '34px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', width: '280px', maxWidth: '100%' },
        oninput: (e) => { state.search = e.target.value; paintList(); } });
    const count = h('b', { 'data-ref-count': '', style: { color: 'var(--ink-800)' } }, '0');
    const listEl = h('div', { 'data-ref-list': '' });
    const card = h('div', { class: 'card', 'data-my-referrals': '' },
        h('div', { class: 'card-header', style: { flexWrap: 'wrap', gap: '10px' } },
            h('div', { class: 'row', style: { gap: '8px', flex: '1', flexWrap: 'wrap', alignItems: 'center' } },
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Период')), dateInput('from'),
                h('span', { class: 'muted' }, '—'), dateInput('to'),
                groupSel, search,
                h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-ref-refresh': '', onclick: reload },
                    Icon('Refresh', { size: 13 }), ' ', tr('Обновить'))),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Показано'), ' ', count, ' ', tr('из'), ' ', txt(String(state.rows.length)))),
        state.truncated ? h('div', { class: 'muted', 'data-ref-truncated': '', style: { padding: '8px 16px', fontSize: '12.5px' } },
            tr('Показаны последние направления периода — сузьте период, чтобы увидеть остальные.')) : null,
        listEl);

    function paintList() {
        clear(listEl);
        if (!state.loaded) { listEl.appendChild(h('div', { class: 'empty', style: { padding: '30px' } }, tr('Загрузка…'))); count.textContent = '0'; return; }
        if (state.error) { listEl.appendChild(h('div', { class: 'empty', style: { padding: '30px' } }, trf('Не удалось загрузить: {msg}', { msg: tr(state.error) }))); count.textContent = '0'; return; }
        const rows = shownRows();
        count.textContent = String(rows.length);
        if (!rows.length) {
            listEl.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
                state.rows.length ? tr('Ничего не найдено') : tr('За этот период вы никого не направляли.')));
            return;
        }
        const body = h('tbody', null, ...rows.map((r) => h('tr', { 'data-ref-row': r.kind + ':' + r.id },
            h('td', { class: 'num', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, txt(fmtDate(r.sent_at)),
                r.visit_date ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, trf('визит {day}', { day: fmtDate(r.visit_date) })) : null),
            h('td', null, h('div', { class: 'cell-strong' }, txt(r.patient_name || '—')),
                r.patient_mrn ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, txt(r.patient_mrn)) : null),
            h('td', null, txt(r.service || '—'),
                r.kind === 'rec' ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('рекомендация')) : null),
            h('td', null, groupLabel(r.group)),
            h('td', null, statusTag(r.status)),
            h('td', null, txt(r.performer || '—')),
            h('td', { style: { textAlign: 'right' } },
                r.result ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-ref-result-btn': String(r.visit_service_id),
                    onclick: () => openReferralResult(r) }, Icon('Doc', { size: 13 }), ' ', tr('Результат')) : null))));
        listEl.appendChild(h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, tr('Дата')), h('th', null, tr('Пациент')), h('th', null, tr('Услуга')), h('th', null, tr('Группа')),
                h('th', null, tr('Статус')), h('th', null, tr('Исполнитель')), h('th', null, ''))),
            body)));
    }
    paintList();
    return card;
}
