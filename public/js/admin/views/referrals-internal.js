// REFERRALS_CRM_V1 (2026-10-26) — вкладка «Внутренние врачи»: врачи клиники,
// которые направляют пациентов на услуги (recommended_services), с деньгами из
// отчёта «Рефералы» за период.
//
// Снимок владельца: плитки «Врачей направляли · Направлений · Выполнено ·
// Ожидают · Сумма выполненных · Вознаграждение», поиск «Врач или
// специальность», период; строка на каждого врача, и с нулями тоже.
import { h, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import {
    rpc, kpi, kpiRow, sumText, filterBar, loadingEl, errorEl, nameCell, actionButtons, openPrint, detailModal, simpleTable,
} from './referrals-common.js';
import { defaultPeriod, matches, dmy, printSheet, RECOMMENDATION_STATUS } from '../referrals-logic.js';

export async function renderReferralsInternal(host, ctx = {}) {
    const state = { ...defaultPeriod(), q: '', data: null, error: null };
    const refs = { kpis: h('div'), body: h('div') };
    clear(host);
    host.appendChild(refs.kpis);
    host.appendChild(filterBar({
        q: state.q, from: state.from, to: state.to, placeholder: 'Врач или специальность',
        onChange: ({ q, from, to }) => {
            const reload = from !== state.from || to !== state.to;
            state.q = q; state.from = from || state.from; state.to = to || state.to;
            if (reload) load(); else paintBody();
        },
    }));
    host.appendChild(refs.body);
    await load();

    async function load() {
        state.data = null; state.error = null;
        paintKpis(); paintBody();
        try { state.data = await rpc('referrals_internal', { from: state.from, to: state.to }); }
        catch (e) { state.error = (e && e.message) || String(e); }
        paintKpis(); paintBody();
    }

    function paintKpis() {
        clear(refs.kpis);
        const d = state.data; const t = d ? d.totals : {};
        refs.kpis.appendChild(kpiRow(
            kpi(d ? t.doctors_referring : '…', 'Врачей направляли'),
            kpi(d ? t.referrals : '…', 'Направлений'),
            kpi(d ? t.done : '…', 'Выполнено', { accent: 'ok' }),
            kpi(d ? t.waiting : '…', 'Ожидают'),
            d && d.money ? kpi(sumText(t.amount), 'Сумма выполненных') : null,
            d && d.money ? kpi(sumText(t.reward), 'Вознаграждение', { accent: 'ok' }) : null,
        ));
    }

    function paintBody() {
        clear(refs.body);
        if (state.error) { refs.body.appendChild(errorEl(state.error)); return; }
        if (!state.data) { refs.body.appendChild(loadingEl()); return; }
        const d = state.data;
        const rows = d.doctors.filter((r) => matches(r, state.q, ['full_name', 'specialty']));
        if (!rows.length) {
            refs.body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
                state.q ? 'По запросу ничего не найдено.' : 'Действующих врачей в клинике пока нет.'));
            return;
        }
        const tb = h('tbody');
        for (const r of rows) {
            tb.appendChild(h('tr', { 'data-ref-doctor': r.id },
                h('td', null, nameCell(r.full_name, r.specialty)),
                h('td', { class: 'num', style: { fontWeight: '700' } }, String(r.referrals)),
                h('td', { class: 'num' }, String(r.done)),
                h('td', { class: 'num' }, String(r.waiting)),
                h('td', { class: 'num' }, String(r.cancelled)),
                h('td', { class: 'num' }, String(r.patients)),
                d.money ? h('td', { class: 'num cell-mono' }, sumText(r.amount)) : null,
                d.money ? h('td', { class: 'num cell-mono', style: { fontWeight: '700' } }, sumText(r.reward)) : null,
                h('td', null, actionButtons({ onDetails: () => openDetails(r), onPrint: () => printDoctor(r) }))));
        }
        refs.body.appendChild(h('div', { class: 'card' },
            h('table', { class: 'tbl ref-tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Врач'), h('th', { class: 'num' }, 'Направлений'), h('th', { class: 'num' }, 'Выполнено'),
                    h('th', { class: 'num' }, 'Ожидают'), h('th', { class: 'num' }, 'Отменено'), h('th', { class: 'num' }, 'Пациентов'),
                    d.money ? h('th', { class: 'num' }, 'Сумма') : null, d.money ? h('th', { class: 'num' }, 'Вознаграждение') : null,
                    h('th', null, ''))),
                tb)));
    }

    const REF_COLUMNS = [
        { label: 'Дата', value: (r) => dmy(r.date) },
        { label: 'Пациент', value: (r) => r.patient || '—' },
        { label: 'Услуга', value: (r) => r.service || '—' },
        { label: 'Статус', value: (r) => tr(RECOMMENDATION_STATUS[r.status] || r.status) },
    ];
    const LINE_COLUMNS = [
        { label: 'Дата', value: (r) => dmy(r.date) },
        { label: 'Пациент', value: (r) => r.patient || '—' },
        { label: 'Услуга', value: (r) => r.service || '—' },
        { label: 'Сумма', value: (r) => sumText(r.amount), num: true, print: (r) => Math.round(r.amount) },
        { label: 'Оплачено', value: (r) => sumText(r.received), num: true, print: (r) => Math.round(r.received) },
        { label: 'Вознаграждение', value: (r) => sumText(r.reward), num: true, print: (r) => Math.round(r.reward) },
    ];

    function sheetFor(r, det) {
        return printSheet({
            title: trf('Направления врача {name}', { name: r.full_name }),
            from: det.from, to: det.to, columns: REF_COLUMNS, rows: det.referrals,
        });
    }

    async function openDetails(r) {
        let det = null;
        const m = detailModal({
            title: r.full_name,
            subtitle: [r.specialty, trf('Период: {from} — {to}', { from: dmy(state.from), to: dmy(state.to) })].filter(Boolean).join(' · '),
            onPrint: () => { if (det) openPrint(sheetFor(r, det)); },
        });
        try { det = await rpc('referrals_doctor_detail', { doctor_id: r.id, from: state.from, to: state.to }); }
        catch (e) { clear(m.body); m.body.appendChild(errorEl((e && e.message) || String(e))); return; }
        clear(m.body);
        m.body.appendChild(h('h3', { style: { margin: '0 0 8px' } }, 'Направления'));
        m.body.appendChild(simpleTable(REF_COLUMNS, det.referrals, { emptyText: tr('За период направлений не было.') }));
        if (det.money) {
            m.body.appendChild(h('h3', { style: { margin: '18px 0 8px' } }, 'Вознаграждение за оплаченные услуги'));
            m.body.appendChild(simpleTable(LINE_COLUMNS, det.lines || [], { emptyText: tr('Оплаченных услуг по направлениям за период нет.') }));
        }
    }

    async function printDoctor(r) {
        try {
            const det = await rpc('referrals_doctor_detail', { doctor_id: r.id, from: state.from, to: state.to });
            openPrint(sheetFor(r, det));
        } catch (e) { toast((e && e.message) || tr('Не удалось подготовить печать.'), 'error'); }
    }
}
