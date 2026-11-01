// META_INBOX_STATS_V1 — «Статистика» «Чата Facebook и Instagram».
//
// Владелец (2026-10-31): «can you build statistics page button on top, page
// should show how many comments arrived how many private masseges, how many
// leads generated from chats and so on detailed stattistics».
//
// Кнопка «Статистика» — в шапке чата (meta-chat.js), страница рисуется на
// месте переписки и возвращается кнопкой «К переписке». Цифры считает сервер
// (meta/inbox-stats.js) из того, что опрос уже сохранил; здесь — только
// раскладка. Что значат «обращение», «пропущено» и «вне Easy-Med» — в шапке
// inbox-stats.js, и подсказки у плиток говорят то же самое.
//
// Цвета каналов — проверенная на дальтонизм четвёрка (порядок фиксирован:
// Messenger, Direct, комментарии Facebook, комментарии Instagram). Две
// светлые из неё ниже 3:1 к белому — поэтому у графика всегда есть легенда,
// а те же цифры стоят в таблице «По каналам».

import { supabase } from '../../supabase.js';
import { h, Icon, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';

export const PERIODS = [
    { days: 1,  label: 'Сегодня' },
    { days: 7,  label: '7 дней' },
    { days: 30, label: '30 дней' },
    { days: 90, label: '90 дней' },
    { days: 0,  label: 'Всё время' },
];

export const CHANNEL_LABEL = {
    messenger: 'Messenger',
    instagram: 'Instagram Direct',
    facebook: 'Комментарии Facebook',
    instagram_comments: 'Комментарии Instagram',
};
const CHANNELS = Object.keys(CHANNEL_LABEL);

let period = 30;   // переживает уход в переписку и обратно

const num = (n) => Number(n || 0).toLocaleString('ru-RU');
const pct = (part, whole) => (whole ? Math.round((100 * part) / whole) : 0);

/** Длительность ответа словами: «12 мин», «3 ч 5 мин», «2 дн 4 ч». */
export function fmtDuration(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const min = Math.round(ms / 60000);
    if (min < 1) return tr('меньше минуты');
    if (min < 60) return trf('{m} мин', { m: min });
    const hrs = Math.floor(min / 60);
    if (hrs < 48) return trf('{h} ч {m} мин', { h: hrs, m: min % 60 });
    return trf('{d} дн {h} ч', { d: Math.floor(hrs / 24), h: hrs % 24 });
}

function bucketLabel(key, unit) {
    if (unit === 'hour') return key;
    if (unit === 'month') return key.slice(5, 7) + '.' + key.slice(0, 4);
    return key.slice(8, 10) + '.' + key.slice(5, 7);
}
const dmy = (d) => (d ? d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4) : '');

/**
 * host — куда рисовать; info — состояние опроса (meta_inbox_state), чтобы
 * сказать, какие каналы сейчас не приходят и потому пусты.
 */
export async function renderMetaChatStats(host, { info } = {}) {
    clear(host);
    const root = h('div', { class: 'ms-root', 'data-meta-stats': '' });
    host.appendChild(root);

    const periods = h('div', { class: 'ms-periods', role: 'tablist' });
    const rangeText = h('span', { class: 'ms-range' });
    const body = h('div', { class: 'ms-body' });
    root.appendChild(h('div', { class: 'ms-toolbar' }, periods, rangeText));
    root.appendChild(body);

    const paintPeriods = () => {
        clear(periods);
        for (const p of PERIODS) {
            periods.appendChild(h('button', {
                type: 'button', role: 'tab', class: 'ms-period' + (p.days === period ? ' is-active' : ''),
                'aria-selected': p.days === period ? 'true' : 'false', 'data-meta-period': String(p.days),
                onclick: () => { if (period !== p.days) { period = p.days; paintPeriods(); load(); } },
            }, p.label));
        }
    };

    const load = async () => {
        body.classList.add('is-loading');
        const { data, error } = await supabase.rpc('meta_inbox_stats', { days: period });
        body.classList.remove('is-loading');
        if (!root.isConnected) return;
        clear(body);
        if (error || !data) {
            body.appendChild(h('div', { class: 'ms-empty' }, error?.message || 'Не удалось посчитать статистику.'));
            return;
        }
        rangeText.textContent = data.range.from === data.range.to ? dmy(data.range.to) : dmy(data.range.from) + ' — ' + dmy(data.range.to);
        paintBody(body, data, info);
    };

    paintPeriods();
    await load();
}

