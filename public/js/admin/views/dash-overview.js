// DASHBOARD_OVERVIEW_V1 (2026-10-30) — вкладка «Обзор клиники» на сводке.
//
// Владелец: «make super informative in terms of everything, CRM, Telegram bot,
// clinic, all the departments to Head of clinic».
//
// Вкладка «Сегодня» осталась взглядом в один экран (DASH_ONE_SCREEN_V1). Здесь —
// чтение для руководителя за выбранный период, сверху вниз в том порядке, в
// каком его читают:
//   1. ПЛИТКИ — главные числа периода, у каждого — сравнение с прошлым периодом
//      той же длины;
//   2. ТРЕБУЕТ ВНИМАНИЯ — только то, что сейчас не в порядке, с переходом туда,
//      где это чинят. Пустая полоса говорит «всё спокойно», а не молчит;
//   3. КАРТОЧКИ ОТДЕЛОВ — финансы, направления, врачи, услуги, CRM, телефония,
//      Telegram-бот, пациенты, лаборатория и стационар.
//
// Числа считает СЕРВЕР (rpc/dashboard-overview.js). Раздел, который роли не
// открыт, приходит null — карточки и плитки этого раздела здесь просто нет.
import { h, Icon } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { METHOD_RU } from '../../shared/payment-methods.js';
import { barChart, legend } from './dash-charts.js';
import { kpiTile } from './dash-kpi.js';
import { deptCards, deptAttentionItems } from './dash-overview-depts.js';   // DASHBOARD_CEO_V1

const CLINIC_COLOR = 'var(--primary-600)';
const WARD_COLOR = 'var(--purple-500)';
const CRIT_COLOR = 'var(--crit-500)';
const INFO_COLOR = 'var(--info-500)';

function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
const num = (v) => fmtPrice(v);
const pct = (v) => String(Math.round((Number(v) || 0) * 10) / 10).replace('.', ',') + '%';

/** «+12% к прошлому периоду». Без прошлого периода сравнивать не с чем — так и говорим. */
export function deltaText(cur, prev) {
    const c = Number(cur) || 0;
    const p = Number(prev) || 0;
    if (!p) return c ? tr('за прошлый период данных нет') : null;
    const d = Math.round(((c - p) / p) * 100);
    const s = (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d) + '%';
    return trf('{d} к прошлому периоду', { d: s });
}

/**
 * Пункты «Требует внимания» — только ненулевые. Чистая функция: тест
 * проверяет её без DOM.
 */
export function attentionItems(o, summary) {
    const out = [];
    const add = (when, icon, text, view, tone = 'warn') => { if (when) out.push({ icon, text, view, tone }); };
    const c = o.calls;
    const crm = o.crm;
    const tg = o.telegram;
    const f = o.finance;
    if (c) add(c.not_called_back > 0, 'PhoneMissed', trf('Пропущенные звонки без ответа: {n} номеров', { n: num(c.not_called_back) }), 'crm', 'crit');
    if (tg) add(tg.unread > 0, 'Msg', trf('Непрочитанные сообщения в Telegram: {n} в {c} чатах', { n: num(tg.unread), c: num(tg.unread_chats) }), 'telegram-chat', 'crit');
    if (crm) add(crm.tasks_overdue > 0, 'Clock', trf('Просроченные задачи CRM: {n}', { n: num(crm.tasks_overdue) }), 'crm');
    if (crm) add(crm.unassigned_now > 0, 'User', trf('Открытые заявки без ответственного: {n}', { n: num(crm.unassigned_now) }), 'crm');
    if (f) {
        const old = (f.debt_aging && f.debt_aging.older) || { n: 0, sum: 0 };
        add(old.n > 0, 'Receipt', trf('Долг старше 30 дней: {amount} ({n} счетов)', { amount: fmtPrice(old.sum), n: num(old.n) }), 'cashier-head', 'crit');
        add(f.shifts_open > 0, 'Coins', trf('Открытые кассовые смены: {n}', { n: num(f.shifts_open) }), 'cashier-shifts');
        add(f.shortage < 0, 'Warning', trf('Недостача в кассе за период: {amount}', { amount: fmtPrice(-f.shortage) }), 'cashier-shifts', 'crit');
    }
    if (tg) add(tg.docs_failed > 0, 'Send', trf('Документы, не доставленные в Telegram: {n}', { n: num(tg.docs_failed) }), 'telegram-chat');
    const low = summary ? Number(summary.low_stock_count) || 0 : 0;
    add(low > 0, 'Warning', trf('Низкий остаток: {n}', { n: num(low) }), 'inventory');
    out.push(...deptAttentionItems(o));   // DASHBOARD_CEO_V1 — чат Meta, склад, выписка с долгом
    return out;
}

