// CRM — CRM_V2. Журнал обращений (лидов) с двумя видами: КАНБАН (колонки по
// статусам, перетаскивание карточек) и СПИСОК. Конверсия открывает попап
// РЕГИСТРАЦИИ ПАЦИЕНТА с предзаполненными ФИО+телефоном (остальное — по
// желанию до сохранения). Внутри — «Отчёт» (период, конверсия, источники)
// и выгрузка Excel. Таблица crm_requests (mig 044).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field, fmtDateTime } from '../ui.js';
import { openVisitWizard } from './visit-wizard.js?v=aug17e';   // CRM_V4 — конверсия сразу в реальный заказ услуги
import { digitsOf, phoneLikePattern, filterPhoneMatches, uzLocalDigits, MIN_PHONE_DIGITS } from './crm-phone-match.js';
import { phoneInput } from '../phone-input.js?v=ph1';
import { filterServicePool, serviceGroupCounts } from './service-search.js';   // CRM_SERVICE_FILTER_V1
import { boardConfig } from '../crm-settings-logic.js?v=crmcfg1';   // CRM_CONFIG_V1

// CRM_CONFIG_V1 — воронка перестала быть константой.
//
// Колонки, их цвета, порядок и видимость, а также список источников теперь
// живут в базе (crm_stages / crm_sources, миграция 077) и правятся на экране
// Настройки → «CRM-канбан». Сюда они приезжают одним вызовом crm_config_get.
//
// Значения в crm-settings-logic.js — ТА ЖЕ жёстко зашитая воронка, что была
// здесь раньше (mig 046), и остаются ИСКЛЮЧИТЕЛЬНО как запасной вариант: если
// RPC не ответил (клиника на старой сборке получает 501, сеть отвалилась,
// ответ пустой), доска рисуется ровно так, как вчера. Экран настроек не должен
// иметь возможности обнулить доску — поэтому неудачная загрузка НИЧЕГО не
// меняет, в том числе не откатывает уже загруженную конфигурацию.
//
// «Пришёл» перестало быть именем: конверсия — это колонка с kind === 'won',
// единственная, через которую регистрируется пациент. Сам список правил
// (цвета, значения по умолчанию, разбор ответа) лежит в crm-settings-logic.js,
// чтобы доска и экран настроек не разъехались.
let SOURCES, SOURCE_RU, STATUSES, STATUS_RU, CONVERT_STATUS, ACTIVE_STATUSES, LOST_STATUSES;
function applyBoardConfig(data) {
    const c = boardConfig(data);
    SOURCES = c.sources; SOURCE_RU = c.sourceRu;
    STATUSES = c.statuses; STATUS_RU = c.statusRu;
    CONVERT_STATUS = c.convertStatus;
    ACTIVE_STATUSES = c.activeStatuses; LOST_STATUSES = c.lostStatuses;
}
applyBoardConfig(null);   // запасная воронка — до первого ответа сервера доска уже рабочая
async function loadBoardConfig() {
    const { data, error } = await supabase.rpc('crm_config_get', {});
    // Молча остаёмся на запасной воронке: доска — рабочий экран регистратуры,
    // и красная плашка «не удалось загрузить настройки» над полностью
    // работающими карточками пугала бы без причины. Настройки не применились —
    // это видно на экране настроек, а не здесь.
    if (error || !data) return;
    applyBoardConfig(data);
}

// CRM_CONFIG_V1 — ключи, на которые завязана АВТОМАТИКА, а не только вид.
//
// 'in_process' / 'scheduled' / 'no_show' — сид миграции 077, и обычно они на
// месте. Но колонку без заявок владелец вправе удалить на экране настроек, а
// после 077 crm_requests.status ссылается на crm_stages: вставка с исчезнувшим
// ключом упала бы «Не удалось создать заявку», и регистратура осталась бы без
// объяснения. Поэтому каждый такой ключ проверяется по ЖИВОЙ конфигурации, а
// запасной вариант — первая видимая колонка (начало воронки).
function stageKey(preferred) {
    if (STATUSES.some(([k]) => k === preferred)) return preferred;
    return STATUSES.length ? STATUSES[0][0] : CONVERT_STATUS;
}
// Есть ли такая колонка вообще: для фоновой автоматики, которой лучше не
// сработать, чем сработать не туда.
const hasStage = (key) => STATUSES.some(([k]) => k === key);
// Источник новой заявки по умолчанию — первый видимый, а не жёсткое 'call':
// источник тоже редактируется, и 'call' может быть переименован или скрыт.
const defaultSource = () => (SOURCES.length ? SOURCES[0][0] : 'call');
// CRM_KANBAN_PAGE_V1 — сколько карточек рисуется в колонке сразу.
const KANBAN_PAGE = 20;

// CRM_FILTERS_V1 — источник и период сужают доску. Живут в state, потому что
// paintBody() перерисовывает только тело, без повторного запроса к базе.
const state = { view: 'kanban', filter: 'all', search: '', rows: [], source: '', period: 'all',
                // CRM_PERIOD_CUSTOM_V1 — границы своего периода, 'YYYY-MM-DD'.
                // Пустая граница = без ограничения с этой стороны: «с 01.08 и
                // далее» — нормальный вопрос, и запрещать его незачем.
                customFrom: '', customTo: '' };

// Период считается по created_at — «когда обратились», а не когда записаны:
// воронку смотрят от момента обращения.
// CRM_PERIOD_WEEK_V1 — «Эта неделя» вместо скользящих «7 дней».
//
// Скользящее окно начиналось в произвольный день: в четверг «7 дней» это
// «с прошлой пятницы», и сравнить его с чем-либо нельзя. Клиника же считает
// неделями календарными — планёрка в понедельник, отчёт за неделю. «30 дней»
// остаются скользящими: месяц здесь про объём, а не про календарь.
const PERIODS = [['all', 'Всё время'], ['today', 'Сегодня'], ['week', 'Эта неделя'], ['30', '30 дней'],
                 ['custom', 'Свой период']];   // CRM_PERIOD_CUSTOM_V1
