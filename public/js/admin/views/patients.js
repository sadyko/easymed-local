// Patients list — server-side pagination (30 per page) and server-side
// search. The page never pulls the whole register into the browser; each
// filter / sort / page / keystroke fires a fresh PostgREST query.

import { h, Icon, Avatar, Tag, StatusTag, PageHead, toast, clear, fmtDate } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { registrarHeader } from './registrar-header.js?v=roleaud1';
import { loadPatientsPaged, findAllDuplicatePatientIds, mergePatients } from '../data.js';   // DUP_MERGE_V1
import { mrnOrder } from '../patient-duplicates.js';   // MRN_BEYOND_99999_V1 — номер карты целиком, как у триггера (232)
import { scopedDoctorId, canView, actorIsAdmin, canCreatePatient, canOrderAdmission } from '../permissions.js';   // V3120_FIX — canCreatePatient, canOrderAdmission
// PATIENT_ROW_V2 — телефон в реестре читается так же, как на карточке CRM.
import { formatPhone } from '../phone-format.js';
import { moneyDisplay } from '../../shared/money-input.js?v=mi2';   // DEBT_FLOW_V1 — сумма долга у имени
// PATIENT_ROW_V2 — регистратор и отметка Telegram читаются напрямую:
// см. resolveRegistrars() ниже; Telegram — loadBotStatus() (PATIENT_BOT_INVITE_V1).
import { supabase } from '../../supabase.js';
import { originTag } from '../record-origin.js';   // BRANCH_ORIGIN_V1 — откуда запись
import { branchSyncButton } from './branch-sync-button.js';   // BRANCH_SYNC_HOURLY_V1
import { openServicePickerModal } from './service-picker-modal.js?v=ownrep4';   // OWN_PRICE_REPEAT_V1 — штамп каталога
// PATIENT_ONE_WINDOW_V1 — заведение пациента больше не отдельная страница:
// «Создать пациента» открывает окно ПОВЕРХ списка, и сохранённая карта
// появляется в этом же списке без перехода туда-обратно.
import { openPatientCreateModal } from './patient-create-modal.js?v=onewin1';
// MOTION_REVEAL_V1 — строки появляются по мере прокрутки, и на страницу
// приезжают плавно. Помощник ОДИН на приложение (public/js/admin/motion.js):
// список пациентов, доска очереди и плитки сводки просят одно и то же.
import { revealOn, smoothScrollTo } from '../motion.js?v=mo1';

// DATA_TRANSFER_V1 — the Шаблон / Импорт / Экспорт trio used to sit in this
// header too. It was removed: the same three actions live in Настройки →
// Пациенты (section-crud paints them from the same section-import-export.js
// config), and two entry points for a bulk overwrite of the whole register is
// one more than the registrar's toolbar needs.


// Set<patient_id> for every patient the PATIENT_DUP_RULE_V2 scan calls the same
// person as another card (same PINFL, or same phone AND same first name).
// Loaded once on mount; powers both the count on the Duplicates card and the
// id-set filter passed to loadPatientsPaged when the card is clicked.
let duplicateIdSet = new Set();
// DUP_MERGE_V1 — ids ticked in the Duplicates filter, for merging.
let selectedDup = new Set();

const PAGE_SIZE = 30;

const state = {
    filter: 'all',
    search: '',
    dob:    '',   // PATIENT_SEARCH_DOB_V2
    sort:   'recent',
    page:   1,
    total:  0,
};

const refs = {
    container: null,
    onNavigate: null,
    doctorId:  null,
    tbody:     null,
    listCard:  null,   // MOTION_SCROLL_V1 — якорь прокрутки при листании
    searchInp: null,
    dobInp:    null,   // PATIENT_SEARCH_DOB_V2
    emptyEl:   null,
    pagerLabel:null,
    prevBtn:   null,
    nextBtn:   null,
    totalEl:   null,
    filterButtons: {},
    sortButtons:   {},
    lastRows:  [],
    revealed:  false,   // MOTION_REVEAL_ONCE_V1 — появление уже сыграно на этом монтировании
};

export async function renderPatients(container, { onNavigate, embedded = false }) {
    state.filter = 'all';
    state.search = '';
    state.dob    = '';   // PATIENT_SEARCH_DOB_V2
    state.sort   = 'recent';
    state.page   = 1;
    state.total  = 0;

    refs.container  = container;
    refs.onNavigate = onNavigate;
    refs.embedded   = embedded;
    // PATIENTS_CLINIC_WIDE_V1 — the patient REGISTER is shared clinic-wide:
    // any role granted 'patients' sees every clinic patient (access level
    // still governs edit/delete). Doctors keep their own queue in «Мои
    // услуги»; scopedDoctorId() no longer narrows this list.
    refs.doctorId   = null;
    refs.filterButtons = {};
    refs.sortButtons   = {};

    mount();
    // PATIENT_ROW_V2 спрашивал отметки Telegram здесь, до первой отрисовки.
    // PATIENT_BOT_INVITE_V1 — теперь их приносит patient_bot_status для каждой
    // страницы (loadBotStatus в paintRows), в последней колонке строки.
    await fetchAndPaint();

    // Async: scan the whole register for shared phone / PINFL so the
    // Duplicates card can show its count + filter the list. Doesn't block
    // the initial paint — the count placeholder reads "—" until this lands.
    findAllDuplicatePatientIds().then(set => {
        duplicateIdSet = set;
        paintDuplicateCount();
        // If the user has clicked through to the Duplicates filter before
        // the scan returned, repaint with the freshly-computed id set.
        if (state.filter === 'duplicates') fetchAndPaint();
    });
}

// -----------------------------------------------------------------------------
// MOUNT — build the static page shell once. Search keystrokes / pager clicks
// repaint just the tbody so the input keeps focus and the page doesn't blink.
// -----------------------------------------------------------------------------
// PATIENT_ONE_WINDOW_V1 — единственная точка открытия окна заведения пациента
// на этом экране. onSaved перечитывает страницу: новая карта обязана появиться
// в списке, из которого её завели, а не после ручного обновления.
function openCreatePatient() {
    return openPatientCreateModal({
        onNavigate: refs.onNavigate,
        onSaved: () => { state.page = 1; fetchAndPaint(); },
    });
}

// FAST_REG_ONE_SCREEN_V1 — быстрая регистрация это СВОЁ окно, а не режим окна
// заведения. Раньше кнопка открывала форму пациента в «быстром режиме», а после
// сохранения — второе окно, мастер услуг: карта успевала создаться, и закрытое
// второе окно оставляло пациента без визита, счёта и очереди. Теперь всё это
// делается одним нажатием в одном окне, и промежуточного «полпациента» нет.
//
// Право спрашивает САМО окно (PATIENT_CREATE_GATE_V1, тот же canCreatePatient и
// тот же видимый отказ), поэтому второй двери мимо гейта здесь не завелось —
// patients-hub.test.mjs сторожит именно это.
//
// Импорт динамический: окно тянет каталог услуг, справочники и печатный бланк,
// и грузить их при каждом входе в список пациентов незачем (а статический
// импорт завёл бы кольцо — NO_IMPORT_CYCLES_V1).
async function openFastRegistration() {
    const { openFastRegistrationDialog } = await import('./fast-registration.js?v=fastreg1');
    return openFastRegistrationDialog({
        onNavigate: refs.onNavigate,
        onSaved: () => { state.page = 1; fetchAndPaint(); },
    });
}

