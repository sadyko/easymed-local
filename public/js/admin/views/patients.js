// Patients list — server-side pagination (30 per page) and server-side
// search. The page never pulls the whole register into the browser; each
// filter / sort / page / keystroke fires a fresh PostgREST query.

import { h, Icon, Avatar, Tag, StatusTag, PageHead, toast, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { registrarHeader } from './registrar-header.js?v=roleaud1';
import { loadPatientsPaged, findAllDuplicatePatientIds, mergePatients } from '../data.js';   // DUP_MERGE_V1
import { scopedDoctorId } from '../permissions.js';
import { originTag } from '../record-origin.js';   // BRANCH_ORIGIN_V1 — откуда запись
import { branchSyncButton } from './branch-sync-button.js';   // BRANCH_SYNC_HOURLY_V1
import { openServicePickerModal } from './service-picker-modal.js?v=aug17e';
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

const FILTER_LABELS = {
    all:         { label: 'All patients', color: 'var(--ink-700)',  icon: 'Patients' },
    active:      { label: 'Active',       color: 'var(--ok-700)',   icon: 'Heart'    },
    inpatient:   { label: 'Inpatient',    color: 'var(--info-700)', icon: 'Bed'      },
    duplicates:  { label: 'Duplicates',   color: 'var(--warn-700)', icon: 'Warning'  },
};

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
    dob: '',        // PATIENT_SEARCH_DOB_V1
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
    dobInp: null,   // PATIENT_SEARCH_DOB_V1
    emptyEl:   null,
    pagerLabel:null,
    prevBtn:   null,
    nextBtn:   null,
    totalEl:   null,
    filterButtons: {},
    sortButtons:   {},
    lastRows:  [],
};

