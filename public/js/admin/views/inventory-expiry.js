// EXPIRY_BALANCE_V1 (2026-09-23) — «СРОКИ ГОДНОСТИ»: ОСТАТКИ ПАРТИЯМИ.
//
// Владелец (23.09), решение по четвёртому вопросу: «экран "Сроки годности"
// показывает остатки партиями, ближайший срок первым; выдача и списание
// просроченного предупреждают». Полную прослеживаемость партии до пациента
// владелец НЕ выбрал — и её здесь нет: у экрана нечего нажать, чтобы узнать,
// кому досталась партия A-117, и никто ни у кого партию не спрашивает.
//
// ЧЕГО ЭТОТ ЭКРАН НЕ ДЕЛАЕТ. Он не считает остатки сам: расклад приходит
// готовым (rpc/expiry.js, stock_expiry_lots) — вместе с отбором по товару,
// поиском и порогом «истекает». Браузеру нечего складывать: сложи он остаток
// иначе, чем сервер, — и предупреждение при выдаче стало бы спорить с
// экраном, а правым читатель счёл бы того, кто громче.
//
// ГЛАВНАЯ СТРОКА ЭТОГО ЭКРАНА — ПРИЗНАНИЕ. Количество по партиям в базе не
// хранится: приход знает партию и срок, расход не знает ничего. Поэтому
// остаток по партиям — РАСЧЁТ («первым расходуется ближайший срок»), и экран
// говорит это словами, приглушённой строкой над таблицей. Показать расчёт как
// измерение — значит однажды поспорить с полкой и оказаться неправым; а
// человек, которому один раз соврали числом, больше этому экрану не поверит.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { fetchGuard, loadingCard, fmtQty } from './inventory-shared.js';

// Состояние партии словами и цветом. Палитра — та же, что у остальных меток
// склада (ui.js Tag): crit — беда, warn — скоро, ok — спокойно, off — нечего
// сказать.
export const LOT_STATE = {
    expired: { label: 'Просрочено',    kind: 'crit' },
    soon:    { label: 'Истекает',      kind: 'warn' },
    ok:      { label: 'В порядке',     kind: 'ok' },
    none:    { label: 'Срок не указан', kind: 'off' },
};

export function lotStateTag(state) {
    const s = LOT_STATE[state] || LOT_STATE.none;
    return Tag(tr(s.label), { kind: s.kind, dot: true });
}

const state = { productId: '', q: '' };
const refs = { host: null, body: null };

/** Параметры запроса из состояния фильтров — ровно то, что понимает RPC. */
export function expiryQuery() {
    const args = {};
    if (state.productId) args.product_id = Number(state.productId);
    if (state.q.trim()) args.q = state.q.trim();
    return args;
}

export async function renderExpiryTab(container) {
    // Экран открывается чистым: уцелевший с прошлого раза отбор читается как
    // «партий нет», и человек ищет поломку, а не фильтр (тот же довод, что у
    // журнала движений).
    state.productId = ''; state.q = '';
    clear(container);
    refs.host = h('div');
    container.appendChild(refs.host);
    await paint();
}

const inpStyle = {
    height: '30px', padding: '0 8px', border: '1px solid var(--ink-200)',
    borderRadius: '8px', fontSize: '12.5px', background: 'white', fontFamily: 'inherit',
};

function filterBar(products) {
    const prod = h('select', { title: 'Товар', 'aria-label': 'Товар', style: { ...inpStyle, maxWidth: '220px' } },
        h('option', { value: '', selected: state.productId === '' }, 'Все товары'),
        ...products.map((p) => h('option', { value: String(p.id), selected: String(p.id) === String(state.productId) }, p.name)));
    prod.addEventListener('change', () => { state.productId = prod.value; paint(); });

    const q = h('input', { type: 'text', placeholder: 'Поиск товара…', value: state.q, style: { ...inpStyle, width: '200px' } });
    q.addEventListener('input', () => { state.q = q.value; paint(); });
    return { prod, q };
}

