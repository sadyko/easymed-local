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
//
// SEARCH_ALIVE_V1 — СТРОКА ФИЛЬТРОВ ПЕРЕРИСОВКУ ПЕРЕЖИВАЕТ. Поиск в программе
// с задержкой (ui.js SEARCH_DEBOUNCE_V1): запрос уходит через полсекунды после
// начала набора. Пока экран перерисовывался целиком, ответ на этот запрос
// пересоздавал поле ввода — и название товара обрывалось на середине, потому
// что остаток слова летел в узел, снятый с экрана. Поэтому органы управления
// строятся ОДИН раз (buildShell), а paint() трогает только область
// результатов; список товаров в выпадающем фильтре приходит с ответом, и
// обновляются ОПЦИИ, а не сам фильтр. Тот же приём, что у очереди лаборатории
// (views/laboratory.js: refs.searchInp живёт в шапке окна, paintRows()
// перерисовывает список).
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { fmtQty } from './inventory-shared.js';
import { categoryFilter, loadCategories } from './category-filter.js';   // PROCUREMENT_FILTERS_V1

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

// PROCUREMENT_FILTERS_V1 — cats: отметки категорий вошедшего (общие с
// «Складом» и «Товарами», запоминаются за человеком — category-filter.js);
// lotState: кнопка состояния «Все / Просрочено / Истекает / В порядке». Оба
// отбора считает СЕРВЕР (stock_expiry_lots: categories, state), как и отбор по
// товару: экран здесь по-прежнему ничего не складывает сам.
const state = { productId: '', q: '', cats: [], lotState: 'all' };

// Кнопки состояния. Число на кнопке — из ответа сервера (summary): партии по
// состояниям ПОСЛЕ отбора по категориям, товару и поиску, но ДО самой кнопки.
export const STATE_FILTERS = [
    ['all', 'Все'],
    ['expired', 'Просрочено'],
    ['soon', 'Истекает'],
    ['ok', 'В порядке'],
];
// refs.results — ЕДИНСТВЕННОЕ, что перерисовывается (SEARCH_ALIVE_V1); шапка с
// полем поиска и фильтром товара живёт от открытия экрана до его закрытия.
// refs.prodSig — список товаров, которым фильтр заполнен сейчас: пока он не
// изменился, опции не трогаются вовсе.
const refs = { host: null, results: null, prod: null, prodSig: null, statePills: [] };
// EXPIRY_BALANCE_V1 — СВОЙ СЧЁТЧИК, а не общий fetchGuard закупок. Экран живёт
// в оболочке «Закупок» рядом с её вкладками, и на общем счётчике перерисовка
// ЛЮБОЙ соседней вкладки отменяла отрисовку этого экрана: он оставался пустым,
// а причины на экране не было. До сих пор этого не случалось лишь потому, что
// оболочка очищает панель перед переключением, — то есть безопасность держалась
// на чужом порядке действий, а не на своём. Тот же довод и то же решение, что у
// журнала движений (views/stock-log.js) и «Моих запасов» (views/my-stock.js).
let token = 0;

/** Параметры запроса из состояния фильтров — ровно то, что понимает RPC. */
export function expiryQuery() {
    const args = {};
    if (state.productId) args.product_id = Number(state.productId);
    if (state.q.trim()) args.q = state.q.trim();
    if (state.cats.length) args.categories = state.cats.slice();
    if (state.lotState && state.lotState !== 'all') args.state = state.lotState;
    return args;
}

export async function renderExpiryTab(container) {
    // Экран открывается чистым: уцелевший с прошлого раза отбор читается как
    // «партий нет», и человек ищет поломку, а не фильтр (тот же довод, что у
    // журнала движений).
    // Отметки категорий — не «уцелевший отбор», а выбор человека: они
    // запоминаются за ним намеренно и видны на экране кнопками.
    state.productId = ''; state.q = ''; state.lotState = 'all';
    state.cats = loadCategories();
    clear(container);
    refs.host = h('div');
    container.appendChild(refs.host);
    buildShell();
    await paint();
}

const inpStyle = {
    height: '30px', padding: '0 8px', border: '1px solid var(--ink-200)',
    borderRadius: '8px', fontSize: '12.5px', background: 'white', fontFamily: 'inherit',
};

function filterBar() {
    // Товары приезжают с ответом сервера; фильтр рождается с одной опцией и
    // дальше только ДОПОЛНЯЕТСЯ (syncProducts) — пересоздавать его нельзя.
    const prod = h('select', { title: 'Товар', 'aria-label': 'Товар', style: { ...inpStyle, maxWidth: '220px' } },
        h('option', { value: '' }, 'Все товары'));
    prod.addEventListener('change', () => { state.productId = prod.value; paint(); });

    const q = h('input', { type: 'text', placeholder: 'Поиск товара…', style: { ...inpStyle, width: '200px' } });
    q.addEventListener('input', () => { state.q = q.value; paint(); });
    return { prod, q };
}

/**
 * Неподвижная часть экрана: окно и строка фильтров в его шапке. Строится ОДИН
 * раз за открытие — см. SEARCH_ALIVE_V1 в шапке файла.
 */
