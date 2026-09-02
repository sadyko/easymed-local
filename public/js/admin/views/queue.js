// QUEUE_BOARD_V1 — «Очередь»: кто у кого стоит прямо сейчас.
//
// Номера выдавались всегда (issue_queue_numbers) и печатались на талоне, но
// показать их обратно было негде — очередь читалась глазами по коридору. Здесь
// те же номера собраны в доску по назначениям: врачи первыми, следом
// процедурная, лаборатория и аппараты.
//
// Раздел ТОЛЬКО ЧИТАЕТ. Ни одной кнопки, меняющей данные, здесь нет: вызвать
// следующего врач по-прежнему может из «Моих услуг», и дублировать это
// действие на доске значило бы завести второе место, где меняется статус.
//
// Один номер может закрывать несколько услуг: у лаборатории это норма — все
// анализы пациента идут под одним номером (одно окно забора). Поэтому строка в
// карточке — это ТАЛОН, а не услуга, и услуги перечислены внутри неё.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, PageHead } from '../ui.js';
import { trf } from '../i18n.js';   // I18N_COVERAGE_V1 — счётчики очереди собираются вокруг чисел

// QUEUE_FILTERS_V1 — фильтры живут в состоянии модуля, а не в DOM: доска сама
// перезагружается каждые 10 секунд, и фильтр, хранившийся в поле ввода,
// сбрасывался бы у сотрудника под руками.
const state = { day: '', board: null, error: '', query: '', kind: 'all', onlyWaiting: false };
let refs = {};
let poll = null;

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'Не удалось выполнить запрос.');
    return data;
}

// Локальная дата, а не toISOString(): последняя вернула бы UTC и вечером
// показала бы завтрашний день.
function todayLocal() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const KIND_TITLE = {
    doctor:    'Врачи',
    room:      'Кабинеты',   // ROOMS_QUEUE_V1 — очередь к двери, а не к врачу
    procedure: 'Процедуры',
    lab:       'Лаборатория',
    imaging:   'Диагностика',
    other:     'Прочее',
};

const STATE_STYLE = {
    serving: { label: 'принимают',      bg: 'var(--primary-50)',       fg: 'var(--primary-700)' },
    waiting: { label: 'ждёт',           bg: 'var(--ink-50, #f1f4f5)',  fg: 'var(--ink-700)' },
    unpaid:  { label: 'ожидает оплату', bg: 'var(--warn-50, #fffbeb)', fg: 'var(--warn-700, #b45309)' },
    done:    { label: 'принят',         bg: 'transparent',             fg: 'var(--ink-400, #9aa7ab)' },
};

// Принятых показываем последними и приглушённо. Убирать их совсем нельзя:
// номера в списке начнут «прыгать», и сотрудник не поймёт, куда делся человек.
const STATE_ORDER = { serving: 0, waiting: 1, unpaid: 2, done: 3 };

// Все карточки одного размера: десять строк видно, остальное прокручивается
// ВНУТРИ карточки. У гинеколога очередь из тринадцати человек, у невролога из
// двух — без общей высоты доска превращается в лестницу, где короткие колонки
// тонут под длинными и глазом их уже не сравнить.
//
// Высота строки фиксирована (а не «сколько получится»), потому что от неё
// считается высота списка: 10 x ROW_H — это ровно десять строк, без половинки
// одиннадцатой, торчащей из-под края.
const ROWS_VISIBLE = 10;
const ROW_H = 52;

export async function renderQueue(container) {
    clear(container);
    stopPolling();
    state.day = state.day || todayLocal();

    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);

    const dayInput = h('input', {
        type: 'date', value: state.day, style: { width: '160px' },
        onchange: () => { state.day = dayInput.value || todayLocal(); load(); },
    });
    const refreshBtn = h('button', {
        class: 'btn', type: 'button', title: 'Обновить сейчас', onclick: () => load(),
    }, Icon('Refresh', { size: 13 }), ' Обновить');

    root.appendChild(PageHead({
        title: 'Очередь',
        subtitle: 'Номера талонов по назначениям за день. Раздел только показывает — вызов пациента остаётся в «Моих услугах».',
        right: [dayInput, refreshBtn],
    }));

    refs.filters = h('div');
    // Панель принадлежит ЭТОМУ монтированию. При повторном входе в раздел
    // контейнер новый, а refs.bar ещё указывал бы на элемент прошлой страницы —
    // и panel никогда бы не построилась заново.
    refs.bar = null;
    root.appendChild(refs.filters);
    refs.body = h('div');
    root.appendChild(refs.body);

    await load();
    // Очередь меняется в других разделах (касса, кабинет врача), а не здесь,
    // поэтому доска обновляет себя сама. 10 секунд — как в «Чате с пациентами».
    poll = setInterval(() => { load({ quiet: true }).catch(() => {}); }, 10000);
}

export function stopQueuePolling() { stopPolling(); }
function stopPolling() { if (poll) { clearInterval(poll); poll = null; } }

