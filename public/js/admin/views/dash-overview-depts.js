// DASHBOARD_CEO_V1 (2026-10-31) — карточки отделов «Обзора клиники» для
// руководителя: маркетинг и реклама, колл-центр, амбулатория, стационар
// подробно, процедуры, склад, направители.
//
// Владелец: «make fully informing dashboard in terms of all departments like
// marketing ads, call center, ambulatory, stationar and other, super
// informative for CEO of hospital».
//
// Числа считает сервер (rpc/dashboard-overview-depts.js); раздел, который роли
// не открыт, приходит null — карточки нет. Мелкие части (card, stats, barRow…)
// — те же, что у остального обзора: dash-overview.js передаёт их сюда, чтобы
// карточки выглядели одной семьёй и не было второй копии разметки.

import { h } from '../ui.js';
import { tr, trf } from '../i18n.js';

const INFO = 'var(--info-500)';
const WARD = 'var(--purple-500)';
const CRIT = 'var(--crit-500)';
const WARN = 'var(--warn-500)';
const OK = 'var(--ok-500)';
const PRIMARY = 'var(--primary-600)';

const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const CHAT_LABEL = { messenger: 'Messenger', instagram: 'Instagram Direct', facebook: 'Комментарии Facebook', instagram_comments: 'Комментарии Instagram' };
const OUTCOME_LABEL = { home: 'Домой', transfer: 'Переведены', refuse: 'Отказ от лечения', death: 'Летальный исход', unknown: 'Исход не указан' };

/** Длительность ответа словами — как «Статистика» чата. */
function duration(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const min = Math.round(ms / 60000);
    if (min < 1) return tr('меньше минуты');
    if (min < 60) return trf('{m} мин', { m: min });
    const hrs = Math.floor(min / 60);
    if (hrs < 48) return trf('{h} ч {m} мин', { h: hrs, m: min % 60 });
    return trf('{d} дн {h} ч', { d: Math.floor(hrs / 24), h: hrs % 24 });
}

/** Пункты «Требует внимания» от новых разделов — та же форма, что attentionItems. */
export function deptAttentionItems(o) {
    const out = [];
    const add = (when, icon, text, view, tone = 'warn') => { if (when) out.push({ icon, text, view, tone }); };
    const m = o.marketing;
    if (m && m.chat) {
        const w = m.chat.waiting_now || {};
        add(w.messages > 0, 'Msg', trf('Facebook и Instagram: переписок ждут ответа — {n}', { n: w.messages }), 'meta-chat', 'crit');
        add(m.chat.missed > 0, 'Clock', trf('Сообщения Facebook и Instagram без ответа за 24 часа: {n}', { n: m.chat.missed }), 'meta-chat', 'crit');
        add(w.comments > 0, 'Doc', trf('Комментарии без ответа: {n}', { n: w.comments }), 'meta-chat');
    }
    if (m && m.meta) add(m.meta.errors > 0, 'Warning', trf('Заявки Meta, не попавшие в CRM: {n}', { n: m.meta.errors }), 'crm', 'crit');
    if (m && m.sms) add(m.sms.failed > 0, 'Send', trf('SMS рассылки не доставлены: {n}', { n: m.sms.failed }), 'commerce');
    const s = o.stock;
    if (s) add(s.zero_count > 0, 'Warning', trf('Закончились на складе позиций: {n}', { n: s.zero_count }), 'inventory', 'crit');
    const ip = o.inpatient_ext;
    if (ip) add(ip.discharge_debt_n > 0, 'Receipt', trf('Выписаны с долгом: {n}', { n: ip.discharge_debt_n }), 'admissions');
    return out;
}

/**
 * Карточки по ключу — раскладку по парам делает dash-overview.js (рядом
 * ставятся карточки одной темы и близкой высоты). Раздела без доступа — null.
 * u — части обзора: { card, stats, subhead, barRow, empty, act, num, pct, fmtPrice }.
 */