// MOTION_SCROLL_V1 — смена страницы списка: сначала везём к началу карточки,
// потом читаем. Прокрутка плавная в браузере и мгновенная, если пользователь
// просил «меньше движения» (motion.js спрашивает эту настройку за нас).
function goPage() {
    smoothScrollTo(refs.listCard || refs.container, { block: 'start' });
    return fetchAndPaint();
}

function mount() {
    clear(refs.container);

    // MOTION_REVEAL_ONCE_V1 — появление играется ОДИН РАЗ на монтирование, и
    // флаг сбрасывается ровно здесь, вместе с новой таблицей.
    refs.revealed = false;

    refs.tbody = h('tbody');
    // V3120_FIX — КНОПКА, ВЕДУЩАЯ В ОТКАЗ, НЕ РИСУЕТСЯ. «Создать пациента»,
    // «Быстрая регистрация» и «Госпитализация» стояли у врача, медсестры,
    // лаборанта и кассира, а окно (или сервер) отвечало им отказом. Окна по-
    // прежнему спрашивают право сами (PATIENT_CREATE_GATE_V1) — это второй
    // замок, а не единственный.
    const mayCreate = canCreatePatient();
    refs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        'Пациент не найден. ',
        mayCreate ? h('button', { class: 'link-btn', type: 'button', onclick: () => openCreatePatient() }, 'Создать нового пациента?') : null,
    );
    refs.pagerLabel = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    refs.totalEl = h('span', { class: 'cell-strong' }, '0');

    refs.searchInp = h('input', {
        type: 'search',
        autocomplete: 'off',
        style: { width: '100%', height: '34px', padding: '0 12px 0 34px', borderRadius: '8px', border: '1px solid var(--ink-200)', fontSize: '13.5px' },
        placeholder: 'Поиск пациента по ФИО, ID или номеру телефона…',
    });
    // PATIENT_SEARCH_DOB_V2 (2026-10-31, владелец: «search and search by date
    // of birth») — отдельное поле даты рождения рядом с поиском, как было до
    // FAST_REGISTRATION_V1. Искать дату внутри той же строки нельзя — «1990»
    // это ещё и кусок номера телефона. Пустое поле снимает фильтр.
    refs.dobInp = h('input', {
        type: 'date', title: 'Поиск по дате рождения', 'aria-label': 'Поиск по дате рождения', 'data-dob-search': '',
        max: new Date().toISOString().slice(0, 10),
        style: { height: '34px', padding: '0 10px', borderRadius: '8px', border: '1px solid var(--ink-200)', fontSize: '13.5px', fontFamily: 'inherit', color: 'var(--ink-700)' },
    });
    refs.dobInp.addEventListener('change', () => {
        state.dob = refs.dobInp.value;
        state.page = 1;
        fetchAndPaint();
    });
    let searchTimer = null;
    refs.searchInp.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.search = refs.searchInp.value;
            state.page = 1;
            fetchAndPaint();
        }, 250);
    });

    // FAST_REGISTRATION_V1 — здесь стояло отдельное поле «Поиск по дате
    // рождения» (PATIENT_SEARCH_DOB_V1). Владелец: «in the registrators window
    // there is search by date of birth. we dont need that. actually create a
    // pulsating button "fast registration"» — и это не просто уборка: место у
    // строки поиска самое дорогое на экране регистратуры, а дата рождения
    // по-прежнему видна у каждой строки реестра отдельной колонкой, так что
    // тёзок различают там же, где и раньше.
    //
    // Кнопка на её месте открывает ровно то, что владелец показал на снимке
    // чужой системы: ОДНО окно — реквизиты пациента сверху, таблица услуг с
    // врачом на строке снизу, счёт, очередь и «Печать» (FAST_REG_ONE_SCREEN_V1,
    // views/fast-registration.js). Пульс — по домашнему правилу
    // (admin-views.css): движение тенью, и ровно одна пульсирующая вещь на
    // экран; других на списке пациентов нет.
    const fastRegBtn = !mayCreate ? null : h('button', {
        class: 'btn btn-primary btn-sm btn-pulse', type: 'button', 'data-onb': 'fast-registration',
        title: 'Быстрая регистрация: пациент → услуги и врач → счёт → печать',
        onclick: () => openFastRegistration(),
    }, Icon('Rocket', { size: 14 }), ' Быстрая регистрация');

    refs.prevBtn = h('button', {
        class: 'icon-btn btn-sm',
        style: { width: '28px', height: '28px' },
        // Страница листается — список обязан начаться сначала. Без этого
        // сотрудник, нажавший «дальше» внизу таблицы, оказывался посреди
        // новой страницы и не понимал, что она уже другая.
        onclick: () => { if (state.page > 1) { state.page--; goPage(); } },
    }, Icon('ChevronLeft', { size: 14 }));
    refs.nextBtn = h('button', {
        class: 'icon-btn btn-sm',
        style: { width: '28px', height: '28px' },
        onclick: () => {
            const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
            if (state.page < maxPage) { state.page++; goPage(); }
        },
    }, Icon('ChevronRight', { size: 14 }));

    const sortSegmented = h('div', { class: 'segmented' },
        sortBtn('recent', 'Сначала новые'),   // V3120_FIX — было «Sort: Recent»
        sortBtn('az',     'A–Z'),
        sortBtn('mrn',    'MRN'),
    );

    // REGISTRATURA_CLEANUP_V1 — table-header actions: duplicates chip + calculator + create.
    const dupCountSpan = h('span', { class: 'num', style: { fontWeight: '700' } }, '—');
    refs.dupChipCount = dupCountSpan;
    const dupChip = h('button', { type: 'button', class: 'btn btn-outline btn-sm',
        title: 'Возможные дубликаты — одно имя на одном телефоне или общий ПИНФЛ. Родственники на общем номере дубликатами не считаются',
        onclick: () => { state.filter = state.filter === 'duplicates' ? 'all' : 'duplicates'; state.page = 1; if (state.filter !== 'duplicates') selectedDup.clear(); paintDupChip(); fetchAndPaint(); } },
        Icon('Warning', { size: 13 }), ' Дубликаты · ', dupCountSpan);
    refs.dupChip = dupChip;
    const calcBtn = h('button', { class: 'btn btn-amber btn-sm', title: 'Калькулятор услуг — расчёт без выбора пациента',
        onclick: () => openServicePickerModal({ calculator: true, title: 'Калькулятор услуг', titleIcon: 'Coins', onPick: () => {}, onCreatePatient: () => openCreatePatient() }) },
        Icon('Coins', { size: 14 }), ' Калькулятор');
    // ADMISSION_ORDER_V1 — «Госпитализация» жила в шапке страницы заведения
    // пациента; страницы больше нет (PATIENT_ONE_WINDOW_V1), а действие
    // осталось — и переехало туда, где регистратор и стоит. Окно заявки само
    // ищет пациента: на приёмном покое человека чаще находят по фамилии, чем
    // открывают его карту.
    const admitBtn = !canOrderAdmission() ? null : h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-act': 'admission',
        title: 'Заявка на госпитализацию — пациент выбирается в окне заявки',
        onclick: () => import('./admission-modal.js?v=inp2').then((m) => m.openAdmissionOrderModal({})) },
        Icon('Bed', { size: 14 }), ' Госпитализация');
    // ONBOARDING_TARGET_V1 — за эту кнопку цепляется подсказка «заведите
    // первого пациента» (admin/onboarding.js). Раньше она целилась в призывную
    // кнопку меню, а меню её лишилось (NO_TABS_APPBAR_V1) — подсказка молча
    // перестала показываться. Метка нужна именно как метка: класс у кнопки
    // общий с десятками других, и селектор по нему нашёл бы не ту.
    const createBtn = !mayCreate ? null : h('button', { class: 'btn btn-primary btn-sm', 'data-onb': 'create-patient',
        onclick: () => openCreatePatient() },
        Icon('Plus', { size: 14 }), ' Создать пациента');

    // DUP_MERGE_V1 — «select all visible» header checkbox (only meaningful in the
    // Duplicates filter) + the floating merge action bar.
    const dupHeadCb = h('input', { type: 'checkbox', title: 'Выбрать все на странице',
        style: { cursor: 'pointer', display: state.filter === 'duplicates' ? '' : 'none' },
        onchange: (e) => {
            const on = e.currentTarget.checked;
            for (const p of (refs.lastRows || [])) { if (on) selectedDup.add(p.id); else selectedDup.delete(p.id); }
            paintRows(refs.lastRows || []); paintMergeBar();
        } });
    refs.dupHeadCb = dupHeadCb;
    const mergeCount = h('b', null, '0');
    refs.mergeCount = mergeCount;
    const mergeBar = h('div', { class: 'dup-merge-bar', style: {
        display: 'none', alignItems: 'center', gap: '12px', padding: '10px 20px',
        background: 'var(--warn-50, #fffbeb)', borderBottom: '1px solid var(--warn-200, #fde68a)', fontSize: '13.5px' } },
        Icon('Warning', { size: 15 }),
        h('span', null, 'Выбрано дубликатов: ', mergeCount),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { selectedDup.clear(); paintRows(refs.lastRows || []); paintMergeBar(); } }, 'Снять'),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openMergeModal() },
            Icon('Check', { size: 14 }), ' Объединить выбранные'),
    );
    refs.mergeBar = mergeBar;

    refs.container.appendChild(h('div', { class: 'fade-in' },
        refs.embedded ? null : registrarHeader({ active: 'patients', onNavigate: refs.onNavigate }),
        // List card. Ссылка на карточку сохраняется: к её началу возвращает
        // прокрутка при листании страниц (goPage).
        // REG_LIST_ADAPT_V1 (2026-10-31, владелец: «Make it possible to adopt
        // based on screen size») — классы шапки и карточки ведут раскладку по
        // ШИРИНЕ КАРТОЧКИ (@container в admin-views.css), а не окна: открытое
        // меню отнимает у списка ~250px, и правило по окну врало бы.
        refs.listCard = h('div', { class: 'card reg-base-card' },
            // REG_LIST_ADAPT_V2 — шапка ДВУМЯ РЯДАМИ при любой ширине. Первая
            // попытка (V1) оставила один ряд с переносами — и левая группа
            // ломалась сама в себе («Сначала новые» уезжала под поиск), а
            // действия стояли справа как ни в чём не бывало. Теперь порядок
            // задан смыслом, а не случаем переноса:
            //   ряд 1 — работа: поиск (тянется), «Быстрая регистрация» (там,
            //           где стоял фильтр даты рождения — место выбрал
            //           владелец, FAST_REGISTRATION_V1), сортировка, а справа —
            //           «Создать пациента»;
            //   ряд 2 — справка и вспомогательное: «Всего», дубликаты,
            //           калькулятор, госпитализация, синхронизация.
            // На узкой карточке первый ряд складывается: поиск во всю ширину,
            // под ним сортировка и кнопки (admin-views.css, @container).
            //
            // REG_LIST_HEAD_V3 (2026-10-31, владелец со снимком шапки: «put the
            // button on one line and search place belove them separately,
            // search and search by date of birth») — порядок рядов ПЕРЕВЁРНУТ:
            //   ряд 1 — все кнопки одной строкой: «Всего», «Быстрая регистрация»,
            //           сортировка, дубликаты, калькулятор, госпитализация,
            //           синхронизация, справа — «Создать пациента»;
            //   ряд 2 — поиск по ФИО / ID / телефону и рядом поиск по дате
            //           рождения (PATIENT_SEARCH_DOB_V2), под тонкой чертой.
            h('div', { class: 'card-header reg-base-head' },
                h('div', { class: 'reg-base-tools' },
                    h('span', { class: 'muted reg-base-total' }, 'Всего ', refs.totalEl),
                    fastRegBtn,
                    sortSegmented,
                    dupChip, calcBtn, admitBtn,
                    // BRANCH_SYNC_HOURLY_V1 — сама покажется, только если это
                    // подключённый филиал. onDone перечитывает список: карта,
                    // заведённая в соседнем здании, уже в базе, но на экране
                    // её ещё нет.
                    branchSyncButton({ onDone: () => fetchAndPaint() }),
                    h('div', { class: 'reg-base-main' }, createBtn),
                ),
                h('div', { class: 'reg-base-acts reg-base-find' },
                    h('div', { class: 'reg-base-search', style: { position: 'relative' } },
                        h('span', { style: { position: 'absolute', left: '12px', top: '11px', color: 'var(--ink-400)' } },
                            Icon('Search', { size: 14 })),
                        refs.searchInp,
                    ),
                    refs.dobInp,
                ),
            ),
            mergeBar,
            // REG_TBL_FIT_V1 — таблица должна прокручиваться САМА, а не тянуть
            // за собой всю страницу.
            //
            // Здесь единственной из плотных таблиц приложения не было обёртки со
            // своей горизонтальной прокруткой (она есть у кассы, склада, CRM,
            // карты пациента — 18 мест). А у .reg-base-tbl жёсткий
            // min-width:1180px, и двенадцать колонок с их заголовками требуют
            // ещё больше — поэтому таблица распирала карточку, карточка
            // распирала страницу, и вбок ехало ВСЁ окно вместе с шапкой и
            // поиском. Прокрутка внутри обёртки оставляет страницу на месте.
            h('div', { style: { overflowX: 'auto' } },
            // REG_LIST_COMPACT_V1 — ref: колонка флажков видна только в режиме «Дубликаты».
            refs.baseTbl = h('table', { class: 'tbl reg-base-tbl' + (state.filter === 'duplicates' ? ' is-dup' : '') },
                h('thead', null, h('tr', null,
                    h('th', { style: { width: '34px', textAlign: 'center' }, 'data-dupcol': '' }, dupHeadCb),   // DUP_MERGE_V1
                    // PATIENT_ROW_V2 — восемь колонок вместо десяти, и это НЕ
                    // потеря данных: «Пол» переехал в личность (номер карты ·
                    // пол · город — одна строка под именем), «Визитов» — под
                    // дату последнего визита, к которой он и относится.
                    // Девять равнозначных колонок не давали строке ведущего:
                    // взгляд начинал с любой. Теперь ведёт имя, а всё, чем
                    // человека опознают, стоит одним блоком рядом с ним.
                    h('th', null, 'Пациент'),
                    h('th', null, 'Дата рождения'),
                    // REG_LIST_AGE_COL_V1 — возраст своей колонкой, а не строкой под датой.
                    h('th', null, 'Возраст'),
                    h('th', null, 'Телефон'),
                    // REG_TBL_FIT_V2 — «Телеграм» и «Есть ДМС?» убраны: обе
                    // колонки занимали ширину, но ничего не сообщали. Телеграм
                    // показывал «Не подключён» у всех (колонки
                    // patients.telegram_opt_in в схеме нет вовсе), ДМС — «—»,
                    // потому что страховая в постраничный список не джойнится.
                    // Полис виден в карточке пациента. Отметка Telegram
                    // вернулась НЕ колонкой, а значком у имени, и берётся из
                    // настоящей связки чата; теперь — последней колонкой (loadBotStatus).
                    h('th', null, 'Последний визит'),
                    h('th', { style: { textAlign: 'right' } }, 'Баланс'),
                    h('th', null, 'Регистратор'),
                    h('th', { style: { width: '104px' } }),
                    // PATIENT_BOT_INVITE_V1 — Telegram-бот пациента: значок или «Ссылка на бот».
                    h('th', { class: 'pt-bot-col' }),
                )),
                refs.tbody,
            )),
            refs.emptyEl,
            h('div', { class: 'row', style: { padding: '12px 20px', borderTop: '1px solid var(--ink-100)' } },
                refs.pagerLabel,
                h('span', { class: 'grow' }),
                h('div', { class: 'row', style: { gap: '4px' } },
                    refs.prevBtn,
                    refs.nextBtn,
                ),
            ),
        ),
    ));

    paintFilterCardChrome();
    paintSortChrome();
}