// Граница периода — НАЧАЛО дня по местному времени, а не «минус 24 часа»:
// «7 дней» для регистратуры это семь календарных дней, а не 168 часов.
function periodStart(key) {
    if (key === 'all') return null;
    const d = new Date(); d.setHours(0, 0, 0, 0);
    if (key === 'today') return d;
    // Неделя начинается с ПОНЕДЕЛЬНИКА: getDay() считает воскресенье нулём,
    // поэтому сдвигаем, иначе в воскресенье «эта неделя» показала бы один день.
    if (key === 'week') {
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        return d;
    }
    d.setDate(d.getDate() - (Number(key) - 1));
    return d;
}
// CRM_PERIOD_CUSTOM_V1 — 'YYYY-MM-DD' в границы МЕСТНЫХ суток.
//
// Верхняя граница включает весь день целиком. Иначе «по 18.08» отрезало бы
// заявки, поданные 18-го после полуночи, — то есть почти все заявки последнего
// дня выборки, и пропажу заметили бы не сразу.
//
// Без 'Z' в строке: new Date('2026-08-18T00:00:00') разбирается как местное
// время, а с 'Z' — как UTC, и на UTC+5 период съезжал бы на пять часов.
// Местная дата как 'YYYY-MM-DD'. Через toISOString() вечером на UTC+5
// получилось бы завтрашнее число.
function ymdLocal(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayStart(ymd) {
    if (!ymd) return null;
    const d = new Date(ymd + 'T00:00:00');
    return isNaN(d) ? null : d;
}
function dayEnd(ymd) {
    if (!ymd) return null;
    const d = new Date(ymd + 'T23:59:59.999');
    return isNaN(d) ? null : d;
}

function inPeriod(r) {
    if (state.period === 'custom') {
        const d = new Date(r.created_at);
        if (isNaN(d)) return false;
        const f = dayStart(state.customFrom);
        const t = dayEnd(state.customTo);
        if (f && d < f) return false;
        if (t && d > t) return false;
        return true;
    }
    const from = periodStart(state.period);
    if (!from) return true;
    const d = new Date(r.created_at);
    return !isNaN(d) && d >= from;
}
function inSource(r) {
    return !state.source || (r.source || 'other') === state.source;
}
const refs = { root: null, onNavigate: null };

export async function renderCrm(container, { onNavigate } = {}) {
    clear(container);
    refs.onNavigate = onNavigate;
    refs.root = h('div', { class: 'fade-in' });
    container.appendChild(refs.root);
    // CRM_CONFIG_V1 — воронка читается ДО первой отрисовки: иначе доска
    // моргнула бы запасными колонками и тут же перерисовалась настроенными.
    await loadBoardConfig();
    await paint();
}

async function load() {
    // CRM_AUTO_NOSHOW_V1 — день записи прошёл, а визита так и не было: заявка
    // автоматически уходит в «Не пришёл». Идемпотентно, ошибки не блокируют
    // загрузку (у ролей без права записи просто ничего не произойдёт).
    try {
        const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
        const today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        // CRM_CONFIG_V1 — если колонку «Не пришёл» из воронки убрали, автоматика
        // просто не срабатывает: молча переложить заявку в другую колонку было бы
        // хуже, чем оставить её там, где она есть.
        if (hasStage('no_show')) {
            await supabase.from('crm_requests').update({ status: 'no_show' })
                .in('status', ['scheduled', 'approved']).lt('scheduled_date', today);
        }
    } catch (e) { /* фоновая автоматика — молча */ }
    const { data, error } = await supabase.from('crm_requests')
        .select('*, patients(id, full_name, mrn), users(full_name), services(id, name, price)')
        .order('id', { ascending: false }).limit(800);
    if (error) { toast('Не удалось загрузить заявки: ' + error.message, 'fail'); state.rows = []; return; }
    state.rows = data || [];
}

// CRM_NAME_PARTS_V1 — «Фамилия Имя Отчество» из одной строки заявки. Одно слово
// — это ИМЯ (в заявку чаще пишут именно его), два — фамилия и имя, остальное
// уходит в отчество. Порядок совпадает с savePatient() в admin/data.js.
function splitFio(s) {
    const p = String(s || '').trim().split(/\s+/).filter(Boolean);
    if (!p.length)      return { last: '', first: '',   middle: '' };
    if (p.length === 1) return { last: '', first: p[0], middle: '' };
    return { last: p[0], first: p[1], middle: p.slice(2).join(' ') };
}

function uid() {
    return (window.easymed && window.easymed.state && window.easymed.state.user && window.easymed.state.user.id) || null;
}

async function setStatus(r, status) {
    const { error } = await supabase.from('crm_requests').update({ status }).eq('id', r.id);
    if (error) { toast(error.message, 'fail'); return false; }
    return true;
}

async function paint() {
    await load();
    const root = refs.root;
    clear(root);

    const viewBtn = (key, label, icon) => h('button', {
        class: 'btn btn-sm ' + (state.view === key ? 'btn-primary' : 'btn-outline'), type: 'button',
        onclick: () => { state.view = key; paint(); },
    }, Icon(icon, { size: 13 }), ' ' + label);

    // CRM_FILTERS_V1 — поиск СЛЕВА и крупнее: для регистратуры это основной
    // инструмент (найти позвонившего по имени или номеру), а он стоял прижатым
    // к правому краю мелкой строкой под кнопками экспорта. Иконка внутри и
    // крестик очистки — как в поиске «Чата с пациентами»: два поиска в системе
    // должны выглядеть одинаково.
    const searchInp = h('input', {
        class: 'crm-search',
        type: 'search', placeholder: 'Поиск по имени или телефону…', value: state.search,
        style: {
            width: '100%', height: '40px', padding: '0 36px 0 40px',
            border: '1px solid var(--ink-200, #d1d5db)', borderRadius: '12px',
            background: 'var(--white, #fff)', fontFamily: 'inherit',
            fontSize: '14px', fontWeight: '500', color: 'var(--ink-900)',
            outline: 'none', boxShadow: 'var(--shadow-sm)',
            transition: 'border-color .12s, box-shadow .12s',
        },
    });
    const searchClear = h('button', {
        type: 'button', title: 'Очистить',
        style: {
            position: 'absolute', right: '11px', top: '50%', transform: 'translateY(-50%)',
            border: 'none', background: 'transparent', cursor: 'pointer', display: 'none',
            color: 'var(--ink-500)', padding: '4px', lineHeight: '1',
        },
    }, Icon('X', { size: 14 }));
    const syncClear = () => { searchClear.style.display = searchInp.value ? 'block' : 'none'; };
    searchInp.addEventListener('focus', () => {
        searchInp.style.borderColor = 'var(--primary-500, #2d958f)';
        searchInp.style.boxShadow = '0 0 0 4px var(--primary-50, #e8f3f2)';
    });
    searchInp.addEventListener('blur', () => {
        searchInp.style.borderColor = 'var(--ink-200, #d1d5db)';
        searchInp.style.boxShadow = 'var(--shadow-sm)';
    });
    searchInp.addEventListener('input', () => { state.search = searchInp.value; syncClear(); paintFilters(); paintBody(); });
    searchClear.addEventListener('click', () => { searchInp.value = ''; state.search = ''; syncClear(); paintFilters(); paintBody(); searchInp.focus(); });
    const searchBox = h('div', { style: { position: 'relative', flex: '0 0 300px', minWidth: '200px' } },
        h('span', { style: {
            position: 'absolute', left: '13px', top: '50%', transform: 'translateY(-50%)',
            color: 'var(--primary-600, #167873)', pointerEvents: 'none', display: 'flex',
        } }, Icon('Search', { size: 16 })),
        searchInp, searchClear);
    syncClear();

    const filtersEl = h('div', { 'data-crm-filters': '', style: {
        display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap', flex: '1 1 auto', minWidth: '0',
    } });

    root.appendChild(h('div', { class: 'page-head' },
        h('div', null,
            h('h1', { class: 'page-title' }, 'CRM · Заявки'),
            h('p', { class: 'page-subtitle' }, 'Обращения в клинику: фиксируйте каждый запрос и превращайте его в пациента. ',
                h('span', { class: 'muted', style: { fontSize: '10px', opacity: '0.6' } }, 'v11'))),
        h('div', { class: 'page-head-actions', style: { flexWrap: 'wrap' } },
            viewBtn('kanban', 'Канбан', 'Grid'),
            viewBtn('list', 'Список', 'Layers'),
            h('button', { class: 'btn btn-sm btn-outline', type: 'button', onclick: () => reportModal() }, Icon('Chart', { size: 13 }), ' Отчёт'),
            h('button', { class: 'btn btn-sm btn-outline', type: 'button', onclick: () => exportExcel() }, Icon('Download', { size: 13 }), ' Excel'),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => requestModal(null) },
                Icon('Plus', { size: 14 }), ' Новая заявка')),
    ));
    // CRM_FILTERS_V2 — поиск и фильтры в ОДНОЙ строке.
    //
    // Раньше поиск занимал строку целиком, «Источник» шёл второй строкой, а
    // «Период» третьей: три яруса на то, что помещается в один, и доска
    // начиналась ниже сгиба экрана.
    root.appendChild(h('div', { style: {
        display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px',
    } }, searchBox, filtersEl));
    paintFilters();

    const bodyWrap = h('div', { 'data-crm-body': '' });
    root.appendChild(bodyWrap);
    paintBody();

    function matchesSearch(r) {
        const q = state.search.trim().toLowerCase();
        return !q || (r.full_name || '').toLowerCase().includes(q) || (r.phone || '').includes(q);
    }
    function filtered() {
        return state.rows.filter(r => matchesSearch(r) && inSource(r) && inPeriod(r));
    }

    // CRM_FILTERS_V1 — «Источник» и «Период» над доской.
    //
    // Счётчики у источников считаются по ОСТАЛЬНЫМ фильтрам (поиск + период), а
    // не по всей базе: иначе «Instagram · 40» рядом с пустой доской за сегодня
    // читается как поломка. Источники, которых в выборке нет, не рисуем вовсе —
    // в клинику идут двумя-тремя каналами, а не всеми семью.
    function paintFilters() {
        clear(filtersEl);
        const lbl = (t) => h('span', { class: 'muted', style: {
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '.04em', alignSelf: 'center', marginRight: '2px',
        } }, t);
        const chip = (on, label, onclick) => h('button', { class: 'wzc-cat' + (on ? ' on' : ''), type: 'button', onclick }, label);

        const byPeriod = state.rows.filter(r => matchesSearch(r) && inPeriod(r));
        const counts = {};
        for (const r of byPeriod) { const k = r.source || 'other'; counts[k] = (counts[k] || 0) + 1; }

        const srcRow = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, lbl('Источник'),
            chip(!state.source, 'Все · ' + byPeriod.length, () => { state.source = ''; paintFilters(); paintBody(); }));
        for (const [key, label] of SOURCES) {
            if (!counts[key]) continue;
            srcRow.appendChild(chip(state.source === key, label + ' · ' + counts[key],
                () => { state.source = key; paintFilters(); paintBody(); }));
        }

        const perRow = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, lbl('Период'));
        for (const [key, label] of PERIODS) {
            perRow.appendChild(chip(state.period === key, label, () => {
                // CRM_PERIOD_CUSTOM_V1 — при первом переходе в «Свой период»
                // подставляем текущий месяц. Пустая форма выглядела бы как
                // сломанная кнопка: нажал — ничего не изменилось. Обе даты
                // остаются редактируемыми, а очищенное поле снова означает
                // «без ограничения с этой стороны».
                if (key === 'custom' && !state.customFrom && !state.customTo) {
                    const now = new Date();
                    state.customFrom = ymdLocal(new Date(now.getFullYear(), now.getMonth(), 1));
                    state.customTo = ymdLocal(now);
                }
                state.period = key;
                paintFilters();
                paintBody();
            }));
        }
        if (state.period === 'custom') perRow.appendChild(customRange());

        filtersEl.appendChild(srcRow);
        filtersEl.appendChild(perRow);
    }

    // CRM_PERIOD_CUSTOM_V1 — поля «с» и «по» рядом с чипами.
    //
    // Появляются только при выбранном «Свой период»: две пустые даты, висящие
    // над доской постоянно, читались бы как активный фильтр, которого нет.
    function customRange() {
        // CRM_PERIOD_CUSTOM_V2 — одна «таблетка» вместо двух голых полей даты:
        // рамка и фон живут на контейнере (.crm-range), поля внутри прозрачные.
        const bad = !!(state.customFrom && state.customTo && state.customFrom > state.customTo);
        const box = h('div', { class: 'crm-range' + (bad ? ' bad' : '') });
        const apply = () => { paintFilters(); paintBody(); };
        const inp = (value, onchange) => {
            const el = h('input', { type: 'date', value: value || '' });
            el.addEventListener('change', () => onchange(el.value));
            return el;
        };

        box.appendChild(h('span', { class: 'lbl' }, 'с'));
        box.appendChild(inp(state.customFrom, (v) => { state.customFrom = v; apply(); }));
        box.appendChild(h('span', { class: 'lbl' }, 'по'));
        box.appendChild(inp(state.customTo, (v) => { state.customTo = v; apply(); }));

        // Перевёрнутый диапазон молча даёт пустую доску, и это выглядит как
        // «заявок нет», а не как «даты перепутаны». Говорим прямо.
        if (bad) box.appendChild(h('span', { class: 'err' }, 'начало позже конца'));
        return box;
    }

    function paintBody() {
        const wrap = root.querySelector('[data-crm-body]');
        if (!wrap) return;
        clear(wrap);
        if (state.view === 'kanban') wrap.appendChild(kanban()); else wrap.appendChild(listTable());
    }

    // ---------------- КАНБАН ----------------
    function kanban() {
        const rows = filtered();
        // CRM_KANBAN_PAGE_V1 — alignItems убран НАМЕРЕННО: значение grid по
        // умолчанию (stretch) равняет колонки по самой высокой, и пустой статус
        // перестаёт быть огрызком рядом с длинным соседом. Доска
        // прокручивается страницей — статусы кончаются на одной линии.
        const board = h('div', { 'data-crm-board': '', style: { display: 'grid', gridTemplateColumns: 'repeat(' + STATUSES.length + ', minmax(215px, 1fr))', gap: '12px', overflowX: 'auto', paddingBottom: '6px' } });
        for (const [key, label, kind] of STATUSES) {
            const colRows = rows.filter(r => r.status === key);
            const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '60px', padding: '4px' } });

            // Показываем первые KANBAN_PAGE, остальные — по кнопке. Дело не
            // только в длине страницы: каждая карточка вешает свои обработчики
            // перетаскивания, и несколько сотен «Пришёл» разом заметно тормозят
            // доску. Дорисовываем на месте, без перерисовки всей доски, — иначе
            // терялась бы позиция прокрутки и уже открытые колонки схлопывались.
            let shown = 0;
            const more = h('button', {
                class: 'btn btn-ghost btn-sm', type: 'button',
                style: { width: '100%', marginTop: '8px' },
                onclick: () => showMore(),
            });
            function syncMore() {
                const left = colRows.length - shown;
                if (left <= 0) { more.remove(); return; }
                more.textContent = 'Показать ещё ' + Math.min(KANBAN_PAGE, left);
            }
            function showMore() {
                for (const r of colRows.slice(shown, shown + KANBAN_PAGE)) list.appendChild(kanbanCard(r));
                shown = Math.min(shown + KANBAN_PAGE, colRows.length);
                syncMore();
            }
            showMore();

            const col = h('div', {
                class: 'card', 'data-col': key,
                style: { padding: '10px 12px', background: 'var(--ink-25, #f8fafa)' },
            },
                h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } },
                    Tag(label, { kind, dot: true }),
                    // Счётчик — ПОЛНОЕ число заявок в статусе, а не сколько
                    // отрисовано: это цифра воронки, и зависеть от того, сколько
                    // раз нажали «показать ещё», она не должна.
                    h('span', { class: 'muted', style: { fontSize: '12px', fontWeight: 700 } }, String(colRows.length)),
                    h('span', { class: 'grow' }),
                    key === stageKey('in_process') ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Новая заявка', onclick: () => requestModal(null) }, '+') : null),
                list,
                shown < colRows.length ? more : null);
            board.appendChild(col);
        }
        return board;
    }

    function kanbanCard(r) {
        // CRM_CARD_LINES_V1 — каждая информация на своей строке; длинный текст
        // переносится, а не обрезается.
        const line = (...children) => h('div', { style: { fontSize: '12.5px', marginTop: '4px', overflowWrap: 'anywhere' } }, ...children);
        const fmtD = (iso) => (iso || '').slice(0, 10).split('-').reverse().join('.');
        const acts = cardActions(r);
        const card = h('div', {
            style: { background: 'var(--white, #fff)', border: '1px solid var(--ink-100)', borderRadius: '10px', padding: '10px 12px', cursor: r.status !== CONVERT_STATUS ? 'grab' : 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', touchAction: 'none', userSelect: 'none', webkitUserDrag: 'none' },
            onclick: (ev) => { if (ev.target.closest('button, select')) return; requestModal(r); },
        },
            h('div', { class: 'row', style: { gap: '6px', alignItems: 'baseline' } },
                h('span', { style: { flex: 1, minWidth: 0, fontWeight: 700, fontSize: '13px', overflowWrap: 'anywhere' } }, r.full_name || '—'),
                h('span', { class: 'muted', style: { fontSize: '11px', whiteSpace: 'nowrap' } }, fmtD(r.created_at))),
            line(h('span', { class: 'num' }, r.phone || '—')),
            line(Tag(SOURCE_RU[r.source] || r.source, { kind: '' })),
            r.services ? line(h('span', { class: 'muted' }, 'Услуга: '), r.services.name) : null,
            r.scheduled_date ? line(h('span', { class: 'muted' }, 'Записан на: '), h('b', { style: { color: '#6d28d9' } }, fmtD(r.scheduled_date))) : null,
            r.patients ? line(Tag(r.patients.mrn || 'карта', { kind: 'ok' })) : null,
            r.note ? line(h('span', { class: 'muted' }, r.note)) : null,
            acts.length ? h('div', { class: 'row', style: { gap: '6px', marginTop: '8px', flexWrap: 'wrap' } }, ...acts) : null,
        );
        // CRM_DRAG_V2 — перетаскивание на pointer-событиях вместо HTML5 DnD
        // (тот часто вовсе не стартует). Держите карточку и ведите: клон летит
        // за курсором, колонка под ним подсвечивается, доска прокручивается у
        // краёв. Отпустили над колонкой — статус меняется; над «Пришёл» —
        // конверсия через попап. Мышь и сенсорный экран работают одинаково.
        card.addEventListener('pointerdown', (ev) => {
            if (r.status === CONVERT_STATUS) return;
            if (ev.button !== 0 && ev.pointerType === 'mouse') return;
            if (ev.target.closest('button, select, input, a')) return;
            // Захват указателя: события идут карточке даже если курсор ушёл
            // с неё (они всплывают до document, где висят наши слушатели).
            try { card.setPointerCapture(ev.pointerId); } catch (e) { /* не критично */ }
            card.style.cursor = 'grabbing';
            const startX = ev.clientX, startY = ev.clientY;
            const board = card.closest('[data-crm-board]');
            let ghost = null, overCol = null, raf = 0, lastX = 0, dx = 0, dy = 0;
            const mark = (col) => {
                if (overCol === col) return;
                if (overCol) overCol.style.outline = 'none';
                overCol = col;
                if (overCol) overCol.style.outline = '2px dashed var(--primary-300, #7fcbb8)';
            };
            const tick = () => {
                if (board) {
                    const br = board.getBoundingClientRect();
                    if (lastX > br.right - 70) board.scrollLeft += 16;
                    else if (lastX < br.left + 70) board.scrollLeft -= 16;
                }
                raf = requestAnimationFrame(tick);
            };
            const onMove = (mv) => {
                lastX = mv.clientX;
                if (!ghost) {
                    if (Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY) < 7) return;
                    const rect = card.getBoundingClientRect();
                    dx = startX - rect.left; dy = startY - rect.top;
                    ghost = card.cloneNode(true);
                    Object.assign(ghost.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', margin: '0', zIndex: '9999', pointerEvents: 'none', boxShadow: '0 12px 28px rgba(0,0,0,0.2)', transform: 'rotate(2deg)', opacity: '0.95' });
                    document.body.appendChild(ghost);
                    card.style.opacity = '0.35';
                    raf = requestAnimationFrame(tick);
                }
                ghost.style.left = (mv.clientX - dx) + 'px';
                ghost.style.top = (mv.clientY - dy) + 'px';
                const under = document.elementFromPoint(mv.clientX, mv.clientY);
                mark(under ? under.closest('[data-col]') : null);
                mv.preventDefault();
            };
            const cleanup = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onCancel);
                cancelAnimationFrame(raf);
                card.style.cursor = 'grab';
                try { card.releasePointerCapture(ev.pointerId); } catch (e) { /* уже отпущен */ }
                if (ghost) { ghost.remove(); card.style.opacity = '1'; }
            };
            const onUp = async () => {
                const dragged = !!ghost, target = overCol;
                cleanup(); mark(null);
                if (!dragged) return;   // порога не было — обычный клик, откроется окно заявки
                // подавить click, который браузер шлёт вслед за pointerup
                const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
                document.addEventListener('click', swallow, { capture: true, once: true });
                setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 0);
                const key = target ? target.dataset.col : null;
                if (!key || key === r.status) return;
                if (key === CONVERT_STATUS) { convertPopup(r); return; }
                if (await setStatus(r, key)) { toast('Статус: ' + (STATUS_RU[key] || [key])[0]); await paint(); }
            };
            const onCancel = () => { cleanup(); mark(null); };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onCancel);
        });
        return card;
    }

    function cardActions(r) {
        if (r.status === CONVERT_STATUS) return [];
        // Компактный переключатель статуса. «Пришёл» в нём нет: конверсия
        // происходит АВТОМАТИЧЕСКИ при создании визита (CRM_AUTO_CAME_V1);
        // вручную — перетаскиванием в колонку «Пришёл» или из окна заявки.
        const sel = h('select', { title: 'Сменить статус', style: { padding: '4px 6px', fontSize: '11.5px', borderRadius: '8px', border: '1px solid var(--ink-200)', fontFamily: 'inherit', maxWidth: '150px', background: 'var(--white, #fff)', cursor: 'pointer' } },
            ...STATUSES.filter(([k]) => k !== CONVERT_STATUS)
                .map(([k, l]) => h('option', { value: k, selected: r.status === k }, l)));
        sel.addEventListener('change', async () => {
            if (await setStatus(r, sel.value)) { toast('Статус: ' + (STATUS_RU[sel.value] || [sel.value])[0]); await paint(); }
        });
        return [sel];
    }

    // ---------------- СПИСОК ----------------
    function listTable() {
        const rows = filtered();
        if (!rows.length) {
            return h('div', { class: 'card', style: { padding: '26px' } },
                h('div', { class: 'empty' }, state.rows.length ? 'Ничего не найдено.' : 'Заявок пока нет — зафиксируйте первое обращение.'));
        }
        const tbody = h('tbody');
        for (const r of rows) {
            const [stLabel, stKind] = STATUS_RU[r.status] || [r.status, ''];
            tbody.appendChild(h('tr', { class: 'row-click', style: { cursor: 'pointer' }, onclick: (ev) => { if (ev.target.closest('button, select')) return; requestModal(r); } },
                h('td', { class: 'cell-strong' }, r.full_name || '—',
                    r.patients ? h('div', { class: 'muted', style: { fontSize: '11.5px' } }, r.patients.mrn || '') : null),
                h('td', { class: 'num' }, r.phone || '—'),
                h('td', null, SOURCE_RU[r.source] || r.source || '—'),
                h('td', null, r.services ? r.services.name : h('span', { class: 'muted' }, '—')),
                h('td', { class: 'muted', style: { maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.note || '—'),
                h('td', null, Tag(stLabel, { kind: stKind, dot: true })),
                h('td', { class: 'num', style: { fontSize: '12.5px' } }, fmtDateTime(r.created_at)),
                h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } }, h('span', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end' } }, ...cardActions(r))),
            ));
        }
        return h('div', { class: 'card' }, h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Имя'), h('th', null, 'Телефон'), h('th', null, 'Источник'),
                h('th', null, 'Услуга'), h('th', null, 'Комментарий'), h('th', null, 'Статус'), h('th', null, 'Дата'), h('th', null, ''))),
            tbody)));
    }

    // ---------------- КОНВЕРСИЯ: попап регистрации пациента ----------------
    // ФИО и телефон приходят из заявки; остальные поля — по желанию, до сохранения.
    // CRM_CONVERT_V2 — «услуги» отдельно от «регистрации»: сюда попадают заявки
    // с УЖЕ существующим пациентом, минуя попап регистрации.
    async function openServicesFor(r, patient) {
        // Пациент есть, а вложенной строки нет (join не вернул) — дочитываем по id,
        // чтобы не свалиться обратно в регистрацию и не создать дубль карты.
        let p = patient;
        if (!p) {
            const { data } = await supabase.from('patients')
                .select('id, full_name, mrn, phone').eq('id', r.patient_id).single();
            p = data || null;
        }
        if (!p) { toast('Пациент заявки не найден — привязка потеряна.', 'fail'); return; }
        p = { id: p.id, full_name: p.full_name, mrn: p.mrn, phone: p.phone || r.phone };
        // Пациента выбрали в форме заявки, но ещё не сохранили — конверсия и
        // закрепляет привязку: иначе она потеряется вместе с закрытым попапом.
        const patch = { status: CONVERT_STATUS };
        if (String(r.patient_id || '') !== String(p.id)) patch.patient_id = p.id;
        const { error } = await supabase.from('crm_requests').update(patch).eq('id', r.id);
        if (error) { toast(error.message, 'fail'); return; }
        r.patient_id = p.id;
        r.patients = { id: p.id, full_name: p.full_name, mrn: p.mrn };
        r.status = CONVERT_STATUS;
        if (refs.onNavigate) refs.onNavigate('patient-card', p);
        // CRM_CONVERT_V1 — мастер открывается всегда: с услугой заявки в смете,
        // либо пустым, чтобы регистратор выбрал её сам.
        openVisitWizard(null, p, { presetServiceIds: r.service_id ? [r.service_id] : [] });
    }

    // `linked` — пациент, выбранный в открытой форме заявки, но ещё не сохранённый.
    function convertPopup(r, linked) {
        // CRM_V5 — заявка уже привязана к пациенту клиники: регистрация не нужна.
        // CRM_CONVERT_V2 — признак привязки только patient_id: раньше требовалась
        // ещё и вложенная patients, и без неё повторная конверсия снова открывала
        // регистрацию, заводя пациенту вторую карту.
        const known = linked || r.patients || null;
        if (r.patient_id || known) {
            if (known) toast('Пациент уже в базе: ' + known.full_name + (known.mrn ? ' · ' + known.mrn : '') + ' — заявка привязана.', 'ok');
            openServicesFor(r, known);
            return;
        }
        patientRegistrationModal({
            requestRow: r,
            markCame: true,
            onCreated: (p) => {
                if (refs.onNavigate) refs.onNavigate('patient-card', p);
                // Мастер сам подберёт врача, дату и очередь — как при обычном заказе.
                openVisitWizard(null, p, { presetServiceIds: r.service_id ? [r.service_id] : [] });
            },
        });
    }

    // CRM_REG_BEFORE_SCHEDULE_V1 — карточка пациента заводится ДО выбора врача
    // и даты.
    //
    // Раньше эта форма была только внутри конверсии. Но колл-центр назначает
    // даты («Записать на дату») ещё до того, как пациент вообще появился в
    // базе, и регистратура получала строки услуг, привязанные к заявке, а не к
    // карте: в день приёма пациента приходилось заводить заново и сверять
    // руками, тот ли это человек. Поэтому форма вынесена сюда и вызывается из
    // обоих мест.
    //
    // `requestRow` может быть null — заявку ещё не сохранили (её создаст
    // persist() уже с patient_id). `markCame` разделяет два случая: конверсия
    // означает «пациент пришёл», а запись на будущую дату — нет, и ставить ей
    // статус «Пришёл» было бы враньём в канбане.
    function patientRegistrationModal({ requestRow = null, prefill = null, markCame = true, onCreated } = {}) {
        const r = requestRow || {};
        const src = prefill || {
            full_name: r.full_name || '', phone: r.phone || '', dob: '', note: r.note || '',
        };
        const overlay = h('div', { class: 'modal' });
        const close = () => overlay.remove();
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

        // CRM_NAME_PARTS_V1 — ФИО по частям, как в «Регистрации пациента»:
        // в заявке имя лежит одной строкой, поэтому раскладываем её на три поля.
        const fio = splitFio(src.full_name);
        const lastInp  = h('input', { type: 'text', value: fio.last,   placeholder: 'Каримова' });
        const firstInp = h('input', { type: 'text', value: fio.first,  placeholder: 'Азиза' });
        const midInp   = h('input', { type: 'text', value: fio.middle, placeholder: 'Рустамовна' });
        const phoneInp = phoneInput('phone', '+998 90 961 00 04', { value: src.phone });
        const dobInp   = h('input', { type: 'date' });
        const sexSel   = h('select', null, h('option', { value: '' }, '—'),
            h('option', { value: 'male' }, 'Мужской'), h('option', { value: 'female' }, 'Женский'));
        const addrInp  = h('input', { type: 'text', placeholder: 'Город, улица, дом' });
        const mailInp  = h('input', { type: 'email', placeholder: 'Необязательно' });
        const noteInp  = h('textarea', { rows: '2', placeholder: 'Заметки регистратора' });
        if (src.dob) dobInp.value = src.dob;
        if (src.note) noteInp.value = 'Из заявки CRM: ' + src.note;

        // CRM_CONVERT_V1 — кнопка «Оформить услугу» и означает конверсию, поэтому
        // выбора здесь нет: сразу после регистрации откроется мастер «Добавить
        // услуги» с интересующей услугой в смете. Строка ниже — просто анонс.
        const svcName = r.services ? r.services.name : null;
        const orderRow = r.service_id
            ? h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', padding: '9px 12px', border: '1px solid var(--teal-200, #b2dfdb)', background: 'var(--teal-25, #f0faf9)', borderRadius: '10px', fontSize: '13px' } },
                Icon('Check', { size: 14 }),
                h('span', null, 'После регистрации оформим услугу: ', h('b', null, svcName || ('#' + r.service_id))))
            : null;

        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, Icon('Check', { size: 14 }), ' Зарегистрировать');
        saveBtn.addEventListener('click', async () => {
            // CRM_NAME_PARTS_V1 — те же обязательные поля, что в «Регистрации
            // пациента»: фамилия и имя. full_name собираем сами — колонка NOT NULL,
            // а порядок «Фамилия Имя Отчество» повторяет savePatient().
            const last = lastInp.value.trim(), first = firstInp.value.trim(), mid = midInp.value.trim();
            if (!last || !first) { toast('Фамилия и имя обязательны.', 'fail'); return; }
            saveBtn.disabled = true;
            const payload = {
                full_name: [last, first, mid].filter(Boolean).join(' '),
                last_name: last, first_name: first, middle_name: mid,
            };
            if (phoneInp.value.trim()) payload.phone = phoneInp.value.trim();
            if (dobInp.value) payload.date_of_birth = dobInp.value;
            if (sexSel.value) payload.gender = sexSel.value;
            if (addrInp.value.trim()) payload.address = addrInp.value.trim();
            if (mailInp.value.trim()) payload.email = mailInp.value.trim();
            if (noteInp.value.trim()) payload.notes = noteInp.value.trim();
            if (uid() != null) payload.created_by = uid();
            const { data: p, error } = await supabase.from('patients').insert(payload).select('id, full_name, mrn, phone').single();
            if (error) { toast('Пациент не создан: ' + error.message, 'fail'); saveBtn.disabled = false; return; }
            // Заявку обновляем, только если она УЖЕ сохранена: «Записать на
            // дату» может вызвать регистрацию из ещё не созданной заявки —
            // её patient_id запишет persist() при сохранении.
            if (requestRow && requestRow.id) {
                const patch = { patient_id: p.id };
                if (markCame) patch.status = CONVERT_STATUS;
                const { error: upErr } = await supabase.from('crm_requests').update(patch).eq('id', requestRow.id);
                if (upErr) toast('Пациент создан, но заявка не обновилась: ' + upErr.message, 'fail');
            }
            // CRM_CONVERT_V2 — заявка в памяти теперь ЗНАЕТ своего пациента. Без
            // этого повторная конверсия (карточка ещё держит старый объект) снова
            // открывала бы регистрацию и заводила пациенту вторую карту.
            if (requestRow) {
                requestRow.patient_id = p.id;
                requestRow.patients = { id: p.id, full_name: p.full_name, mrn: p.mrn };
                if (markCame) requestRow.status = CONVERT_STATUS;
            }
            toast('Пациент зарегистрирован: ' + p.full_name + (p.mrn ? ' · ' + p.mrn : ''), 'ok');
            close();
            if (typeof onCreated === 'function') onCreated(p);
        });

        const col = { flex: '1 1 0', minWidth: 0 };
        const regBody = h('div', { class: 'modal-body', style: { overflowY: 'auto' } },
            // CRM_NAME_PARTS_V1 — три поля в строку, как в «Регистрации пациента».
            h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
                h('div', { style: col }, field('Фамилия', lastInp, { required: true })),
                h('div', { style: col }, field('Имя', firstInp, { required: true })),
                h('div', { style: col }, field('Отчество', midInp))),
            h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
                h('div', { style: col }, field('Телефон', phoneInp, { required: true })),
                h('div', { style: col }, field('Дата рождения', dobInp))),
            h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
                h('div', { style: col }, field('Пол', sexSel)),
                h('div', { style: col }, field('Email', mailInp))),
            field('Адрес', addrInp),
            field('Примечание', noteInp),
            orderRow,
            h('div', { class: 'muted', style: { fontSize: '11.5px' } },
                'MRN присвоится автоматически. Остальные данные можно дозаполнить позже в карте пациента.'));
        // CRM_REG_WIDTH_V1 — вне .modal-grouped у .field input нет width:100%, и
        // поля держат ширину по умолчанию (~200px). Три имени в строку переставали
        // помещаться, и попап уезжал в горизонтальный скролл. Пусть поля тянутся
        // по колонке — тогда ширина карточки решает всё, а переполнения нет.
        // .ph-input is a flex child of .ph-wrap next to the 46px country button —
        // forcing width:100% on it would overflow the row, so it opts out.
        for (const el of regBody.querySelectorAll('input:not(.ph-input), select, textarea')) {
            el.style.width = '100%';
            el.style.boxSizing = 'border-box';
        }

        overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '760px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
            h('header', { class: 'modal-head' },
                h('div', null,
                    h('h2', { style: { margin: 0 } }, 'Регистрация пациента'),
                    h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } },
                        requestRow && requestRow.created_at
                            ? 'Из заявки: ' + (SOURCE_RU[r.source] || r.source) + ' · ' + fmtDateTime(r.created_at)
                            : 'Карта заводится сразу — дальше выберем врача и дату')),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            regBody,
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
                h('span', { class: 'grow' }),
                saveBtn),
        ));
        document.body.appendChild(overlay);
        // CRM_NAME_PARTS_V1 — курсор в первое незаполненное обязательное поле:
        // из заявки обычно приходит только имя, и дописать нужно фамилию.
        (!fio.last ? lastInp : !fio.first ? firstInp : dobInp).focus();
    }

    // ---------------- ЗАЯВКА: создание / редактирование ----------------
    function requestModal(r) {
        const isEdit = !!r;
        const overlay = h('div', { class: 'modal' });
        const close = () => overlay.remove();
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

        // CRM_V5 — ФИО = поиск по базе клиники: заявка может прийти от уже
        // существующего пациента, тогда лид привязывается (patient_id), а не дублируется.
        let linkedPatient = (r && r.patient_id && r.patients)
            ? { id: r.patients.id, full_name: r.patients.full_name, mrn: r.patients.mrn, phone: r.phone } : null;
        const phoneInp = phoneInput('phone', '+998 … или без кода', { value: r ? r.phone : '' });
        const nameInp = h('input', {
            type: 'text', value: r ? (r.full_name || '') : '', placeholder: 'Фамилия Имя — или найдите пациента клиники…', autocomplete: 'off',
            style: { width: '100%', boxSizing: 'border-box', padding: '10px 12px 10px 32px', border: '1px solid var(--ink-200)', borderRadius: '10px', fontFamily: 'inherit', fontSize: '13px', outline: 'none' },
        });
        const patResults = h('div', { style: { display: 'none', position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 41, maxHeight: '230px', overflow: 'auto', background: 'var(--white, #fff)', border: '1px solid var(--ink-200)', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' } });
        const nameWrap = h('div', { style: { position: 'relative' } },
            h('span', { style: { position: 'absolute', left: '10px', top: '19px', transform: 'translateY(-50%)', color: 'var(--ink-400)', display: 'flex', pointerEvents: 'none' } }, Icon('Search', { size: 13 })),
            nameInp, patResults);
        // CRM_V11 — пациент найден → контактная строка (Телефон/Дата рождения)
        // прячется: эти поля нужны только для ПОИСКА и для контакта нового
        // лида; у привязанного пациента всё есть в карте. Отвязка возвращает
        // строку с прежде введёнными значениями.
        let contactRow = null;
        const syncContactRow = () => { if (contactRow) contactRow.style.display = linkedPatient ? 'none' : ''; };
        function paintLinked() {
            syncContactRow();
            if (linkedPatient) {
                nameInp.style.display = 'none';
                nameWrap.firstChild.style.display = 'none';
                let chip = nameWrap.querySelector('[data-chip]');
                if (chip) chip.remove();
                chip = h('div', { 'data-chip': '1', class: 'row', style: { gap: '8px', alignItems: 'center', padding: '9px 12px', border: '1px solid var(--teal-200, #b2dfdb)', background: 'var(--teal-25, #f0faf9)', borderRadius: '10px', fontSize: '13px' } },
                    h('span', { style: { color: 'var(--teal-700, #00796b)', display: 'flex' } }, Icon('User', { size: 15 })),
                    h('b', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, linkedPatient.full_name),
                    linkedPatient.mrn ? Tag(linkedPatient.mrn, { kind: 'ok' }) : null,
                    h('span', { class: 'muted', style: { fontSize: '12px' } }, 'пациент клиники'),
                    h('span', { class: 'grow' }),
                    h('button', { type: 'button', title: 'Отвязать — ввести имя вручную', style: { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-400)', fontWeight: 700, fontSize: '15px' },
                        onclick: () => { linkedPatient = null; paintLinked(); nameInp.focus(); } }, '×'));
                nameWrap.appendChild(chip);
            } else {
                nameInp.style.display = '';
                nameWrap.firstChild.style.display = '';
                const chip = nameWrap.querySelector('[data-chip]');
                if (chip) chip.remove();
            }
        }
        let patSeq = 0;
        async function paintPatResults() {
            const q = nameInp.value.trim();
            if (q.length < 2) { patResults.style.display = 'none'; return; }
            const my = ++patSeq;
            const { data } = await supabase.from('patients').select('id, full_name, mrn, phone')
                .or('full_name.ilike.%' + q + '%,phone.ilike.%' + q + '%,mrn.ilike.%' + q + '%')
                .order('full_name').limit(6);
            if (my !== patSeq) return;
            clear(patResults);
            const pool = data || [];
            if (!pool.length) { patResults.style.display = 'none'; return; }
            patResults.style.display = '';
            patResults.appendChild(h('div', { style: { padding: '7px 12px 4px', fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-400)' } }, 'Пациенты клиники'));
            for (const p of pool) {
                patResults.appendChild(h('div', {
                    class: 'row', style: { gap: '8px', alignItems: 'center', padding: '8px 12px', cursor: 'pointer', fontSize: '13px' },
                    onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                    onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                    onmousedown: (e) => {
                        e.preventDefault();
                        linkedPatient = p;
                        if (p.phone && !phoneInp.value.trim()) phoneInp.value = p.phone;
                        patResults.style.display = 'none';
                        paintLinked();
                    },
                }, h('b', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.full_name),
                   p.mrn ? Tag(p.mrn, { kind: 'ok' }) : null,
                   h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: 'auto' } }, p.phone || '')));
            }
            patResults.appendChild(h('div', { class: 'muted', style: { padding: '5px 12px 8px', fontSize: '11.5px', borderTop: '1px solid var(--ink-50, #eef1f3)' } },
                'Не он? Просто продолжайте вводить имя — заявка создастся как новый лид.'));
        }
        let patTimer = null;
        nameInp.addEventListener('input', () => { clearTimeout(patTimer); patTimer = setTimeout(paintPatResults, 250); });
        nameInp.addEventListener('blur', () => setTimeout(() => { patResults.style.display = 'none'; }, 150));
        if (linkedPatient) paintLinked();

        // CRM_V8/V9 — Телефон и Дата рождения = тоже поиск по базе: у менеджера
        // в руках прежде всего НОМЕР звонящего (или дата рождения из документа).
        // Один конструктор на оба поля: runQuery() возвращает null (искать
        // нечего) или промис списка пациентов; клик привязывает пациента так
        // же, как выбор в поле ФИО. Введённый номер НЕ перезаписывается
        // номером из карты (пустой телефон — заполняется).
        function patientFinder(anchorInp, runQuery, hint, icon) {
            const results = h('div', { style: { display: 'none', position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 41, maxHeight: '230px', overflow: 'auto', background: 'var(--white, #fff)', border: '1px solid var(--ink-200)', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' } });
            let seq = 0, timer = null;
            async function paintResults() {
                const q = linkedPatient ? null : runQuery();
                if (!q) { results.style.display = 'none'; return; }
                const my = ++seq;
                const pool = await q;
                if (my !== seq) return;
                clear(results);
                if (!pool.length) { results.style.display = 'none'; return; }
                results.style.display = '';
                results.appendChild(h('div', { style: { padding: '7px 12px 4px', fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-400)' } }, 'Пациенты клиники'));
                for (const p of pool) {
                    results.appendChild(h('div', {
                        class: 'row', style: { gap: '8px', alignItems: 'center', padding: '8px 12px', cursor: 'pointer', fontSize: '13px' },
                        onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                        onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                        onmousedown: (e) => {
                            e.preventDefault();
                            linkedPatient = p;
                            if (p.phone && !phoneInp.value.trim()) phoneInp.value = p.phone;
                            results.style.display = 'none';
                            paintLinked();
                        },
                    }, h('b', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.full_name),
                       p.mrn ? Tag(p.mrn, { kind: 'ok' }) : null,
                       h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: 'auto' } }, p.phone || '')));
                }
                results.appendChild(h('div', { class: 'muted', style: { padding: '5px 12px 8px', fontSize: '11.5px', borderTop: '1px solid var(--ink-50, #eef1f3)' } }, hint));
            }
            // PHONE_INPUT_V1 — the phone anchor is now the country-code control,
            // a wrapper around the real <input>. Listen on that inner field:
            // 'blur' does not bubble, so a wrapper-level listener never fires.
            const listenEl = anchorInp.input || anchorInp;
            listenEl.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(paintResults, 250); });
            listenEl.addEventListener('blur', () => setTimeout(() => { results.style.display = 'none'; }, 150));
            return h('div', { style: { position: 'relative' } },
                icon ? h('span', { style: { position: 'absolute', left: '11px', top: '19px', transform: 'translateY(-50%)', color: 'var(--ink-400)', display: 'flex', pointerEvents: 'none', zIndex: 1 } }, Icon(icon, { size: 13 })) : null,
                anchorInp, results);
        }
        const phoneWrap = patientFinder(phoneInp, () => {
            const digits = digitsOf(phoneInp.value);
            if (digits.length < MIN_PHONE_DIGITS) return null;
            return supabase.from('patients').select('id, full_name, mrn, phone')
                .ilike('phone', phoneLikePattern(uzLocalDigits(digits))).order('full_name').limit(30)
                .then(({ data }) => filterPhoneMatches(data, digits));
        }, 'Не он? Просто продолжайте вводить номер — заявка создастся как новый лид.');   // no leading icon: the country button already occupies that slot
        // CRM_V9 — дата рождения: точное совпадение по date_of_birth (формат
        // input type=date = формат хранения, YYYY-MM-DD — нормализация не нужна).
        const dobInp = h('input', { type: 'date', style: { width: '100%', boxSizing: 'border-box' } });
        const dobWrap = patientFinder(dobInp, () => {
            const v = dobInp.value;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
            return supabase.from('patients').select('id, full_name, mrn, phone')
                .eq('date_of_birth', v).order('full_name').limit(6)
                .then(({ data }) => data || []);
        }, 'Не он? Заполните остальные поля — заявка создастся как новый лид.');

        // Источник — чипы вместо выпадающего списка: видно всё сразу, один клик.
        let srcChosen = r ? (r.source || defaultSource()) : defaultSource();
        const srcRow = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } });
        function paintSrc() {
            clear(srcRow);
            for (const [v, l] of SOURCES) {
                const on = srcChosen === v;
                srcRow.appendChild(h('button', {
                    type: 'button',
                    style: { padding: '6px 13px', borderRadius: '999px', fontSize: '12.5px', fontFamily: 'inherit', cursor: 'pointer', fontWeight: on ? '700' : '500',
                        border: '1px solid ' + (on ? 'var(--teal-600, #00897b)' : 'var(--ink-200)'),
                        background: on ? 'var(--teal-600, #00897b)' : 'var(--white, #fff)',
                        color: on ? '#fff' : 'var(--ink-600, #3f4b52)' },
                    onclick: () => { srcChosen = v; paintSrc(); },
                }, l));
            }
        }
        paintSrc();
        // CRM_V4 — интересующая услуга: ПОИСКОВЫЙ комбобокс по каталогу.
        // CRM_MULTI_SERVICE_V1 — заявка может закрывать НЕСКОЛЬКО услуг, у каждой
        // своя дата. `picked` — рабочий список: [{ service_id, name, price, date }].
        // svcChosen остаётся первой услугой списка: crm_requests.service_id и
        // карточка канбана по-прежнему читают её (см. миграцию 057).
        let picked = [];
        let svcChosen = r ? (r.service_id || null) : null;
        let svcCatalog = [];
        let docCatalog = [];   // CRM_LINE_DOCTOR_V1
        // CRM_SERVICE_FILTER_V1 — категории услуг и выбранная в рейке. '' = «Все».
        let svcTypes = [];
        let svcGroup = '';

        // Врачи, оказывающие услугу (users.service_rates — «Услуги и ставки» в
        // карточке сотрудника). Тот же список, что предлагает мастер записи, —
        // иначе колл-центр записал бы к врачу, у которого этой услуги нет.
        // Никто не отмечен на услугу — предлагаем всех, чтобы запись не встала.
        function doctorsForService(svcId) {
            const assigned = docCatalog.filter(d => {
                let rates = d.service_rates;
                if (typeof rates === 'string') { try { rates = JSON.parse(rates); } catch (_) { rates = []; } }
                return Array.isArray(rates) && rates.some(x => x && String(x.service_id) === String(svcId));
            });
            return assigned.length ? assigned : docCatalog;
        }
        const needsDoctor = (p) => {
            const sv = svcCatalog.find(x => String(x.id) === String(p.service_id));
            return !!(sv && sv.requires_doctor);
        };
        const svcInp = h('input', {
            type: 'text', placeholder: 'Поиск услуги — начните вводить название…', autocomplete: 'off',
            style: { width: '100%', boxSizing: 'border-box', padding: '10px 12px 10px 32px', border: '1px solid var(--ink-200)', borderRadius: '10px', fontFamily: 'inherit', fontSize: '13px', outline: 'none' },
        });
        const svcResults = h('div', { style: { display: 'none', position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 40, maxHeight: '200px', overflow: 'auto', background: 'var(--white, #fff)', border: '1px solid var(--ink-200)', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' } });
        const svcWrap = h('div', { style: { position: 'relative' } },
            h('span', { style: { position: 'absolute', left: '10px', top: '19px', transform: 'translateY(-50%)', color: 'var(--ink-400)', display: 'flex', pointerEvents: 'none' } }, Icon('Search', { size: 13 })),
            svcInp, svcResults);
        // CRM_SERVICE_FILTER_V1 — рейка категорий над поиском, как у регистратуры
        // (service-picker-modal.js paintCatGroups). 511 услуг в одном текстовом
        // поле означали, что оператор должен угадать формулировку, пока пациент
        // ждёт на линии. Класс .wzc-cat — общий, поэтому вид тот же.
        const svcChips = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } });
        // CRM_MULTI_SERVICE_V1 — выбранные услуги списком: выбор из выпадашки
        // ДОБАВЛЯЕТ строку, а не заменяет единственное поле. Поле поиска после
        // выбора очищается — сразу можно искать следующую.
        const pickedList = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
        function addPicked(sv) {
            if (picked.some(p => String(p.service_id) === String(sv.id))) return;
            picked.push({ service_id: sv.id, name: sv.name, price: sv.price, date: '' });
            syncPrimary();
            paintPicked();
        }
        function removePicked(id) {
            picked = picked.filter(p => String(p.service_id) !== String(id));
            syncPrimary();
            paintPicked();
        }
        // crm_requests.service_id / scheduled_date зеркалят ПЕРВУЮ строку —
        // канбан-карточка и выгрузка Excel читают именно их (миграция 057).
        function syncPrimary() {
            svcChosen = picked.length ? picked[0].service_id : null;
            // Зеркало ВСЕГДА, включая очистку: иначе у заявки оставалась старая
            // дата в родителе, и карточка канбана показывала «Записан на …»,
            // когда у услуг уже другие даты (или их нет вовсе).
            schedInp.value = (picked.length && picked[0].date) ? picked[0].date : '';
        }
        function paintPicked() {
            clear(pickedList);
            paintSvcChips();   // CRM_SERVICE_FILTER_V1 — счётчики следуют за выбором
            if (!picked.length) return;
            for (const p of picked) {
                const dateInp = h('input', { type: 'date', value: p.date || '',
                    style: { width: '150px', padding: '6px 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '12.5px' } });
                dateInp.addEventListener('change', () => { p.date = dateInp.value; syncPrimary(); });
                pickedList.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', background: 'var(--teal-25, #f0faf9)', border: '1px solid var(--teal-200, #b2dfdb)', borderRadius: '10px' } },
                    h('div', { style: { flex: 1, minWidth: 0 } },
                        h('div', { style: { fontSize: '13px', fontWeight: 600, overflowWrap: 'anywhere' } }, p.name),
                        h('div', { class: 'muted', style: { fontSize: '11.5px' } }, String(p.price || 0) + ' сум')),
                    dateInp,
                    h('button', { type: 'button', title: 'Убрать услугу',
                        style: { border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--crit-500, #ef4444)', fontSize: '16px', lineHeight: 1, padding: '0 2px' },
                        onclick: () => removePicked(p.service_id) }, '×')));
            }
        }

        // CRM_SERVICE_FILTER_V1 — счётчики считаются по каталогу МИНУС уже
        // выбранное, поэтому цифры совпадают с тем, что ещё можно добавить.
        function paintSvcChips() {
            clear(svcChips);
            if (!svcCatalog.length) return;
            const chosen = picked.map(p => p.service_id);
            const { total, byGroup } = serviceGroupCounts(svcCatalog, { chosen, types: svcTypes });
            const mk = (id, name, n) => {
                const b = h('button', { class: 'wzc-cat' + (svcGroup === id ? ' on' : ''), type: 'button',
                    // mousedown, а не click: blur поля поиска прячет выпадашку раньше,
                    // чем сработал бы click, и рейка казалась бы неотзывчивой.
                    onmousedown: (e) => {
                        e.preventDefault();
                        svcGroup = id;
                        paintSvcChips();
                        paintSvcResults();
                        svcInp.focus();
                    } }, `${name} · ${n}`);
                return b;
            };
            svcChips.appendChild(mk('', 'Все', total));
            for (const t of svcTypes) {
                const n = byGroup[String(t.id)] || 0;
                if (n) svcChips.appendChild(mk(String(t.id), t.name, n));
            }
        }
        function paintSvcResults() {
            clear(svcResults);
            // Выбрана категория — показываем больше: 8 строк из 86 выглядят как
            // «в лаборатории всего восемь услуг».
            const pool = filterServicePool(svcCatalog, {
                query: svcInp.value,
                groupId: svcGroup,
                chosen: picked.map(p => p.service_id),
                types: svcTypes,
                limit: svcGroup ? 25 : 8,
            });
            svcResults.style.display = '';
            if (!pool.length) {
                svcResults.appendChild(h('div', { style: { padding: '8px 12px', fontSize: '12.5px', color: 'var(--ink-500)' } }, 'Ничего не найдено.'));
                return;
            }
            for (const sv of pool) {
                svcResults.appendChild(h('div', {
                    style: { padding: '8px 12px', cursor: 'pointer', fontSize: '13px' },
                    onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                    onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                    onmousedown: (e) => { e.preventDefault(); addPicked(sv); svcInp.value = ''; svcResults.style.display = 'none'; },
                }, sv.name, h('span', { class: 'muted', style: { fontSize: '12px' } }, ' · ' + sv.price)));
            }
        }
        svcInp.addEventListener('input', paintSvcResults);
        svcInp.addEventListener('focus', paintSvcResults);
        svcInp.addEventListener('blur', () => setTimeout(() => { svcResults.style.display = 'none'; }, 150));
        // CRM_LINE_DOCTOR_V1 — `requires_doctor` решает, нужен ли строке врач;
        // список врачей нужен тут же, чтобы колл-центр выбирал из тех, кто эту
        // услугу реально оказывает (Сотрудники → «Услуги и ставки»).
        supabase.from('users').select('id, full_name, specialty, service_rates')
            .eq('role', 'doctor').eq('is_active', true).order('full_name')
            .then(({ data }) => { docCatalog = data || []; });
        // CRM_SERVICE_FILTER_V1 — рейка категорий: сами категории и колонки, по
        // которым service-group.js определяет группу услуги. type/is_lab нужны
        // потому, что type_id у большей части каталога NULL (миграция 056).
        supabase.from('service_types').select('id, name').eq('active', 1).order('name')
            .then(({ data }) => { svcTypes = data || []; paintSvcChips(); });
        supabase.from('services').select('id, name, price, requires_doctor, type, type_id, is_lab').eq('active', 1).order('name').limit(1000).then(({ data }) => {
            svcCatalog = data || [];
            paintSvcChips();
            // Правка существующей заявки — подтягиваем её строки услуг.
            if (isEdit && r.id) {
                supabase.from('crm_request_services')
                    .select('service_id, scheduled_date, status, doctor_id')
                    .eq('request_id', r.id).neq('status', 'cancelled')
                    .then(({ data: lines }) => {
                        for (const ln of (lines || [])) {
                            const sv = svcCatalog.find(x => String(x.id) === String(ln.service_id));
                            if (sv) picked.push({ service_id: sv.id, name: sv.name, price: sv.price, date: ln.scheduled_date || '', doctor_id: ln.doctor_id || null });
                        }
                        // Заявка до миграции 057 — единственная услуга в родителе.
                        if (!picked.length && svcChosen) {
                            const sv = svcCatalog.find(x => String(x.id) === String(svcChosen));
                            if (sv) picked.push({ service_id: sv.id, name: sv.name, price: sv.price, date: r.scheduled_date || '' });
                        }
                        syncPrimary(); paintPicked();
                    });
            } else if (svcChosen) {
                const sv = svcCatalog.find(x => String(x.id) === String(svcChosen));
                if (sv) { picked.push({ service_id: sv.id, name: sv.name, price: sv.price, date: '' }); paintPicked(); }
            }
        });
        const noteInp  = h('textarea', { rows: '3', placeholder: 'Что нужно пациенту, когда перезвонить…' });
        if (r) noteInp.value = r.note || '';
        // CRM_V7 — дата записи: питает автоматику (день прошёл без визита → «Не пришёл»).
        const schedInp = h('input', { type: 'date', value: r ? (r.scheduled_date || '') : '' });

        // CRM_CONVERT_V3 — сохранение вынесено из кнопки: его переиспользует
        // «Оформить услугу», которой нужна уже существующая строка заявки
        // (у новой заявки нет id, а конверсия работает по нему).
        // Возвращает сохранённую строку либо null, если форма не прошла проверку.
        async function persist() {
            const name = linkedPatient ? linkedPatient.full_name : nameInp.value.trim();
            if (!name) { toast('Укажите имя.', 'fail'); return null; }
            // Привязанный пациент — телефон берём из ввода или из карты; поле
            // скрыто и обязательным быть не может (CRM_V11).
            const phone = phoneInp.value.trim() || (linkedPatient ? (linkedPatient.phone || '') : '');
            if (!phone && !linkedPatient) { toast('Укажите телефон.', 'fail'); return null; }
            const payload = { full_name: name, phone, source: srcChosen, note: noteInp.value.trim(), service_id: svcChosen || null, patient_id: linkedPatient ? linkedPatient.id : null, scheduled_date: schedInp.value || null };
            // Дата записи назначена — активная заявка сама переходит в «Записан».
            // CRM_CONFIG_V1 — правило прежнее (дата назначена → «Записан»), но
            // целевая колонка проверяется: если её удалили, статус не трогаем.
            if (isEdit && schedInp.value && ['in_process', 'recall'].includes(r.status) && hasStage('scheduled')) payload.status = 'scheduled';
            if (isEdit) {
                const { error } = await supabase.from('crm_requests').update(payload).eq('id', r.id);
                if (error) { toast(error.message, 'fail'); return null; }
                Object.assign(r, payload);
                // CRM_MULTI_SERVICE_V1 — строки услуг пишутся и при РЕДАКТИРОВАНИИ.
                // Раньше эта ветка возвращалась раньше saveLines(), и правка
                // существующей заявки не сохраняла ни одной услуги: регистратура
                // не видела ничего, потому что писать было нечего.
                await saveLines(r.id);
                return r;
            }
            const { data, error } = await supabase.from('crm_requests')
                .insert({ ...payload, status: schedInp.value ? stageKey('scheduled') : stageKey('in_process'), ...(uid() != null ? { created_by: uid() } : {}) })
                .select().single();
            if (error) { toast(error.message, 'fail'); return null; }
            // insert не возвращает join'ы — подставляем услугу из каталога, иначе
            // попап конверсии показал бы «#12» вместо названия.
            const row = data || { ...payload, id: null };
            if (!row.services && svcChosen) row.services = svcCatalog.find(x => String(x.id) === String(svcChosen)) || null;
            await saveLines(row.id);
            return row;
        }

        // CRM_MULTI_SERVICE_V1 — записать выбранные услуги строками. Полная
        // замена набора: старые строки отменяем, текущие пишем заново. Отмена
        // (а не удаление) — уже закрытая регистратурой строка со статусом 'done'
        // должна пережить редактирование заявки.
        async function saveLines(requestId) {
            if (!requestId) return;
            try {
                await supabase.from('crm_request_services')
                    .update({ status: 'cancelled' })
                    .eq('request_id', requestId).eq('status', 'pending');
                if (!picked.length) return;
                await supabase.from('crm_request_services').insert(picked.map(p => ({
                    request_id: requestId,
                    service_id: p.service_id,
                    scheduled_date: p.date || null,
                    doctor_id: p.doctor_id || null,   // CRM_LINE_DOCTOR_V1
                    status: 'pending',
                })));
            } catch (e) {
                toast('Услуги заявки не сохранились: ' + ((e && e.message) || e), 'fail');
            }
        }

        // CRM_SCHEDULE_V1 — «Записать на дату» заменила «Оформить услугу».
        //
        // Прежняя кнопка сохраняла заявку и открывала мастер записи: регистрация
        // пациента, смета, счёт. Для колл-центра это чужая работа — он не берёт
        // деньги и не оформляет визит. Его результат — УСЛУГА и ДАТА в заявке;
        // дальше пациент приходит, и регистратура в этот день видит эту услугу
        // уже подставленной в «Добавить услуги к визиту» и выставляет счёт.
        //
        // Поэтому кнопка требует ровно два поля и ничего больше не открывает.
        const scheduleBtn = h('button', {
            class: 'btn', type: 'button',
            style: { background: 'var(--ok-600, #16a34a)', borderColor: 'var(--ok-600, #16a34a)', color: '#fff', fontWeight: 700 },
            title: 'Назначить дату каждой услуге — регистратура подхватит их в эти дни',
        }, Icon('Check', { size: 14 }), ' Записать на дату');
        scheduleBtn.addEventListener('click', () => {
            if (!picked.length) { toast('Добавьте хотя бы одну услугу.', 'fail'); svcInp.focus(); return; }
            // CRM_REG_BEFORE_SCHEDULE_V1 — сначала карта пациента, потом врач и дата.
            //
            // Пациент, найденный в базе через поле ФИО, уже привязан — ему карту
            // заводить не надо. А вот нового лида раньше записывали на дату,
            // не заводя карты вовсе: регистратура получала услуги, висящие на
            // заявке, и в день приёма заводила человека заново — с риском
            // второй карты и с ручной сверкой «тот ли это».
            if (linkedPatient) { openScheduleSheet(); return; }

            const name = nameInp.value.trim();
            const phone = phoneInp.value.trim();
            if (!name) { toast('Укажите ФИО пациента.', 'fail'); nameInp.focus(); return; }
            if (!phone) { toast('Укажите телефон пациента.', 'fail'); phoneInp.focus(); return; }

            patientRegistrationModal({
                requestRow: r || null,
                // Запись на будущую дату — это НЕ «пациент пришёл»: статус
                // заявки трогать нельзя, иначе канбан покажет визит, которого
                // ещё не было.
                markCame: false,
                prefill: { full_name: name, phone, dob: dobInp.value || '', note: noteInp.value.trim() },
                onCreated: (p) => {
                    linkedPatient = { id: p.id, full_name: p.full_name, mrn: p.mrn, phone: p.phone || phone };
                    paintLinked();
                    openScheduleSheet();
                },
            });
        });

        // CRM_MULTI_SERVICE_V1 — окно назначения дат. У каждой услуги своя дата
        // (УЗИ во вторник, анализы в среду — это одна заявка), плюс строка
        // «одна дата для всех»: чаще всего пациент приходит за всем сразу, и
        // проставлять одно и то же в пяти полях — работа на пустом месте.
        function openScheduleSheet() {
            const ov = h('div', { class: 'modal', style: { zIndex: '160' } });
            const shut = () => ov.remove();
            ov.appendChild(h('div', { class: 'modal-backdrop', onclick: shut }));

            const rows = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
            const inputs = new Map();   // service_id -> <input type=date>
            const paintRows = () => {
                clear(rows);
                for (const p of picked) {
                    const inp = h('input', { type: 'date', value: p.date || '',
                        style: { width: '155px', flex: '0 0 auto', padding: '7px 9px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '13px' } });
                    inp.addEventListener('change', () => { p.date = inp.value; });
                    inputs.set(String(p.service_id), inp);

                    // CRM_LINE_DOCTOR_V1 — врач выбирается ТОЛЬКО там, где услуга
                    // его требует. Мастер записи не пустит такую услугу в смету
                    // без врача (visibleCart), поэтому без него запись колл-центра
                    // дошла бы до регистратуры невидимой строкой.
                    let docCell = null;
                    if (needsDoctor(p)) {
                        const pool = doctorsForService(p.service_id);
                        const sel = h('select', { style: { width: '210px', flex: '0 0 auto', padding: '7px 9px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '12.5px', background: 'var(--white,#fff)' } },
                            h('option', { value: '' }, '— выберите врача —'),
                            ...pool.map(d => h('option', { value: String(d.id), selected: String(p.doctor_id || '') === String(d.id) },
                                d.full_name + (d.specialty ? ' · ' + d.specialty : ''))));
                        sel.addEventListener('change', () => { p.doctor_id = sel.value ? Number(sel.value) : null; });
                        docCell = sel;
                    } else {
                        docCell = h('span', { class: 'muted', style: { width: '210px', flex: '0 0 auto', fontSize: '11.5px' } }, 'врач не требуется');
                    }

                    rows.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 11px', border: '1px solid var(--ink-100)', borderRadius: '10px' } },
                        h('div', { style: { flex: 1, minWidth: 0 } },
                            h('div', { style: { fontSize: '13px', fontWeight: 600, overflowWrap: 'anywhere' } }, p.name),
                            h('div', { class: 'muted', style: { fontSize: '11.5px' } }, String(p.price || 0) + ' сум')),
                        docCell, inp));
                }
            };
            paintRows();

            const allInp = h('input', { type: 'date',
                style: { width: '160px', padding: '7px 9px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '13px' } });
            const applyAll = h('button', { class: 'btn btn-outline btn-sm', type: 'button',
                onclick: () => {
                    if (!allInp.value) { toast('Выберите дату.', 'fail'); return; }
                    for (const p of picked) { p.date = allInp.value; const i = inputs.get(String(p.service_id)); if (i) i.value = allInp.value; }
                    toast('Дата проставлена всем услугам.', 'ok');
                } }, 'Применить ко всем');

            const saveAll = h('button', { class: 'btn btn-primary', type: 'button' }, Icon('Check', { size: 14 }), ' Сохранить и записать');
            saveAll.addEventListener('click', async () => {
                const missing = picked.filter(p => !p.date);
                if (missing.length) { toast('Без даты: ' + missing.map(p => p.name).join(', '), 'fail'); return; }
                // CRM_LINE_DOCTOR_V1 — услуга, требующая врача, без врача не
                // сохраняется: регистратура получила бы строку, которую мастер
                // записи не покажет в смете.
                const noDoc = picked.filter(p => needsDoctor(p) && !p.doctor_id);
                if (noDoc.length) { toast('Не выбран врач: ' + noDoc.map(p => p.name).join(', '), 'fail'); return; }
                saveAll.disabled = true;
                const row = await persist();
                if (!row) { saveAll.disabled = false; return; }
                shut(); close();
                toast('Записано услуг: ' + picked.length + ' — регистратура увидит каждую в свой день.', 'ok');
                await paint();
            });

            // Шире прежнего: в строке теперь три поля — услуга, врач и дата.
            ov.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '860px', maxWidth: 'calc(100vw - 32px)' } },
                h('header', { class: 'modal-head' },
                    h('h2', { style: { margin: 0, fontSize: '15px' } }, Icon('Check', { size: 16 }), ' Даты приёма'),
                    h('button', { class: 'modal-close', onclick: shut }, '×')),
                h('div', { class: 'modal-body', style: { display: 'block', maxHeight: '62vh', overflowY: 'auto' } },
                    h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } },
                        'Назначьте дату каждой услуге и врача там, где он нужен. Регистратура увидит услугу в смете именно в этот день.'),
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 11px', marginBottom: '12px', background: 'var(--ink-25, #f6f8f9)', border: '1px solid var(--ink-100)', borderRadius: '10px' } },
                        h('span', { style: { flex: 1, fontSize: '13px', fontWeight: 600 } }, 'Одна дата для всех'),
                        allInp, applyAll),
                    rows),
                h('footer', { class: 'modal-foot' },
                    h('button', { class: 'btn', type: 'button', onclick: shut }, 'Отмена'),
                    h('span', { class: 'grow' }),
                    saveAll)));
            document.body.appendChild(ov);
        }

        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' },
            Icon(isEdit ? 'Check' : 'Plus', { size: 14 }), ' ', isEdit ? 'Сохранить' : 'Создать заявку');
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            const row = await persist();
            if (!row) { saveBtn.disabled = false; return; }
            toast(isEdit ? 'Заявка обновлена.' : 'Заявка зафиксирована.', 'ok');
            close();
            await paint();
        });

        overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '720px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
                    h('span', { style: { width: '34px', height: '34px', borderRadius: '10px', background: 'var(--teal-50, #e0f2f1)', color: 'var(--teal-700, #00796b)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                        Icon('Headset', { size: 17 })),
                    h('div', null,
                        h('h2', { style: { margin: 0, fontSize: '15px' } }, isEdit ? 'Заявка' : 'Новая заявка'),
                        h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '1px' } },
                            isEdit ? ('Создана ' + fmtDateTime(r.created_at)) : 'Найдите пациента клиники или зафиксируйте нового'))),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body' },
                field('ФИО', nameWrap, { required: true }),
                (contactRow = h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
                    h('div', { style: { flex: 1 } }, field('Телефон', phoneWrap, { required: true })),
                    h('div', { style: { flex: 1 } }, field('Дата рождения', dobWrap)))),
                field('Источник', srcRow),
                // CRM_SCHEDULE_V1 + CRM_MULTI_SERVICE_V1 — колл-центр набирает
                // список услуг и назначает каждой дату. Раньше вместо этого была
                // одна услуга и кнопка «Оформить услугу», которая проваливалась в
                // мастер записи с регистрацией и счётом — не работа колл-центра.
                // Счёт выставит регистратура в день приёма.
                field('Интересующие услуги', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                    svcChips, svcWrap, pickedList)),
                field('Комментарий', noteInp),
            ),
            h('footer', { class: 'modal-foot' },
                // CRM_CONVERT_V1 — конверсия одной кнопкой: интересующая услуга
                // становится реальной. Нет пациента — сначала попап регистрации.
                // CRM_CONVERT_V3 — доступна и для НОВОЙ заявки: она сохраняется
                // на лету (конверсия работает по id), поэтому «пациент пришёл
                // сразу с ресепшена» — это одна кнопка, а не создать-открыть-нажать.
                (!isEdit || r.status !== CONVERT_STATUS) ? scheduleBtn : null,
                (isEdit && r.status === CONVERT_STATUS && r.patients) ? h('button', {
                    class: 'btn btn-outline', type: 'button',
                    onclick: () => { close(); refs.onNavigate && refs.onNavigate('patient-card', r.patients); },
                }, 'Карта пациента →') : null,
                h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
                h('span', { class: 'grow' }),
                saveBtn),
        ));
        syncContactRow();   // CRM_V11 — заявка уже привязана? контактная строка скрыта сразу
        document.body.appendChild(overlay);
        if (!linkedPatient) nameInp.focus();
    }

    // ---------------- ОТЧЁТ ----------------
    function reportModal() {
        const overlay = h('div', { class: 'modal' });
        const close = () => overlay.remove();
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

        let period = 30;   // дней; 0 = всё время
        const bodyEl = h('div', { class: 'modal-body', style: { overflowY: 'auto' } });

        function rowsInPeriod() {
            if (!period) return state.rows;
            const from = Date.now() - period * 86400000;
            return state.rows.filter(r => Date.parse(r.created_at || 0) >= from);
        }
        function paintReport() {
            clear(bodyEl);
            const rows = rowsInPeriod();
            const conv = rows.filter(r => r.status === CONVERT_STATUS).length;
            const lost = rows.filter(r => LOST_STATUSES.includes(r.status)).length;
            const rate = rows.length ? Math.round(conv / rows.length * 100) : 0;

            const chip = (days, label) => h('button', {
                class: 'btn btn-sm ' + (period === days ? 'btn-primary' : 'btn-outline'), type: 'button',
                onclick: () => { period = days; paintReport(); },
            }, label);
            bodyEl.appendChild(h('div', { class: 'row', style: { gap: '8px', marginBottom: '14px' } },
                chip(1, 'Сегодня'), chip(7, '7 дней'), chip(30, '30 дней'), chip(0, 'Всё время')));

            const kpi = (label, value, color) => h('div', { class: 'card', style: { flex: 1, padding: '12px 14px', textAlign: 'center' } },
                h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em' } }, label),
                h('div', { style: { fontSize: '22px', fontWeight: 800, marginTop: '2px', color: color || 'var(--ink-900)' } }, String(value)));
            bodyEl.appendChild(h('div', { class: 'row', style: { gap: '10px', marginBottom: '14px' } },
                kpi('Заявок', rows.length),
                kpi('Пришло', conv, 'var(--ok-600, #16a34a)'),
                kpi('Конверсия', rate + '%', 'var(--primary-700)'),
                kpi('Потеряно', lost, 'var(--crit-600, #dc2626)')));

            // разбивка по всем статусам воронки
            bodyEl.appendChild(h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginBottom: '14px' } },
                ...STATUSES.map(([k, l, kind]) => {
                    const n = rows.filter(r => r.status === k).length;
                    return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                        Tag(l + ' · ' + n, { kind, dot: true }));
                })));

            // по источникам
            const bySrc = new Map();
            for (const r of rows) {
                const k = r.source || 'other';
                const s = bySrc.get(k) || { total: 0, conv: 0 };
                s.total++; if (r.status === CONVERT_STATUS) s.conv++;
                bySrc.set(k, s);
            }
            const tbody = h('tbody');
            [...bySrc.entries()].sort((a, b) => b[1].total - a[1].total).forEach(([src, s]) => {
                tbody.appendChild(h('tr', null,
                    h('td', null, SOURCE_RU[src] || src),
                    h('td', { class: 'num' }, String(s.total)),
                    h('td', { class: 'num' }, String(s.conv)),
                    h('td', { class: 'num', style: { fontWeight: 700 } }, (s.total ? Math.round(s.conv / s.total * 100) : 0) + '%')));
            });
            bodyEl.appendChild(h('div', { class: 'card' }, h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Источник'), h('th', { style: { textAlign: 'right' } }, 'Заявок'),
                    h('th', { style: { textAlign: 'right' } }, 'Пришло'), h('th', { style: { textAlign: 'right' } }, 'Конверсия'))),
                tbody)));
        }
        paintReport();

        overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '640px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Chart', { size: 16 }), ' Отчёт по заявкам'),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            bodyEl,
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', type: 'button', onclick: close }, 'Закрыть')),
        ));
        document.body.appendChild(overlay);
    }

    // ---------------- EXCEL ----------------
    async function exportExcel() {
        const rows = filtered();
        if (!rows.length) { toast('Нет заявок для выгрузки.', 'fail'); return; }
        try {
            const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
            const aoa = [
                ['Имя', 'Телефон', 'Источник', 'Услуга', 'Дата записи', 'Комментарий', 'Статус', 'Пациент (MRN)', 'Дата'],
                ...rows.map(r => [
                    r.full_name || '', r.phone || '', SOURCE_RU[r.source] || r.source || '',
                    r.services ? r.services.name : '', r.scheduled_date || '', r.note || '', (STATUS_RU[r.status] || [r.status])[0],
                    r.patients ? (r.patients.mrn || r.patients.full_name || '') : '',
                    (r.created_at || '').replace('T', ' ').slice(0, 16),
                ]),
            ];
            const ws = XLSX.utils.aoa_to_sheet(aoa);
            ws['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 13 }, { wch: 34 }, { wch: 12 }, { wch: 16 }, { wch: 17 }];
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'CRM');
            XLSX.writeFile(wb, 'crm-requests.xlsx');
        } catch (e) {
            toast('Не удалось сформировать Excel: ' + ((e && e.message) || e), 'fail');
        }
    }
}