// -----------------------------------------------------------------------------
// МЕЛКИЕ ЧАСТИ
// -----------------------------------------------------------------------------
function card(title, icon, right, actions, body, { wide = false } = {}) {
    const acts = (actions || []).filter(Boolean);
    return h('div', { class: 'card dash-card dho-card' + (wide ? ' dho-wide' : ''), 'data-reveal': '' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon(icon, { size: 16 }), ' ', tr(title)),
            h('div', { class: 'dash-card-right' },
                ...(right || []).filter(Boolean),
                acts.length ? h('div', { class: 'dash-card-acts' }, ...acts) : null)),
        h('div', { class: 'dash-card-body dho-body' }, body));
}

/** Сетка «подпись — число»: по ячейке на показатель. */
function stats(items) {
    return h('div', { class: 'dho-stats' }, ...items.filter(Boolean).map(([label, value, tone]) =>
        h('div', { class: 'dho-stat' + (tone ? ' dho-' + tone : '') },
            h('span', { class: 'dho-stat-v num' }, value),
            h('span', { class: 'dho-stat-l' }, tr(label)))));
}

function subhead(text) {
    return h('div', { class: 'dho-sub' }, tr(text));
}

/** Строка с полосой: подпись, доля от максимума, справа — числа. */
function barRow(label, value, max, right, color = CLINIC_COLOR, hint = null) {
    const w = max > 0 ? Math.max(2, Math.round((Math.max(0, value) / max) * 100)) : 0;
    return h('div', { class: 'dho-row' },
        h('span', { class: 'dho-row-name', title: label }, label,
            hint ? h('small', null, hint) : null),
        h('span', { class: 'dash-ward-bar' }, h('i', { style: { width: w + '%', background: color } })),
        h('span', { class: 'dho-row-n num' }, right));
}

function empty(text = 'Нет данных за период') {
    return h('div', { class: 'dash-chart-empty' }, tr(text));
}

// -----------------------------------------------------------------------------
// РАСКЛАДКА
// -----------------------------------------------------------------------------
/**
 * @param o        ответ dashboard_overview
 * @param summary  ответ dashboard_summary (низкий остаток) — может быть null
 * @param nav      { go(view) → handler, open(view) → bool }
 */