function buildShell() {
    const host = refs.host;
    clear(host);
    const f = filterBar();
    refs.prod = f.prod;
    refs.prodSig = null;
    // Отступы окна (PROCUREMENT_FILTERS_V1): у .card своего отступа нет, он
    // живёт в .card-pad-sm — без него пояснения и таблица стояли вплотную к рамке.
    refs.results = h('div', { class: 'card-pad-sm' });
    refs.statePills = STATE_FILTERS.map(([value, label]) => {
        const count = h('span', { class: 'state-count', style: { fontWeight: 400, opacity: '0.8' } });
        const b = h('button', { type: 'button', class: 'state-pill', 'data-state': value, style: pillStyle }, label, ' ', count);
        b._value = value;
        b._count = count;
        b.addEventListener('click', () => {
            if (state.lotState === value) return;
            state.lotState = value;
            paintStatePills(null);
            paint();
        });
        return b;
    });
    paintStatePills(null);
    host.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-header', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('h3', null, Icon('Clock', { size: 15 }), ' ', tr('Сроки годности')),
            h('span', { class: 'grow' }),
            f.q, f.prod,
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 16px', borderBottom: '1px solid var(--ink-100)' } },
            categoryFilter({ selected: state.cats, onChange: (c) => { state.cats = c; paint(); } }),
            h('div', { class: 'row', role: 'group', 'aria-label': 'Состояние', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' } },
                h('span', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 600, marginRight: '4px' } }, 'Состояние'),
                ...refs.statePills),
        ),
        refs.results,
    ));
}

const pillStyle = {
    height: '30px', padding: '0 12px', borderRadius: '999px', cursor: 'pointer',
    fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600,
};

/** Вид кнопок состояния и числа на них; summary === null — числа не трогать. */
function paintStatePills(summary) {
    for (const b of refs.statePills) {
        const on = state.lotState === b._value;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        Object.assign(b.style, {
            border: '1px solid ' + (on ? 'var(--primary-600)' : 'var(--ink-200)'),
            background: on ? 'var(--primary-600)' : 'var(--white, #fff)',
            color: on ? '#fff' : 'var(--ink-700)',
        });
        if (summary) {
            const n = b._value === 'all' ? summary.total : summary[b._value];
            b._count.textContent = n === undefined || n === null ? '' : String(n);
        }
    }
}

/**
 * Список товаров в фильтре — из ответа сервера. Меняются ОПЦИИ, а не сам
 * фильтр, и только если список действительно стал другим: иначе выпадающий
 * список закрывался бы прямо под рукой, а выбранный товар слетал бы на «Все».
 */
function syncProducts(products) {
    const sel = refs.prod;
    if (!sel) return;
    const sig = JSON.stringify(products.map((p) => [p.id, p.name]));
    if (sig === refs.prodSig) return;
    refs.prodSig = sig;
    const picked = String(state.productId || '');
    clear(sel);
    sel.appendChild(h('option', { value: '', selected: picked === '' }, 'Все товары'));
    for (const p of products) {
        sel.appendChild(h('option', { value: String(p.id), selected: String(p.id) === picked }, p.name));
    }
    sel.value = picked;
}

/** Ожидание ВНУТРИ уже нарисованного окна: второе окно тут было бы рамкой в рамке. */
const loadingLine = () => h('div', { class: 'empty' }, 'Загрузка…');

async function paint() {
    const region = refs.results;
    if (!region) return;
    clear(region);
    region.appendChild(loadingLine());

    const mine = ++token;
    const { data, error } = await supabase.rpc('stock_expiry_lots', expiryQuery());
    if (mine !== token || refs.results !== region) return;
    clear(region);

    if (error) {
        toast(trf('Не удалось загрузить сроки годности: {msg}', { msg: error.message || error }), 'fail');
        region.appendChild(h('div', { class: 'empty' }, 'Не удалось загрузить сроки годности.'));
        return;
    }

    const res = data || {};
    // PROCUREMENT_FILTERS_V1 (ревью M4) — выбранный товар, которого нет среди
    // товаров отмеченных категорий, сбрасывается и запрос уходит заново: иначе
    // отбор «товар И категория» молча отдавал пустоту, а в списке товаров
    // выбранного уже не было — снять его было нечем.
    if (state.productId && !(res.products || []).some((p) => String(p.id) === String(state.productId))) {
        state.productId = '';
        return paint();
    }
    const rows = res.lots || [];
    const filtered = !!(state.productId || state.q.trim() || state.cats.length || state.lotState !== 'all');
    syncProducts(res.products || []);
    paintStatePills(res.summary || { total: rows.length });

    const tbody = h('tbody');
    if (!rows.length) {
        tbody.appendChild(h('tr', null,
            h('td', { colspan: '7', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } },
                filtered ? 'Нет подходящих партий.' : emptyWords())));
    } else {
        for (const l of rows) tbody.appendChild(lotRow(l));
    }

    const parts = [
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
    ];
    for (const part of parts) if (part) region.appendChild(part);
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
