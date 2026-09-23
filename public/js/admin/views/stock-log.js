// STOCK_LOG_V1 (2026-09-23) — ЖУРНАЛ ДВИЖЕНИЙ СКЛАДА.
//
// Владелец (23.09): «выдавать со склада можно без объяснений, но журнал должен
// быть виден», и решение по области видимости — «каждый видит своё,
// заведующая — свой отдел, администратор и кладовщик — всю клинику».
//
// ЧТО ЭКРАН ПОКАЗЫВАЕТ И ЧЕГО НЕ ДЕЛАЕТ. Он рисует то, что прислал сервер
// (rpc/stock-log.js, stock_movements_list), и НЕ решает сам, чьи строки
// показывать: область видимости — это отбор в WHERE, а не фильтр в браузере.
// Поэтому здесь нет ни одной проверки роли: строка, которой человеку видеть
// нельзя, до этого файла не доезжает.
//
// ТРИ КОЛОНКИ, КОТОРЫХ НЕ БЫЛО. «Кто» рисовал прочерк у КАЖДОЙ строки (экран
// просил встраивание `users(…)`, а реестр регистрирует его как `created_by` —
// запрос отвергался целиком, и вид молча откатывался на выборку без имени).
// «Кому» не существовало: получатель был вклеен в начало основания. «Партия» и
// «Срок» писались приходом с 037-й миграции и не читались никем.
//
// ОТБОР ПО ДАТАМ СЧИТАЕТ СЕРВЕР, а не браузер поверх обрезанной выборки:
// журнал за март не может появиться из последних трёхсот строк, если их все
// написали в сентябре. Границ у полей даты нет намеренно — DATE_LIMITS_V1
// (e886ecb) вернул правило «не в будущем» тем полям, которым оно принадлежит.
//
// SEARCH_ALIVE_V1 — СТРОКА ФИЛЬТРОВ ПЕРЕРИСОВКУ ПЕРЕЖИВАЕТ. Поиск в программе
// с задержкой (ui.js SEARCH_DEBOUNCE_V1): запрос уходит через полсекунды после
// начала набора. Пока экран перерисовывался целиком, ответ на этот запрос
// пересоздавал поле ввода — и «парацетамол» обрывался на середине, потому что
// остаток слова летел в узел, снятый с экрана. Поэтому органы управления
// строятся ОДИН раз (buildShell), а paint() трогает только область
// результатов. Тот же приём, что у очереди лаборатории (views/laboratory.js:
// refs.searchInp живёт в шапке окна, paintRows() перерисовывает список).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { fmtPrice, fmtSignedQty, movementTag } from './inventory-shared.js';

const PAGE = 200;
const MAX_PAGE = 1000;

// Вид получателя словами. Пациент не держатель (у него ничего не «лежит») —
// он конец пути, и строка расхода называет его отдельно.
export const HOLDER_LABEL = { staff: 'Сотрудник', room: 'Кабинет', department: 'Отдел' };

const KIND_OPTIONS = [
    ['all', 'Все типы'], ['receive', 'Приход'], ['issue', 'Выдача'],
    ['dispense', 'Списание'], ['adjust', 'Корректировка'], ['void', 'Отмена'],
];

// Что человеку видно — его же словами. Молчание на месте этой строки читалось
// бы как «движений в клинике нет», а не «вам видно своё».
const SCOPE_NOTE = {
    department: 'Видны движения вашего отдела и ваши собственные.',
    own: 'Видны ваши движения: что выдали вам и что провели вы.',
};

const state = { from: '', to: '', kind: 'all', q: '', limit: PAGE };
// refs.results — ЕДИНСТВЕННОЕ, что перерисовывается (SEARCH_ALIVE_V1); шапка с
// полем поиска и фильтрами живёт от открытия экрана до его закрытия.
const refs = { host: null, results: null, withHead: false };
// STOCK_LOG_V1 — СВОЙ СЧЁТЧИК, а не общий fetchGuard закупок. Оболочка держит
// до трёх смонтированных панелей, и журнал живёт рядом с «Закупками»: на общем
// счётчике перерисовка любой их вкладки отменяла отрисовку журнала, и он
// оставался пустым молча. Тот же довод и то же решение, что у «Моих запасов»
// (views/my-stock.js).
let token = 0;

/** Параметры запроса из состояния фильтров — ровно то, что понимает RPC. */
export function journalQuery() {
    const args = { limit: state.limit };
    if (state.from) args.from = state.from;
    if (state.to) args.to = state.to;
    if (state.kind && state.kind !== 'all') args.kind = state.kind;
    if (state.q.trim()) args.q = state.q.trim();
    return args;
}

export async function renderStockLog(container, { withHead = false } = {}) {
    refs.withHead = withHead;
    // Журнал открывается чистым: незаметно уцелевший с прошлого раза период —
    // это «движений нет» на пустом экране, и человек ищет поломку, а не фильтр.
    state.from = ''; state.to = ''; state.kind = 'all'; state.q = ''; state.limit = PAGE;
    clear(container);
    refs.host = h('div', { class: withHead ? 'fade-in' : null });
    container.appendChild(refs.host);
    buildShell();
    await paint();
}

/**
 * Неподвижная часть экрана: заголовок, окно и строка фильтров в его шапке.
 * Строится ОДИН раз за открытие — см. SEARCH_ALIVE_V1 в шапке файла.
 */
function buildShell() {
    const host = refs.host;
    clear(host);
    if (refs.withHead) {
        host.appendChild(h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Журнал движений'),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } },
                    'Приход, выдача и расход товара: кто провёл, кому выдал, из какой партии.'))));
    }
    const f = filterBar();
    refs.results = h('div');
    host.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-header', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('h3', null, Icon('Activity', { size: 15 }), ' ', tr('Журнал движений')),
            h('span', { class: 'grow' }),
            Icon('Calendar', { size: 14 }), f.from, f.to, f.q, f.kind,
        ),
        refs.results,
    ));
}