export async function renderPatients(container, { onNavigate, embedded = false }) {
    state.filter = 'all';
    state.search = '';
    state.dob = '';
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

// MOTION_SCROLL_V1 — смена страницы списка: сначала везём к началу карточки,
// потом читаем. Прокрутка плавная в браузере и мгновенная, если пользователь
// просил «меньше движения» (motion.js спрашивает эту настройку за нас).
function goPage() {
    smoothScrollTo(refs.listCard || refs.container, { block: 'start' });
    return fetchAndPaint();
}

function mount() {
    clear(refs.container);

    refs.tbody = h('tbody');
    refs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        'Пациент не найден. ',
        h('button', { class: 'link-btn', type: 'button', onclick: () => openCreatePatient() }, 'Создать нового пациента?'),
    );
    refs.pagerLabel = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    refs.totalEl = h('span', { class: 'cell-strong' }, '0');

    refs.searchInp = h('input', {
        type: 'search',
        autocomplete: 'off',
        style: { width: '100%', height: '34px', padding: '0 12px 0 34px', borderRadius: '8px', border: '1px solid var(--ink-200)', fontSize: '13.5px' },
        placeholder: 'Поиск пациента по ФИО, ID или номеру телефона…',
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

    // PATIENT_SEARCH_DOB_V1 — отдельное поле даты рождения рядом с поиском.
    // Тёзок в регистратуре много, и на стойке их различают именно датой; искать
    // её внутри той же строки нельзя — «1990» это ещё и кусок номера телефона.
    // Пустое поле фильтр снимает, поэтому очистка возвращает весь список.
    refs.dobInp = h('input', {
        type: 'date',
        title: 'Поиск по дате рождения',
        style: { height: '34px', padding: '0 10px', borderRadius: '8px', border: '1px solid var(--ink-200)', fontSize: '13.5px', fontFamily: 'inherit', color: 'var(--ink-700)' },
    });
    refs.dobInp.addEventListener('change', () => {
        state.dob = refs.dobInp.value;
        state.page = 1;
        fetchAndPaint();
    });

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
        sortBtn('recent', 'Sort: Recent'),
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
    const admitBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-act': 'admission',
        title: 'Заявка на госпитализацию — пациент выбирается в окне заявки',
        onclick: () => import('./admission-modal.js?v=inp2').then((m) => m.openAdmissionOrderModal({})) },
        Icon('Bed', { size: 14 }), ' Госпитализация');
    // ONBOARDING_TARGET_V1 — за эту кнопку цепляется подсказка «заведите
    // первого пациента» (admin/onboarding.js). Раньше она целилась в призывную
    // кнопку меню, а меню её лишилось (NO_TABS_APPBAR_V1) — подсказка молча
    // перестала показываться. Метка нужна именно как метка: класс у кнопки
    // общий с десятками других, и селектор по нему нашёл бы не ту.
    const createBtn = h('button', { class: 'btn btn-primary btn-sm', 'data-onb': 'create-patient',
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
        refs.listCard = h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('div', { class: 'row', style: { gap: '10px', flex: '1' } },
                    h('div', { style: { position: 'relative', maxWidth: '380px', flex: '1' } },
                        h('span', { style: { position: 'absolute', left: '12px', top: '11px', color: 'var(--ink-400)' } },
                            Icon('Search', { size: 14 })),
                        refs.searchInp,
                    ),
                    refs.dobInp,   // PATIENT_SEARCH_DOB_V1
                    sortSegmented,
                ),
                h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                    h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Всего ', refs.totalEl),
                    dupChip, calcBtn, admitBtn,
                    // BRANCH_SYNC_HOURLY_V1 — сама покажется, только если это
                    // подключённый филиал. onDone перечитывает список: карта,
                    // заведённая в соседнем здании, уже в базе, но на экране
                    // её ещё нет.
                    branchSyncButton({ onDone: () => fetchAndPaint() }),
                    createBtn,
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
            h('table', { class: 'tbl reg-base-tbl' },
                h('thead', null, h('tr', null,
                    h('th', { style: { width: '34px', textAlign: 'center' }, 'data-dupcol': '' }, dupHeadCb),   // DUP_MERGE_V1
                    h('th', null, 'Пациент'),
                    h('th', null, 'Дата рожд. / возраст'),
                    h('th', { style: { textAlign: 'center' } }, 'Пол'),
                    h('th', null, 'Телефон'),
                    // REG_TBL_FIT_V2 — «Телеграм» и «Есть ДМС?» убраны: обе
                    // колонки занимали ширину, но ничего не сообщали. Телеграм
                    // показывал «Не подключён» у всех (интеграции в локальной
                    // сборке нет), ДМС — «—», потому что страховая в постраничный
                    // список не джойнится. Полис виден в карточке пациента.
                    h('th', null, 'Последний визит'),
                    h('th', { style: { textAlign: 'center' } }, 'Визитов'),
                    h('th', { style: { textAlign: 'right' } }, 'Баланс'),
                    h('th', null, 'Регистратор'),
                    h('th', { style: { width: '104px' } }),
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
        dob:      state.dob,   // PATIENT_SEARCH_DOB_V1
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

    state.total    = result.total;
    refs.lastRows  = result.rows;
    paintRows(result.rows);
    paintPager();
}

function setLoadingRow() {
    if (!refs.tbody) return;
    clear(refs.tbody);
    refs.tbody.appendChild(h('tr', null,
        // REG_TBL_FIT_V2 — 10 колонок после удаления «Телеграм» и «Есть ДМС?».
        h('td', { colspan: '10', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка…'),
    ));
    refs.emptyEl.style.display = 'none';
}

function paintRows(rows) {
    clear(refs.tbody);
    if (rows.length === 0) {
        refs.emptyEl.style.display = '';
        return;
    }
    refs.emptyEl.style.display = 'none';
    for (const p of rows) refs.tbody.appendChild(patientRow(p));
    // Один наблюдатель на ВСЮ таблицу, а не по одному на строку; повторный
    // вызов (буква в поиске, смена страницы) снимает предыдущий сам.
    // lift: false — строку таблицы поднимать нельзя, transform на <tr>
    // дрожит на линейках; строке хватает прозрачности.
    revealOn(refs.tbody, '[data-reveal]', { lift: false });
    syncHeadCb();
    paintMergeBar();
}

// DUP_MERGE_V1 — reflect selection count in the bar; toggle the whole strip.
function paintMergeBar() {
    // keep only ids still present as duplicates
    for (const id of [...selectedDup]) if (!duplicateIdSet.has(id)) selectedDup.delete(id);
    if (refs.mergeCount) refs.mergeCount.textContent = String(selectedDup.size);
    if (refs.mergeBar) refs.mergeBar.style.display = selectedDup.size >= 2 ? 'flex' : 'none';
    if (refs.dupHeadCb) refs.dupHeadCb.style.display = state.filter === 'duplicates' ? '' : 'none';
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
    const byBest = [...chosen].sort((a, b) =>
        (b.visitCount || 0) - (a.visitCount || 0) || String(a.mrn || '').localeCompare(String(b.mrn || '')));
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
            toast(trf('Не удалось объединить: {msg}', { msg: (e && e.message) || e }), 'fail');
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
    refs.pagerLabel.textContent = `Page ${state.page} of ${totalPages} · ${state.total} patient${state.total === 1 ? '' : 's'}`;
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

function patientRow(p) {
    // DUP_MERGE_V1 — leading checkbox; only interactive in the Duplicates filter.
    const isDup = state.filter === 'duplicates';
    const cb = isDup ? h('input', { type: 'checkbox', checked: selectedDup.has(p.id),
        style: { cursor: 'pointer' },
        onclick: (e) => { e.stopPropagation(); },
        onchange: (e) => { if (e.currentTarget.checked) selectedDup.add(p.id); else selectedDup.delete(p.id); paintMergeBar(); syncHeadCb(); } }) : null;
    // data-reveal — заявка на появление; ПРЯЧЕТ строку только motion.js и
    // только когда уже может показать (см. MOTION_REVEAL_V1). Атрибут в
    // разметке безвреден сам по себе: без JS он ничего не значит.
    return h('tr', { class: 'row-click', 'data-reveal': '', onclick: () => refs.onNavigate('patient-card', p), style: { cursor: 'pointer' } },
        h('td', { style: { textAlign: 'center' }, onclick: (e) => e.stopPropagation() }, cb || ''),
        // 1 — Пациент: avatar + inline ID/MRN + ФИО
        h('td', null,
            h('div', { class: 'row', style: { gap: '11px' } },
                Avatar({ initials: p.initials, color: p.avColor }),
                h('div', { style: { minWidth: 0 } },
                    h('div', { class: 'cell-strong' },
                        h('span', { class: 'num', style: { color: 'var(--ink-400)', marginRight: '6px' } }, p.mrn || '—'),
                        `${p.lastName} ${p.firstName} ${p.middle || ''}`.trim(),
                        duplicateIdSet.has(p.id) ? h('span', { class: 'tag tag-warn', style: { marginLeft: '8px', fontSize: '12.5px' }, title: 'Возможный дубликат — то же имя на том же телефоне (или общий ПИНФЛ). Откройте карточку для объединения.' }, 'Дубликат') : null,
                        // BRANCH_ORIGIN_V1 — регистр КЛИНИЧЕСКИЙ, а не пофилиальный: поиск
                        // обязан находить всех (PATIENTS_CLINIC_WIDE_V1), поэтому список не
                        // фильтруется — подписывается. Метка только на чужих: подпись на
                        // каждой строке перестала бы что-либо значить.
                        branchTag(p),
                    ),
                    p.city
                        ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '1px' } }, p.city)
                        : null,
                ),
            ),
        ),
        // 2 — Дата рожд. / возраст
        h('td', null,
            h('div', { class: 'num', style: { fontSize: '12.5px' } }, p.dob || '—'),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, p.age != null ? trf('{n} лет', { n: p.age }) : '—'),
        ),
        // 3 — Пол
        h('td', { style: { textAlign: 'center' } },
            h('span', { class: 'tag' }, p.gender === 'M' ? 'М' : p.gender === 'F' ? 'Ж' : (p.gender || '—')),
        ),
        // 4 — Телефон
        h('td', { class: 'num', style: { fontSize: '12.5px' } }, p.phone || '—'),
        // REG_TBL_FIT_V2 — «Телеграм» и «Есть ДМС?» удалены вместе с заголовками
        // (см. комментарий в шапке таблицы). Порядок ячеек обязан совпадать с
        // порядком <th>, поэтому обе строки убираются одной правкой.
        // 5 — Последний визит
        h('td', { class: 'num muted', style: { fontSize: '12.5px' } }, p.lastVisit || '—'),
        // 6 — Визитов
        h('td', { class: 'num', style: { textAlign: 'center', fontWeight: '700' } }, String(p.visitCount ?? 0)),
        // 7 — Баланс  (real balance not joined → zero-state «0 сум», never a fake ±)
        h('td', { style: { textAlign: 'right' } }, balanceCell(p.balance)),
        // 8 — Регистратор
        h('td', null,
            h('span', { class: 'reg-by' }, Icon('User', { size: 13 }), p.registrar || '—'),
        ),
        // 9 — action «Карточка»
        h('td', { onclick: (e) => e.stopPropagation() },
            h('button', { class: 'start-btn done', type: 'button', onclick: () => refs.onNavigate('patient-card', p) },
                Icon('ID', { size: 14 }), 'Карточка'),
        ),
    );
}

// Balance cell — Aurora BalanceCell port. v>0 green +, v<0 red −, v===0 «0 сум».
// In B1 the paged list never joins invoices, so balance is always 0 (zero-state).
// We keep the ± branches so the cell lights up correctly once invoices land.
function balanceCell(v) {
    const n = Number(v) || 0;
    const rfmt = (x) => Math.abs(x).toLocaleString('ru-RU');
    if (n > 0) return h('span', { class: 'bal pos num' }, `+${rfmt(n)}`);
    if (n < 0) return h('span', { class: 'bal neg num' }, `−${rfmt(n)}`);
    return h('span', { class: 'bal zero num' }, '0 ', h('small', null, 'сум'));
}

function displayStatus(p) {
    if (p.status === 'inpatient') return 'inpatient';
    return 'active';
}