function filterCard(key, m) {
    // Count value (only rendered for the Duplicates card right now). Updated
    // by paintDuplicateCount() once findAllDuplicatePatientIds() resolves.
    const countEl = h('span', {
        class: 'num',
        style: {
            display: key === 'duplicates' ? 'inline-block' : 'none',
            fontSize: '20px', fontWeight: 700, color: m.color,
            letterSpacing: '-0.02em', marginTop: '2px',
        },
    }, '—');
    refs.filterButtons[key + '_count'] = countEl;

    const btn = h('button', {
        type: 'button',
        onclick: () => { state.filter = key; state.page = 1; paintFilterCardChrome(); fetchAndPaint(); },
        style: {
            textAlign: 'left', padding: '14px 16px',
            borderRadius: '12px',
            cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '4px',
            transition: 'all 120ms ease',
            fontFamily: 'inherit',
        },
    },
        h('div', { class: 'row', style: { gap: '8px' } },
            h('span', { class: 'flt-icon', style: { color: m.color } }, Icon(m.icon, { size: 16 })),
            h('span', { style: { fontSize: '12.5px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.04em', color: m.color } }, m.label),
        ),
        countEl,
    );
    refs.filterButtons[key] = btn;
    return btn;
}

function paintDuplicateCount() {
    if (refs.dupChipCount) refs.dupChipCount.textContent = String(duplicateIdSet.size);
}
function paintDupChip() {
    const b = refs.dupChip; if (!b) return;
    const on = state.filter === 'duplicates';
    b.style.borderColor = on ? 'var(--warn-500, #d97706)' : '';
    b.style.background  = on ? 'var(--warn-50, #fff7ed)'  : '';
    b.style.color       = on ? 'var(--warn-700)'          : '';
}