export function renderOverview(o, summary, nav) {
    const root = h('div', { class: 'dho' });
    const act = (label, icon, view) => (nav.open(view)
        ? h('button', { class: 'btn btn-ghost btn-sm dash-act', type: 'button', onclick: nav.go(view) },
            Icon(icon, { size: 13 }), ' ', tr(label))
        : null);
    const goIf = (view) => (nav.open(view) ? nav.go(view) : null);

    // DASHBOARD_ONE_VIEW_V1 — «Сегодня» стал периодом сводки: один день и
    // сравнение со вчерашним, а не «с 30.10 — 30.10».
    root.appendChild(h('div', { class: 'dho-period' },
        o.period.days === 1
            ? trf('Сегодня, {date}. Сравнение — со вчерашним днём.', { date: dmy(o.period.to) })
            : trf('Период: {from} — {to}. Сравнение — с {pfrom} — {pto}.', {
                from: dmy(o.period.from), to: dmy(o.period.to),
                pfrom: dmy(o.period.prev_from), pto: dmy(o.period.prev_to),
            })));

    // 1. Плитки.
    const p = o.patients || {};
    const f = o.finance;
    const crm = o.crm;
    const calls = o.calls;
    const tg = o.telegram;
    const lab = o.lab || {};
    const ip = o.inpatient || {};
    const tiles = h('div', { class: 'dash-kpi-row' });
    if (f) {
        tiles.appendChild(kpiTile({ icon: 'Coins', accent: 'ok', label: 'Выручка за период',
            value: fmtPrice(f.collected), meta: deltaText(f.collected, f.collected_prev),
            split: f.refunds ? trf('возвраты {amount}', { amount: fmtPrice(f.refunds) }) : null,
            onClick: goIf('reports-hub') }));
        tiles.appendChild(kpiTile({ icon: 'Receipt', accent: 'primary', label: 'Средний чек',
            value: fmtPrice(f.avg_check), meta: trf('счетов: {n}', { n: num(f.invoices) }),
            split: f.discounts ? trf('скидки {amount}', { amount: fmtPrice(f.discounts) }) : null }));
    }
    tiles.appendChild(kpiTile({ icon: 'Patients', accent: 'primary', label: 'Новые пациенты',
        value: num(p.new), meta: deltaText(p.new, p.new_prev), onClick: goIf('patients') }));
    tiles.appendChild(kpiTile({ icon: 'Calendar', accent: 'info', label: 'Визиты',
        value: num(p.visits), meta: deltaText(p.visits, p.visits_prev),
        split: trf('уникальных пациентов: {n}', { n: num(p.unique) }), onClick: goIf('queue') }));
    if (crm) {
        tiles.appendChild(kpiTile({ icon: 'Target', accent: 'warn', label: 'Заявки CRM',
            value: num(crm.leads), meta: deltaText(crm.leads, crm.leads_prev),
            split: trf('пришли {won} · конверсия {pct}', { won: num(crm.won), pct: pct(crm.conversion) }),
            onClick: goIf('crm') }));
    }
    if (calls) {
        tiles.appendChild(kpiTile({ icon: 'PhoneMissed', accent: 'crit', label: 'Пропущенные звонки',
            value: num(calls.missed), meta: trf('не перезвонили: {n} номеров', { n: num(calls.not_called_back) }),
            split: trf('отвечено {pct} входящих', { pct: pct(calls.answer_rate) }),
            valueWarn: calls.not_called_back > 0, onClick: goIf('crm') }));
    }
    if (tg) {
        tiles.appendChild(kpiTile({ icon: 'Bot', accent: 'info', label: 'Telegram-бот',
            value: num(tg.subscribers), meta: trf('подписчиков · новых за период {n}', { n: num(tg.new_subscribers) }),
            split: trf('сообщений {a} · непрочитано {b}', { a: num(tg.messages_in), b: num(tg.unread) }),
            onClick: goIf('telegram-chat') }));
    }
    tiles.appendChild(kpiTile({ icon: 'Bed', accent: 'ward', label: 'Поступило в стационар',
        value: num(ip.admissions), meta: deltaText(ip.admissions, ip.admissions_prev),
        split: ip.avg_los_days != null
            ? trf('выписано {n} · средний срок {d} дн.', { n: num(ip.discharges), d: String(ip.avg_los_days).replace('.', ',') })
            : trf('выписано {n}', { n: num(ip.discharges) }),
        onClick: goIf('admissions') }));
    // DASHBOARD_CEO_V1 — загрузка коек сейчас: первое, что спрашивает руководитель стационара.
    const ipx = o.inpatient_ext;
    if (ipx) {
        tiles.appendChild(kpiTile({ icon: 'Bed', accent: 'ward', label: 'Занято коек',
            value: ipx.occupancy + '%', meta: trf('{a} из {b}', { a: num(ipx.beds_busy), b: num(ipx.beds_total) }),
            split: trf('койко-дней за период: {n}', { n: String(ipx.bed_days).replace('.', ',') }),
            onClick: goIf('admissions') }));
    }
    tiles.appendChild(kpiTile({ icon: 'Flask', accent: 'info', label: 'Анализы готовы',
        value: num(lab.verified),
        meta: lab.avg_tat_hours != null ? trf('в среднем за {h} ч', { h: String(lab.avg_tat_hours).replace('.', ',') }) : null,
        split: lab.results ? trf('отклонения от нормы: {pct}', { pct: pct(lab.abnormal_pct) }) : null,
        onClick: goIf('labs') }));
    root.appendChild(tiles);

    // 2. Требует внимания.
    const items = attentionItems(o, summary);
    const att = h('div', { class: 'dho-attn', 'data-reveal': '' },
        h('div', { class: 'dho-attn-h' }, Icon('Bell', { size: 15 }), ' ', tr('Требует внимания')));
    if (!items.length) {
        att.appendChild(h('div', { class: 'dho-attn-ok' }, Icon('Check', { size: 14 }), ' ', tr('Всё спокойно — срочного нет')));
    } else {
        const list = h('div', { class: 'dho-attn-list' });
        for (const it of items) {
            const open = nav.open(it.view);
            list.appendChild(h(open ? 'button' : 'div', {
                class: 'dho-attn-i dho-' + it.tone, type: open ? 'button' : null,
                onclick: open ? nav.go(it.view) : null,
            }, Icon(it.icon, { size: 14 }), h('span', null, it.text),
            open ? Icon('ArrowRight', { size: 13 }) : null));
        }
        att.appendChild(list);
    }
    root.appendChild(att);

    // 3. Карточки отделов.
    // DASHBOARD_CEO_LAYOUT_V1 — владелец: «make card sized more appropriate to
    // each other to make look beautiful». Сетка по две, и в ряду стоят карточки
    // одной темы и близкой высоты (обе тянутся до высоты ряда, CSS .dho-grid):
    // раньше новые карточки шли хвостом, и рядом с длинной стояла короткая с
    // пустотой под ней. Раздела без доступа нет — пары за ним сдвигаются.
    const money = o.money_visible !== false;
    const d = deptCards(o, { card, stats, subhead, barRow, empty, act, num, pct, fmtPrice });
    const grid = h('div', { class: 'dho-grid' });
    for (const el of [
        f ? financeCard(f, act) : null,                     patientsCard(p, act),
        doctorsCard(o.doctors || [], money),                servicesCard(o.services || [], money),
        crm ? crmCard(crm, o.series || [], act) : null,     d.marketing,
        calls ? callsCard(calls, o.series || [], act) : null, d.callcenter,
        d.outpatient,                                       d.inpatient,
        directionsCard(o.directions || [], money, act),     d.procedures,
        tg ? telegramCard(tg, act) : null,                  d.referrers,
        d.stock,                                            labWardCard(lab, ip, act),
    ]) if (el) grid.appendChild(el);
    root.appendChild(grid);
    return root;
}

