// OPERATOR_KPI_V1 (2026-11-14) — «Мой KPI»: дашборд оператора колл-центра.
//
// Владелец, со снимком доски CRM: «I want that each call operator has his own
// dashboard and he can see his KPI … the KPI setting we already have when we
// create employee, do not touch it there, just bring fix and % of interest if
// it is set there».
//
// Открывается кнопкой «Мой KPI» в шапке CRM большим окном — как «Cust Dev»
// (custdev.js), а не отдельным разделом: оператор живёт на доске, и свои
// цифры ему нужны рядом с ней, а не через меню. Оператор видит себя;
// руководитель колл-центра (видит всю доску) выбирает любого оператора.
//
// Числа и определения — на сервере (rpc/operator-kpi.js): заявки — те, что
// оператор ВЕДЁТ; звонки — по его внутреннему номеру; оклад и процент — из
// карточки сотрудника как есть. Экран только раскладывает.

import { supabase } from '../../supabase.js';
import { h, Icon, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { kpiTile } from './dash-kpi.js';
import { barChart, legend } from './dash-charts.js';

export const KPI_PERIODS = [
    { key: 'today',      label: 'Сегодня' },
    { key: 'week',       label: 'Эта неделя' },
    { key: 'month',      label: 'Этот месяц' },
    { key: 'prev_month', label: 'Прошлый месяц' },
];
const state = { period: 'month', userId: null };

function money(n) {
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? '-' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
const num = (n) => money(n);
const pct = (v) => String(Math.round((Number(v) || 0) * 10) / 10).replace('.', ',') + '%';
const dmy = (s) => (s ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : '');

export async function openOperatorKpi() {
    const overlay = h('div', { class: 'modal', 'data-operator-kpi': '' });
    const close = () => overlay.remove();
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

    const title = h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '1px' } }, '');
    const controls = h('div', { class: 'okpi-controls' });
    const body = h('div', { class: 'modal-body okpi-body' });

    overlay.appendChild(h('div', {
        class: 'modal-card',
        style: { width: 'calc(100vw - 48px)', maxWidth: '1280px', height: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column' },
    },
        h('header', { class: 'modal-head' },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
                h('span', { class: 'okpi-ico' }, Icon('Target', { size: 17 })),
                h('div', null, h('h2', { style: { margin: 0, fontSize: '15px' } }, tr('Мой KPI')), title)),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { style: { padding: '12px 20px 0' } }, controls),
        body));
    document.body.appendChild(overlay);

    async function load() {
        clear(body);
        body.appendChild(h('div', { class: 'muted', style: { padding: '28px', textAlign: 'center' } }, tr('Загрузка…')));
        const args = { period: state.period };
        if (state.userId) args.user_id = state.userId;
        const { data, error } = await supabase.rpc('crm_operator_kpi', args);
        if (!overlay.isConnected) return;
        clear(body);
        if (error || !data) {
            body.appendChild(h('div', { class: 'empty', style: { padding: '28px' } }, (error && error.message) || tr('Не удалось загрузить показатели.')));
            return;
        }
        title.textContent = data.operator.name + ' · ' + (data.period.from === data.period.to
            ? dmy(data.period.to) : dmy(data.period.from) + ' — ' + dmy(data.period.to));
        paintControls(data);
        paint(body, data);
    }

    function paintControls(d) {
        clear(controls);
        const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': tr('Период') });
        for (const p of KPI_PERIODS) {
            seg.appendChild(h('button', {
                type: 'button', class: state.period === p.key ? 'on' : null, 'data-okpi-period': p.key,
                'aria-pressed': state.period === p.key ? 'true' : 'false',
                onclick: () => { if (state.period !== p.key) { state.period = p.key; load(); } },
            }, p.label));
        }
        controls.appendChild(seg);
        if (d.can_pick && d.operators.length) {
            const sel = h('select', { class: 'okpi-pick', 'data-okpi-operator': '',
                onchange: (e) => { state.userId = Number(e.target.value) || null; load(); } });
            for (const o of d.operators) {
                const opt = h('option', { value: String(o.id) }, o.name);
                if (o.id === d.operator.id) opt.setAttribute('selected', 'selected');
                sel.appendChild(opt);
            }
            controls.appendChild(h('label', { class: 'okpi-pick-wrap' }, h('span', { class: 'muted' }, tr('Оператор')), sel));
        }
    }

    await load();
    return { close };
}

function section(titleText, ...children) {
    return h('section', { class: 'okpi-sec' }, h('h3', { class: 'okpi-sec-h' }, tr(titleText)), ...children);
}