function paintFilterCardChrome() {
    for (const [key, btn] of Object.entries(refs.filterButtons)) {
        const active = state.filter === key;
        btn.style.border     = '1px solid ' + (active ? 'var(--primary-500)' : 'var(--ink-100)');
        btn.style.background = active ? 'var(--primary-50)' : 'white';
        btn.style.boxShadow  = active ? '0 0 0 4px var(--primary-50)' : 'none';
    }
}

function sortBtn(key, label) {
    const btn = h('button', {
        type: 'button',
        onclick: () => { state.sort = key; state.page = 1; paintSortChrome(); fetchAndPaint(); },
    }, label);
    refs.sortButtons[key] = btn;
    return btn;
}

function paintSortChrome() {
    for (const [key, btn] of Object.entries(refs.sortButtons)) {
        if (state.sort === key) btn.classList.add('on');
        else                    btn.classList.remove('on');
    }
}

// -----------------------------------------------------------------------------
// PATIENT_ROW_V2 (2026-09-05) — КТО ЗАВЁЛ КАРТУ и ЕСТЬ ЛИ У ЧЕЛОВЕКА TELEGRAM.
//
// Владелец: «show the registrators name also add small telegram icon for the
// patients with active telegram». Оба ответа лежали рядом с экраном, но экран
// их не спрашивал, и колонка «Регистратор» показывала прочерк на КАЖДОЙ строке.
//
// ПОЧЕМУ ОНА БЫЛА ПУСТА. data.js после выборки страницы зовёт RPC
// `patient_base_aggregates` (визиты, баланс, страховая, регистратор) — а такой
// процедуры в этой сборке НЕТ ВОВСЕ: во всём репозитории её имя встречается
// ровно один раз, в самом вызове (server/services/rpc/index.js её не
// регистрирует). Вызов падает, catch пишет предупреждение в консоль, и все
// четыре поля остаются пустыми — отсюда и «0» в визитах, и «0 сум» в балансе,
// и прочерк в регистраторе. То есть колонка не «не выбрана» и не «пуста в
// данных»: спрашивали не то.
//
// ЧЕМ ЧИНИМ ЗДЕСЬ. Кто завёл карту, записано в самой карте — patients.created_by
// (миграция 002), и эта колонка уже читается реестром (schema-registry.js). Имя
// сотрудника берём ОДНИМ запросом на страницу (30 строк → максимум 30 id, а
// обычно 2–3 разных регистратора), и запомненные имена не спрашиваем повторно.
// Если RPC когда-нибудь появится, его ответ имеет приоритет — p.registrar
// проверяется первым.
const registrarNames = new Map();   // user id → ФИО

