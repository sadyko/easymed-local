// FAST_REG_ONE_SCREEN_V1 (2026-09-19) — «БЫСТРАЯ РЕГИСТРАЦИЯ» ОДНИМ ОКНОМ.
// docs/plans/2026-09-19-fast-registration-one-screen.md
//
// Что было. Кнопка «Быстрая регистрация» открывала окно заведения пациента, а
// после сохранения — ВТОРОЕ окно, мастер услуг. Между ними карта успевала
// создаться, и регистратор, закрывший второе окно, оставлял пациента без
// визита: с виду он «зарегистрирован», а услуг, врача и счёта у него нет.
//
// Что стало. Одно окно и одна кнопка «Сохранить»: реквизиты пациента сверху,
// таблица услуг с врачом снизу, счёт и номера очереди — одним нажатием. Пока
// нажатие не сделано, не создано НИЧЕГО; после него есть и карта, и визит, и
// счёт. Промежуточного состояния «полпациента» больше нет.
//
// ПОЛЯ ПАЦИЕНТА ЗДЕСЬ НЕ СВОИ. Их рисует buildPatientFields (PATIENT_FIELDS_V1,
// views/patient-create-modal.js) — те же контролы, те же обязательные поля, та
// же проверка. Второй набор полей разошёлся бы с первым МОЛЧА.
//
// FAST_REG_COMPACT_V1 (2026-09-19) — НО НАБОР ЗДЕСЬ КОРОЧЕ, И ЭТО РЕШЕНИЕ.
// Владелец: «смысл быстрой регистрации в том, чтобы в окне было только
// необходимое, как на образце, а вы добавили паспорта, географию и прочее, что
// для быстрой не нужно». Поэтому сборщик зовётся компактной раскладкой
// (layout: 'compact') — ОДИН раздел «Реквизиты пациента» ровно с полями
// образца: ФИО, дата рождения, пол, телефон, паспортные данные, резидентство,
// область, адрес, код отправителя, тип скидки. Всё остальное — ПИНФЛ, язык,
// гражданство, почта, район, махалля, здоровье — работа КАРТЫ пациента, и
// живёт в полной раскладке того же сборщика.
//
// FAST_REG_LAYOUT_V1 (2026-09-20) — И ОКНО ТЕПЕРЬ ВО ВСЮ ШИРИНУ.
// Владелец: «the dialogue window is small and text is small, can you redesign
// the fast registration dialog window so it fits content». Образец — страница
// во всю ширину: блок «Реквизиты пациента» с «Сохранить» в его же шапке
// справа, форма «подпись слева — поле справа» по две пары в строке, ниже
// таблица услуг с «Печать / +Пакеты / +Услуги» в её шапке. Раскладка живёт в
// .fr-card/.fr-form (admin-views.css), подвал окна оставлен уходу: «Отмена»
// до записи, «Открыть карту» и «Закрыть» после.
//
// ЦЕПОЧКА СОХРАНЕНИЯ ТОЖЕ НЕ СВОЯ. Визит → строки → счёт → очередь ведёт
// registerWalkIn (WALK_IN_BOOKING_V1, views/walk-in-booking.js) — та же
// последовательность, что у мастера визита, без единого обращения к DOM.
//
// А ВОТ СОХРАНЕНИЕ ПАЦИЕНТА — СВОЁ, И ЭТО РЕШЕНИЕ. api.save() сборщика на
// «Открыть существующего» в диалоге дубликата ЗАКРЫВАЕТ окно и уходит в карту
// пациента: для формы заведения это правильно, а здесь это потеря уже набранной
// таблицы услуг. В этом окне «Открыть существующего» значит «записать услуги на
// НЕГО», поэтому savePatient() зовётся здесь напрямую, а диалог дубликата
// (openDuplicatePatientDialog — тот же самый) получает свои обработчики.
// Сборщик при этом НЕ ТРОНУТ: у формы заведения поведение прежнее.

import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { supabase } from '../../supabase.js';
import { savePatient, loadPatientById, currentUser } from '../data.js';
// PATIENT_CREATE_GATE_V1 — тот же ключ и тот же видимый отказ, что у формы
// заведения: окно, открывающееся в обход права, — это дыра, а молчащая кнопка
// читается как поломка.
import { canCreatePatient } from '../permissions.js';
import { openAccessDeniedDialog } from '../access-denied.js';
import { fadeOutAndRemove } from '../motion.js?v=mo1';   // MOTION_DIALOG_V1
// MODULE_INSTANCE_V1 — строка запроса ТА ЖЕ, что у картотеки и регистрации
// (?v=onewin1). Для браузера адрес с другим ?v это ДРУГОЙ модуль: вторая копия
// сборщика со своим состоянием (PATIENT_PHOTO_V1 — снимок с веб-камеры ждёт
// сохранения в модуле, а не в окне). Расхождение ничем не видно, кроме
// потерянного снимка, — поэтому оно закреплено проверкой на исходнике.
import { buildPatientFields, openDuplicatePatientDialog, runPatientSearch, uploadPendingPhoto } from './patient-create-modal.js?v=onewin1';
import { openTemplatePickerModal } from './template-picker-modal.js?v=tpl1';   // TEMPLATE_PICKER_V1
import { resolveTemplate } from './service-templates.js?v=tpl1';               // WIZ_TEMPLATES_LOCAL_V1
import { registerWalkIn, walkInRoleRefusal } from './walk-in-booking.js?v=wib1';   // WALK_IN_BOOKING_V1
import { doctorPoolFor } from './doctor-pool.js?v=dp1';                        // DOCTOR_POOL_V1
import { searchableSelect } from './searchable-select.js?v=ss2';               // SEARCHABLE_SELECT_V1
import { referralSourceLabel } from '../../shared/referral-label.js?v=rl1';    // REFERRAL_SOURCE_CODE_V1
import { printableSheet } from './doc-settings.js?v=noqr1';                    // WIZ_INVOICE_PRINT_V1 — тот же бланк «Счёт»
import { closeCrmLinesForPatient } from '../crm-lines.js';                     // CRM_LINKS_V1
import { localYmd } from '../discount-rules.js';                               // CRM_LINKS_V1 — местная дата «сегодня», как у строк заявки