async function paint() {
    const host = refs.host;
    if (!host) return;
    clear(host);
    const body = h('div');
    host.appendChild(body);
    refs.body = body;
    body.appendChild(loadingCard());

    const token = ++fetchGuard.token;
    const { data, error } = await supabase.rpc('stock_expiry_lots', expiryQuery());
    if (token !== fetchGuard.token || refs.body !== body) return;
    clear(body);

    if (error) {
        toast(trf('Не удалось загрузить сроки годности: {msg}', { msg: error.message || error }), 'fail');
        body.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Не удалось загрузить сроки годности.')));
        return;
    }

    const res = data || {};
    const rows = res.lots || [];
    const filtered = !!(state.productId || state.q.trim());
    const f = filterBar(res.products || []);

    const tbody = h('tbody');
    if (!rows.length) {
        tbody.appendChild(h('tr', null,
            h('td', { colspan: '7', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } },
                filtered ? 'Нет подходящих партий.' : emptyWords())));
    } else {
        for (const l of rows) tbody.appendChild(lotRow(l));
    }

    body.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-header', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('h3', null, Icon('Clock', { size: 15 }), ' ', tr('Сроки годности')),
            h('span', { class: 'grow' }),
            f.q, f.prod,
        ),
        // ПРИЗНАНИЕ — одной строкой и первым делом. См. шапку файла.
        h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '0 0 4px' } },
            'Остаток по партиям — расчёт, а не факт: программа не запоминает, из какой партии товар взяли, и считает, что первым расходуется ближайший срок.'),
        h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '0 0 8px' } },
            trf('«Истекает» — до конца срока осталось {n} дней или меньше.', { n: res.soon_days || 30 })),
        res.dated_total === 0 && rows.length
            ? h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '0 0 8px' } }, emptyWords())
            : null,
        scopeNote(res),
        h('div', { style: { overflowX: 'auto' } },
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Товар'),
                    h('th', null, 'Партия'),
                    h('th', null, 'Срок'),
                    h('th', null, 'Остаток'),
                    h('th', null, 'Осталось дней'),
                    h('th', null, 'Состояние'),
                    h('th', null, 'Поставщик'),
                )),
                tbody,
            ),
        ),
        truncationNote(res),
    ));
}

/** Пустота говорит словами — и называет место, где срок вводится. */
function emptyWords() {
    return tr('Сроки годности ещё не заполняли: срок и номер партии указываются при приёме товара на склад, в приходе.');
}

/** Область видимости словами: молчание тут читается как «партий в клинике нет». */
function scopeNote(res) {
    if (!res.scope || res.scope === 'all') return null;
    return h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '0 0 8px' } },
        'Остатки склада по партиям видят администратор и кладовщик.');
}

function truncationNote(res) {
    if (!res.truncated) return null;
    return h('div', { class: 'muted', style: { fontSize: '12.5px', paddingTop: '8px' } },
        trf('Показаны первые {n} партий — уточните товар или поиск.', { n: res.count }));
}

/** Сколько дней осталось — или сколько уже просрочено. */
export function daysCell(lot) {
    if (lot.no_expiry || lot.days_left === null || lot.days_left === undefined) return '—';
    if (lot.days_left < 0) return trf('просрочено на {n} дн.', { n: -lot.days_left });
    return trf('{n} дн.', { n: lot.days_left });
}

function lotRow(l) {
    return h('tr', null,
        h('td', null, h('div', null, l.product_name || '—'),
            l.product_code ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, l.product_code) : null),
        h('td', null, l.batch_no || '—'),
        h('td', null, l.expiry_date || '—'),
        h('td', { class: 'num' }, `${fmtQty(Number(l.remaining) || 0)} ${l.unit || ''}`.trim()),
        h('td', null, daysCell(l)),
        h('td', null, lotStateTag(l.state)),
        h('td', null, l.supplier_name || '—'),
    );
}
