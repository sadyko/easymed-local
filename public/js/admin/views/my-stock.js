// MY_STOCK_V1 (2026-09-23) — «МОИ ЗАПАСЫ»: ЧТО У МЕНЯ ЕСТЬ, КТО МНЕ ЭТО ВЫДАЛ
// И НА КОГО Я ЭТО СПИСАЛ.
//
// Владелец (23.09), решение по первому вопросу: «личный экран "Мои запасы":
// что выдали, когда, кто выдал, сколько осталось — плюс пункт меню на карточку
// отдела для медсестры и заведующей. Без уведомлений».
//
// ЧТО БЫЛО ДО НЕГО. Медсестра видела свой подотчёт ОДНИМ ВЫПАДАЮЩИМ СПИСКОМ на
// амбулаторной вкладке — то есть только в ту минуту, когда уже выдаёт товар
// пациенту, и только как «источник». Врач после HOLDINGS_FIRST_V1 тратит свой
// подотчёт из шести дверей и не видел его НИГДЕ. «Сколько у меня осталось» и
// «кто мне это выдал» не имели экрана вовсе, и ответ на них искали звонком на
// склад.
//
// ТРИ ВОПРОСА — ТРИ БЛОКА, И ИМЕННО В ЭТОМ ПОРЯДКЕ: что у меня есть сейчас
// (по нему принимают решение), что мне выдали (по нему спорят со складом), что
// я израсходовал (по нему отчитываются). Четвёртого блока нет намеренно:
// остатки кабинета и отдела — не «мои», их показывает карточка отдела, и
// кнопка ведёт туда.
//
// ОБЛАСТЬ ВИДИМОСТИ СЧИТАЕТ СЕРВЕР. Экран не отбирает своё из общего списка —
// он его и не получает: `holdings_list` спрашивается с `mine: true` (имя
// держателя сервер берёт из сессии, rpc/holdings.js), а журнал — с сужением
// `only` (rpc/stock-log.js). Отбор в браузере означал бы, что чужие остатки
// уже приехали в браузер, и разница видна в любой вкладке разработчика.
//
// ЖУРНАЛ ЗДЕСЬ НЕ ПЕРЕПИСЫВАЕТСЯ ВТОРОЙ РАЗ. Оба списка движений — тот же
// `stock_movements_list`, что рисует «Журнал движений» (STOCK_LOG_V1), только
// с разными вопросами: «что выдали мне» (kind=issue, only=to_me) и «что провёл
// я» (kind=dispense, only=by_me). Второй запрос к тем же строкам разошёлся бы
// с первым на следующей же правке.
import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { fmtQty, loadingCard } from './inventory-shared.js';
import { ownDepartmentId } from '../permissions.js';

const PAGE = 50;
const MAX_PAGE = 500;

const state = { issued: PAGE, spent: PAGE };
const refs = { host: null, body: null, onNavigate: null };
// Свой счётчик, а не общий fetchGuard закупок: «Мои запасы» и «Журнал
// движений» бывают смонтированы одновременно (оболочка держит до трёх
// панелей), и общий счётчик отменял бы чужую отрисовку.
let token = 0;

/** Ровно те три вопроса, которые экран задаёт серверу. */
export function myStockQueries(limits = state) {
    return [
        ['holdings_list', { mine: true }],
        ['stock_movements_list', { kind: 'issue', only: 'to_me', limit: limits.issued }],
        ['stock_movements_list', { kind: 'dispense', only: 'by_me', limit: limits.spent }],
    ];
}

export async function renderMyStock(container, { onNavigate } = {}) {
    // Экран открывается целиком заново: «показать ещё», нажатое вчера, сегодня
    // читалось бы как «у меня столько выдач», а не как раскрытый список.
    state.issued = PAGE; state.spent = PAGE;
    refs.onNavigate = onNavigate || null;
    clear(container);
    refs.host = h('div', { class: 'fade-in' });
    container.appendChild(refs.host);
    await paint();
}

function pageHead() {
    const right = [];
    // MY_STOCK_V1 — путь на карточку отдела для того, у кого отдел есть
    // (медсестра отделения, заведующая). Отдел известен из сессии
    // (users.department_id), а не угадывается по роли.
    if (ownDepartmentId()) {
        right.push(h('button', {
            class: 'btn btn-sm btn-outline', type: 'button',
            title: 'Карточка отдела: команда, помещения, снабжение и журнал.',
            onclick: () => refs.onNavigate && refs.onNavigate('my-department'),
        }, Icon('Building', { size: 14 }), ' ', tr('Мой отдел')));
    }
    right.push(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => paint() },
        Icon('Refresh', { size: 14 }), ' ', tr('Обновить')));
    return PageHead({
        title: 'Мои запасы',
        subtitle: 'Что выдали вам и когда, кто выдал, сколько осталось на руках и что вы списали на пациентов.',
        right,
    });
}