const inpStyle = {
    height: '30px', padding: '0 8px', border: '1px solid var(--ink-200)',
    borderRadius: '8px', fontSize: '12.5px', background: 'white', fontFamily: 'inherit',
};

function filterBar() {
    const from = h('input', { type: 'date', value: state.from, title: 'Дата с', 'aria-label': 'Дата с', style: inpStyle });
    from.addEventListener('change', () => { state.from = from.value; state.limit = PAGE; paint(); });
    const to = h('input', { type: 'date', value: state.to, title: 'Дата по', 'aria-label': 'Дата по', style: inpStyle });
    to.addEventListener('change', () => { state.to = to.value; state.limit = PAGE; paint(); });

    const kind = h('select', { title: 'Тип', 'aria-label': 'Тип', style: inpStyle },
        ...KIND_OPTIONS.map(([v, label]) => h('option', { value: v, selected: v === state.kind }, label)));
    kind.addEventListener('change', () => { state.kind = kind.value; state.limit = PAGE; paint(); });

    const q = h('input', { type: 'text', placeholder: 'Поиск товара…', value: state.q, style: { ...inpStyle, width: '200px' } });
    q.addEventListener('input', () => { state.q = q.value; state.limit = PAGE; paint(); });

    return { from, to, kind, q };
}

/** Ожидание ВНУТРИ уже нарисованного окна: второе окно тут было бы рамкой в рамке. */
const loadingLine = () => h('div', { class: 'empty' }, 'Загрузка…');

async function paint() {
    const region = refs.results;
    if (!region) return;
    clear(region);
    region.appendChild(loadingLine());

    const mine = ++token;
    const { data, error } = await supabase.rpc('stock_movements_list', journalQuery());
    if (mine !== token || refs.results !== region) return;
    clear(region);

    if (error) {
        toast(trf('Не удалось загрузить журнал: {msg}', { msg: error.message || error }), 'fail');
        region.appendChild(h('div', { class: 'empty' }, 'Не удалось загрузить движения.'));
        return;
    }

    const res = data || {};
    const rows = res.movements || [];
    // STOCK_LOG_V1 — ЗАКУПОЧНАЯ ЦЕНА ТОЛЬКО ТОМУ, КТО ВИДИТ ВСЮ КЛИНИКУ.
    // Журнал был экраном администратора и кладовщика; область видимости
    // («своё / свой отдел / вся клиника») открыла его медсестре и заведующей,
    // и та же колонка молча показала бы заведующей отделением, почём клиника
    // закупает. Расширение области видимости — не расширение видимости ДЕНЕГ.
    const withPrice = res.scope === 'all';

    const tbody = h('tbody');
    if (!rows.length) {
        tbody.appendChild(h('tr', null,
            h('td', { colspan: withPrice ? '10' : '9', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } },
                'Нет подходящих движений.')));
    } else {
        for (const m of rows) tbody.appendChild(auditRow(m, withPrice));
    }

    const note = SCOPE_NOTE[res.scope];
    const parts = [
        note ? h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '0 0 8px' } }, note) : null,
        h('div', { style: { overflowX: 'auto' } },
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Когда'),
                    h('th', null, 'Товар'),
                    h('th', null, 'Тип'),
                    h('th', null, 'Кол-во'),
                    withPrice ? h('th', null, 'Цена за ед.') : null,
                    h('th', null, 'Кому'),
                    h('th', null, 'Партия'),
                    h('th', null, 'Срок'),
                    h('th', null, 'Основание'),
                    h('th', null, 'Кто'),
                )),
                tbody,
            ),
        ),
        truncationNote(res),
    ];
    for (const part of parts) if (part) region.appendChild(part);
}

/** Список обрезан — скажи это, а не делай вид, что журнал кончился. */
function truncationNote(res) {
    if (!res.truncated) return null;
    const more = h('button', { class: 'btn btn-sm btn-outline', type: 'button' }, 'Показать ещё');
    more.addEventListener('click', () => { state.limit = Math.min(state.limit + PAGE, MAX_PAGE); paint(); });
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', paddingTop: '8px' } },
        h('span', { class: 'muted', style: { fontSize: '12.5px' } },
            trf('Показаны последние {n} — журнал длиннее. Уточните период, тип или поиск.', { n: res.count })),
        h('span', { class: 'grow' }),
        state.limit < MAX_PAGE ? more : null);
}

/** Кому ушёл товар: получатель выдачи — или пациент, если это расход на него. */
export function receiverCell(m) {
    if (m.patient_name) {
        return h('div', null, h('div', null, m.patient_name),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Пациент'));
    }
    if (!m.holder_name && !m.holder_type) return h('span', { class: 'muted' }, '—');
    return h('div', null, h('div', null, m.holder_name || '—'),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, HOLDER_LABEL[m.holder_type] || ''));
}

function auditRow(m, withPrice) {
    return h('tr', null,
        h('td', null, fmtDateTime(m.created_at)),
        h('td', null, m.product_name || '—'),
        h('td', null, movementTag(m)),
        h('td', { class: 'num' }, fmtSignedQty(m.qty, m.unit || '')),
        withPrice ? h('td', { class: 'num' }, m.unit_cost != null ? fmtPrice(m.unit_cost) : '—') : null,
        h('td', null, receiverCell(m)),
        h('td', null, m.batch_no || '—'),
        h('td', null, m.expiry_date || '—'),
        h('td', null, m.note || '—'),
        h('td', null, m.actor_name || '—'),
    );
}