function dmy(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
}

function financeCard(f, act) {
    const body = h('div', null);
    body.appendChild(stats([
        ['Принято', fmtPrice(f.collected)],
        ['Возвраты', fmtPrice(f.refunds), f.refunds > 0 ? 'crit' : null],
        ['Скидки', fmtPrice(f.discounts)],
        ['Счетов', num(f.invoices)],
    ]));
    body.appendChild(subhead('Способы оплаты'));
    const methods = f.methods || [];
    const maxM = Math.max(0, ...methods.map((m) => m.sum));
    if (!methods.length) body.appendChild(empty());
    for (const m of methods) body.appendChild(barRow(tr(METHOD_RU[m.method] || m.method || '—'), m.sum, maxM, fmtPrice(m.sum)));
    body.appendChild(subhead('Долг по давности'));
    const ag = f.debt_aging || {};
    const rows = [['до 7 дней', ag.d7, 'var(--warn-500)'], ['8–30 дней', ag.d30, 'var(--warn-700)'], ['старше 30 дней', ag.older, CRIT_COLOR]];
    const maxD = Math.max(0, ...rows.map((r) => (r[1] && r[1].sum) || 0));
    for (const [label, v, color] of rows) {
        const x = v || { n: 0, sum: 0 };
        body.appendChild(barRow(tr(label), x.sum, maxD, fmtPrice(x.sum), color, ' · ' + trf('счетов: {n}', { n: num(x.n) })));
    }
    body.appendChild(subhead('Касса'));
    body.appendChild(stats([
        ['Смен закрыто', num(f.shifts_closed)],
        ['С расхождением', num(f.shifts_off), f.shifts_off > 0 ? 'warn' : null],
        ['Недостача', fmtPrice(-f.shortage), f.shortage < 0 ? 'crit' : null],
        ['Излишек', fmtPrice(f.surplus)],
    ]));
    return card('Финансы', 'Coins', [], [act('Касса', 'Coins', 'cashier-head'), act('Отчёты', 'Chart', 'reports-hub')], body);
}

function directionsCard(rows, money, act) {
    const body = h('div', null);
    if (!rows.length) body.appendChild(empty());
    const key = money ? 'sum' : 'n';
    const max = Math.max(0, ...rows.map((r) => r[key] || 0));
    for (const r of rows) {
        const name = r.inpatient ? tr('Стационар') : (r.name || tr('Прочее'));
        const right = money ? fmtPrice(r.sum) : num(r.n);
        body.appendChild(barRow(name, r[key] || 0, max, right, r.inpatient ? WARD_COLOR : CLINIC_COLOR,
            ' · ' + trf('услуг {n} · выполнено {d}', { n: num(r.n), d: num(r.done) })));
    }
    return card('Направления', 'Layers', [money ? h('span', { class: 'dho-note' }, tr('сумма назначенных услуг')) : null],
        [act('Отчёты', 'Chart', 'reports-hub')], body);
}