async function paint() {
    const host = refs.host;
    if (!host) return;
    clear(host);
    host.appendChild(pageHead());
    const body = h('div');
    host.appendChild(body);
    refs.body = body;
    body.appendChild(loadingCard());

    const mine = ++token;
    const [held, issued, spent] = await Promise.all(
        myStockQueries().map(([name, args]) => supabase.rpc(name, args)));
    if (mine !== token || refs.body !== body) return;
    clear(body);

    // Отказ сервера ВИДЕН: молчание на этом месте читается как «мне ничего не
    // выдавали», то есть как спор со складом, которого не было.
    const failed = [held, issued, spent].find((r) => r && r.error);
    if (failed) {
        const e = failed.error;
        toast(trf('Не удалось загрузить «Мои запасы»: {msg}', { msg: (e && e.message) || e }), 'fail');
    }

    body.appendChild(heldCard(held));
    body.appendChild(movementsCard({
        icon: 'ArrowDown', title: 'Что мне выдали', res: issued,
        columns: ['Когда', 'Товар', 'Сколько', 'Кто выдал', 'Основание'],
        empty: 'Вам ничего не выдавали.',
        failure: 'Не удалось загрузить выдачи.',
        cells: (m) => [fmtDateTime(m.created_at), m.product_name || '—', gotQty(m), m.actor_name || '—', m.note || '—'],
        more: () => { state.issued = Math.min(state.issued + PAGE, MAX_PAGE); paint(); },
        limit: state.issued,
    }));
    body.appendChild(movementsCard({
        icon: 'Patients', title: 'Что я списал на пациентов', res: spent,
        columns: ['Когда', 'Товар', 'Сколько', 'Пациент', 'Основание'],
        empty: 'Вы ещё ничего не списывали на пациентов.',
        failure: 'Не удалось загрузить списания.',
        cells: (m) => [fmtDateTime(m.created_at), m.product_name || '—', gotQty(m), m.patient_name || '—', m.note || '—'],
        more: () => { state.spent = Math.min(state.spent + PAGE, MAX_PAGE); paint(); },
        limit: state.spent,
    }));
}

/**
 * Количество глазами получателя. В журнале склада выдача и расход записаны
 * ОТРИЦАТЕЛЬНЫМИ (склада стало меньше), но человеку выдали пять упаковок, а не
 * «минус пять»: знак здесь — это чужая система координат, и «−5 уп» на
 * собственном экране читается как ошибка.
 */
export function gotQty(m) {
    const qty = Math.abs(Number(m.qty) || 0);
    return [fmtQty(qty), m.unit || ''].filter(Boolean).join(' ');
}

const emptyRow = (colspan, text) => h('tr', null,
    h('td', { colspan: String(colspan), style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, text));

function card(icon, title, ...kids) {
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon(icon, { size: 15 }), ' ', tr(title))),
        ...kids);
}

function table(columns, tbody) {
    return h('div', { style: { overflowX: 'auto' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, ...columns.map((c) => h('th', null, c)))),
            tbody));
}

/** Блок «Что у меня на руках» — остатки, числящиеся лично за вошедшим. */
function heldCard(res) {
    const rows = (res && res.data && res.data.holdings) || [];
    const tbody = h('tbody');
    if (res && res.error) {
        tbody.appendChild(emptyRow(2, tr('Не удалось загрузить ваши остатки.')));
    } else if (!rows.length) {
        tbody.appendChild(emptyRow(2, tr('На руках у вас ничего не числится: со склада вам ещё ничего не выдавали.')));
    } else {
        for (const r of rows) tbody.appendChild(heldRow(r));
    }
    return card('Layers', 'Что у меня на руках',
        h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '0 0 8px' } },
            'Числится лично за вами. Запасы кабинета и отдела — в карточке отдела.'),
        table(['Товар', 'Осталось'], tbody));
}

function heldRow(r) {
    const unit = r.consumption_unit || r.base_unit || '';
    // Вторая строка — та же цифра в единицах СКЛАДА: медсестра считает
    // таблетками, склад упаковками, и спор «у меня 30, а у вас 3» начинается
    // именно здесь.
    const base = r.base_unit && r.consumption_unit && r.base_unit !== r.consumption_unit
        ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, [fmtQty(r.qty_base), r.base_unit].join(' '))
        : null;
    return h('tr', null,
        h('td', null, r.product_name || '—'),
        h('td', { class: 'num' }, h('div', null, [fmtQty(r.qty_units), unit].filter(Boolean).join(' ')), base));
}

/** Блок движений: одна и та же таблица для «выдали мне» и «списал я». */
function movementsCard({ icon, title, res, columns, empty, failure, cells, more, limit }) {
    const data = (res && res.data) || {};
    const rows = data.movements || [];
    const tbody = h('tbody');
    if (res && res.error) {
        tbody.appendChild(emptyRow(columns.length, tr(failure)));
    } else if (!rows.length) {
        tbody.appendChild(emptyRow(columns.length, tr(empty)));
    } else {
        for (const m of rows) tbody.appendChild(h('tr', null, ...cells(m).map((c, i) => h('td', { class: i === 2 ? 'num' : null }, c))));
    }
    return card(icon, title, table(columns, tbody), truncationNote(data, more, limit));
}

/** Список обрезан — скажи это, а не делай вид, что выдач больше не было. */
function truncationNote(data, more, limit) {
    if (!data || !data.truncated) return null;
    const btn = h('button', { class: 'btn btn-sm btn-outline', type: 'button' }, 'Показать ещё');
    btn.addEventListener('click', more);
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', paddingTop: '8px' } },
        h('span', { class: 'muted', style: { fontSize: '12.5px' } },
            trf('Показаны последние {n} — список длиннее.', { n: data.count })),
        h('span', { class: 'grow' }),
        limit < MAX_PAGE ? btn : null);
}