export function deptCards(o, u) {
    const money = o.money_visible !== false;
    return {
        marketing: o.marketing ? marketingCard(o.marketing, money, u) : null,
        callcenter: o.callcenter ? callcenterCard(o.callcenter, u) : null,
        outpatient: o.outpatient ? outpatientCard(o.outpatient, money, u) : null,
        inpatient: o.inpatient_ext ? inpatientCard(o.inpatient_ext, money, u) : null,
        procedures: o.procedures ? proceduresCard(o.procedures, money, u) : null,
        stock: o.stock ? stockCard(o.stock, money, u) : null,
        referrers: o.referrers ? referrersCard(o.referrers, money, u) : null,
    };
}

// DASHBOARD_CEO_LAYOUT_V1 — длинные списки укорочены, чтобы карточка не уходила
// намного ниже соседки по ряду: остальное — в своём разделе по кнопке.
const LIST_MAX = 6;

function marketingCard(m, money, u) {
    const { card, stats, subhead, barRow, empty, act, num, pct, fmtPrice } = u;
    const body = h('div', null);
    const meta = m.meta;
    if (meta) {
        body.appendChild(subhead('Реклама Meta — заявки из форм'));
        body.appendChild(stats([
            ['Заявок из рекламы', num(meta.leads)],
            ['Пришли в клинику', num(meta.won), 'ok'],
            ['Стали пациентами', num(meta.patients)],
            ['Повторные обращения', num(meta.merged)],
            meta.errors ? ['Не попали в CRM', num(meta.errors), 'crit'] : null,
        ]));
        const camps = (meta.campaigns || []).slice(0, LIST_MAX);
        if (camps.length) {
            const max = Math.max(0, ...camps.map((c) => c.n));
            for (const c of camps) {
                body.appendChild(barRow(c.name || tr('Без кампании'), c.n, max, num(c.n), WARN,
                    ' · ' + (money && c.revenue != null
                        ? trf('пришли {won} · оплатили {amount}', { won: num(c.won), amount: fmtPrice(c.revenue) })
                        : trf('пришли {won}', { won: num(c.won) }))));
            }
        }
    }
    const chat = m.chat;
    if (chat) {
        body.appendChild(subhead('Чат Facebook и Instagram'));
        body.appendChild(stats([
            ['Личных сообщений', num(chat.messages_in)],
            ['Комментариев', num(chat.comments_in)],
            ['Написали людей', num(chat.people)],
            ['Время ответа', duration(chat.median_ms)],
            ['Ответили', trf('{a} из {b}', { a: num(chat.answered), b: num(chat.requests) })],
            ['Лидов из чата', num(chat.leads), chat.leads ? 'ok' : null],
        ]));
        const chs = chat.channels || [];
        const max = Math.max(0, ...chs.map((c) => c.incoming));
        for (const c of chs) body.appendChild(barRow(tr(CHAT_LABEL[c.key] || c.key), c.incoming, max, num(c.incoming), INFO,
            ' · ' + trf('лидов {n}', { n: num(c.leads) })));
    }
    body.appendChild(subhead('Откуда приходят заявки'));
    const src = (m.sources || []).slice(0, LIST_MAX);
    if (!src.length) body.appendChild(empty());
    const maxS = Math.max(0, ...src.map((s) => s.n));
    for (const s of src) {
        body.appendChild(barRow(s.label || s.key || '—', s.n, maxS, num(s.n), WARN,
            ' · ' + (money && s.revenue != null
                ? trf('пришли {won} ({pct}) · оплатили {amount}', { won: num(s.won), pct: pct(s.n ? (s.won / s.n) * 100 : 0), amount: fmtPrice(s.revenue) })
                : trf('пришли {won} ({pct})', { won: num(s.won), pct: pct(s.n ? (s.won / s.n) * 100 : 0) }))));
    }
    if (m.sms && (m.sms.broadcasts || m.sms.failed)) {
        body.appendChild(subhead('SMS рассылки'));
        body.appendChild(stats([
            ['Рассылок', num(m.sms.broadcasts)],
            ['Доставлено', num(m.sms.sent), 'ok'],
            ['Не доставлено', num(m.sms.failed), m.sms.failed ? 'crit' : null],
        ]));
    }
    body.appendChild(h('div', { class: 'dho-note dho-foot' },
        tr(money
            ? '«Оплатили» — сколько эти пациенты заплатили в кассу за период. Расход на рекламу в программу не приходит: цену заявки смотрите в рекламном кабинете Meta.'
            : 'Расход на рекламу в программу не приходит: цену заявки смотрите в рекламном кабинете Meta.')));
    return card('Маркетинг и реклама', 'Megaphone', [], [act('Чат Facebook', 'Msg', 'meta-chat'), act('CRM', 'Target', 'crm')], body);
}

