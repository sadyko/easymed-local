// REFERRALS_CRM_V1 (2026-10-26) — вкладка «Представители»: внешние врачи,
// сгруппированные по медпредставителям, с визитами, пациентами и деньгами за
// период; закрепление врача за представителем прямо в строке.
//
// Снимок владельца: плитки «Представителей · Врачей закреплено · Без
// представителя · Пациентов за период · Получено за период», поиск и период,
// карточка «Медпредставителей пока нет» и группа «Без представителя» со
// списком врачей (ФИО, «№ код · телефон», место работы, визитов, пациентов,
// получено, выпадающий список представителя, «Подробнее», «Печать»).
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { grantAllows } from '../permissions.js';
import {
    rpc, kpi, kpiRow, sumText, filterBar, loadingEl, errorEl, nameCell, actionButtons, openPrint, detailModal, simpleTable,
} from './referrals-common.js';
import {
    defaultPeriod, groupByRepresentative, matches, subline, fmtSum, dmy, printSheet, VISIT_STATUS_RU,
} from '../referrals-logic.js';

export async function renderReferralsRepresentatives(host, ctx = {}) {
    const state = { ...defaultPeriod(), q: '', data: null, error: null, collapsed: new Set() };
    const refs = { kpis: h('div'), body: h('div') };
    clear(host);
    host.appendChild(refs.kpis);
    host.appendChild(filterBar({
        q: state.q, from: state.from, to: state.to, placeholder: 'Представитель или врач',
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
        try {
            state.data = await rpc('referrals_representatives', { from: state.from, to: state.to });
        } catch (e) {
            state.error = (e && e.message) || String(e);
        }
        paintKpis(); paintBody();
    }

    function paintKpis() {
        clear(refs.kpis);
        const d = state.data;
        const t = d ? d.totals : {};
        const money = !!(d && d.money);
        refs.kpis.appendChild(kpiRow(
            kpi(d ? t.representatives : '…', 'Представителей'),
            kpi(d ? t.assigned : '…', 'Врачей закреплено'),
            kpi(d ? t.unassigned : '…', 'Без представителя', { accent: d && t.unassigned > 0 ? 'warn' : '' }),
            kpi(d ? t.patients : '…', 'Пациентов за период'),
            money ? kpi(sumText(t.received), 'Получено за период', { accent: 'ok' }) : null,
        ));
    }

    function paintBody() {
        clear(refs.body);
        if (state.error) { refs.body.appendChild(errorEl(state.error)); return; }
        if (!state.data) { refs.body.appendChild(loadingEl()); return; }
        const d = state.data;
        const canAssign = grantAllows('settings.referral_sources', 'edit');

        if (!d.representatives.length) {
            refs.body.appendChild(h('div', { class: 'card', style: { marginBottom: '16px' } },
                h('div', { class: 'empty', style: { padding: '40px 20px' } },
                    h('p', { style: { fontWeight: '600' } }, 'Медпредставителей пока нет'),
                    h('p', { class: 'muted', style: { fontSize: '13.5px', marginTop: '6px', maxWidth: '420px', marginLeft: 'auto', marginRight: 'auto' } },
                        'Заведите сотрудника с ролью «Медпредставитель» в «Настройки → Сотрудники». После этого за ним можно закреплять врачей.'))));
        }

        const q = state.q;
        const rows = d.sources.filter((s) => matches(s, q, ['name', 'code', 'phone', 'workplace'])
            || d.representatives.some((r) => r.id === s.representative_id && matches(r, q, ['full_name'])));
        const groups = groupByRepresentative(rows, d.representatives);
        if (!groups.length) {
            refs.body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
                q ? 'По запросу ничего не найдено.' : 'Внешних врачей пока нет: добавьте их во вкладке «Врачи-источники».'));
            return;
        }
        for (const g of groups) refs.body.appendChild(groupCard(g, d, canAssign));
    }

    function stat(value, label) {
        return h('div', { class: 'ref-stat' }, h('div', { class: 'ref-stat-value' }, value), h('div', { class: 'ref-stat-label muted' }, label));
    }

    function groupCard(g, d, canAssign) {
        const key = g.rep ? 'rep:' + g.rep.id : 'none';
        const collapsed = state.collapsed.has(key);
        const t = g.totals;
        const table = h('div', { class: 'ref-group-body', style: { display: collapsed ? 'none' : '' } }, groupTable(g, d, canAssign));
        const chev = h('span', { class: 'ref-group-chev', style: { transform: collapsed ? 'rotate(-90deg)' : '' } }, Icon('ChevronDown', { size: 14 }));
        const head = h('button', {
            class: 'ref-group-head', type: 'button', 'aria-expanded': collapsed ? 'false' : 'true',
            onclick: () => {
                const now = table.style.display !== 'none';
                table.style.display = now ? 'none' : '';
                chev.style.transform = now ? 'rotate(-90deg)' : '';
                head.setAttribute('aria-expanded', now ? 'false' : 'true');
                if (now) state.collapsed.add(key); else state.collapsed.delete(key);
            } },
            chev,
            h('div', { class: 'ref-group-title' },
                h('div', { style: { fontWeight: '600' } }, g.rep ? g.rep.full_name : tr('Без представителя')),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } }, g.rep ? tr('Медпредставитель') : tr('врачи, ни за кем не закреплённые'))),
            h('div', { class: 'ref-group-stats' },
                stat(String(t.doctors), 'Врачей'),
                stat(String(t.referring), 'Направляли'),
                stat(String(t.visits), 'Визитов'),
                stat(String(t.patients), 'Пациентов'),
                d.money ? stat(sumText(t.received), 'Получено') : null));
        return h('div', { class: 'card ref-group', 'data-ref-group': key, style: { marginBottom: '16px' } }, head, table);
    }

    function groupTable(g, d, canAssign) {
        if (!g.rows.length) return h('div', { class: 'empty', style: { padding: '20px' } }, 'За этим представителем врачи пока не закреплены.');
        const tb = h('tbody');
        for (const s of g.rows) {
            const sel = h('select', { class: 'ref-select', 'data-ref-assign': s.id, disabled: !canAssign,
                title: canAssign ? '' : tr('Закреплять врачей может роль с правом «Список источников: Изменение».'),
                onchange: async () => {
                    const prev = s.representative_id;
                    const next = sel.value === '' ? null : Number(sel.value);
                    sel.disabled = true;
                    try {
                        await rpc('referrals_assign_representative', { source_id: s.id, user_id: next });
                        s.representative_id = next;
                        toast(next == null ? 'Врач откреплён от представителя.' : 'Врач закреплён за представителем.', 'success');
                        // Строка переезжает в другую группу — счёт плиток и групп пересчитывается.
                        const t = state.data.totals;
                        const assigned = state.data.sources.filter((x) => x.representative_id != null).length;
                        t.assigned = assigned; t.unassigned = state.data.sources.length - assigned;
                        paintKpis(); paintBody();
                    } catch (e) {
                        sel.value = prev == null ? '' : String(prev);
                        toast((e && e.message) || tr('Не удалось сохранить.'), 'error');
                    } finally { sel.disabled = !canAssign; }
                } },
                h('option', { value: '', selected: s.representative_id == null }, '— без представителя —'),
                ...d.representatives.map((r) => h('option', { value: String(r.id), selected: s.representative_id === r.id }, r.full_name)));
            tb.appendChild(h('tr', { 'data-ref-source': s.id },
                h('td', null, nameCell(s.name, subline(['№ ' + s.code, s.phone, s.specialty]))),
                h('td', null, s.workplace || '—'),
                h('td', { class: 'num' }, String(s.visits)),
                h('td', { class: 'num' }, String(s.patients)),
                d.money ? h('td', { class: 'num cell-mono' }, sumText(s.received)) : null,
                h('td', null, sel),
                h('td', null, actionButtons({
                    onDetails: () => openDetails(s),
                    onPrint: () => printSource(s),
                }))));
        }
        return h('table', { class: 'tbl ref-tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Врач'), h('th', null, 'Место работы'), h('th', { class: 'num' }, 'Визитов'), h('th', { class: 'num' }, 'Пациентов'),
                d.money ? h('th', { class: 'num' }, 'Получено') : null, h('th', null, 'Представитель'), h('th', null, ''))),
            tb);
    }

    function detailColumns(money) {
        return [
            { label: 'Дата', value: (v) => dmy(v.date) },
            { label: 'Пациент', value: (v) => v.patient || '—' },
            { label: 'Услуги', value: (v) => v.services || '—' },
            { label: 'Статус', value: (v) => tr(VISIT_STATUS_RU[v.status] || v.status) },
            ...(money ? [
                { label: 'Получено', value: (v) => sumText(v.received), num: true, print: (v) => Math.round(v.received) },
                { label: 'Вознаграждение', value: (v) => sumText(v.reward), num: true, print: (v) => Math.round(v.reward) },
            ] : []),
        ];
    }

    function sheetFor(s, det) {
        const cols = detailColumns(det.money).map((c) => ({ label: c.label, value: c.print || c.value }));
        return printSheet({
            title: trf('Направления врача {name}', { name: s.name }) + (s.code ? ' (№ ' + s.code + ')' : ''),
            from: det.from, to: det.to, columns: cols, rows: det.visits,
        });
    }

    async function openDetails(s) {
        let det = null;
        const m = detailModal({
            title: s.name,
            subtitle: subline(['№ ' + s.code, s.phone, s.workplace, trf('Период: {from} — {to}', { from: dmy(state.from), to: dmy(state.to) })]),
            onPrint: () => { if (det) openPrint(sheetFor(s, det)); },
        });
        try {
            det = await rpc('referrals_source_detail', { source_id: s.id, from: state.from, to: state.to });
        } catch (e) {
            clear(m.body); m.body.appendChild(errorEl((e && e.message) || String(e))); return;
        }
        clear(m.body);
        m.body.appendChild(h('div', { class: 'ref-detail-stats' },
            stat(String(det.visits.length), 'Визитов'), stat(String(det.patients), 'Пациентов'),
            det.money ? stat(sumText(det.received), 'Получено') : null,
            det.money ? stat(sumText(det.reward), 'Вознаграждение') : null));
        m.body.appendChild(simpleTable(detailColumns(det.money), det.visits, { emptyText: tr('За период визитов от этого врача не было.') }));
    }

    async function printSource(s) {
        try {
            const det = await rpc('referrals_source_detail', { source_id: s.id, from: state.from, to: state.to });
            openPrint(sheetFor(s, det));
        } catch (e) {
            toast((e && e.message) || tr('Не удалось подготовить печать.'), 'error');
        }
    }
}