/** Разряды тысяч пробелом — так цену читают во всех экранах продукта. */
function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? '-' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * VAT_INCLUSIVE_V1 — цена каталога уже С НДС, поэтому «Сумма» это цена БЕЗ
 * него, а не наоборот. Та же арифметика, что в выгрузке услуг в Excel; счёт
 * от этого не меняется — столбец показывает, из чего цена сложена.
 */
function netOfVat(price, taxRate) {
    const p = Number(price) || 0;
    const t = Number(taxRate) || 0;
    if (!t) return p;
    return Math.round((p / (1 + t / 100)) * 100) / 100;
}

/** Имя пациента, как его отдают ОБА источника: savePatient (fullName) и строка базы. */
function nameOf(p) {
    if (!p) return '';
    return p.fullName
        || p.full_name
        || [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' ').trim()
        || '';
}

/**
 * FAST_REG_ONE_SCREEN_V1 — окно «Быстрая регистрация».
 * @param {{onNavigate?:Function, onSaved?:Function}} [opts]
 * @returns {{overlay, card, body, close, state, fields, collect, saveBtn, printBtn}|null}
 */
export function openFastRegistrationDialog({ onNavigate, onSaved } = {}) {
    if (!canCreatePatient()) { openAccessDeniedDialog(); return null; }

    const navigate = typeof onNavigate === 'function' ? onNavigate : () => {};
    const notifySaved = typeof onSaved === 'function' ? onSaved : () => {};

    // ЭТАЖ ОКНА. Оно открывает поверх себя каталог услуг (130), стража
    // дубликатов и предпросмотр печати (160), выбор пакета (180) — и все они
    // такие же подложки на весь экран, соседи в document.body. Кто выше,
    // решает ТОЛЬКО z-index: окно выше каталога — и «+Услуги» открывается за
    // ним, то есть выглядит как неработающая кнопка. Поэтому 120: выше
    // страничных модалок (100) и ниже каждого своего ребёнка.
    const overlay = h('div', { class: 'modal', style: { zIndex: '120' } });
    /** Снять окно с экрана. Своё решение окна — оно и знает, что запись дошла. */
    const dismiss = () => { document.removeEventListener('keydown', onKey); fadeOutAndRemove(overlay); };
    /**
     * Закрытие ПО ЖЕЛАНИЮ ЧЕЛОВЕКА: Esc, щелчок мимо, «Отмена», крестик.
     *
     * Пока идёт запись, оно не срабатывает: между нажатием и ответом сервера
     * окно — единственное место, где известно, что именно записывается.
     * Закрытие цепочку не остановит (она уже в пути), и визит со счётом
     * появились бы молча — без номера счёта, без номеров очереди, без печати.
     */
    const close = () => { if (state.saving) return; dismiss(); };

    /**
     * Стоит ли поверх этого окна ЧУЖОЙ диалог.
     *
     * Окно открывает поверх себя ещё три: выбор пакета («+Пакеты»), каталог
     * услуг («+Услуги») и стража дубликатов. У каждого свой Escape, и слушают
     * они один и тот же document — значит нажатие достаётся ОБОИМ. Без этой
     * проверки Esc, закрывающий выбор пакета, заодно сносил бы и само окно
     * регистрации вместе с набранной таблицей услуг и заполненными полями.
     *
     * Ищем не по имени: у каталога услуг нет data-dialog вовсе, а у стража
     * дубликатов оно стоит на карточке, а не на подложке. Общее у всех троих
     * одно — своя подложка .modal в document.body. Перечень имён разошёлся бы с
     * жизнью при первом же четвёртом диалоге; «есть чужая подложка» — нет.
     */
    function childDialogOpen() {
        const kids = (typeof document !== 'undefined' && document.body && document.body.children) || [];
        for (const el of kids) {
            if (!el || el === overlay) continue;
            if (String(el.className || '').split(/\s+/).includes('modal')) return true;
        }
        return false;
    }

    const onKey = (e) => { if (e.key === 'Escape' && !childDialogOpen()) close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // FAST_REG_LAYOUT_V1 — ширину, высоту и раскладку тела задаёт .fr-card
    // (admin-views.css), а не встроенный стиль: окно во всю доступную ширину.
    //
    // Что ушло и почему. .mg-dense — раскладка «подпись над полем», ужатая до
    // 32 px, чтобы четыре ряда по три поля влезли в 1240 px; теперь подпись
    // стоит СЛЕВА, строка стоит одну высоту, и ужимать нечего. .modal-grouped
    // задавал ширину 760 px и своё тело; .modal-compact с MODAL_FITS_CONTENT_V1
    // не значит ничего (это умолчание); .pc-form — оформление формы заведения.
    const card = h('div', {
        class: 'modal-card fr-card',
        'data-dialog': 'fast-registration',
    });
    overlay.appendChild(card);
    const body = h('div', { class: 'modal-body' });

    // ── состояние окна ────────────────────────────────────────────────────
    // rows: [{ service, doctorId, sel }] — sel нужен, чтобы отказ «выберите
    // врача» ставил курсор в ТУ САМУЮ строку, а не заставлял искать её глазами.
    const state = {
        patient: null,      // выбранный/созданный пациент — второй раз не создаём
        rows: [],
        catalog: [],
        doctors: [],
        sources: [],
        result: null,       // { visit, invoice, items, queue, lines } после записи
        saving: false,
        // Визит заведён, а счёт — нет: цепочка сломалась посередине. Повтор в
        // этом состоянии допишет строки в тот же визит дня, поэтому «Сохранить»
        // больше нет (см. toStalledState).
        stalled: false,
        addLine, applyTemplate, removeLine,
    };
    // Была ли карта заведена ЗДЕСЬ. Для найденного пациента без услуг «Пациент
    // сохранён» — неправда: его карту никто не трогал.
    let patientCreatedHere = false;
    /** Записывать больше нельзя: либо всё записано, либо визит уже заведён без счёта. */
    const locked = () => !!state.result || !!state.stalled;

    // ── шапка ─────────────────────────────────────────────────────────────
    const headHint = h('span', { class: 'mg-hint', style: { marginLeft: '12px' } },
        'Пациент → услуги и врач → счёт → печать');
    card.appendChild(h('header', { class: 'modal-head' },
        h('h2', null, Icon('Rocket', { size: 16 }), ' ', tr('Быстрая регистрация')),
        headHint,
        h('span', { class: 'grow' }),
        h('button', { class: 'modal-close', onclick: close }, '×'),
    ));
    card.appendChild(body);

    // ── строка поиска существующего пациента ──────────────────────────────
    // Своя, а не сборщика: у сборщика выбор найденного УВОДИТ в карту пациента
    // (это его работа — форма заведения там и заканчивается). Здесь выбор
    // значит «этому человеку и записываем услуги», окно остаётся открытым.
    const searchInput = h('input', {
        type: 'search', autocomplete: 'off', class: 'mg-search-input',
        placeholder: 'Поиск по ФИО, MRN, телефону или ПИНФЛ…',
    });
    const searchResults = h('div', { class: 'mg-search-results', style: { display: 'none' } });
    searchInput.addEventListener('input', () => {
        runPatientSearch(searchInput.value, searchResults, (p) => usePatient(p, { load: true }));
    });
    const searchEl = h('div', { class: 'mg-section span-full mg-search' },
        h('div', { class: 'field' },
            h('label', null, tr('Найти существующего пациента'), ' ',
                h('span', { class: 'muted', style: { fontWeight: '400' } },
                    tr('— выберите его, и услуги запишутся на эту карту'))),
            h('div', { class: 'mg-search-box' },
                h('span', { class: 'mg-search-ic' }, Icon('Search', { size: 15 })),
                searchInput, searchResults)));

    // Плашка выбранного пациента: пока она видна, поля заперты — карта уже есть,
    // и править её из окна регистрации значило бы тихо менять чужие данные.
    const pickedName = h('span', { class: 'cell-strong', style: { fontSize: '13.5px' } }, '');
    const changeBtn = h('button', {
        class: 'link-btn', type: 'button',
        onclick: () => { if (!locked()) usePatient(null); },
    }, tr('Сменить'));
    // FAST_REG_LAYOUT_V1 — .fr-picked раскладывает плашку в строку. Раньше
    // здесь стояли встроенные flexDirection/alignItems/gap, но .mg-section это
    // БЛОК: ни одно из трёх правил не действовало, и «Сменить» просто липла к
    // имени вместо правого края.
    const pickedBar = h('div', {
        class: 'mg-section fr-picked',
        style: { display: 'none' },
    }, Icon('Patients', { size: 15 }), pickedName, h('span', { class: 'grow' }), changeBtn);

    // ── блок 1: реквизиты пациента (поля сборщика) ────────────────────────
    // FAST_REG_COMPACT_V1 — компактная раскладка сборщика: ОДНА форма ровно с
    // полями образца владельца. Раньше сюда брали три раздела карты пациента,
    // и в быстрое окно приезжали ПИНФЛ, язык, гражданство, район, махалля и
    // почта — владелец: «в быстрой регистрации должно быть только необходимое».
    //
    // «Код отправителя» уходит ВНУТРЬ той же формы — рядом перед «Типом
    // скидки», как на образце. Строит его окно, потому что это поле ВИЗИТА:
    // карта пациента о направлении не знает и в patients его не пишут.
    const referralSel = h('select', { name: '__referral_source' },
        h('option', { value: '' }, '— Без направления —'));
    const referralWrap = searchableSelect(referralSel, { placeholder: 'Номер или имя…' });
    // FAST_REG_LAYOUT_V1 — своё имя обёртке: searchableSelect рисует поле
    // ВСТРОЕННЫМ стилем (40 px, 13.5 px), и подогнать его под соседей по
    // строке можно только правилом с пометкой (.fr-ctl .fr-ref > input).
    referralWrap.className = 'fr-ref';
    // data-keep-enabled — метка для setPatientFormEnabled: поле стоит среди
    // полей карты, но запирается НЕ с ними (см. там же).
    referralWrap.dataset.keepEnabled = '1';

    const patientBox = h('div');
    const api = buildPatientFields(patientBox, {
        layout: 'compact',               // FAST_REG_COMPACT_V1 — только реквизиты образца
        withSearchStrip: false,          // строка поиска у окна своя, см. выше
        extraRows: [{ label: 'Код отправителя (лечащий врач)', control: referralWrap, span: true }],
        onNavigate: navigate,
        close: () => {},                 // окно закрывает себя само
    });

    // ── блок 2: услуги ────────────────────────────────────────────────────
    const countEl = h('span', { class: 'h-count' }, '0');
    const addServicesBtn = h('button', {
        class: 'btn btn-sm btn-outline', type: 'button', onclick: openServicePicker,
    }, Icon('Plus', { size: 13 }), ' ', tr('+Услуги'));
    const addPackagesBtn = h('button', {
        class: 'btn btn-sm btn-outline', type: 'button', onclick: openPackagePicker,
    }, Icon('Copy', { size: 13 }), ' ', tr('+Пакеты'));
    const printBtn = h('button', {
        class: 'btn btn-sm btn-outline', type: 'button', disabled: true, onclick: printInvoice,
    }, Icon('Print', { size: 13 }), ' ', tr('Печать'));
    // FAST_REG_LAYOUT_V1 — .fr-table поднимает строки таблицы до 15 px: на
    // образце услуги читаются с того же расстояния, что и поля формы.
    const table = h('table', { class: 'tbl fr-table' });
    // Скидка категории пациента применяется сервером при выставлении счёта, и
    // до него её суммы не существует. После — она стоит под таблицей строкой:
    // «Итого» это уже сумма счёта, и без этой строки разница между ней и
    // ценами строк выглядела бы ошибкой сложения.
    const discountLine = h('div', {
        class: 'muted',
        style: { display: 'none', padding: '8px 14px 10px', fontSize: '12.5px', textAlign: 'right' },
    });
    // FAST_REG_LAYOUT_V1 — порядок кнопок с образца: «Печать», «+Пакеты»,
    // «+Услуги». Главное действие блока стоит у самого края, как «Сохранить» в
    // шапке блока реквизитов.
    const servicesBlock = h('div', { class: 'fr-block' },
        h('div', { class: 'card-header fr-block-head' },
            h('h3', null, Icon('Receipt', { size: 14 }), ' ', tr('Услуги'), ' ', countEl),
            h('span', { class: 'grow' }),
            printBtn, addPackagesBtn, addServicesBtn),
        table, discountLine);

    // ── главное действие: «Сохранить» В ШАПКЕ БЛОКА РЕКВИЗИТОВ ─────────────
    // На образце владельца «Сохранить» стоит справа в шапке карточки
    // «Реквизиты пациента», а не в подвале окна: окно теперь во всю ширину и
    // во всю высоту, и кнопка в подвале уезжала бы за нижний край формы —
    // регистратор искал бы её прокруткой. Поведение кнопки прежнее: во время
    // записи выключена, после записи спрятана и выключена (Enter по спрятанной,
    // но живой кнопке всё ещё срабатывает).
    const cancelBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: close }, tr('Отмена'));
    const saveBtn = h('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: () => { void doSave(); },
    }, Icon('Check', { size: 14 }), ' ', tr('Сохранить'));
    // Номера карты и счёта после записи — здесь же, над формой, к которой они
    // относятся (раньше стояли строкой в шапке окна).
    const patientInfo = h('span', { class: 'fr-block-info' }, '');
    const patientBlock = h('div', { class: 'fr-block' },
        h('div', { class: 'card-header fr-block-head' },
            h('h3', null, Icon('Patients', { size: 14 }), ' ', tr('Реквизиты пациента')),
            patientInfo,
            h('span', { class: 'grow' }),
            saveBtn),
        searchEl, pickedBar, patientBox);
    body.appendChild(patientBlock);
    body.appendChild(servicesBlock);

    // ── подвал ────────────────────────────────────────────────────────────
    // Здесь остаётся только уход: «Отмена» до записи, «Открыть карту» и
    // «Закрыть» после неё. Главное действие уехало в шапку блока реквизитов.
    const openCardBtn = h('button', {
        class: 'btn btn-outline', type: 'button', style: { display: 'none' },
        onclick: async () => {
            const p = state.patient;
            if (!p || !p.id) return;
            const full = await loadPatientById(p.id).catch(() => null);
            close();
            navigate('patient-card', full || p);
        },
    }, Icon('Patients', { size: 14 }), ' ', tr('Открыть карту'));
    const doneBtn = h('button', {
        class: 'btn btn-primary', type: 'button', style: { display: 'none' }, onclick: close,
    }, Icon('Check', { size: 14 }), ' ', tr('Закрыть'));
    const footHint = h('span', { class: 'mg-hint' }, h('kbd', null, 'Enter'), ' ', tr('— сохранить и записать услуги'));
    card.appendChild(h('footer', { class: 'modal-foot' },
        footHint, h('span', { class: 'grow' }), cancelBtn, openCardBtn, doneBtn));

    // PATIENT_FORM_FLOW_V1 — Enter нажимает ГЛАВНОЕ действие окна. Пропускаем
    // там, где Enter уже занят и значит другое: перенос строки в <textarea>,
    // нажатие самой кнопки/ссылки, выбор строки в открытом списке и строка
    // поиска дубликатов (сохранять оттуда значило бы заводить второго такого же
    // ровно в тот миг, когда регистратор проверяет, нет ли первого).
    card.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.isComposing || e.keyCode === 229) return;
        const t = e.target;
        const tag = ((t && t.tagName) || '').toLowerCase();
        if (tag === 'textarea' || tag === 'button' || tag === 'a') return;
        if (t && t.closest && t.closest('.mg-search')) return;
        if (typeof document !== 'undefined' && document.querySelector
            && document.querySelector('.uisel-pop, .uidate-pop')) return;
        // ...и пока поверх стоит ЧУЖОЙ диалог — по той же причине, что и Esc
        // (см. childDialogOpen). Стража дубликатов открыт как раз в тот миг,
        // когда вопрос «не второй ли это такой же человек» ещё не решён: Enter
        // из живого поля формы прошёл бы мимо него и запустил сохранение
        // ЗАНОВО — второй проход цепочки и второй диалог поверх первого.
        if (childDialogOpen()) return;
        e.preventDefault();
        if (saveBtn.disabled || locked()) return;
        saveBtn.click();
    });

    // =======================================================================
    // Таблица услуг
    // =======================================================================
    /**
     * ЦЕНА СТРОКИ ПОСЛЕ СОХРАНЕНИЯ — ТА, ПО КОТОРОЙ ВЫСТАВЛЕН СЧЁТ.
     *
     * До нажатия другой цены нет: показываем каталог. После нажатия цена
     * известна точно — тариф визита вернул её построчно (первичный/повторный
     * приём), и именно она легла в visit_services. Оставить на экране каталог
     * значило бы называть пациенту одну сумму, пока касса берёт другую.
     *
     * Сверяемся по услуге, а не только по месту: строки уезжают в registerWalkIn
     * в том же порядке, но молчаливое смещение на один — это чужая цена в чужой
     * строке, а такое обязано выродиться в цену каталога, а не в ошибку.
     */
    function savedLine(i) {
        const row = state.rows[i];
        const line = state.result && state.result.lines && state.result.lines[i];
        if (!row || !line) return null;
        return Number(line.serviceId) === Number(row.service.id) ? line : null;
    }

    function rowPrice(i) {
        const line = savedLine(i);
        const row = state.rows[i];
        if (line && Number.isFinite(Number(line.unitPrice))) return Number(line.unitPrice);
        return Number(row && row.service.price) || 0;
    }

    /** Сумма строк в тех деньгах, что показаны: до записи — каталог, после — счёт. */
    function totalGross() {
        return state.rows.reduce((a, r, i) => a + rowPrice(i), 0);
    }

    /** Итог — это итог СЧЁТА: процент категории пациента применяет сервер. */
    function totalDue() {
        const inv = state.result && state.result.invoice;
        const total = inv && Number(inv.total_amount);
        return Number.isFinite(total) ? total : totalGross();
    }

    /** Насколько счёт меньше суммы строк — это и есть применённая скидка. */
    function discountApplied() {
        if (!state.result || !state.result.invoice) return 0;
        return Math.max(0, Math.round(totalGross() - totalDue()));
    }

    /** Имя исполнителя строки: из справочника, а иначе — как его отдал каталог. */
    function doctorNameOf(row) {
        if (!row || row.doctorId == null) return '';
        const d = (state.doctors || []).find((x) => String(x.id) === String(row.doctorId));
        if (d) return d.full_name || d.username || '';
        if (row.doctor) return row.doctor.full_name || row.doctor.username || '';
        return trf('Сотрудник №{id}', { id: row.doctorId });
    }

    /**
     * ЧТО ЗАПИСАНО, ТО И ПОКАЗАНО. Каталог услуг отдаёт услугу вместе с
     * исполнителем, и это может быть человек ВНЕ пула услуги — медсестра на
     * заборе крови, которой эта услуга в «Ставках» не отмечена. Пул такого не
     * содержит, и без своей строки список показывал бы «не выбран», пока в базу
     * уезжает он: выбор, сделанный регистратором, пропадал бы с глаз, оставшись
     * в записи.
     */
    function doctorCell(row) {
        const pool = doctorPoolFor(state.doctors, row.service);
        if (!pool.length && !row.service.requires_doctor && row.doctorId == null) {
            return h('td', { class: 'muted' }, '—');
        }
        const sel = h('select', { style: { width: '100%' } },
            h('option', { value: '' }, '— выберите врача —'),
            ...pool.map((d) => h('option', { value: String(d.id) }, d.full_name || d.username || String(d.id))));
        if (row.doctorId != null && !pool.some((d) => String(d.id) === String(row.doctorId))) {
            sel.appendChild(h('option', { value: String(row.doctorId) }, doctorNameOf(row)));
        }
        sel.value = row.doctorId == null ? '' : String(row.doctorId);
        sel.addEventListener('change', () => { row.doctorId = sel.value ? Number(sel.value) : null; });
        if (state.result) sel.disabled = true;
        row.sel = sel;
        return h('td', null, sel);
    }

    /** Талон строки: сама запись очереди, а не её пересказ. */
    function queueTicket(i) {
        const line = state.result && state.result.lines && state.result.lines[i];
        if (!line || !state.result.queue) return null;
        return state.result.queue.get(line.visitServiceId) || null;
    }

    /**
     * НОМЕР — ЭТО НОМЕР, А НЕ ДВЕРЬ. issue_queue_numbers возвращает и label
     * (чья дверь: врач, кабинет, лаборатория), и number (какой по счёту). В
     * столбце «№ очереди» стояло имя врача — то есть номера у пациента не было
     * вовсе, хотя он выдан и записан в строку.
     */
    function queueCell(i) {
        const t = queueTicket(i);
        if (!t || t.number == null) return h('td', { class: 'muted' }, '—');
        return h('td', { class: 'cell-strong' }, String(t.number),
            t.label ? h('span', { class: 'muted', style: { fontWeight: '400', marginLeft: '6px' } }, t.label) : null);
    }

    function paintTable() {
        clear(table);
        const done = !!state.result;
        const cols = 6;   // № · Наименование · Сумма · С НДС · Врач · (№ очереди | Уд.)
        table.appendChild(h('thead', null, h('tr', null,
            h('th', { style: { width: '46px' } }, '№'),
            h('th', null, tr('Наименование')),
            h('th', { style: { width: '130px' } }, tr('Сумма')),
            h('th', { style: { width: '130px' } }, tr('С НДС')),
            h('th', { style: { width: '270px' } }, tr('Врач')),
            done ? h('th', { style: { width: '120px' } }, tr('№ очереди'))
                 : h('th', { style: { width: '56px' } }, tr('Уд.')))));

        const tbody = h('tbody');
        if (!state.rows.length) {
            tbody.appendChild(h('tr', null, h('td', { colspan: String(cols), class: 'muted', style: { padding: '18px 14px', textAlign: 'center', fontSize: '12.5px' } },
                tr('Добавьте услуги кнопкой «+Услуги» или пакетом'))));
        }
        state.rows.forEach((row, i) => {
            const price = rowPrice(i);
            tbody.appendChild(h('tr', null,
                h('td', { class: 'muted' }, String(i + 1)),
                h('td', { class: 'cell-strong' }, row.service.name || '—'),
                h('td', null, fmtPrice(netOfVat(price, row.service.tax_rate))),
                h('td', { class: 'cell-strong' }, fmtPrice(price)),
                doctorCell(row),
                done
                    ? queueCell(i)
                    : h('td', null, h('button', {
                        class: 'icon-btn btn-sm', type: 'button',
                        title: 'Убрать услугу', 'aria-label': 'Убрать услугу',
                        onclick: () => removeLine(i),
                    }, Icon('Trash', { size: 13 })))));
        });
        table.appendChild(tbody);

        table.appendChild(h('tfoot', null, h('tr', null,
            h('td', { colspan: '3', class: 'cell-strong', style: { textAlign: 'right' } }, tr('Итого')),
            h('td', { class: 'cell-strong' }, fmtPrice(done ? totalDue() : totalGross())),
            h('td', null, ''),
            h('td', null, ''))));

        // Скидка названа, а не оставлена разницей, которую пациент сложит сам.
        const off = discountApplied();
        discountLine.style.display = off > 0 ? '' : 'none';
        discountLine.textContent = off > 0 ? trf('Скидка: {sum}', { sum: fmtPrice(off) }) : '';

        countEl.textContent = String(state.rows.length);
    }

    function addLine(service, doctor) {
        if (!service || service.id == null) return null;
        const row = {
            service,
            doctorId: doctor && doctor.id != null ? Number(doctor.id) : null,
            // Кого выбрал каталог — целиком: в справочнике окна его может не
            // быть вовсе, а показать в строке надо именно его.
            doctor: doctor || null,
            sel: null,
        };
        state.rows.push(row);
        paintTable();
        return row;
    }

    function removeLine(i) {
        state.rows.splice(i, 1);
        paintTable();
    }

    function applyTemplate(template) {
        const { services, missing } = resolveTemplate(template, state.catalog);
        for (const s of services) addLine(s, null);
        if (missing) toast(trf('Пакет: {n} услуг(и) не найдено в каталоге', { n: missing }), 'warn');
        return services.length;
    }

    // «+Услуги» — тот же каталог, что у мастера визита, в режиме подбора: он
    // зовёт onPick по одному разу на выбранную услугу, а строку рисуем мы.
    // Импорт динамический: каталог тянет полмодуля продукта, и грузить его при
    // каждом открытии окна регистрации незачем (и кольца импортов не завести).
    //
    // СТРОКА ЗАПРОСА — ТА ЖЕ, ЧТО У ВСЕХ (?v=aug17e). Для браузера адрес с
    // другим ?v это ДРУГОЙ модуль: вторая копия каталога со своим состоянием
    // (забронированные слоты, forgetSlots). Расхождение не видно ничем, кроме
    // потерянной брони, — поэтому оно и закреплено проверкой на исходнике.
    //
    // PICKER_CATALOG_EVERYWHERE_V1 — ИМЕННО КАТАЛОГ, а не три колонки. Владелец:
    // «i see an old version with 3 columns». У окна выбора услуги два облика, и
    // без attachMode оно открывалось старым: «Группы услуг» → «Услуги» → «Врачи».
    // attachMode даёт тот же каталог со сметой, что видят мастер записи и визит,
    // и зовёт onPick по строке сметы. requireSlot: false снимает бронь времени:
    // пациента здесь ещё вводят, врача выбирают в самой строке регистрации, и
    // требовать слот в каталоге не за что.
    async function openServicePicker() {
        if (locked()) return;
        try {
            const mod = await import('./service-picker-modal.js?v=aug17e');
            mod.openServicePickerModal({
                attachMode: true,
                requireSlot: false,
                title: 'Добавить услуги',
                ctaLabel: 'Готово',
                onPick: (p) => { if (p && p.service) addLine(p.service, p.doctor || null); },
            });
        } catch (e) {
            toast(trf('Не удалось открыть каталог услуг: {msg}', { msg: (e && e.message) || e }), 'fail');
        }
    }

    function openPackagePicker() {
        if (locked()) return;
        openTemplatePickerModal({ onPick: (t) => applyTemplate(t) });
    }

    // =======================================================================
    // Пациент
    // =======================================================================
    /** Взять готовую карту (найденную поиском, созданную или выбранную в дубликатах). */
    async function usePatient(p, { load = false } = {}) {
        if (!p) {
            state.patient = null;
            pickedBar.style.display = 'none';
            setPatientFormEnabled(true);
            return null;
        }
        const full = load ? await loadPatientById(p.id).catch(() => null) : null;
        const chosen = full || p;
        state.patient = chosen;
        pickedName.textContent = trf('Пациент № {mrn} · {name}', {
            mrn: chosen.mrn || '—', name: nameOf(chosen) || '—',
        });
        pickedBar.style.display = '';
        searchResults.style.display = 'none';
        setPatientFormEnabled(false);
        return chosen;
    }

    function setPatientFormEnabled(on) {
        const walk = (node) => {
            for (const c of (node.children || [])) {
                // FAST_REG_COMPACT_V1 — «Код отправителя» живёт среди полей
                // карты, но это поле ВИЗИТА: у найденного пациента карта
                // запирается (её не наша забота), а направление у сегодняшнего
                // визита своё — и запертым оно терялось бы на каждом найденном.
                if (c.dataset && c.dataset.keepEnabled) continue;
                const tag = String(c.tagName || '').toUpperCase();
                if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') {
                    c.disabled = !on;
                    if (on) { if (c.removeAttribute) c.removeAttribute('disabled'); }
                    else if (c.setAttribute) c.setAttribute('disabled', '');
                }
                walk(c);
            }
        };
        walk(patientBox);
        patientBox.style.opacity = on ? '' : '0.55';
    }

    // =======================================================================
    // Сохранение
    // =======================================================================
    /** Врач у услуги, которая его требует, — проверка ДО первой записи в базу. */
    function checkDoctors() {
        for (const row of state.rows) {
            if (row.service.requires_doctor && !row.doctorId) {
                toast(trf('Укажите врача для услуги «{name}»', { name: row.service.name || '' }), 'fail');
                try { if (row.sel && row.sel.focus) row.sel.focus(); } catch (e) { /* нет фокуса — не беда */ }
                return false;
            }
        }
        return true;
    }

    async function doSave() {
        if (state.saving || state.result || state.stalled) return null;
        // WALK_IN_ROLE_GATE_V1 — отказ по роли ДО заведения карты.
        //
        // Право «Регистрация пациента» открыло окно, но цепочку «карта → визит
        // → счёт» проходят целиком только администратор и регистратор
        // (walk-in-booking.js). Кассир с этим правом иначе завёл бы карту и
        // визит и получил отказ на счёте — то самое «визит без счёта», ради
        // ухода от которого окно и делали одним.
        //
        // Спрашиваем только когда услуги набраны: пустая таблица — это обычное
        // заведение карты, а его сервер разрешает шире (и колл-центру тоже).
        if (state.rows.length) {
            const refusal = walkInRoleRefusal(currentUser());
            if (refusal) { toast(refusal, 'fail'); return null; }
        }
        if (!checkDoctors()) return null;
        state.saving = true;
        saveBtn.disabled = true;
        try {
            if (!state.patient) {
                const payload = api.collect();
                if (!payload) return null;
                // PATIENT_PHOTO_V1 — снимок кладётся в хранилище ДО вставки
                // карты, ровно как в форме заведения: иначе фото, снятое с
                // веб-камеры прямо здесь, молча не доехало бы до карты.
                const photoUrl = await uploadPendingPhoto(api.state);
                if (photoUrl) payload.photo_url = photoUrl;
                const created = await createPatient(payload, false);
                // null значит либо отказ с тостом, либо открытый диалог
                // дубликата — он продолжит сохранение сам, своим doSave().
                if (!created) return null;
                await usePatient(created);
            }
            return await bookServices();
        } finally {
            state.saving = false;
            saveBtn.disabled = !!state.result || !!state.stalled;
        }
    }

    /**
     * Создание карты и диалог дубликата СВОИМИ обработчиками (см. шапку файла):
     * «Открыть существующего» здесь значит «записать услуги на него», а не уход
     * в карту. Продолжение цепочки — повторный doSave(): пациент уже в
     * состоянии окна, поэтому второй карты не появится.
     */
    async function createPatient(payload, force) {
        try {
            const created = await savePatient(payload, { force });
            if (created) patientCreatedHere = true;
            return created;
        } catch (e) {
            if (!force && e && e.code === 'DUPLICATE_PATIENT' && e.existing) {
                openDuplicatePatientDialog(e, {
                    onOpenExisting: async (c) => { await usePatient(c, { load: true }); await doSave(); },
                    onForceCreate: async () => {
                        const created = await createPatient(payload, true);
                        if (!created) return;
                        await usePatient(created);
                        await doSave();
                    },
                });
                return null;
            }
            toast(trf('Не удалось сохранить: {msg}', { msg: (e && e.message) || e }), 'fail');
            return null;
        }
    }

    /** Пустая таблица — это обычное заведение карты: сохранили и закрылись. */
    async function bookServices() {
        const patient = state.patient;
        if (!patient) return null;
        if (!state.rows.length) {
            // Найденного пациента без услуг никто не сохранял: «Пациент
            // сохранён» здесь читалось бы как «изменения записаны», и
            // регистратор уходил бы с экрана уверенным, что что-то сделал.
            toast(patientCreatedHere ? tr('Пациент сохранён.') : tr('Услуги не добавлены — карта пациента не изменена.'));
            notifySaved(patient);
            dismiss();   // не close(): запись ещё «идёт» (state.saving), а решение — наше
            return patient;
        }
        let res;
        try {
            res = await registerWalkIn({
                patientId: patient.id,
                lines: state.rows.map((r) => ({ service: r.service, doctorId: r.doctorId })),
                referralSourceId: referralSel.value || null,
                createdBy: (currentUser() || {}).id || null,
                // WALK_IN_ROLE_GATE_V1 — тот же человек, что уходит в
                // created_by, и его же «Дополнительные роли»: цепочка сама
                // откажет до первой записи, если ему туда нельзя.
                actorRole: currentUser(),
            });
        } catch (e) {
            // ЦЕПОЧКА СЛОМАЛАСЬ ПОСЛЕ ВИЗИТА — ПОВТОРА НЕ БУДЕТ.
            //
            // registerWalkIn отдаёт в e.partial то, что уже легло в базу. Визит
            // дня переиспользуется, так что второе нажатие допишет в него те же
            // строки заново и выставит счёт на всё сразу: пациент с задвоенными
            // услугами разбирается уже в кассе. Дальше — из карты пациента, где
            // визит виден и счёт выставляется по нему.
            const msg = (e && e.message) || e;
            if (e && e.partial) {
                toast(trf('Визит создан, счёт не выставлен: {msg} — выставьте счёт из карты пациента', { msg }), 'fail');
                toStalledState();
                return null;
            }
            // Ни визита, ни строк: отказ до первой записи. Карта уже есть
            // (state.patient), поэтому повтор нажатия продолжит с того же места.
            toast(trf('Услуги не записаны: {msg}', { msg }), 'fail');
            return null;
        }
        state.result = res;
        if (res.quoteError) toast(trf('Тариф визита не спрошен: {msg}', { msg: res.quoteError }), 'warn');
        if (res.queueError) toast(trf('Номера очереди не выданы: {msg}', { msg: res.queueError }), 'warn');
        // CRM_LINKS_V1 — ЗАПИСАННЫЙ ПО ТЕЛЕФОНУ ПРИШЁЛ И ОФОРМЛЕН ЗДЕСЬ.
        //
        // Это окно оформляет услуги само (registerWalkIn), не проходя через
        // подстановку из заявки, — и заявка колл-центра на сегодня оставалась
        // «Записан» с сегодняшней датой. Ночью автоматика уносила пришедшего
        // пациента в «Не пришёл», а завтра регистратура снова видела уже
        // оплаченную услугу подставленной в смету. Лучшая попытка: пациент,
        // визит и счёт уже созданы, и сбой здесь не отменяет записи.
        await closeCrmLinesForPatient(patient.id, localYmd());
        notifySaved(patient);
        toSavedState();
        return res;
    }

    function toSavedState() {
        const inv = (state.result && state.result.invoice) || null;
        const p = state.patient || {};
        // FAST_REG_LAYOUT_V1 — номера стоят в шапке блока реквизитов, над теми
        // самыми полями, из которых карта и заведена.
        patientInfo.textContent = [
            trf('Пациент № {mrn} · {name}', { mrn: p.mrn || '—', name: nameOf(p) || '—' }),
            trf('Счёт № {no}', { no: (inv && (inv.invoice_number || inv.id)) || '—' }),
        ].join(' · ');
        lockInputs();
        printBtn.disabled = false;
        if (printBtn.removeAttribute) printBtn.removeAttribute('disabled');
        saveBtn.style.display = 'none';
        cancelBtn.style.display = 'none';
        openCardBtn.style.display = '';
        doneBtn.style.display = '';
        footHint.textContent = tr('Пациент, визит и счёт созданы. Печать счёта — кнопкой в шапке таблицы.');
        paintTable();
        toast(tr('Пациент зарегистрирован, счёт выставлен.'));
    }

    /**
     * Визит есть, счёта нет. Кнопки «Сохранить» больше нет — повтор дописал бы
     * строки в тот же визит дня (см. bookServices). Печатать нечего: счёт не
     * выставлен. Остаётся уйти в карту пациента, где визит виден, и закрыть.
     */
    function toStalledState() {
        state.stalled = true;
        lockInputs();
        saveBtn.style.display = 'none';
        saveBtn.disabled = true;
        if (saveBtn.setAttribute) saveBtn.setAttribute('disabled', '');
        cancelBtn.style.display = 'none';
        openCardBtn.style.display = '';
        doneBtn.style.display = '';
        footHint.textContent = tr('Визит создан, счёт не выставлен. Выставьте его из карты пациента.');
    }

    /** Всё, чем можно ещё что-то изменить, запирается одним местом. */
    function lockInputs() {
        setPatientFormEnabled(false);
        searchInput.disabled = true;
        referralSel.disabled = true;
        // SEARCHABLE_SELECT_V1 — у направления два лица: скрытый <select>
        // (источник правды) и строка поиска поверх него. Выключенный select
        // при живой строке — поле, которое по-прежнему открывается, ищет и
        // выбирает, ничего уже не меняя.
        const input = referralInput();
        if (input) {
            input.disabled = true;
            if (input.setAttribute) input.setAttribute('disabled', '');
        }
        changeBtn.style.display = 'none';
        addServicesBtn.style.display = 'none';
        addPackagesBtn.style.display = 'none';
    }

    /** Видимая строка поиска обёртки searchableSelect (сам select скрыт внутри). */
    function referralInput() {
        const kids = (referralWrap && referralWrap.children) || [];
        for (const c of kids) if (String(c.tagName || '').toUpperCase() === 'INPUT') return c;
        return null;
    }

    /**
     * Печатный счёт — тот же бланк и та же форма данных, что у мастера визита
     * (visit-wizard.js, WIZ_INVOICE_PRINT_V1). Отсюда три вещи, каждая из
     * которых уже была утеряна:
     *
     *   • НОМЕР ОЧЕРЕДИ. Блок очереди на бланке собирается только из строк с
     *     непустым number (doc-variants.js queueGroups): талон без номера с
     *     бумаги просто исчезает, и пациент идёт обратно к стойке спрашивать,
     *     какой он по счёту.
     *   • ЦЕНЫ И СКИДКА. Позиции печатаются по цене СЧЁТА, подытог — их сумма,
     *     «Итого» — сумма счёта; разницу называет строка «Скидка», иначе она
     *     читается как ошибка сложения.
     *   • ВРАЧ. Кто выполняет — в самой позиции, а при одном враче на весь
     *     заказ ещё и строкой в шапке (как в счёте мастера).
     */
    function printInvoice() {
        const inv = state.result && state.result.invoice;
        if (!inv) return;
        const p = state.patient || {};
        const queueRows = [];
        state.rows.forEach((row, i) => {
            const t = queueTicket(i);
            if (!t) return;
            queueRows.push({
                service: row.service.name || '', label: t.label || '',
                number: t.number, key: t.queue_key || '',
            });
        });
        const subtotal = totalGross();
        const total = totalDue();
        const off = discountApplied();
        const docNames = [...new Set(state.rows.map((r) => doctorNameOf(r)).filter(Boolean))];
        /* i18n-exempt-start: печатный счёт — бланк документа, намеренно русский (как в мастере визита) */
        printableSheet({ type: 'invoice', idLine: inv.invoice_number || String(inv.id), data: {
            title: 'Амбулаторные услуги',
            docNo: inv.invoice_number || String(inv.id),
            issueDate: 'Дата ' + new Date().toLocaleDateString('ru-RU'),
            status: 'UNPAID',
            patient: [
                ['ФИО', nameOf(p) || '—'],
                ['Карта №', p.mrn || '—'],
                ['Телефон', p.phone || '—'],
                ...(docNames.length === 1 ? [['Врач', docNames[0]]] : []),
            ],
            billing: [
                ['Дата', new Date().toLocaleDateString('ru-RU')],
                ['Оплата', 'Пациент — оплата в кассе'],
                ...(off > 0 ? [['Скидка', '−' + fmtPrice(off) + ' сум']] : []),
            ],
            items: state.rows.map((row, i) => {
                const dn = doctorNameOf(row);
                return {
                    name: (row.service.name || '') + (dn ? ' · ' + dn : ''),
                    qty: 1, price: rowPrice(i), _alt: i % 2 === 1,
                };
            }),
            queue: queueRows,
            subtotal,
            total,
            paid: 0,
        } });
        /* i18n-exempt-end */
    }

    // =======================================================================
    // Справочники
    // =======================================================================
    (async () => {
        try {
            const [svcRes, docRes, srcRes] = await Promise.all([
                supabase.from('services').select('id, name, price, tax_rate, requires_doctor, type, active').eq('active', true).order('name').limit(1000),
                // EASYMED_DOCTOR_DETECTION — список врачей проверяет is_doctor, а
                // не role: у администратора-врача роли 'doctor' нет вовсе.
                supabase.from('users').select('id, full_name, service_rates').eq('is_doctor', true).eq('active', true).order('full_name'),
                supabase.from('referral_sources').select('id, name, code, category_id, doctor_id, active').eq('active', true).order('code'),
            ]);
            state.catalog = (svcRes && svcRes.data) || [];
            state.doctors = (docRes && docRes.data) || [];
            state.sources = (srcRes && srcRes.data) || [];
            for (const s of state.sources) {
                referralSel.appendChild(h('option', { value: String(s.id) }, referralSourceLabel(s)));
            }
            paintTable();
        } catch (e) {
            toast(trf('Не удалось загрузить справочники: {msg}', { msg: (e && e.message) || e }), 'fail');
        }
    })();

    paintTable();
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    setTimeout(() => { try { api.fields.last_name.focus(); } catch (e) { /* нет фокуса — не беда */ } }, 30);

    return {
        overlay, card, body, close, state,
        fields: api.fields, collect: api.collect, setGender: api.setGender,
        table, saveBtn, printBtn, addServicesBtn, addPackagesBtn, referralSel, searchInput,
        // FAST_REG_LAYOUT_V1 — два блока окна: реквизиты и услуги.
        patientBlock, servicesBlock, formEl: api.formEl,
    };
}