async function resolveRegistrars(rows) {
    const want = [];
    for (const p of rows) {
        const id = p && p.createdBy;
        if (id == null || id === '' || registrarNames.has(String(id))) continue;
        if (!want.includes(id)) want.push(id);
    }
    if (!want.length) return;
    try {
        const { data, error } = await supabase.from('users').select('id, full_name').in('id', want);
        if (error) throw new Error(error.message);
        for (const u of (data || [])) registrarNames.set(String(u.id), u.full_name || '');
        // Промах тоже запоминаем: сотрудника могли удалить, и спрашивать про
        // него на каждой странице значит платить запросом за пустоту.
        for (const id of want) if (!registrarNames.has(String(id))) registrarNames.set(String(id), '');
    } catch (e) {
        console.warn('[patients/registrar]', e.message);
    }
}

function registrarOf(p) {
    if (p && p.registrar) return p.registrar;
    const id = p && p.createdBy;
    if (id == null || id === '') return '';
    return registrarNames.get(String(id)) || '';
}

// DEBT_FLOW_V1 — долг пациента в реестре: красная метка у имени.
//
// Владелец: «yes mark as a debt». Долг — это счета со статусом 'debt' («Оставить
// как долг» на кассе или выписка из стационара с долгом); неоплаченный счёт
// сегодняшнего визита долгом не считается. Спрашивается ОДНИМ запросом на
// страницу, как имена регистраторов, и НЕ запоминается между страницами:
// долг гасят, и метка обязана исчезнуть при следующей отрисовке.
const debtByPatient = new Map();   // patient id → остаток

async function resolveDebts(rows) {
    debtByPatient.clear();
    const ids = rows.map((p) => p && p.id).filter((id) => id != null && id !== '');
    if (!ids.length) return;
    try {
        const { data, error } = await supabase.from('invoices')
            .select('patient_id, total_amount, paid_amount').eq('status', 'debt').in('patient_id', ids);
        if (error) throw new Error(error.message);
        for (const inv of (data || [])) {
            const key = String(inv.patient_id);
            const due = Math.max(0, (Number(inv.total_amount) || 0) - (Number(inv.paid_amount) || 0));
            debtByPatient.set(key, (debtByPatient.get(key) || 0) + due);
        }
    } catch (e) {
        console.warn('[patients/debt]', e.message);
    }
}

function debtOf(p) {
    return (p && debtByPatient.get(String(p.id))) || 0;
}

// PATIENT_BOT_INVITE_V1 (2026-11-01) — TELEGRAM-БОТ ПАЦИЕНТА В КОНЦЕ СТРОКИ.
//
// Владелец: «at the end of patientline add button to send bot link to patient
// if patient has no bot, if patinet has bot, small telegram logo should be
// there». Подключён к боту — маленький логотип Telegram; нет — кнопка
// «Ссылка на бот»: patient_bot_invite шлёт ссылку SMS (Play Mobile), а если
// SMS не настроено — ссылка ложится в буфер обмена, и регистратор отправляет
// её сам (rpc/patient-bot.js).
//
// Прежде (PATIENT_ROW_V2) отметка стояла у имени и читалась из
// telegram_chats_list: только роли с правом чата и только по последним 300
// чатам — регистратор по умолчанию не видел её вовсе. patient_bot_status
// отвечает за id ЭТОЙ страницы всем, кто видит список, и номеров не отдаёт.
// Бот у клиники не подключён — колонка пустая: звать в несуществующий бот нельзя.
const botCells = new Map();   // String(patient id) → <td> последней колонки
let botStatusToken = 0;

function botCell(p) {
    const td = h('td', { class: 'pt-bot-cell', onclick: (e) => e.stopPropagation() });
    if (p && p.id != null) botCells.set(String(p.id), td);
    return td;
}

async function loadBotStatus(rows) {
    const token = ++botStatusToken;
    const ids = (rows || []).map((p) => p.id).filter((id) => id != null);   // проверку id делает сервер
    if (!ids.length) return;
    let st = null;
    try {
        const { data, error } = await supabase.rpc('patient_bot_status', { ids });
        if (error) return;   // нет права или сбой — колонка остаётся пустой, тревоги нет
        st = data;
    } catch (_) { return; }
    // Пока шёл запрос, список перерисовали (поиск, страница) — ответ устарел.
    if (token !== botStatusToken || !st) return;
    const linked = new Set((st.linked || []).map(String));
    for (const p of rows) {
        const td = botCells.get(String(p.id));
        if (td) fillBotCell(td, p, linked.has(String(p.id)), !!st.bot);
    }
}

function fillBotCell(td, p, linked, botReady = true) {
    clear(td);
    // Бот клиники не подключён — кнопка видна, но неактивна и говорит почему.
    // Сначала колонка в этом случае оставалась пустой, и владелец её не нашёл
    // («I don't see the button»): пустая колонка читается как поломка.
    if (!botReady) {
        td.appendChild(h('button', { class: 'pt-bot-invite', type: 'button', disabled: true,
            title: tr('Telegram-бот клиники не подключён — его включают в «Настройки → Telegram-бот».') },
            Icon('Send', { size: 13 }), h('span', { class: 'pt-act-lbl' }, tr('Ссылка на бот'))));
        return;
    }
    if (linked) {
        td.appendChild(h('span', { class: 'pt-tg', title: tr('Подключён к Telegram-боту клиники'), 'aria-label': tr('Подключён к Telegram-боту клиники') },
            Icon('Send', { size: 12 })));
        return;
    }
    const hasPhone = String(p.phone || '').replace(/\D/g, '').length >= 9;
    const btn = h('button', {
        class: 'pt-bot-invite', type: 'button', disabled: !hasPhone,
        title: hasPhone ? tr('Отправить пациенту ссылку на Telegram-бот клиники') : tr('У пациента нет номера телефона'),
        onclick: async () => {
            btn.disabled = true;
            try {
                const { data, error } = await supabase.rpc('patient_bot_invite', { patient_id: p.id });
                if (error) throw new Error(error.message);
                const res = data || {};
                if (res.ok) {
                    toast(tr('Ссылка на Telegram-бот отправлена пациенту по SMS.'), 'ok');
                    btn.title = tr('Ссылка отправлена');
                    btn.classList.add('is-sent');
                    return;
                }
                // SMS не настроено или не ушло — ссылку в буфер, отправит регистратор.
                const copied = await copyText(res.link || '');
                toast(res.message ? tr(res.message)
                    : copied ? tr('SMS не настроено — ссылка на бот скопирована, отправьте её пациенту.')
                    : trf('SMS не настроено. Ссылка на бот: {link}', { link: res.link || '' }), res.message ? 'fail' : 'info');
                btn.disabled = false;
            } catch (e) {
                toast((e && e.message) || tr('Не удалось отправить ссылку.'), 'fail');
                btn.disabled = false;
            }
        },
    }, Icon('Send', { size: 13 }), h('span', { class: 'pt-act-lbl' }, tr('Ссылка на бот')));
    td.appendChild(btn);
}