function paintBody(body, s, info) {
    const t = s.totals;

    // Каналы с ошибкой подключения — пустые не потому, что никто не писал.
    const broken = new Set((info?.errors || []).map((e) => e.part));
    const dead = [];
    if (broken.has('messenger')) dead.push(tr('Messenger'));
    if (broken.has('instagram')) dead.push(tr('Instagram Direct'));
    if (broken.has('facebook')) dead.push(tr('Комментарии Facebook'));
    if (broken.has('instagram_comments')) dead.push(tr('Комментарии Instagram'));
    if (dead.length) {
        body.appendChild(h('div', { class: 'ms-note' }, Icon('Info', { size: 14 }),
            h('span', null, trf('Сейчас не приходят: {list}. Пока подключение не исправлено, эти цифры будут нулями.', { list: dead.join(', ') }))));
    }

    // ---- Плитки ----
    const replies = t.messages_out + t.comment_replies + t.private_replies;
    const unanswered = t.requests - t.answered;
    body.appendChild(h('div', { class: 'ms-kpis' },
        tile('Msg', 'Личные сообщения', num(t.messages_in),
            trf('Людей: {n}', { n: num(t.message_people) }),
            'Входящие сообщения в Messenger и Instagram Direct.'),
        tile('Doc', 'Комментарии', num(t.comments_in),
            trf('Людей: {n} · под рекламой: {a}', { n: num(t.comment_people), a: num(t.comments_on_ads) }),
            'Комментарии людей под постами и рекламой. Ответы клиники сюда не входят.'),
        tile('Send', 'Ответы клиники', num(replies),
            trf('В переписке: {m} · под комментариями: {c} · в личку: {p}', { m: num(t.messages_out), c: num(t.comment_replies), p: num(t.private_replies) }),
            'Все ответы клиники, включая отправленные из Meta Business Suite или с телефона.'),
        tile('Clock', 'Время ответа', fmtDuration(t.median_ms),
            trf('За час ответили: {p}%', { p: pct(t.within_hour, t.answered) }),
            'Медиана: половина обращений получила ответ быстрее. Считается от первого вопроса до первого ответа.'),
        tile('Warning', 'Без ответа', num(unanswered),
            trf('Из {n} обращений · пропущено: {m}', { n: num(t.requests), m: num(t.missed) }),
            'Пропущено — на сообщение не ответили за 24 часа, и Meta больше не даёт ответить.'),
        tile('Target', 'Лиды из чата', num(t.leads),
            trf('Конверсия: {p}% · пришли: {w}', { p: t.conversion == null ? 0 : Math.round(t.conversion * 1000) / 10, w: num(s.leads.won) }),
            'Карточки CRM, заведённые кнопкой «Отметить как лид». Конверсия — от числа людей, которые написали.'),
    ));

    const w = s.waiting_now;
    body.appendChild(h('div', { class: 'ms-waiting' },
        h('span', { class: 'ms-waiting-dot' }),
        trf('Сейчас ждут ответа: переписок — {m}, комментариев — {c}', { m: num(w.messages), c: num(w.comments) })));

    // ---- График ----
    const unitTitle = { hour: 'Обращения по часам', day: 'Обращения по дням', month: 'Обращения по месяцам' }[s.range.unit];
    body.appendChild(card(unitTitle, chart(s.series, s.range.unit)));

    // ---- Таблица по каналам ----
    body.appendChild(card('По каналам', channelTable(s.channels, t)));

    // ---- Часы и этапы ----
    body.appendChild(h('div', { class: 'ms-two' },
        card('Когда пишут', hoursChart(s.hours), 'Входящие сообщения и комментарии по часу суток — когда нужен человек на ответах.'),
        card('Лиды по этапам CRM', stagesBlock(s))));

    // ---- Посты ----
    body.appendChild(card('Посты и реклама с наибольшим числом комментариев', postsTable(s.posts)));

    // ---- Сотрудники ----
    body.appendChild(card('Кто отвечал', staffTable(s.staff, s.outside)));
}

