// REFERRALS_CRM_V1 (2026-10-26) — вкладка «Активность врачей»: кто из внешних
// врачей направляет, кто затихает, кто давно молчит.
//
// Снимок владельца: плитки «Активные · Затихают · Пассивные · Ни разу не
// направляли», фильтры «Последние 7 дн.» / «Все представители» / поиск,
// колонки Врач · Представитель · Последний пациент · За N дн. · Прошлый период ·
// Динамика · Всего · Telegram · Статус. Правило статуса — одно с сервером
// (shared/referral-activity.js): окна 30 / 90 фиксированы, выбранное окно
// меняет только две колонки счёта.
import { h, Tag, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { rpc, kpi, kpiRow, loadingEl, errorEl, nameCell, actionButtons, openPrint, detailModal, simpleTable, sumText } from './referrals-common.js';
import { matches, subline, dmy, dynamicsCell, printSheet, ACTIVITY_LABELS, ACTIVITY_TAG, VISIT_STATUS_RU, ymdLocal } from '../referrals-logic.js';
import { ACTIVITY_WINDOWS } from '../../shared/referral-activity.js';

const WINDOW_LABEL = { 7: 'Последние 7 дн.', 30: 'Последние 30 дн.', 90: 'Последние 90 дн.' };

export async function renderReferralsActivity(host, ctx = {}) {
    const state = { days: 30, rep: 'all', q: '', data: null, error: null };
    const refs = { kpis: h('div'), filters: h('div'), body: h('div') };
    clear(host);
    host.appendChild(refs.kpis);
    host.appendChild(refs.filters);
    host.appendChild(refs.body);
    paintFilters();
    await load();

    async function load() {
        state.data = null; state.error = null;
        paintKpis(); paintBody();
        try { state.data = await rpc('referrals_activity', { days: state.days, representative_id: state.rep }); }
        catch (e) { state.error = (e && e.message) || String(e); }
        paintKpis(); paintFilters(); paintBody();
    }

    function paintKpis() {
        clear(refs.kpis);
        const d = state.data; const t = d ? d.totals : {};
        refs.kpis.appendChild(kpiRow(
            kpi(d ? t.active : '…', 'Активные', { accent: 'ok' }),
            kpi(d ? t.fading : '…', 'Затихают', { accent: 'warn' }),
            kpi(d ? t.passive : '…', 'Пассивные', { accent: 'warn' }),
            kpi(d ? t.never : '…', 'Ни разу не направляли'),
        ));
    }

    function paintFilters() {
        clear(refs.filters);
        const reps = state.data ? state.data.representatives : [];
        const windowSel = h('select', { class: 'ref-select', 'data-ref-window': '', onchange: () => { state.days = Number(windowSel.value); load(); } },
            ...ACTIVITY_WINDOWS.map((n) => h('option', { value: String(n), selected: n === state.days }, WINDOW_LABEL[n])));
        const repSel = h('select', { class: 'ref-select', 'data-ref-rep': '', onchange: () => { state.rep = repSel.value; load(); } },
            h('option', { value: 'all', selected: state.rep === 'all' }, 'Все представители'),
            h('option', { value: 'none', selected: state.rep === 'none' }, 'Без представителя'),
            ...reps.map((r) => h('option', { value: String(r.id), selected: state.rep === String(r.id) }, r.full_name)));
        const search = h('input', { type: 'search', class: 'ref-search', value: state.q, placeholder: 'Врач, код, специальность', 'aria-label': 'Врач, код, специальность' });
        search.addEventListener('input', () => { state.q = search.value; paintBody(); });
        refs.filters.appendChild(h('div', { class: 'ref-filters' },
            windowSel, repSel, h('div', { class: 'ref-filters-search' }, search)));
    }

    function repName(id) {
        const r = state.data && state.data.representatives.find((x) => x.id === id);
        return r ? r.full_name : '—';
    }

    function paintBody() {
        clear(refs.body);
        if (state.error) { refs.body.appendChild(errorEl(state.error)); return; }
        if (!state.data) { refs.body.appendChild(loadingEl()); return; }
        const d = state.data;
        const rows = d.sources.filter((s) => matches(s, state.q, ['name', 'code', 'specialty', 'workplace']));
        if (!rows.length) {
            refs.body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
                state.q ? 'По запросу ничего не найдено.' : 'Внешних врачей пока нет: добавьте их во вкладке «Врачи-источники».'));
            return;
        }
        const tb = h('tbody');
        for (const s of rows) {
            const dyn = dynamicsCell(s.current, s.previous);
            tb.appendChild(h('tr', { 'data-ref-source': s.id, 'data-ref-status': s.status },
                h('td', null, nameCell(s.name, subline(['№ ' + s.code, s.specialty, s.workplace]))),
                h('td', null, s.representative_id != null ? repName(s.representative_id) : '—'),
                h('td', null, s.last_visit ? dmy(s.last_visit) : tr('никогда')),
                h('td', { class: 'num', style: { fontWeight: '700' } }, String(s.current)),
                h('td', { class: 'num' }, String(s.previous)),
                h('td', { class: 'num' }, dyn.kind ? Tag(dyn.text, { kind: dyn.kind }) : dyn.text),
                h('td', { class: 'num' }, String(s.total)),
                h('td', null, s.telegram ? Tag(tr('подключён'), { kind: 'ok' }) : '—'),
                h('td', null, Tag(tr(ACTIVITY_LABELS[s.status] || s.status), { kind: ACTIVITY_TAG[s.status] || '' })),
                h('td', null, actionButtons({ onDetails: () => openDetails(s), onPrint: () => printSource(s) }))));
        }
        refs.body.appendChild(h('div', { class: 'card' },
            h('table', { class: 'tbl ref-tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Врач'), h('th', null, 'Представитель'), h('th', null, 'Последний пациент'),
                    h('th', { class: 'num' }, trf('За {n} дн.', { n: d.days })), h('th', { class: 'num' }, 'Прошлый период'),
                    h('th', { class: 'num' }, 'Динамика'), h('th', { class: 'num' }, 'Всего'), h('th', null, 'Telegram'), h('th', null, 'Статус'), h('th', null, ''))),
                tb)));
    }

    // «Подробнее» активности — визиты за последние 90 дней: столько держит
    // правило статуса, и ровно это хочется видеть, когда врач «затихает».
    function detailPeriod() {
        const to = state.data ? state.data.today : ymdLocal(new Date());
        const d = new Date(to + 'T12:00:00'); d.setDate(d.getDate() - 89);
        return { from: ymdLocal(d), to };
    }
    function detailColumns(money) {
        return [
            { label: 'Дата', value: (v) => dmy(v.date) },
            { label: 'Пациент', value: (v) => v.patient || '—' },
            { label: 'Услуги', value: (v) => v.services || '—' },
            { label: 'Статус', value: (v) => tr(VISIT_STATUS_RU[v.status] || v.status) },
            ...(money ? [{ label: 'Получено', value: (v) => sumText(v.received), num: true, print: (v) => Math.round(v.received) }] : []),
        ];
    }
    function sheetFor(s, det) {
        return printSheet({
            title: trf('Направления врача {name}', { name: s.name }) + (s.code ? ' (№ ' + s.code + ')' : ''),
            from: det.from, to: det.to,
            columns: detailColumns(det.money).map((c) => ({ label: c.label, value: c.print || c.value })), rows: det.visits,
        });
    }
    async function openDetails(s) {
        const p = detailPeriod();
        let det = null;
        const m = detailModal({
            title: s.name,
            subtitle: subline(['№ ' + s.code, s.specialty, s.workplace, trf('Период: {from} — {to}', { from: dmy(p.from), to: dmy(p.to) })]),
            onPrint: () => { if (det) openPrint(sheetFor(s, det)); },
        });
        try { det = await rpc('referrals_source_detail', { source_id: s.id, ...p }); }
        catch (e) { clear(m.body); m.body.appendChild(errorEl((e && e.message) || String(e))); return; }
        clear(m.body);
        m.body.appendChild(simpleTable(detailColumns(det.money), det.visits, { emptyText: tr('За 90 дней визитов от этого врача не было.') }));
    }
    async function printSource(s) {
        try { const det = await rpc('referrals_source_detail', { source_id: s.id, ...detailPeriod() }); openPrint(sheetFor(s, det)); }
        catch (e) { toast((e && e.message) || tr('Не удалось подготовить печать.'), 'error'); }
    }
}