async function copyText(text) {
    if (!text) return false;
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (_) { /* буфер закрыт — покажем ссылку в сообщении */ }
    return false;
}

// -----------------------------------------------------------------------------
// FETCH + REPAINT
// -----------------------------------------------------------------------------
let lastFetchToken = 0;

async function fetchAndPaint() {
    const token = ++lastFetchToken;
    setLoadingRow();

    // Duplicates card is a virtual filter — pass the precomputed id set in,
    // and let the shared loader handle the rest.
    const opts = {
        limit:    PAGE_SIZE,
        offset:   (state.page - 1) * PAGE_SIZE,
        search:   state.search,
        dob:      state.dob,   // PATIENT_SEARCH_DOB_V2
        filter:   state.filter,
        sort:     state.sort,
        doctorId: refs.doctorId,
    };
    if (state.filter === 'duplicates') {
        opts.filter = 'all';
        opts.idsIn = [...duplicateIdSet];
    }
    const result = await loadPatientsPaged(opts);

    // A later keystroke / page click already kicked off a fresh query — drop
    // this stale response so it can't overwrite the newer rows.
    if (token !== lastFetchToken) return;

    // PATIENT_ROW_V2 — имена регистраторов приезжают ДО отрисовки, а не после:
    // иначе на каждой странице сначала мигал бы прочерк, а через мгновение —
    // фамилия, и глаз ловил бы это движение на самом читаемом экране продукта.
    // Один запрос на страницу, и только про неизвестные ещё id.
    await resolveRegistrars(result.rows);
    if (token !== lastFetchToken) return;
    await resolveDebts(result.rows);   // DEBT_FLOW_V1 — метка «Долг» приезжает ДО отрисовки
    if (token !== lastFetchToken) return;

    state.total    = result.total;
    refs.lastRows  = result.rows;
    paintRows(result.rows);
    paintPager();
}

function setLoadingRow() {
    if (!refs.tbody) return;
    clear(refs.tbody);
    refs.tbody.appendChild(h('tr', null,
        // PATIENT_ROW_V2 — 10 колонок (REG_LIST_AGE_COL_V1 + PATIENT_BOT_INVITE_V1): число обязано
        // совпадать с шапкой, иначе строка загрузки не растянется на таблицу.
        h('td', { colspan: '10', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка…'),
    ));
    refs.emptyEl.style.display = 'none';
}

function paintRows(rows) {
    clear(refs.tbody);
    botCells.clear();   // PATIENT_BOT_INVITE_V1
    if (rows.length === 0) {
        refs.emptyEl.style.display = '';
        return;
    }
    refs.emptyEl.style.display = 'none';
    for (const p of rows) refs.tbody.appendChild(patientRow(p));
    // MOTION_REVEAL_ONCE_V1 — появление ОДИН РАЗ на монтирование, а не на
    // каждую перерисовку. paintRows() зовётся на КАЖДУЮ букву в поиске (тот же
    // ввод с задержкой 250 мс строкой выше), на смену страницы, фильтра и
    // сортировки; безусловный revealOn прятал бы весь список в opacity: 0 и
    // проявлял заново на каждое нажатие клавиши — на самом «печатаемом» экране
    // продукта. Ровно этот довод уже записан в доске очереди (views/queue.js:
    // «карточки мигали бы у сотрудника весь рабочий день»).
    //
    // Один наблюдатель на ВСЮ таблицу, а не по одному на строку.
    // lift: false — строку таблицы поднимать нельзя, transform на <tr>
    // дрожит на линейках; строке хватает прозрачности.
    if (!refs.revealed) {
        refs.revealed = true;
        revealOn(refs.tbody, '[data-reveal]', { lift: false });
    }
    syncHeadCb();
    paintMergeBar();
    loadBotStatus(rows);   // PATIENT_BOT_INVITE_V1 — дозаполняет последнюю колонку
}

// DUP_MERGE_V1 — reflect selection count in the bar; toggle the whole strip.
function paintMergeBar() {
    // keep only ids still present as duplicates
    for (const id of [...selectedDup]) if (!duplicateIdSet.has(id)) selectedDup.delete(id);
    if (refs.mergeCount) refs.mergeCount.textContent = String(selectedDup.size);
    // Четвёртая проверка, M4 — объединяет карты только администратор (сервер
    // merge_patients откажет остальным): кнопки у других ролей нет.
    if (refs.mergeBar) refs.mergeBar.style.display = selectedDup.size >= 2 && actorIsAdmin() ? 'flex' : 'none';
    if (refs.dupHeadCb) refs.dupHeadCb.style.display = state.filter === 'duplicates' ? '' : 'none';
    // REG_LIST_COMPACT_V1 — пустая колонка флажков сдвигала всю строку вправо.
    if (refs.baseTbl) refs.baseTbl.className = 'tbl reg-base-tbl' + (state.filter === 'duplicates' ? ' is-dup' : '');
}
function syncHeadCb() {
    if (!refs.dupHeadCb) return;
    const rows = refs.lastRows || [];
    const on = rows.length > 0 && rows.every(p => selectedDup.has(p.id));
    refs.dupHeadCb.checked = on;
    refs.dupHeadCb.indeterminate = !on && rows.some(p => selectedDup.has(p.id));
}

// DUP_MERGE_V1 — merge dialog: pick which record to KEEP, merge the rest into it.
function openMergeModal() {
    const chosen = (refs.lastRows || []).filter(p => selectedDup.has(p.id));
    if (chosen.length < 2) { toast('Выберите минимум два дубликата.', 'fail'); return; }
    // Default primary = most visits, tiebreak the lowest (oldest) MRN.
    // MRN_BEYOND_99999_V1 — «oldest» by year + WHOLE number (mrnOrder), not by
    // text: as text 'A-26-100000' sorts before 'A-26-99999'.
    const byBest = [...chosen].sort((a, b) =>
        (b.visitCount || 0) - (a.visitCount || 0) || mrnOrder(a.mrn, b.mrn));
    let primaryId = byBest[0].id;

    const overlay = h('div', { class: 'modal', style: { zIndex: '9000' } });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const nameOf = (p) => `${p.lastName || ''} ${p.firstName || ''} ${p.middle || ''}`.trim() || '—';
    const rowsWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' } });
    const paintChoices = () => {
        clear(rowsWrap);
        for (const p of chosen) {
            const on = p.id === primaryId;
            rowsWrap.appendChild(h('label', { style: {
                    display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px', cursor: 'pointer',
                    border: '1px solid ' + (on ? 'var(--primary-400)' : 'var(--ink-200)'), borderRadius: '10px',
                    background: on ? 'var(--primary-50)' : 'white' } },
                h('input', { type: 'radio', name: 'dup-primary', checked: on, onchange: () => { primaryId = p.id; paintChoices(); } }),
                h('div', { style: { minWidth: 0 } },
                    h('div', { class: 'cell-strong' },
                        h('span', { class: 'num', style: { color: 'var(--ink-400)', marginRight: '6px' } }, p.mrn || '—'),
                        nameOf(p)),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                        (p.dob || '—') + ' · ' + (p.phone || '—') + ' · ' + trf('визитов: {n}', { n: p.visitCount || 0 }))),
                on ? h('span', { class: 'tag tag-ok', style: { marginLeft: 'auto', fontSize: '12.5px' } }, 'Оставить') : null,
            ));
        }
    };
    paintChoices();

    const mergeBtn = h('button', { class: 'btn btn-primary', style: { minWidth: '150px', justifyContent: 'center' } },
        Icon('Check', { size: 14 }), ' Объединить');
    mergeBtn.addEventListener('click', async () => {
        const duplicateIds = chosen.map(p => p.id).filter(id => id !== primaryId);
        mergeBtn.disabled = true; mergeBtn.textContent = tr('Объединение…');
        try {
            await mergePatients({ primaryId, duplicateIds });
            toast(trf('Объединено: {n} дубликат(ов) → одна карта.', { n: duplicateIds.length }), 'ok');
            selectedDup.clear();
            close();
            // rescan duplicates, then repaint
            duplicateIdSet = await findAllDuplicatePatientIds();
            paintDuplicateCount();
            await fetchAndPaint();
        } catch (e) {
            // M4 — отказ по роли словами экрана; остальные отказы сервер пишет по-русски.
            const msg = e && e.code === 'forbidden' ? tr('Объединять карты может только администратор.') : ((e && e.message) || e);
            toast(trf('Не удалось объединить: {msg}', { msg }), 'fail');
            mergeBtn.disabled = false; mergeBtn.textContent = '';
            mergeBtn.append(Icon('Check', { size: 14 }), ' Объединить');
        }
    });

    // modal-compact so the global MODAL_FULLSCREEN_V1 rule doesn't blow it up.
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '520px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Check', { size: 16 }), ' Объединить дубликаты'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { display: 'block' } },
            h('p', { class: 'muted', style: { fontSize: '12.5px', margin: '0' } },
                'Выберите карту, которую ОСТАВИТЬ. Визиты, счета, документы и назначения остальных перейдут к ней, а лишние карты будут удалены. Действие необратимо.'),
            rowsWrap),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            mergeBtn),
    ));
    document.body.appendChild(overlay);
}