function tile(icon, label, value, sub, hint) {
    return h('div', { class: 'ms-kpi', title: hint },
        h('div', { class: 'ms-kpi-top' }, h('span', { class: 'ms-kpi-ic' }, Icon(icon, { size: 16 })), h('span', { class: 'ms-kpi-label' }, label)),
        h('div', { class: 'ms-kpi-val' }, value),
        h('div', { class: 'ms-kpi-sub' }, sub));
}

function card(title, content, hint) {
    return h('section', { class: 'card ms-card' },
        h('div', { class: 'ms-card-head' }, h('h3', { class: 'ms-card-title' }, title), hint ? h('div', { class: 'ms-card-hint' }, hint) : null),
        content);
}

function legend() {
    return h('div', { class: 'ms-legend' }, ...CHANNELS.map((k, i) =>
        h('span', { class: 'ms-legend-item' }, h('span', { class: 'ms-sw ms-c' + (i + 1) }), CHANNEL_LABEL[k])));
}

function chart(series, unit) {
    const totals = series.map((b) => CHANNELS.reduce((n, k) => n + b[k], 0));
    const max = Math.max(1, ...totals);
    if (!totals.some(Boolean)) return h('div', { class: 'ms-empty' }, 'За этот период ничего не пришло.');
    // Подписи под осью — не у каждого столбика, иначе 30 дат слипаются.
    const every = series.length > 31 ? 7 : series.length > 14 ? 3 : series.length > 12 ? 2 : 1;
    const cols = series.map((b, i) => {
        const tip = bucketLabel(b.key, unit) + '\n' + CHANNELS.map((k) => tr(CHANNEL_LABEL[k]) + ': ' + b[k]).join('\n') + '\n' + tr('Ответов клиники') + ': ' + b.replies;
        return h('div', { class: 'ms-col', title: tip, 'data-meta-bucket': b.key },
            h('div', { class: 'ms-stack', style: `height:${(100 * totals[i]) / max}%` },
                ...CHANNELS.map((k, ci) => (b[k] ? h('div', { class: 'ms-seg ms-c' + (ci + 1), style: `flex-grow:${b[k]}` }) : null))),
            h('div', { class: 'ms-xlab' }, i % every === 0 ? bucketLabel(b.key, unit) : ''));
    });
    return h('div', null,
        legend(),
        h('div', { class: 'ms-chart' },
            h('div', { class: 'ms-ymax' }, num(max)),
            h('div', { class: 'ms-cols' }, ...cols)));
}

function hoursChart(hours) {
    const max = Math.max(1, ...hours.map((x) => x.count));
    if (!hours.some((x) => x.count)) return h('div', { class: 'ms-empty' }, 'За этот период ничего не пришло.');
    return h('div', { class: 'ms-chart ms-chart-sm' },
        h('div', { class: 'ms-ymax' }, num(max)),
        h('div', { class: 'ms-cols' }, ...hours.map((x) => h('div', { class: 'ms-col', title: String(x.hour).padStart(2, '0') + ':00 — ' + x.count },
            h('div', { class: 'ms-stack', style: `height:${(100 * x.count) / max}%` }, x.count ? h('div', { class: 'ms-seg ms-c1', style: 'flex-grow:1' }) : null),
            h('div', { class: 'ms-xlab' }, x.hour % 3 === 0 ? String(x.hour).padStart(2, '0') : '')))));
}