async function load({ quiet = false } = {}) {
    if (!quiet) {
        clear(refs.body);
        refs.body.appendChild(h('div', { class: 'muted', style: { padding: '18px' } }, 'Загрузка…'));
    }
    try {
        state.board = await rpc('queue_board', { day: state.day });
        state.error = '';
    } catch (e) {
        state.error = e.message;
        // Тихое обновление не стирает уже показанную доску: сеть моргнула —
        // сотрудник продолжает видеть последнюю известную очередь.
        if (quiet) return;
    }
    paintFilters();
    paint();
}

// ---------------------------------------------------------------------------
// QUEUE_FILTERS_V1 — фильтры доски
// ---------------------------------------------------------------------------
// Фильтруем УЖЕ полученную доску, а не спрашиваем сервер заново: queue_board
// отдаёт день целиком, и лишний запрос на каждую букву в поиске нагружал бы
// базу ради данных, которые уже лежат в памяти.
//
// Поиск ищет сразу по врачу, пациенту и услуге. У доски два разных читателя:
// регистратура смотрит «что у Пулатова», а медсестра — «где мой пациент», и
// заводить под это два поля значило бы заставлять обоих думать, в какое
// вводить.
function matchesQuery(g, q) {
    if (!q) return true;
    if (String(g.label || '').toLowerCase().includes(q)) return true;
    return (g.tickets || []).some((t) =>
        String(t.patient_name || '').toLowerCase().includes(q) ||
        (t.services || []).some((s) => String(s || '').toLowerCase().includes(q)));
}

function visibleGroups() {
    const all = (state.board && state.board.groups) || [];
    const q = state.query;
    return all.filter((g) =>
        (state.kind === 'all' || g.kind === state.kind) &&
        (!state.onlyWaiting || (g.waiting_count + (g.unpaid_count || 0)) > 0) &&
        matchesQuery(g, q));
}

// Панель строится ОДИН раз, а перерисовываются только вкладки со счётчиками.
//
// Доска сама обновляется каждые 10 секунд. Если пересоздавать поле поиска на
// каждом обновлении, оно будет терять фокус и курсор прямо под руками у
// сотрудника — искать в таком поле невозможно.
function buildFilters() {
    refs.search = h('input', {
        value: state.query, placeholder: 'Врач, пациент, услуга',
        oninput: (ev) => { state.query = ev.target.value.trim().toLowerCase(); paint(); },
    });
    const searchWrap = h('div', { class: 'q-search' }, h('span', null, Icon('Search', { size: 14 })), refs.search);

    refs.chips = h('div', { class: 'q-chips' });

    const waitCb = h('input', { type: 'checkbox', checked: state.onlyWaiting,
        onchange: (ev) => { state.onlyWaiting = ev.target.checked; paint(); } });
    const waitLbl = h('label', { class: 'q-wait' }, waitCb, 'Только где есть очередь');

    refs.bar = h('div', { class: 'q-filters' }, searchWrap, refs.chips, waitLbl);
    refs.filters.appendChild(refs.bar);
}

function paintFilters() {
    if (!refs.filters) return;
    if (!refs.bar) buildFilters();

    const all = (state.board && state.board.groups) || [];
    // Пустой день — панель прячем, а не удаляем: удаление снова сожгло бы
    // введённый в поиск текст.
    refs.bar.style.display = all.length ? '' : 'none';
    if (!all.length) return;

    // Вкладки видов. Показываем только те, что реально есть в этот день:
    // «Диагностика (0)» — это шум, а не информация.
    clear(refs.chips);
    const kinds = ['all', ...Object.keys(KIND_TITLE).filter((k) => all.some((g) => g.kind === k))];
    // Выбранный вид исчез из выдачи (сменили день) — возвращаемся к «Все»,
    // иначе доска пуста без видимой причины.
    if (!kinds.includes(state.kind)) state.kind = 'all';

    for (const k of kinds) {
        const on = state.kind === k;
        const n = k === 'all' ? all.length : all.filter((g) => g.kind === k).length;
        refs.chips.appendChild(h('button', {
            type: 'button',
            class: on ? 'on' : null,
            onclick: () => { state.kind = k; paintFilters(); paint(); },
        }, k === 'all' ? 'Все' : (KIND_TITLE[k] || k),
            h('span', { class: 'n' }, String(n))));
    }
}

