// Dashboard — сводка клиники.
//
// DASHBOARD_ONE_VIEW_V1 (2026-10-31) — владелец, со снимком переключателей
// «Сегодня | Обзор клиники» и «7 / 14 / 30 / 90 дней»: «put today to date
// place and no need today page, just obzor kliniki should show todays date».
//
// Было две вкладки: «Сегодня» — взгляд в один экран (DASHBOARD_TREND_V1,
// DASH_ONE_SCREEN_V1: плитки дня, деньги по дням, кольцо коек, движение
// людей) и «Обзор клиники» — чтение для руководителя за период
// (DASHBOARD_OVERVIEW_V1, DASHBOARD_CEO_V1: все отделы, сравнение с прошлым
// периодом, «Требует внимания»). Две вкладки отвечали на один вопрос с разной
// глубиной, и обзор уже умеет всё, что умела «Сегодня», и больше. Теперь
// сводка — ОДИН экран, обзор, а «сегодня» стал периодом: первая кнопка ряда
// «Сегодня · 7 дней · 14 дней · 30 дней · 90 дней», с неё сводка и
// открывается. Сравнение у «Сегодня» — со вчерашним днём (сервер считает
// прошлый период той же длины).
//
// Чего не стало вместе со вкладкой «Сегодня»: площадь «деньги по дням» и
// столбики визитов — их место заняли карточки обзора (финансы, амбулатория,
// стационар с палатами). Серверный dashboard_trend больше ни один экран не
// читает; он оставлен на сервере — удалять RPC отдельное решение.
//
// Числа считает СЕРВЕР (rpc/dashboard-overview.js и dashboard-overview-depts.js);
// здесь шапка с периодом и загрузка. Раскладка обзора — dash-overview.js.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, PageHead } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
// MOTION_REVEAL_V1 — тот же помощник появления, что у списка пациентов и
// доски очереди (public/js/admin/motion.js): один словарь движения на всё.
import { revealOn } from '../motion.js?v=mo1';
// V3120_FIX — карточка ведёт только туда, куда роли можно: иначе щелчок
// кончался панелью «Нет доступа».
import { isRouteAllowed } from '../permissions.js';
import { renderOverview } from './dash-overview.js';

/** 1 — «Сегодня»; первым и по умолчанию. */
export const PERIODS = [1, 7, 14, 30, 90];
const DEFAULT_DAYS = 1;
const PERIOD_KEY = 'dash.days';

const refs = { container: null, onNavigate: null, wrap: null, body: null, periodWrap: null };
const state = { days: readPeriod(), summary: null, overview: null };

function readPeriod() {
    try {
        const raw = window.localStorage && window.localStorage.getItem(PERIOD_KEY);
        const v = Number(raw);
        return raw != null && PERIODS.includes(v) ? v : DEFAULT_DAYS;
    } catch (e) { return DEFAULT_DAYS; }
}
function savePeriod(days) {
    try { window.localStorage && window.localStorage.setItem(PERIOD_KEY, String(days)); } catch (e) { /* без памяти — просто не запомним */ }
}

export async function renderDashboard(container, { onNavigate } = {}) {
    refs.container = container;
    refs.onNavigate = onNavigate;
    // Период перечитывается при каждом открытии: его могли сменить в другой
    // вкладке, и экран обязан открыться на том, что человек выбрал последним.
    state.days = readPeriod();
    mount();
    await fetchAndPaint();
}

const go = (view) => () => refs.onNavigate && refs.onNavigate(view);
function routeOpen(view) {
    try { return isRouteAllowed(view); } catch (e) { return true; }
}

// -----------------------------------------------------------------------------
// MOUNT — шапка с периодом; fetchAndPaint() перерисовывает только тело.
// -----------------------------------------------------------------------------
function mount() {
    clear(refs.container);
    refs.periodWrap = h('div', { class: 'segmented', role: 'group', 'aria-label': tr('Период') });
    refs.body = h('div', { class: 'dash-body' });
    // Обзор длиннее экрана: подгонка высоты снята (.dash-scroll), тело —
    // обычная колонка.
    refs.wrap = h('div', { class: 'fade-in dash-fit dash-scroll' },
        PageHead({
            title: 'Сводка',
            subtitle: todaySubtitle(),
            right: [
                refs.periodWrap,
                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => fetchAndPaint() },
                    Icon('Refresh', { size: 13 }), ' ', tr('Обновить')),
            ],
        }),
        refs.body,
    );
    refs.container.appendChild(refs.wrap);
    paintPeriod();
}

function paintPeriod() {
    clear(refs.periodWrap);
    for (const d of PERIODS) {
        refs.periodWrap.appendChild(h('button', {
            type: 'button',
            class: state.days === d ? 'on' : null,
            'aria-pressed': state.days === d ? 'true' : 'false',
            'data-dash-days': String(d),
            onclick: () => {
                if (state.days === d) return;
                state.days = d;
                savePeriod(d);
                paintPeriod();
                fetchAndPaint();
            },
        }, d === 1 ? tr('Сегодня') : trf('{n} дней', { n: d })));
    }
}

function todaySubtitle() {
    try {
        return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    } catch (_) {
        return new Date().toDateString();
    }
}

// -----------------------------------------------------------------------------
// FETCH + REPAINT
// -----------------------------------------------------------------------------
let lastFetchToken = 0;

/** Обзор за период; сводка (dashboard_summary) нужна ради низкого остатка склада. */
async function fetchAndPaint() {
    const token = ++lastFetchToken;
    setLoading();
    try {
        const [ov, sum] = await Promise.all([
            supabase.rpc('dashboard_overview', { days: state.days }),
            supabase.rpc('dashboard_summary', {}),
        ]);
        if (token !== lastFetchToken) return;   // a newer fetch already landed
        if (ov.error) {
            toast(trf('Не удалось загрузить обзор: {msg}', { msg: ov.error.message || ov.error }), 'fail');
            paintError();
            return;
        }
        state.overview = ov.data || null;
        state.summary = sum.error ? state.summary : (sum.data || null);
        if (!refs.body || !state.overview) return paintError();
        clear(refs.body);
        const view = renderOverview(state.overview, state.summary, { go, open: routeOpen });
        refs.body.appendChild(view);
        revealOn(view, '[data-reveal]');
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast(trf('Не удалось загрузить обзор: {msg}', { msg: (e && e.message) || e }), 'fail');
        paintError();
    }
}

function setLoading() {
    if (!refs.body) return;
    clear(refs.body);
    refs.body.appendChild(h('div', { class: 'card', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, tr('Загрузка…')));
}

function paintError() {
    if (!refs.body) return;
    clear(refs.body);
    refs.body.appendChild(h('div', { class: 'card', style: { padding: '22px' } },
        h('div', { class: 'empty' }, tr('Сводка не загрузилась.'))));
}