function callcenterCard(c, u) {
    const { card, stats, subhead, barRow, empty, act, num } = u;
    const body = h('div', null);
    body.appendChild(stats([
        ['Заявок из звонков', num(c.leads_from_calls)],
        ['Из них пришли', num(c.won_from_calls), 'ok'],
    ]));
    body.appendChild(subhead('Операторы'));
    const ops = c.operators || [];
    if (!ops.length) body.appendChild(empty());
    const max = Math.max(0, ...ops.map((o) => o.incoming + o.outgoing));
    for (const o of ops) {
        const name = o.name || (o.ext ? trf('Внутренний {ext}', { ext: o.ext }) : tr('Без внутреннего номера'));
        const rate = o.incoming ? Math.round((o.answered / o.incoming) * 100) : 0;
        body.appendChild(barRow(name, o.incoming + o.outgoing, max, num(o.incoming + o.outgoing), PRIMARY,
            ' · ' + trf('входящих {i}, отвечено {r}% · исходящих {o} · {t} мин · ожидание {w} с',
                { i: num(o.incoming), r: rate, o: num(o.outgoing), t: num(o.talk_min), w: num(o.avg_wait_sec) })));
    }
    body.appendChild(subhead('Когда теряем звонки — пропущенные по часам'));
    // Шесть худших часов, по порядку часа: остальные часы — без потерь или почти.
    const hrs = (c.missed_hours || []).filter((x) => x.missed > 0)
        .sort((a, b) => b.missed - a.missed).slice(0, LIST_MAX).sort((a, b) => a.hour - b.hour);
    if (!hrs.length) body.appendChild(empty());
    const maxH = Math.max(0, ...hrs.map((x) => x.missed));
    for (const x of hrs) {
        const p = x.incoming ? Math.round((x.missed / x.incoming) * 100) : 0;
        body.appendChild(barRow(String(x.hour).padStart(2, '0') + ':00', x.missed, maxH, num(x.missed), p >= 30 ? CRIT : WARN,
            ' · ' + trf('из {n} входящих ({p}%)', { n: num(x.incoming), p })));
    }
    return card('Колл-центр', 'Headset', [], [act('Звонки', 'Phone', 'crm')], body);
}

function outpatientCard(a, money, u) {
    const { card, stats, subhead, barRow, empty, act, num, pct, fmtPrice } = u;
    const body = h('div', null);
    body.appendChild(stats([
        ['Услуг на визит', a.services_per_visit != null ? String(a.services_per_visit).replace('.', ',') : '—'],
        money ? ['Сумма на визит', a.revenue_per_visit != null ? fmtPrice(a.revenue_per_visit) : '—'] : null,
        ['Не пришли', num(a.no_show), a.no_show ? 'warn' : null],
        ['Отменено', num(a.cancelled)],
        ['Доля неявок', pct(a.no_show_rate), a.no_show_rate >= 10 ? 'crit' : null],
    ]));
    body.appendChild(subhead('Отделения'));
    const deps = (a.departments || []).slice(0, LIST_MAX);
    if (!deps.length) body.appendChild(empty());
    const max = Math.max(0, ...deps.map((d) => d.visits));
    for (const d of deps) {
        body.appendChild(barRow(d.name || tr('Прочее'), d.visits, max, num(d.visits), PRIMARY,
            ' · ' + trf('пациентов {p} · не пришли {n}', { p: num(d.patients), n: num(d.no_show) })));
    }
    body.appendChild(subhead('Загрузка по дням недели'));
    const wd = a.weekdays || [];
    const maxW = Math.max(0, ...wd.map((x) => x.visits));
    for (const i of WEEK_ORDER) {
        const x = wd[i] || { visits: 0 };
        body.appendChild(barRow(tr(WEEKDAYS[i]), x.visits, maxW, num(x.visits), INFO));
    }
    body.appendChild(h('div', { class: 'dho-note dho-foot' },
        tr('Время ожидания в очереди не считается: программа не записывает, когда пациента вызвали и когда начался приём.')));
    return card('Амбулатория', 'Stethoscope', [], [act('Очередь', 'Calendar', 'queue')], body);
}