function table(headers, rows, foot) {
    return h('div', { class: 'ms-table-wrap' }, h('table', { class: 'ms-table' },
        h('thead', null, h('tr', null, ...headers.map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
        h('tbody', null, ...rows),
        foot ? h('tfoot', null, foot) : null));
}

function channelTable(channels, t) {
    const td = (v) => h('td', { class: 'num' }, v);
    const rows = channels.map((c, i) => h('tr', { 'data-meta-channel': c.key },
        h('td', null, h('span', { class: 'ms-sw ms-c' + (i + 1) }), CHANNEL_LABEL[c.key]),
        td(num(c.incoming)), td(num(c.people)), td(num(c.requests)), td(num(c.answered)),
        td(num(c.waiting)), td(c.key === 'messenger' || c.key === 'instagram' ? num(c.missed) : '—'),
        td(fmtDuration(c.median_ms)), td(num(c.leads))));
    const sum = (f) => channels.reduce((n, c) => n + (c[f] || 0), 0);
    const foot = h('tr', null, h('td', null, 'Итого'),
        td(num(sum('incoming'))), td(num(t.people)), td(num(t.requests)), td(num(t.answered)),
        td(num(sum('waiting'))), td(num(t.missed)), td(fmtDuration(t.median_ms)), td(num(t.leads)));
    return h('div', null,
        table(['Канал', 'Входящих', 'Людей', 'Обращений', 'Ответили', 'Ждут ответа', 'Пропущено', 'Время ответа', 'Лидов'], rows, foot),
        h('div', { class: 'ms-foot-note' }, 'Обращение — вопросы человека подряд до ответа клиники; у комментариев — нитка под постом. Пропущено бывает только у сообщений: на комментарий можно ответить и позже.'));
}

function stagesBlock(s) {
    const l = s.leads;
    if (!l.total) {
        return h('div', { class: 'ms-empty' }, 'Лидов из чата за этот период нет. Лид появляется, когда сотрудник нажимает «Отметить как лид» в переписке или комментарии.');
    }
    const max = Math.max(1, ...s.stages.map((x) => x.count));
    return h('div', null,
        h('div', { class: 'ms-stages' }, ...s.stages.map((st) => h('div', { class: 'ms-stage', 'data-meta-stage': st.key },
            h('span', { class: 'ms-stage-label' }, st.label),
            h('span', { class: 'ms-stage-bar' }, h('span', { class: 'ms-stage-fill ms-k-' + st.kind, style: `width:${(100 * st.count) / max}%` })),
            h('span', { class: 'ms-stage-n' }, num(st.count))))),
        h('div', { class: 'ms-foot-note' },
            trf('Новых карточек: {a} · дописано в существующие: {b} · стали пациентами: {c}', { a: num(l.created), b: num(l.merged), c: num(l.patients) })));
}

function postsTable(posts) {
    if (!posts.length) return h('div', { class: 'ms-empty' }, 'За этот период комментариев нет.');
    const rows = posts.map((p) => h('tr', null,
        h('td', { class: 'ms-post' },
            h('div', { class: 'ms-post-text' }, p.post_text || tr('Публикация без текста')),
            h('div', { class: 'ms-post-meta' },
                h('span', { class: 'ms-chip' }, p.platform === 'instagram' ? 'Instagram' : 'Facebook'),
                p.is_ad ? h('span', { class: 'ms-chip ms-chip-ad' }, 'Реклама') : null,
                p.post_url ? h('a', { href: p.post_url, target: '_blank', rel: 'noopener noreferrer', class: 'ms-link' }, 'Открыть') : null)),
        h('td', { class: 'num' }, num(p.comments)),
        h('td', { class: 'num' }, num(p.people)),
        h('td', { class: 'num' }, num(p.leads))));
    return table(['Пост', 'Комментариев', 'Людей', 'Лидов'], rows);
}

function staffTable(staff, outside) {
    const td = (v) => h('td', { class: 'num' }, v);
    const rows = staff.map((x) => h('tr', null,
        h('td', null, x.name || tr('Без имени')),
        td(num(x.messages)), td(num(x.comment_replies)), td(num(x.private_replies)), td(num(x.leads))));
    if (outside.messages || outside.comment_replies) {
        rows.push(h('tr', { class: 'ms-muted-row' },
            h('td', null, 'Вне Easy-Med (Meta Business Suite, телефон)'),
            td(num(outside.messages)), td(num(outside.comment_replies)), td('—'), td('—')));
    }
    if (!rows.length) return h('div', { class: 'ms-empty' }, 'За этот период клиника не отвечала.');
    return table(['Сотрудник', 'В переписке', 'Под комментариями', 'В личку на комментарий', 'Лидов'], rows);
}