function paintPager() {
    const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    // V3120_FIX — было «Page 1 of … · … patients» по-английски посреди русского экрана.
    refs.pagerLabel.textContent = trf('Страница {page} из {pages} · пациентов: {n}', { page: state.page, pages: totalPages, n: state.total });
    refs.totalEl.textContent = String(state.total);
    setDisabled(refs.prevBtn, state.page <= 1);
    setDisabled(refs.nextBtn, state.page >= totalPages);
}

function setDisabled(btn, disabled) {
    if (!btn) return;
    if (disabled) btn.setAttribute('disabled', '');
    else          btn.removeAttribute('disabled');
}

// -----------------------------------------------------------------------------
// ROW
// -----------------------------------------------------------------------------
// BRANCH_ORIGIN_V1 — «эта карта заведена в другом здании». Буква берётся из
// хранимой метки sync_origin (её ставит приём порции), а НЕ из буквы MRN: MRN
// говорит, где пациент заведён, и на визитах врал бы — пациент из «C», пришедший
// в «B», лечится здесь. У пациента эти два ответа совпадают, но правило одно на
// все списки, чтобы карточка и очередь не расходились в том, что считают чужим.
// shapePatient не переносит сырые колонки наверх, поэтому метка читается из _raw.
function branchTag(p) {
    const letter = originTag((p && p._raw) || p);
    if (!letter) return null;
    return h('span', { class: 'tag', style: { marginLeft: '8px', fontSize: '12.5px' } },
        trf('Филиал {letter}', { letter }));
}

// PATIENT_ROW_V2 — ДАТА ПО-ЧЕЛОВЕЧЕСКИ.
//
// Владелец: «date format is 2 may 2019». В реестре стояло сырое ISO
// (1994-11-15) — машинная запись, которую человек читает по слогам.
//
// Форматтер НЕ пишется заново: в приложении уже есть один общий и
// локале-зависимый — fmtDate (ui.js, DATE_FMT_V1), он же рисует даты в карточке
// пациента, в кассе и в документах. Имена месяцев он берёт у Intl по языку
// интерфейса, поэтому «2 мая 2019» по-русски, «2-may 2019» по-узбекски и
// «2 May 2019» по-английски получаются сами, без словаря месяцев в этом файле.
//
// Здесь у его ответа снимается только хвост, лишний в плотной таблице: русское
// « г.» и узбекская запятая перед годом. Тридцать строк на странице, и год —
// это год; сокращение экономит ширину в каждой из них, а порядок «день, месяц,
// год» и язык остаются те же, что во всём продукте.
function fmtDay(value) {
    const out = fmtDate(value);
    if (!out || out === '—') return '';
    return String(out).replace(/\s*г\.\s*$/, '').replace(/,\s*(\d{4})$/, ' $1');
}

// «Ничего не известно» пишется одинаково во всех ячейках строки: пустая ячейка
// и прочерк отличаются в реестре только тем, что прочерк ХОТЯ БЫ видно.
function noneCell(text) {
    return h('span', { class: 'pt-none' }, text);
}