function inpatientCard(ip, money, u) {
    const { card, stats, subhead, barRow, act, num, fmtPrice } = u;
    const body = h('div', null);
    body.appendChild(subhead('Сейчас'));
    body.appendChild(stats([
        ['Пациентов в койках', num(ip.in_bed_now)],
        ['Занято коек', trf('{a} из {b}', { a: num(ip.beds_busy), b: num(ip.beds_total) })],
        ['Загрузка', ip.occupancy + '%', ip.occupancy >= 90 ? 'crit' : null],
    ]));
    body.appendChild(subhead('За период'));
    body.appendChild(stats([
        ['Плановых', num(ip.planned)],
        ['Экстренных', num(ip.emergency)],
        ['Дневной стационар', num(ip.day_stay)],
        ['Койко-дней', String(ip.bed_days).replace('.', ',')],
        money ? ['Начислено стационару', fmtPrice(ip.revenue)] : null,
        money ? ['Из них за койки', fmtPrice(ip.bed_revenue)] : null,
        money ? ['Выписаны с долгом', trf('{n} · {amount}', { n: num(ip.discharge_debt_n), amount: fmtPrice(ip.discharge_debt) }), ip.discharge_debt_n ? 'crit' : null]
              : ['Выписаны с долгом', num(ip.discharge_debt_n), ip.discharge_debt_n ? 'crit' : null],
    ]));
    const oc = ip.outcomes || {};
    const ocKeys = Object.keys(oc).filter((k) => oc[k] > 0);
    if (ocKeys.length) {
        body.appendChild(subhead('Исходы выписки'));
        const max = Math.max(0, ...ocKeys.map((k) => oc[k]));
        for (const k of ocKeys) body.appendChild(barRow(tr(OUTCOME_LABEL[k] || k), oc[k], max, num(oc[k]), k === 'death' ? CRIT : k === 'home' ? OK : WARD));
    }
    // Палаты — самые загруженные сверху; пустые палаты не занимают экран.
    const wards = (ip.wards || []).slice().sort((a, b) => (b.busy / (b.beds || 1)) - (a.busy / (a.beds || 1)) || b.busy - a.busy);
    const busyWards = wards.filter((w) => w.busy > 0);
    body.appendChild(subhead('Палаты'));
    for (const w of busyWards.slice(0, LIST_MAX)) {
        body.appendChild(barRow(w.name || '—', w.busy, w.beds, trf('{a} из {b}', { a: num(w.busy), b: num(w.beds) }), WARD));
    }
    const free = wards.length - busyWards.length;
    if (free > 0) body.appendChild(h('div', { class: 'dho-note dho-foot' }, trf('Свободных палат целиком: {n}', { n: num(free) })));
    return card('Стационар', 'Bed', [], [act('Стационар', 'Bed', 'admissions')], body);
}