function paint() {
    clear(refs.body);
    if (state.error) {
        refs.body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } }, state.error));
        return;
    }
    const total = ((state.board && state.board.groups) || []).length;
    const groups = visibleGroups();
    // Отфильтровали всё — это НЕ «талонов нет»: сотрудник должен видеть, что
    // виноват фильтр, иначе он решит, что очередь пуста.
    if (total && !groups.length) {
        refs.body.appendChild(h('div', { class: 'empty', style: { padding: '34px', textAlign: 'center' } },
            h('div', { style: { fontWeight: '600' } }, 'Ничего не найдено'),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                'Под выбранные фильтры не подходит ни одна очередь.'),
            h('button', { class: 'btn btn-sm', type: 'button', style: { marginTop: '12px' },
                onclick: () => {
                    state.query = ''; state.kind = 'all'; state.onlyWaiting = false;
                    if (refs.search) refs.search.value = '';
                    refs.bar = null; clear(refs.filters);   // пересобрать: галочка и вкладки сброшены
                    paintFilters(); paint();
                } },
                'Сбросить фильтры')));
        return;
    }
    if (!groups.length) {
        refs.body.appendChild(h('div', { class: 'empty', style: { padding: '40px', textAlign: 'center' } },
            h('div', { style: { color: 'var(--ink-300, #c3ced2)' } }, Icon('Clock', { size: 28 })),
            h('div', { style: { marginTop: '10px', fontWeight: '600' } }, 'За этот день талонов нет'),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                'Номер появляется, когда услугу заводят в визит пациента.')));
        return;
    }

    // Группы приходят с сервера уже отсортированными (врачи первыми); здесь
    // только расставляем заголовок там, где меняется вид назначения.
    let lastKind = null;
    let grid = null;
    for (const g of groups) {
        if (g.kind !== lastKind) {
            lastKind = g.kind;
            refs.body.appendChild(h('div', { style: {
                fontSize: '12.5px', fontWeight: '700', letterSpacing: '.06em', textTransform: 'uppercase',
                color: 'var(--ink-500)', margin: '18px 0 10px',
            } }, KIND_TITLE[g.kind] || KIND_TITLE.other));
            grid = h('div', { style: {
                display: 'grid', gap: '14px',
                gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            } });
            refs.body.appendChild(grid);
        }
        grid.appendChild(groupCard(g));
    }
}

function groupCard(g) {
    const nowNumbers = g.now || [];

    // Крупная цифра — то, ради чего на доску вообще смотрят. Когда никого не
    // приняли, показываем прочерк, а не ноль: ноль читается как «номер 0».
    const nowBox = h('div', { style: {
        minWidth: '74px', padding: '10px 12px', borderRadius: '12px', textAlign: 'center', flex: '0 0 auto',
        background: nowNumbers.length ? 'var(--primary-600)' : 'var(--ink-50, #f1f4f5)',
        color: nowNumbers.length ? '#fff' : 'var(--ink-400, #9aa7ab)',
    } },
        h('div', { style: { fontSize: '24px', fontWeight: '800', lineHeight: '1.05' } },
            nowNumbers.length ? nowNumbers.join(', ') : '—'),
        h('div', { style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '.05em', marginTop: '3px', opacity: '0.9' } },
            'сейчас'));

    const head = h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', padding: '14px 16px' } },
        nowBox,
        h('div', { style: { minWidth: '0', flex: '1' } },
            h('div', { style: { fontSize: '15px', fontWeight: '700', color: 'var(--ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                g.label),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '3px' } },
                trf('ждут: {n}', { n: g.waiting_count }) +
                (g.unpaid_count ? ' · ' + trf('без оплаты: {n}', { n: g.unpaid_count }) : '') +
                ' · ' + trf('принято: {n}', { n: g.done_count }))));

    const list = h('div', { style: {
        borderTop: '1px solid var(--ink-100)',
        height: (ROWS_VISIBLE * ROW_H) + 'px',
        overflowY: 'auto',
    } });
    const tickets = (g.tickets || []).slice().sort((a, b) =>
        (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || (a.number - b.number));

    for (const t of tickets) {
        const st = STATE_STYLE[t.state] || STATE_STYLE.waiting;
        list.appendChild(h('div', { style: {
            display: 'flex', gap: '10px', alignItems: 'center',
            // Фиксированная высота + border-box: строка обязана быть ровно
            // ROW_H, иначе десять строк перестанут совпадать с высотой списка.
            height: ROW_H + 'px', boxSizing: 'border-box',
            padding: '8px 16px', borderBottom: '1px solid var(--ink-50, #f1f4f5)',
            opacity: t.state === 'done' ? '0.55' : '1',
        } },
            h('div', { style: {
                width: '30px', flex: '0 0 auto', textAlign: 'center',
                fontSize: '13.5px', fontWeight: '700',
                color: t.state === 'serving' ? 'var(--primary-700)' : 'var(--ink-700)',
            } }, String(t.number)),
            h('div', { style: { minWidth: '0', flex: '1' } },
                h('div', { style: { fontSize: '13.5px', lineHeight: '17px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    t.patient_name),
                t.services && t.services.length
                    ? h('div', { class: 'muted', style: { fontSize: '12.5px', lineHeight: '15px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        t.services.join(' · '))
                    : null),
            h('span', { style: {
                flex: '0 0 auto', fontSize: '12.5px', fontWeight: '600',
                padding: '3px 8px', borderRadius: '99px',
                background: st.bg, color: st.fg,
            } }, st.label)));
    }

    return h('div', { class: 'card', style: { padding: '0', overflow: 'hidden' } }, head, list);
}