function patientRow(p) {
    // DUP_MERGE_V1 — leading checkbox; only interactive in the Duplicates filter.
    const isDup = state.filter === 'duplicates';
    const cb = isDup ? h('input', { type: 'checkbox', checked: selectedDup.has(p.id),
        style: { cursor: 'pointer' },
        onclick: (e) => { e.stopPropagation(); },
        onchange: (e) => { if (e.currentTarget.checked) selectedDup.add(p.id); else selectedDup.delete(p.id); paintMergeBar(); syncHeadCb(); } }) : null;

    const fullName = `${p.lastName || ''} ${p.firstName || ''} ${p.middle || ''}`.trim();
    const sex = p.gender === 'M' ? 'М' : p.gender === 'F' ? 'Ж' : '';
    const phone = formatPhone(p.phone) || p.phone || '';
    const dob = fmtDay(p.dob);
    const last = fmtDay(p.lastVisit);
    const next = fmtDay(p.nextVisit);   // LAST_VISIT_TRUE_V1 — ближайшая запись
    const visits = Number(p.visitCount || 0);
    const registrar = registrarOf(p);

    // data-reveal — заявка на появление; ПРЯЧЕТ строку только motion.js и
    // только когда уже может показать (см. MOTION_REVEAL_V1). Атрибут в
    // разметке безвреден сам по себе: без JS он ничего не значит.
    return h('tr', { class: 'row-click', 'data-reveal': '', onclick: () => refs.onNavigate('patient-card', p), style: { cursor: 'pointer' } },
        h('td', { class: 'pt-dupcell', style: { textAlign: 'center' }, onclick: (e) => e.stopPropagation() }, cb || ''),
        // 1 — ЛИЧНОСТЬ одним блоком: аватар, имя со своими метками, а под ним
        // всё, чем человека опознают у стойки, — номер карты, пол, город.
        h('td', null,
            h('div', { class: 'pt-ident' },
                Avatar({ initials: p.initials, color: p.avColor, size: 'sm' }),   // REG_LIST_COMPACT_V1
                h('div', { class: 'pt-ident-txt' },
                    h('div', { class: 'pt-name' },
                        // title — полное ФИО: длинная фамилия обрезается
                        // многоточием, и обрезанное обязано быть прочитываемым.
                        h('span', { class: 'pt-nm', title: fullName || undefined }, fullName || '—'),
                        // TELEGRAM — значок у имени (PATIENT_ROW_V2) переехал в
                        // последнюю колонку строки: PATIENT_BOT_INVITE_V1.
                        duplicateIdSet.has(p.id) ? h('span', { class: 'tag tag-warn', style: { fontSize: '12.5px' }, title: 'Возможный дубликат — то же имя на том же телефоне (или общий ПИНФЛ). Откройте карточку для объединения.' }, 'Дубликат') : null,
                        // DEBT_FLOW_V1 — долг у имени, с суммой: у стойки это
                        // видят ДО того, как человек дойдёт до кассы.
                        debtOf(p) > 0
                            ? h('span', { class: 'tag tag-crit pt-debt', title: 'Есть неоплаченный долг по счетам — откройте карточку, вкладку «Счёт»' },
                                Icon('Wallet', { size: 11 }), ' ', tr('Долг'), ' ', h('b', { class: 'num' }, moneyDisplay(debtOf(p))))
                            : null,
                        // BRANCH_ORIGIN_V1 — регистр КЛИНИЧЕСКИЙ, а не пофилиальный: поиск
                        // обязан находить всех (PATIENTS_CLINIC_WIDE_V1), поэтому список не
                        // фильтруется — подписывается. Метка только на чужих: подпись на
                        // каждой строке перестала бы что-либо значить.
                        branchTag(p),
                    ),
                    h('div', { class: 'pt-meta' },
                        h('span', { class: 'num pt-mrn' }, p.mrn || '—'),
                        sex ? h('span', { class: 'pt-dot' }, '·') : null,
                        sex ? h('span', null, sex) : null,
                        p.city ? h('span', { class: 'pt-dot' }, '·') : null,
                        p.city ? h('span', { class: 'pt-city' }, p.city) : null,
                    ),
                ),
            ),
        ),
        // 2 — Дата рождения «2 мая 2019».
        // REG_LIST_AGE_COL_V1 (2026-10-31, владелец: «put age separte from year
        // of birth») — возраст ушёл из-под даты в соседнюю колонку: у стойки
        // его ищут глазами отдельно от даты, по которой сверяют паспорт.
        h('td', null, dob ? h('div', { class: 'pt-when-main' }, dob) : noneCell('—')),
        h('td', null, p.age != null ? h('div', { class: 'pt-when-main' }, trf('{n} лет', { n: p.age })) : noneCell('—')),
        // 3 — Телефон: тот же вид, что на карточке CRM (formatPhone), и его
        // можно ВЫДЕЛИТЬ мышью — номер из реестра диктуют и копируют. Клик по
        // номеру поэтому не открывает карту: выделение заканчивается кликом, и
        // строка увозила бы человека с экрана посреди копирования.
        h('td', null,
            phone
                ? h('span', { class: 'num pt-phone', onclick: (e) => e.stopPropagation() }, phone)
                : noneCell('—'),
        ),
        // 4 — Последний визит, под ним счёт визитов: число относится к этой же
        // дате, и стоять им врозь незачем.
        h('td', null,
            last ? h('div', { class: 'pt-when-main' }, last) : noneCell('—'),
            // LAST_VISIT_TRUE_V1 — будущая запись — не «последний визит»: она
            // стоит своей строкой под датой.
            next ? h('div', { class: 'pt-when-sub pt-when-next' }, trf('запись: {d}', { d: next })) : null,
            h('div', { class: 'pt-when-sub' }, visits > 0 ? trf('визитов: {n}', { n: visits }) : 'визитов не было'),
        ),
        // 5 — Баланс: депозит пациента, под ним — долг (V3120_FIX).
        h('td', { style: { textAlign: 'right' } }, balanceCell(p)),
        // 6 — Регистратор: настоящее имя того, кто завёл карту, а если его в
        // карте нет — так и сказано словом, а не прочерком, который на каждой
        // строке читается как «экран сломан».
        h('td', null,
            h('span', { class: 'reg-by' }, Icon('User', { size: 13 }),
                registrar ? h('span', { class: 'pt-reg-nm', title: registrar }, registrar) : noneCell('Не указан')),
        ),
        // 7 — action «Карточка»
        h('td', { onclick: (e) => e.stopPropagation() },
            // REG_LIST_ADAPT_V1 — подпись в своём span: на узкой карточке
            // остаётся одна иконка (admin-views.css), а имя кнопки — в title.
            h('button', { class: 'start-btn done', type: 'button', title: 'Карточка', 'aria-label': 'Карточка', onclick: () => refs.onNavigate('patient-card', p) },
                Icon('ID', { size: 14 }), h('span', { class: 'pt-act-lbl' }, 'Карточка')),
        ),
        // 8 — PATIENT_BOT_INVITE_V1: Telegram-бот пациента. Ячейка пустая, пока
        // не ответил patient_bot_status (loadBotStatus) — чтобы строка не
        // мигала «Ссылкой» у уже подключённого пациента.
        botCell(p),
    );
}

// Balance cell — Aurora BalanceCell port. v>0 green +, v<0 red −, v===0 «0 сум».
//
// V3120_FIX — ДВА ЧИСЛА, А НЕ ОДНО. patient_base_aggregates отдаёт `balance`
// (депозит — деньги пациента на счету клиники) и `debt` (неоплаченные счета
// без страховой). Одно знаковое число прятало долг: пациент с депозитом
// 500 000 и долгом 375 000 выглядел «+125 000», и регистратура не знала, что
// за ним долг. Сверху — депозит, под ним красным — долг, если он есть.
export function balanceCell(p) {
    const wallet = Number(p && p.balance) || 0;
    const debt = Number(p && p.debt) || 0;
    const rfmt = (x) => Math.abs(x).toLocaleString('ru-RU');
    const main = wallet > 0 ? h('span', { class: 'bal pos num', title: tr('Депозит пациента') }, `+${rfmt(wallet)}`)
        : wallet < 0 ? h('span', { class: 'bal neg num' }, `−${rfmt(wallet)}`)
        : h('span', { class: 'bal zero num' }, '0 ', h('small', null, 'сум'));
    if (!(debt > 0)) return main;
    return h('div', null, main,
        h('div', { class: 'bal neg num pt-bal-debt', title: tr('Неоплаченные счета пациента (без страховой)') },
            trf('долг {sum}', { sum: rfmt(debt) })));
}

function displayStatus(p) {
    if (p.status === 'inpatient') return 'inpatient';
    return 'active';
}