function doctorsCard(rows, money) {
    const body = h('div', null);
    if (!rows.length) body.appendChild(empty());
    const key = money ? 'sum' : 'n';
    const max = Math.max(0, ...rows.map((r) => r[key] || 0));
    for (const r of rows) {
        body.appendChild(barRow(r.name || '—', r[key] || 0, max, money ? fmtPrice(r.sum) : num(r.n), CLINIC_COLOR,
            ' · ' + trf('пациентов {p} · услуг {n}', { p: num(r.patients), n: num(r.n) })));
    }
    return card('Врачи', 'Stethoscope', [h('span', { class: 'dho-note' }, tr(money ? 'первые 10 по сумме' : 'первые 10 по числу услуг'))], [], body);
}

function servicesCard(rows, money) {
    const body = h('div', null);
    if (!rows.length) body.appendChild(empty());
    const key = money ? 'sum' : 'n';
    const max = Math.max(0, ...rows.map((r) => r[key] || 0));
    for (const r of rows) {
        body.appendChild(barRow(r.name || '—', r[key] || 0, max, money ? fmtPrice(r.sum) : num(r.n), 'var(--primary-500)',
            money ? ' · ' + trf('раз: {n}', { n: num(r.n) }) : null));
    }
    return card('Популярные услуги', 'Activity', [h('span', { class: 'dho-note' }, tr(money ? 'первые 10 по сумме' : 'первые 10 по числу услуг'))], [], body);
}

/** Полоса цвета колонки доски — тот же словарь, что у CRM (crm_stages.color). */
const STAGE_COLOR = { info: INFO_COLOR, warn: 'var(--warn-500)', purple: WARD_COLOR, teal: 'var(--primary-500)', ok: 'var(--ok-500)', crit: CRIT_COLOR };

function crmCard(c, series, act) {
    const body = h('div', null);
    body.appendChild(stats([
        ['Заявок', num(c.leads)],
        ['Пришли', num(c.won), 'ok'],
        ['Конверсия', pct(c.conversion)],
        ['Отказ', num(c.lost)],
        ['В работе сейчас', num(c.open_now)],
        ['Без ответственного', num(c.unassigned_now), c.unassigned_now > 0 ? 'warn' : null],
        ['Просрочено задач', num(c.tasks_overdue), c.tasks_overdue > 0 ? 'crit' : null],
        c.meta_leads ? ['Заявок из Meta', num(c.meta_leads)] : null,
    ]));
    const keys = [{ key: 'leads', label: tr('Заявки'), color: 'var(--warn-500)' }];
    body.appendChild(h('div', { class: 'dho-chart' }, barChart({ series, keys, fmt: num, height: 150 })));
    body.appendChild(subhead('Воронка периода'));
    const stages = (c.stages || []).filter((s) => s.n > 0);
    const maxS = Math.max(0, ...stages.map((s) => s.n));
    if (!stages.length) body.appendChild(empty());
    for (const s of stages) body.appendChild(barRow(s.label || s.key, s.n, maxS, num(s.n), STAGE_COLOR[s.color] || 'var(--ink-400)'));
    body.appendChild(subhead('Источники'));
    const src = c.sources || [];
    const maxSrc = Math.max(0, ...src.map((s) => s.n));
    for (const s of src) {
        body.appendChild(barRow(s.label || s.key || '—', s.n, maxSrc, num(s.n), 'var(--warn-500)',
            ' · ' + trf('пришли {won} ({pct})', { won: num(s.won), pct: pct(s.n ? (s.won / s.n) * 100 : 0) })));
    }
    body.appendChild(subhead('Операторы'));
    const ops = c.operators || [];
    const maxO = Math.max(0, ...ops.map((s) => s.n));
    for (const s of ops) {
        body.appendChild(barRow(s.name || tr('Без ответственного'), s.n, maxO, num(s.n), CLINIC_COLOR,
            ' · ' + trf('пришли {won}', { won: num(s.won) })));
    }
    return card('CRM — заявки', 'Target', [], [act('Открыть CRM', 'ArrowRight', 'crm')], body);
}