function proceduresCard(p, money, u) {
    const { card, stats, subhead, barRow, empty, act, num, fmtPrice } = u;
    const body = h('div', null);
    body.appendChild(stats([
        ['Амбулаторно назначено', num(p.outpatient)],
        ['Отмечено выполненными', num(p.outpatient_done), p.outpatient && !p.outpatient_done ? 'warn' : null],
        ['В стационаре назначено', num(p.inpatient)],
        ['Выполнено в стационаре', num(p.inpatient_done)],
        money ? ['Сумма процедур', fmtPrice(p.revenue)] : null,
    ]));
    body.appendChild(subhead('Чаще всего'));
    const top = p.top || [];
    if (!top.length) body.appendChild(empty());
    const max = Math.max(0, ...top.map((t) => t.n));
    for (const t of top) body.appendChild(barRow(t.name || '—', t.n, max, num(t.n), 'var(--primary-500)',
        money && t.sum != null ? ' · ' + fmtPrice(t.sum) : null));
    if (p.outpatient && !p.outpatient_done) {
        body.appendChild(h('div', { class: 'dho-note dho-foot' },
            tr('Процедуры не отмечаются выполненными в очереди процедур — поэтому «выполнено» равно нулю.')));
    }
    return card('Процедуры', 'Activity', [], [act('Процедуры', 'Activity', 'procedures')], body);
}

function stockCard(s, money, u) {
    const { card, stats, subhead, barRow, empty, act, num, fmtPrice } = u;
    const body = h('div', null);
    body.appendChild(stats([
        ['Низкий остаток', num(s.low_count), s.low_count ? 'warn' : null],
        ['Закончились', num(s.zero_count), s.zero_count ? 'crit' : null],
        ['Заказы в пути', num(s.open_orders)],
        ['Получено заказов', num(s.received_orders)],
        money ? ['На сумму', fmtPrice(s.received_sum)] : null,
        money ? ['Израсходовано', fmtPrice(s.used_sum)] : null,
    ]));
    body.appendChild(subhead('Заканчивается'));
    const low = (s.low || []).slice(0, LIST_MAX);
    if (!low.length) body.appendChild(empty('Всё в достатке'));
    for (const p of low) {
        body.appendChild(barRow(p.name || '—', Math.max(0, p.on_hand), p.reorder_level,
            trf('{a} из {b} {unit}', { a: num(p.on_hand), b: num(p.reorder_level), unit: p.unit || '' }).trim(), p.on_hand <= 0 ? CRIT : WARN));
    }
    return card('Склад', 'Database', [], [act('Склад', 'Database', 'inventory')], body);
}

function referrersCard(r, money, u) {
    const { card, stats, subhead, barRow, empty, act, num, fmtPrice } = u;
    const body = h('div', null);
    body.appendChild(stats([
        ['Визитов по направлению', num(r.visits)],
        ['Госпитализаций по направлению', num(r.admissions)],
        ['Новых направителей от представителей', num(r.new_sources_by_reps)],
    ]));
    body.appendChild(subhead(money ? 'Кто приводит больше всего — по сумме услуг' : 'Кто приводит больше всего'));
    const top = (r.top || []).slice(0, LIST_MAX);
    if (!top.length) body.appendChild(empty('Направлений за период нет'));
    const key = money ? 'sum' : 'visits';
    const max = Math.max(0, ...top.map((t) => t[key] || 0));
    for (const t of top) {
        body.appendChild(barRow(t.name || '—', t[key] || 0, max, money ? fmtPrice(t.sum) : num(t.visits), WARD,
            ' · ' + (t.rep ? trf('визитов {v} · представитель {rep}', { v: num(t.visits), rep: t.rep }) : trf('визитов {v}', { v: num(t.visits) }))));
    }
    const reps = r.reps || [];
    if (reps.length) {
        body.appendChild(subhead('Медпредставители'));
        const maxR = Math.max(0, ...reps.map((x) => x.visits));
        for (const x of reps) body.appendChild(barRow(x.name || '—', x.visits, maxR, num(x.visits), INFO,
            ' · ' + trf('направителей {n}', { n: num(x.sources) })));
    }
    return card('Направители', 'Link', [], [act('Направители', 'Link', 'referrals')], body);
}