function paint(body, d) {
    const L = d.leads;

    // 1. Оплата — то, ради чего оператор открывает окно.
    const pay = d.pay;
    if (pay.configured) {
        const items = [];
        if (pay.fixed != null) items.push(['Оклад в месяц', money(pay.fixed)]);
        if (pay.percent != null) {
            items.push(['Процент', String(pay.percent).replace('.', ',') + '%']);
            items.push(['Оплаты ваших пациентов', money(pay.revenue_base)]);
            items.push(['Бонус за период', money(pay.bonus)]);
        }
        if (pay.total != null) items.push(['К начислению за месяц', money(pay.total), 'total']);
        body.appendChild(section('Оплата',
            h('div', { class: 'okpi-pay' }, ...items.map(([l, v, cls]) =>
                h('div', { class: 'okpi-pay-i' + (cls ? ' okpi-' + cls : '') }, h('span', null, tr(l)), h('b', { class: 'num' }, v)))),
            pay.percent != null ? h('div', { class: 'okpi-note' },
                trf('Бонус — {p}% от оплат в кассу за период от пациентов, которых вы довели до визита: ваша заявка в колонке «Пришёл». Пациентов с оплатой: {n}.',
                    { p: String(pay.percent).replace('.', ','), n: num(pay.revenue_patients) })) : null,
            pay.fixed != null && pay.total == null ? h('div', { class: 'okpi-note' },
                tr('Оклад месячный: итог «к начислению» показывается за месяц.')) : null,
            h('div', { class: 'okpi-note' }, tr('Это ориентир по данным программы; итоговую зарплату считает бухгалтерия.'))));
    } else {
        body.appendChild(section('Оплата', h('div', { class: 'okpi-note' },
            tr('Оклад и процент в карточке сотрудника не заданы (Сотрудники → «Employment & salary»). Здесь показываются только показатели работы.'))));
    }

    // 2. Заявки.
    const tiles = h('div', { class: 'dash-kpi-row okpi-tiles' },
        kpiTile({ icon: 'Target', accent: 'primary', label: 'Заявок в работе', value: num(L.total),
            meta: trf('сейчас открытых: {n}', { n: num(d.open_now) }) }),
        kpiTile({ icon: 'Check', accent: 'ok', label: 'Пришли', value: num(L.came),
            meta: trf('конверсия {p}', { p: pct(L.conversion) }),
            split: d.rank ? trf('место среди операторов: {a} из {b}', { a: d.rank.place, b: d.rank.of }) : null }),
        kpiTile({ icon: 'Calendar', accent: 'info', label: 'Записаны', value: num(L.scheduled),
            meta: trf('с датой визита: {n}', { n: num(L.with_date) }) }),
        kpiTile({ icon: 'Warning', accent: 'warn', label: 'Не пришли', value: num(L.no_show), valueWarn: L.no_show > 0 }),
        kpiTile({ icon: 'Minus', accent: 'crit', label: 'Потеряно', value: num(L.lost) }),
        kpiTile({ icon: 'Patients', accent: 'primary', label: 'Стали пациентами', value: num(L.became_patient) }));
    body.appendChild(section('Заявки', tiles,
        h('div', { class: 'okpi-note' }, tr('Считаются заявки, которые вы ведёте (взяли в работу или вам передали), заведённые за период.'))));

    if ((d.series || []).length > 1) {
        const keys = [
            { key: 'leads', label: tr('Заявки'), color: 'var(--primary-500)' },
            { key: 'came', label: tr('Пришли'), color: 'var(--ok-500)' },
        ];
        body.appendChild(section('По дням', legend(keys), h('div', { class: 'okpi-chart' }, barChart({ series: d.series, keys, fmt: num, height: 180 }))));
    }

    // 3. Звонки.
    const c = d.calls;
    if (c) {
        body.appendChild(section('Звонки',
            h('div', { class: 'dash-kpi-row okpi-tiles' },
                kpiTile({ icon: 'PhoneIn', accent: 'info', label: 'Входящих', value: num(c.incoming),
                    meta: trf('отвечено {p}', { p: pct(c.answer_rate) }) }),
                kpiTile({ icon: 'PhoneMissed', accent: 'crit', label: 'Пропущено', value: num(c.missed), valueWarn: c.missed > 0 }),
                kpiTile({ icon: 'PhoneOut', accent: 'primary', label: 'Исходящих', value: num(c.outgoing),
                    meta: trf('дозвонились: {n}', { n: num(c.outgoing_answered) }) }),
                kpiTile({ icon: 'Clock', accent: 'ok', label: 'Разговоров, мин', value: num(c.talk_min),
                    meta: trf('среднее ожидание {s} с', { s: num(c.avg_wait_sec) }) })),
            h('div', { class: 'okpi-note' }, trf('По внутреннему номеру {ext}.', { ext: c.extension }))));
    } else {
        body.appendChild(section('Звонки', h('div', { class: 'okpi-note' },
            tr('Внутренний номер телефонии не задан — звонки посчитать не к чему. Его задают в карточке сотрудника.'))));
    }

    // 4. Задачи.
    body.appendChild(section('Задачи',
        h('div', { class: 'dash-kpi-row okpi-tiles' },
            kpiTile({ icon: 'Check', accent: 'ok', label: 'Выполнено за период', value: num(d.tasks.done) }),
            kpiTile({ icon: 'Clock', accent: 'warn', label: 'Открыто', value: num(d.tasks.open) }),
            kpiTile({ icon: 'Warning', accent: 'crit', label: 'Просрочено', value: num(d.tasks.overdue), valueWarn: d.tasks.overdue > 0 }))));
}