function callsCard(c, series, act) {
    const body = h('div', null);
    body.appendChild(stats([
        ['Входящих', num(c.incoming)],
        ['Исходящих', num(c.outgoing)],
        ['Отвечено', num(c.answered), 'ok'],
        ['Пропущено', num(c.missed), c.missed > 0 ? 'crit' : null],
        ['Не перезвонили', num(c.not_called_back), c.not_called_back > 0 ? 'crit' : null],
        ['Доля ответа', pct(c.answer_rate)],
        ['Ожидание, сек', num(c.avg_wait_sec)],
        ['Разговоров, мин', num(c.talk_min)],
    ]));
    const keys = [
        { key: 'calls_in', label: tr('Входящие'), color: INFO_COLOR },
        { key: 'missed', label: tr('Пропущенные'), color: CRIT_COLOR },
    ];
    body.appendChild(h('div', { class: 'dho-chart' }, barChart({ series, keys, fmt: num, height: 170 })));
    return card('Телефония', 'Headset', [legend(keys)], [act('Звонки', 'Phone', 'crm')], body);
}

function telegramCard(t, act) {
    const body = h('div', null);
    body.appendChild(subhead('Подписчики'));
    body.appendChild(stats([
        ['Подписаны на бота', num(t.subscribers)],
        ['Новых за период', num(t.new_subscribers), 'ok'],
        ['Заблокировали бота', num(t.blocked), t.blocked > 0 ? 'warn' : null],
        ['Заявок по ссылкам', num(t.deeplink_leads)],
    ]));
    body.appendChild(subhead('Переписка'));
    body.appendChild(stats([
        ['Сообщений от пациентов', num(t.messages_in)],
        ['Диалогов', num(t.chats)],
        ['Ответов клиники', num(t.replies)],
        ['Непрочитано', num(t.unread), t.unread > 0 ? 'crit' : null],
    ]));
    body.appendChild(subhead('Рассылки и документы'));
    body.appendChild(stats([
        ['Документов отправлено', num(t.docs_sent)],
        ['Не доставлено', num(t.docs_failed), t.docs_failed > 0 ? 'crit' : null],
        ['Рассылок', num(t.broadcasts)],
        ['Получили рассылку', num(t.broadcast_sent)],
    ]));
    return card('Telegram-бот', 'Bot', [], [act('Чат', 'Msg', 'telegram-chat')], body);
}

function patientsCard(p, act) {
    const body = h('div', null);
    body.appendChild(stats([
        ['Новых пациентов', num(p.new)],
        ['Визитов', num(p.visits)],
        ['Уникальных', num(p.unique)],
        ['Первичных', num(p.first)],
        ['Повторных', num(p.repeat)],
        ['Отменено и не пришли', num(p.cancelled), p.cancelled > 0 ? 'warn' : null],
    ]));
    body.appendChild(subhead('Возраст пришедших'));
    const a = p.ages || {};
    const ages = [['До 18', a.child], ['18–39', a.young], ['40–59', a.middle], ['60 и старше', a.senior], ['Возраст не указан', a.unknown]];
    const maxA = Math.max(0, ...ages.map((x) => x[1] || 0));
    for (const [label, n] of ages) if (n || label !== 'Возраст не указан') body.appendChild(barRow(tr(label), n || 0, maxA, num(n), INFO_COLOR));
    body.appendChild(subhead('Кто направил'));
    const refs = p.referrals || [];
    if (!refs.length) body.appendChild(empty('Направлений за период нет'));
    const maxR = Math.max(0, ...refs.map((r) => r.n));
    for (const r of refs) body.appendChild(barRow(r.name || '—', r.n, maxR, num(r.n), WARD_COLOR));
    return card('Пациенты', 'Patients', [], [act('Пациенты', 'Patients', 'patients'), act('Направители', 'Link', 'referrals')], body);
}

function labWardCard(lab, ip, act) {
    const body = h('div', null);
    body.appendChild(subhead('Лаборатория'));
    body.appendChild(stats([
        ['Назначено анализов', num(lab.ordered)],
        ['Готово', num(lab.verified), 'ok'],
        ['Средний срок, ч', lab.avg_tat_hours != null ? String(lab.avg_tat_hours).replace('.', ',') : '—'],
        ['Отклонения от нормы', pct(lab.abnormal_pct), lab.abnormal_pct > 0 ? 'warn' : null],
    ]));
    body.appendChild(subhead('Стационар'));
    body.appendChild(stats([
        ['Поступило', num(ip.admissions)],
        ['Выписано', num(ip.discharges)],
        ['Средний срок, дн.', ip.avg_los_days != null ? String(ip.avg_los_days).replace('.', ',') : '—'],
    ]));
    return card('Лаборатория и стационар', 'Flask', [], [act('Лаборатория', 'Flask', 'labs'), act('Стационар', 'Bed', 'admissions')], body);
}
