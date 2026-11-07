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
// MODAL_STACK_V1 — «стоит ли кто-то поверх меня» считает ОДИН помощник на всё
// приложение. Здесь это правило было написано ТРЕТЬЕЙ копией — и самой грубой:
// любая чужая подложка .modal считалась дочерней, даже страничное окно под
// нами. Копии одного правила расходятся молча, а наружу это выходит как «Esc
// закрыл не то окно». Модуль сам не импортирует ничего (NO_IMPORT_CYCLES_V1).
import { coveredByHigherModal } from './modal-stack.js?v=ms1';
import { openTemplatePickerModal } from './template-picker-modal.js?v=tpl1';   // TEMPLATE_PICKER_V1
import { resolveTemplate, cartPackage } from './service-templates.js?v=tpl1';   // WIZ_TEMPLATES_LOCAL_V1; PACKAGES_V1; SERVICES_PACKAGES_V1 — cartPackage
import { registerWalkIn, walkInRoleRefusal, walkInLinesRefusal } from './walk-in-booking.js?v=wib1';
import { loadTodayBooking, bookedStatusLabel, isBookedTwin } from './booked-rows.js';   // CRM_LINK_ALL_V1 (R7a) — строки «из записи»
import { loadDoctorOrders, orderKind, orderStateText, bonusText, orderVsIds } from '../doctor-orders.js';   // DOCTOR_REFERRAL_DESK_V1 — «Направления врача»
import { surgeryBedRefusal, isSurgeryPick, SURGERY_NEEDS_BED_TEXT } from './visit-line-row.js';   // LIVE_AUDIT_FIX_V1   // WALK_IN_BOOKING_V1
import { doctorPoolFor, needsPerformer, performerCandidates, soleCandidate, ROUTE_SELECT } from './doctor-pool.js?v=dp1';   // DOCTOR_POOL_V1 · DIAG_ROUTE_V1 (D1) — исполнитель у каждой услуги кабинета
import { searchableSelect } from './searchable-select.js?v=ss2';               // SEARCHABLE_SELECT_V1
import { referralSourceLabel } from '../../shared/referral-label.js?v=rl1';    // REFERRAL_SOURCE_CODE_V1
import { printableSheet } from './doc-settings.js?v=noqr1';                    // WIZ_INVOICE_PRINT_V1 — тот же бланк «Счёт»
import { packageItemName, packageLabel, printInvoiceSheetById } from './receipt-print.js?v=rp1';     // PACKAGES_V1 — пакет и скидка позиции на бланке; CLINIC_API_FIX_V1 — packageLabel; INVOICE_APPEND_V1 — дописанный счёт целиком
import { invoiceAppendNote } from '../invoice-append.js';
import { groupOf, discountChoiceOptions, defaultChoiceKey, keepChoice, choiceArgs, choiceReason, choiceToSend } from '../discount-choice.js';   // DISCOUNT_V2 — одна скидка на выбор
import { discountValue, localYmd } from '../discount-rules.js';   // DISCOUNT_V2 — стоимость промокода на смете                      // INVOICE_APPEND_V1 — «Добавлено в счёт № …»
import { ratedOutcome } from '../discount-rates.js';   // DISCOUNT_RATES_V1 — скидка по ставкам услуг, как посчитает счёт

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
     *
     * СЧИТАЕТСЯ ТОЛЬКО ЭТАЖ ВЫШЕ НАШЕГО, и правило это ОДНО на всё приложение
     * (modal-stack.js). Здесь стояла его третья копия — «любая чужая подложка
     * дочерняя», — и она считала дочерним даже страничное окно ПОД нами (100),
     * которое заслонить нас не может: Esc глох ровно там, где его ждут.
     */
    const childDialogOpen = () => coveredByHigherModal(overlay);

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
        discountChoice: 'none', group: null, discounts: [],   // DISCOUNT_V2 — выбор скидки, группа пациента, скидки клиники
        groupKnown: false, discountPicked: false,   // DISCOUNT_V2 (ревью S1 L-3) — группа прочитана; скидку выбрал человек
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
        // CRM_LINK_ALL_V1 (R7a) — запись пациента на сегодня: визит записи и строки,
        // которые регистратор убрал (снимутся с визита при сохранении).
        bookedVisitId: null,
        dropBooked: [],
        doctorOrders: null,   // DOCTOR_REFERRAL_DESK_V1 — направления врача пациента (patient_referral_orders)
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
    // CRM_LINK_ALL_V1 (R7a) — строки записи, уже стоящие в счёте: в таблице их нет
    // (выставлять их второй раз нельзя), но регистратор должен их видеть.
    const bookedNote = h('div', {
        class: 'muted', 'data-booked-billed': '',
        style: { display: 'none', padding: '8px 14px 0', fontSize: '12.5px', overflowWrap: 'anywhere' },
    });
    // DOCTOR_REFERRAL_DESK_V1 — группа «Направления врача» над таблицей: выставленные,
    // оплаченные, на другой день, убранные из таблицы и ожидающие рекомендации врача
    // (сегодняшние без счёта — строками таблицы с пометкой «от врача»).
    const doctorOrdersEl = h('div', {
        'data-doctor-orders': '',
        style: { display: 'none', margin: '8px 14px', padding: '9px 12px', background: 'var(--info-50, #eef4ff)', border: '1px solid var(--info-200, #c7dcfd)', borderRadius: '10px' },
    });
    const discountLine = h('div', {
        class: 'muted',
        style: { display: 'none', padding: '8px 14px 10px', fontSize: '12.5px', textAlign: 'right' },
    });
    // DISCOUNT_V2 (решение владельца 2026-11-07, п. 4) — ВЫБОР ОДНОЙ СКИДКИ: скидка группы
    // пациента, промокоды клиники, «Без скидки». По умолчанию — скидка группы (как было).
    // Почему скидка такая — строкой под выбором. Деньги считает сервер (discount_choice).
    const choiceSel = h('select', { 'data-discount-choice': '', style: { minWidth: '220px', maxWidth: '100%', padding: '6px 10px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '12.5px' },
        onchange: () => { state.discountChoice = choiceSel.value; state.discountPicked = true; paintDiscountChoice(); } });   // ревью S1 L-3 — выбор человека
    const choiceWhy = h('span', { class: 'muted', 'data-discount-reason': '', style: { fontSize: '12.5px' } });
    const choiceRow = h('div', { 'data-discount-row': '', style: { display: 'none', padding: '8px 14px 0', alignItems: 'center', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' } },
        h('span', { style: { fontSize: '12.5px', color: 'var(--ink-700)' } }, tr('Скидка')), choiceSel, choiceWhy);
    // FAST_REG_LAYOUT_V1 — порядок кнопок с образца: «Печать», «+Пакеты»,
    // «+Услуги». Главное действие блока стоит у самого края, как «Сохранить» в
    // шапке блока реквизитов.
    const servicesBlock = h('div', { class: 'fr-block' },
        h('div', { class: 'card-header fr-block-head' },
            h('h3', null, Icon('Receipt', { size: 14 }), ' ', tr('Услуги'), ' ', countEl),
            h('span', { class: 'grow' }),
            printBtn, addPackagesBtn, addServicesBtn),
        doctorOrdersEl, table, bookedNote, choiceRow, discountLine);   // DOCTOR_REFERRAL_DESK_V1 — группа над таблицей · DISCOUNT_V2 — выбор скидки

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
        // CRM_LINK_ALL_V1 (R7a) — строка «из записи»: её цена уже в визите.
        if (row && row.booked && Number.isFinite(Number(row.booked.unitPrice))) return Number(row.booked.unitPrice);
        // SERVICES_PACKAGES_V1 — строка пакета: цена услуги без скидки, по которой считалась раскладка.
        if (row && row.package && row.package.full != null && row.package.price != null) return Number(row.package.full);
        return Number(row && row.service.price) || 0;
    }

    // SERVICES_PACKAGES_V1 — до записи: скидка строк пакета (до цены в пакете) —
    // её даст счёт наверняка; скидку группы пациента посчитает сервер.
    function packageOffBefore() {
        if (state.result && state.result.invoice) return 0;
        return state.rows.reduce((a, r) => a + (r.package && r.package.full != null && r.package.price != null
            ? Math.max(0, Number(r.package.full) - Number(r.package.price)) : 0), 0);
    }

    /** Сумма строк в тех деньгах, что показаны: до записи — каталог, после — счёт. */
    function totalGross() {
        return state.rows.reduce((a, r, i) => a + rowPrice(i), 0);
    }

    /** Итог — это итог СЧЁТА: процент категории пациента применяет сервер. */
    function totalDue() {
        // INVOICE_APPEND_V1 — строки легли в уже выставленный счёт: его сумма
        // включает и прежние услуги. Таблица показывает СВОИ строки — итог её
        // строк минус скидка своей части (walk-in-booking.js appendedDiscount).
        if (state.result && state.result.appended) {
            return Math.max(0, totalGross() - (Number(state.result.appendedDiscount) || 0));
        }
        const inv = state.result && state.result.invoice;
        const total = inv && Number(inv.total_amount);
        return Number.isFinite(total) ? total : totalGross() - packageOffBefore();   // SERVICES_PACKAGES_V1
    }

    /** DISCOUNT_V2 — строки сметы без своей скидки пакета: на них ложится скидка счёта. */
    function restLinesBefore() {
        return state.rows.map((r, i) => ({ r, i })).filter(({ r }) => !(r.package && r.package.full != null && r.package.price != null && Number(r.package.price) < Number(r.package.full)))
            .map(({ r, i }) => ({ service_id: Number(r.service && r.service.id), service: r.service && r.service.__consult ? { consultation: true } : (r.service || null), total: rowPrice(i) }));   // service: DISCOUNT_RATES_V1 (консультация по виду приёма — группа «Консультации»)
    }
    /** DISCOUNT_V2 — варианты выбора скидки на эту смету. */
    function discountOptionsNow() {
        return discountChoiceOptions({ group: state.group, discounts: state.discounts, manual: false, fmtMoney: fmtPrice,
            ctx: { today: localYmd(), categoryId: state.patientCategoryId ?? null, serviceIds: state.rows.map((r) => Number(r.service && r.service.id)) } });
    }
    /** DISCOUNT_V2 — скидка остатка сметы до записи по выбору (то же, что даст счёт). */
    function chosenDiscountBefore() {
        const lines = restLinesBefore();
        const base = lines.reduce((a, l) => a + l.total, 0);
        const key = state.discountChoice;
        // DISCOUNT_RATES_V1 — у группы или промокода ставки по услугам: каждая строка — своим процентом.
        const promoRow = String(key).startsWith('promo:') ? (state.discounts || []).find((d) => 'promo:' + d.id === key) : null;
        const rated = ratedOutcome({ key, group: state.group, promo: promoRow, lines });
        if (rated && rated.rated) return rated.off;
        if (key === 'group' && state.group) return Math.round(base * state.group.pct / 100);
        if (String(key).startsWith('promo:')) {
            const row = (state.discounts || []).find((d) => 'promo:' + d.id === key);
            return row ? discountValue(row, lines) : 0;
        }
        return 0;
    }
    function paintDiscountChoice() {
        const show = !!state.patient && !(state.result && state.result.invoice) && state.rows.length > 0;
        choiceRow.style.display = show ? 'flex' : 'none';
        if (!show) return;
        const opts = discountOptionsNow();
        state.discountChoice = keepChoice(state.discountChoice, opts, state.group);
        clear(choiceSel);
        for (const o of opts) choiceSel.appendChild(h('option', { value: o.key, selected: o.key === state.discountChoice }, trf(o.label.text, o.label.params)));
        choiceSel.value = state.discountChoice;
        const promo = String(state.discountChoice).startsWith('promo:') ? (state.discounts || []).find((d) => 'promo:' + d.id === state.discountChoice) : null;
        const why = choiceReason(state.discountChoice, { group: state.group, promo, applied: chosenDiscountBefore(), fmtMoney: fmtPrice });
        choiceWhy.textContent = why ? trf(why.text, why.params) : '';
    }
    /** DISCOUNT_V2 — группа пациента и скидки клиники для выбора (сбой — без выбора, как прежде). */
    async function loadDiscountChoices(patientId) {
        state.group = null; state.discounts = []; state.patientCategoryId = null; state.discountChoice = 'none';
        state.groupKnown = false; state.discountPicked = false;   // ревью S1 L-3
        try {
            const [pRes, dRes] = await Promise.all([
                supabase.from('patients').select('id, category_id, patient_categories(id, name, discount_percent, active, discount_rates)').eq('id', patientId).maybeSingle(),   // discount_rates: DISCOUNT_RATES_V1
                supabase.from('patient_discounts').select('id, name, kind, percent, amount, remaining, active, valid_from, valid_until, category_id, service_ids, discount_rates').eq('active', 1).order('name'),
            ]);
            if (!state.patient || state.patient.id !== patientId) return;
            const cat = pRes && !pRes.error && pRes.data ? pRes.data.patient_categories : null;
            state.patientCategoryId = pRes && pRes.data && pRes.data.category_id != null ? Number(pRes.data.category_id) : null;
            state.group = cat && cat.active !== 0 && cat.active !== false ? groupOf(cat.name, cat.discount_percent, cat.discount_rates) : null;   // DISCOUNT_RATES_V1 — со ставками
            state.discounts = dRes && !dRes.error && Array.isArray(dRes.data) ? dRes.data : [];
            state.discountChoice = defaultChoiceKey(state.group);
            state.groupKnown = !!(pRes && !pRes.error);   // ревью S1 L-3 — сбой чтения: группа не известна
        } catch (e) { /* выбор скидки — удобство: без него сервер даст скидку группы сам */ }
        paintDiscountChoice();
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
        // DIAG_ROUTE_V1 (D1) — «—» только у анализа и процедуры: услуге кабинета исполнитель нужен всегда.
        if (!pool.length && !needsPerformer(row.service) && row.doctorId == null) {
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
        // CRM_LINK_ALL_V1 (R7a) — врач строки «из записи» — врач записи: строка уже в визите.
        // DIAG_ROUTE_V1 (ревью M-1) — строку записи БЕЗ исполнителя у услуги кабинета регистратура
        // назначает здесь (booked.setDoctor): сохранение запишет его в строку визита до счёта.
        if (row.booked && !row.booked.setDoctor) { sel.disabled = true; sel.title = tr('Врач записи — чтобы сменить, уберите строку и добавьте услугу заново'); }
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
            const pkgName = packageLabel(row.package);   // CLINIC_API_FIX_V1 — правило бланка
            tbody.appendChild(h('tr', null,
                h('td', { class: 'muted' }, String(i + 1)),
                h('td', { class: 'cell-strong' }, row.service.name || '—',
                    // DOCTOR_REFERRAL_DESK_V1 — строка направления врача: «от врача · ФИО», кому бонус, рекомендация врача.
                    row.booked && row.booked.doctorOrder ? h('div', { 'data-doctor-order-row': String(row.booked.vsId), class: 'muted', style: { fontWeight: '400', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' } },
                        Icon('Stethoscope', { size: 12 }), orderMeta([
                            trf('от врача · {name}', { name: row.booked.referrerName || '—' }),
                            bonusText(row.booked.bonus) ? trf(bonusText(row.booked.bonus).template, bonusText(row.booked.bonus).params) : null,
                            row.booked.note || null])) : null,
                    // DOCTOR_REFERRAL_DESK_V1 — строка, добавленная из рекомендации врача.
                    row.fromRec ? h('div', { 'data-rec-row': String(row.fromRec), class: 'muted', style: { fontWeight: '400', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '4px' } },
                        Icon('Flag', { size: 12 }), tr('рекомендация врача')) : null,
                    // CRM_LINK_ALL_V1 (R7a) — строка уже в визите записи: подпись и статус записи.
                    row.booked && !row.booked.doctorOrder ? h('div', { 'data-booked-row': String(row.booked.vsId), class: 'muted', style: { fontWeight: '400', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' } },
                        Icon('Calendar', { size: 12 }), tr('из записи') + ' · ' + tr(bookedStatusLabel(row.booked.status))) : null,
                    // PACKAGES_V1 — из какого пакета строка и его скидка (её
                    // применит сервер в счёте; итог после записи — уже со скидкой).
                    // CLINIC_API_FIX_V1 (ревью итога) — «пакет» по тому же правилу,
                    // что чек и счёт (receipt-print.js packageLabel): только у пакета
                    // со скидкой. Шаблон сметы (0 % или скидка не пришла) — та же
                    // таблица service_templates, но пакета пациент не брал: экран
                    // звал его «Пакет «…»», а бумага — нет. Строка по-прежнему
                    // помнит свой шаблон (row.package) — сервер выставит её сам.
                    // SERVICES_PACKAGES_V1 — цена услуги в пакете (её выставит счёт).
                    pkgName ? h('div', { 'data-package-line': String(row.package.id), class: 'muted', style: { fontWeight: '400', fontSize: '12.5px' } },
                        row.package.price != null
                            ? trf('Пакет «{name}»: в пакете {sum} сум', { name: pkgName, sum: fmtPrice(row.package.price) })
                            : trf('Пакет «{name}»', { name: pkgName })) : null),
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
        paintDiscountChoice();   // DISCOUNT_V2
    }

    /**
     * CRM_LINK_ALL_V1 (редакция 2) — ключ строки таблицы для правила isBookedTwin.
     * CRM_LINK_ALL_V1 (повторное ревью денег, S1) — и нужен ли услуге врач: правило
     * «та же услуга» одно с сетью R7b (shared/same-service.js) и сравнивает врача
     * только у услуги, без врача которой не бывает.
     */
    function rowKey(service, doctorId) {
        const consult = !!(service && service.__consult);
        return {
            serviceId: consult ? null : Number(service && service.id),
            consultationTypeId: consult ? Number(service.consultation_type_id) : null,
            doctorId: doctorId != null ? Number(doctorId) : (consult && service.__consultDoctorId ? Number(service.__consultDoctorId) : null),
            needsDoctor: consult || !!Number(service && service.requires_doctor),
        };
    }
    const bookedKeyOf = (row) => ({ ...rowKey(row.service, row.doctorId) });
    /** Строка «из записи», которой эта услуга (с этим врачом) уже стоит в таблице. */
    const bookedRowOf = (service, doctorId) => {
        const key = rowKey(service, doctorId);
        return state.rows.find((r) => r.booked && isBookedTwin(key, bookedKeyOf(r))) || null;
    };

    /** Строка в таблицу без проверок (их делает addLine; строки записи ставит showBookedRows). */
    function pushRow(service, doctor, pkg = null) {
        const row = {
            service,
            doctorId: doctor && doctor.id != null ? Number(doctor.id) : null,
            // Кого выбрал каталог — целиком: в справочнике окна его может не
            // быть вовсе, а показать в строке надо именно его.
            doctor: doctor || null,
            sel: null,
        };
        if (pkg) row.package = pkg;
        state.rows.push(row);
        return row;
    }

    /**
     * @param {object|null} [pkg] — пакет строки (PACKAGES_V1, cartPackage).
     *   CRM_LINK_ALL_V1 (повторное ревью денег, S3) — на строку «из записи» пакет не
     *   ложится: её не вставляют второй раз, значит и package_id ей не дать, а экран
     *   обещал бы цену пакета, которой счёт не возьмёт.
     */
    function addLine(service, doctor, pkg = null) {
        if (!service || service.id == null) return null;
        // CRM_LINK_ALL_V1 (редакция 2) — записанную на сегодня услугу второй строкой не
        // добавляют: строка «из записи» уже регистрирует её (вставка второй убрала бы
        // строку записи — сеть R7b — а её номер идёт в счёт).
        const bookedTwin = bookedRowOf(service, doctor && doctor.id != null ? doctor.id : null);
        if (bookedTwin) {
            toast(pkg
                ? trf('Уже из записи — по цене записи, без пакета: {names}', { names: service.name || '' })
                : trf('«{name}» уже из записи — вторая строка не нужна.', { name: service.name || '' }), 'info');
            return bookedTwin;
        }
        // DIAG_ROUTE_V1 (D1) — исполнитель сам, только когда кандидат один (как в мастере записи).
        if (!doctor && needsPerformer(service)) {
            const one = soleCandidate(doctorPoolFor(state.doctors, service));
            if (one) doctor = { id: one.id, full_name: one.full_name };
        }
        const row = pushRow(service, doctor, pkg);
        paintTable();
        return row;
    }

    function removeLine(i) {
        // CRM_LINK_ALL_V1 (R7a) — строка «из записи» снимется с визита при сохранении.
        // DOCTOR_REFERRAL_DESK_V1 — строка направления врача остаётся в визите: её назначил
        // врач, она возвращается в группу «Направления врача» (там — «Добавить»).
        const gone = state.rows[i];
        if (gone && gone.booked && !gone.booked.doctorOrder) state.dropBooked.push(gone.booked.vsId);
        state.rows.splice(i, 1);
        paintTable();
        paintDoctorOrders();
    }

    function applyTemplate(template) {
        const { services, missing } = resolveTemplate(template, state.catalog);
        // PACKAGES_V1 — строка помнит свой пакет: сервер выставит её со скидкой
        // пакета (и проверит срок), а таблица подпишет, откуда строка.
        // SERVICES_PACKAGES_V1 — строка помнит пакет и цену услуги в нём (cartPackage).
        // CRM_LINK_ALL_V1 (повторное ревью денег, S3) — услуга, уже стоящая строкой «из
        // записи», пакетом не добавляется и пакета не получает: строка записи идёт в счёт
        // по своей цене (её не вставляют второй раз). Тост называет такие услуги.
        const asBooked = [];
        for (const s of services) {
            if (bookedRowOf(s, null)) { asBooked.push(s.name || ''); continue; }
            addLine(s, null, cartPackage(template, s.id));
        }
        paintTable();
        if (asBooked.length) toast(trf('Уже из записи — по цене записи, без пакета: {names}', { names: asBooked.join(', ') }), 'info');
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
            const mod = await import('./service-picker-modal.js?v=ownrep4');
            mod.openServicePickerModal({
                attachMode: true,
                requireSlot: false,
                title: 'Добавить услуги',
                ctaLabel: 'Готово',
                onPick: (p) => {
                    if (!p || !p.service) return;
                    // PACKAGES_V1 — строка из пакета, выбранного в каталоге.
                    // CRM_LINK_ALL_V1 (ревью денег S3) — пакет ставит addLine: строке «из записи» — нет.
                    addLine(p.service, p.doctor || null, p.package || null);
                },
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
    /** CRM_LINK_ALL_V1 (R7a) — убрать строки «из записи» прежнего пациента. */
    function clearBookedRows() {
        state.rows = state.rows.filter((r) => !r.booked && !r.fromRec);   // DOCTOR_REFERRAL_DESK_V1 — и строки из рекомендаций прежнего пациента
        state.dropBooked = [];
        state.bookedVisitId = null;
        state.doctorOrders = null;   // DOCTOR_REFERRAL_DESK_V1
        bookedNote.textContent = '';
        bookedNote.style.display = 'none';
        paintTable();
        paintDoctorOrders();   // DOCTOR_REFERRAL_DESK_V1
    }

    /**
     * CRM_LINK_ALL_V1 (R7a; дефект G7) — ЗАПИСЬ НА СЕГОДНЯ — ГОТОВЫЕ СТРОКИ. Визит
     * дня пациента уже держит строки записи: они встают в таблицу «из записи», и
     * сохранение регистрирует ИХ (второй строки нет, счёт — на них). Строки, уже
     * стоящие в счёте, — только подписью под таблицей.
     */
    async function showBookedRows(patientId) {
        let b;
        try { b = await loadTodayBooking(patientId); }
        catch (e) {
            toast(trf('Запись пациента на сегодня не загрузилась: {msg}', { msg: (e && e.message) || e }), 'warn');
            return;
        }
        if (!b || !b.visit || !state.patient || state.patient.id !== patientId) return;
        state.bookedVisitId = b.visit.id;
        const unpacked = [];   // CRM_LINK_ALL_V1 (ревью денег S3) — пакет снят со строки, ставшей строкой записи
        const skip = orderVsIds(state.doctorOrders);   // DOCTOR_REFERRAL_DESK_V1 — направления врача — своей группой
        for (const r of b.rows) {
            if (skip.has(Number(r.vsId))) continue;
            if (r.billed) continue;
            const service = r.consultationTypeId != null
                ? { id: 'c|' + (r.doctorId || '') + '|' + r.consultationTypeId, __consult: true, consultation_type_id: r.consultationTypeId,
                    __consultDoctorId: r.doctorId, name: r.name, price: r.unitPrice, requires_doctor: 1 }
                : ((state.catalog || []).find((s) => Number(s.id) === r.serviceId) || r.service);
            if (!service) continue;
            // CRM_LINK_ALL_V1 (редакция 2) — услуга уже в таблице (регистратор добавил её до
            // выбора пациента): строка записи прицепляется к ней, второй строки нет.
            // CRM_LINK_ALL_V1 (повторное ревью денег, S1) — правило «та же услуга» — одно с сетью
            // R7b (shared/same-service.js): у услуги без врача исполнитель не сравнивается.
            const bk = rowKey(service, r.doctorId);
            const twin = state.rows.find((x) => !x.booked && isBookedTwin(rowKey(x.service, x.doctorId), bk));
            // Своя строка записи — без проверки addLine: две строки записи одной услуги
            // (два исполнителя) — две строки визита, обе уже в нём.
            const row = twin || pushRow(service, r.doctorId ? { id: r.doctorId } : null);
            if (twin && r.doctorId && Number(twin.doctorId) !== Number(r.doctorId)) {
                twin.doctorId = r.doctorId;   // врач записи — строка уже в визите
                twin.doctor = null;
            }
            // CRM_LINK_ALL_V1 (ревью денег S3) — пакет на строку записи не ложится (её не вставляют).
            if (twin && twin.package) { delete twin.package; unpacked.push(service.name || ''); }
            row.booked = { vsId: r.vsId, status: b.visit.status, unitPrice: r.unitPrice };
            markBookedPerformer(row, r.doctorId);   // DIAG_ROUTE_V1 (ревью M-1)
        }
        if (unpacked.length) toast(trf('Уже из записи — по цене записи, без пакета: {names}', { names: unpacked.join(', ') }), 'info');
        const billed = b.rows.filter((r) => r.billed && !skip.has(Number(r.vsId))).map((r) => r.name).filter(Boolean);   // DOCTOR_REFERRAL_DESK_V1
        if (billed.length) {
            bookedNote.textContent = trf('По записи уже в счёте: {names}', { names: billed.join(', ') });
            bookedNote.style.display = '';
        }
        paintTable();
    }

    /** DOCTOR_REFERRAL_DESK_V1 — подпись строки направления: части через « · ». */
    function orderMeta(parts) {
        return parts.filter(Boolean).join(' · ');
    }

    // DOCTOR_REFERRAL_DESK_V1 — НАПРАВЛЕНИЯ ВРАЧА ПАЦИЕНТА (patient_referral_orders: своё
    // здание, сегодня и вперёд). Сегодняшние без счёта — готовые строки таблицы тем же
    // путём, что строки «из записи» (R7a): второй строки нет, счёт — на них. Остальное —
    // группой над таблицей: выставленные «ждёт оплаты в кассе», оплаченные, на другой день
    // (быстрая регистрация пишет только сегодняшний визит — их оформляет мастер визита),
    // рекомендации — «Добавить».
    async function showDoctorOrders(patientId) {
        let o;
        try { o = await loadDoctorOrders(patientId); }
        catch (e) {
            toast(trf('Направления врача не загрузились: {msg}', { msg: (e && e.message) || e }), 'warn');
            return;
        }
        if (!state.patient || state.patient.id !== patientId) return;
        state.doctorOrders = o;
        let otherVisit = false;
        for (const l of o.lines) {
            if (orderKind(l, o.today) !== 'ready') continue;
            if (addOrderRow(l) === 'other-visit') otherVisit = true;
        }
        if (otherVisit) toast(tr('Направления врача из другого визита — оформите их в окне визита.'), 'warn');
        paintTable();
        paintDoctorOrders();
    }

    /**
     * DOCTOR_REFERRAL_DESK_V1 — сегодняшняя строка направления без счёта → строка таблицы
     * (строка визита уже есть — в счёт идёт она). 'other-visit' — строка другого визита.
     */
    function addOrderRow(l) {
        const consult = l.service_id == null && l.consultation_type_id != null;
        if (l.service_id == null && !consult) return false;
        if (state.bookedVisitId && Number(state.bookedVisitId) !== Number(l.visit_id)) return 'other-visit';
        if (state.rows.some((x) => x.booked && Number(x.booked.vsId) === Number(l.visit_service_id))) return false;
        const service = consult
            ? { id: 'c|' + (l.doctor_id || '') + '|' + l.consultation_type_id, __consult: true, consultation_type_id: l.consultation_type_id,
                __consultDoctorId: l.doctor_id, name: l.name, price: l.unit_price, requires_doctor: 1 }
            : ((state.catalog || []).find((s) => Number(s.id) === Number(l.service_id))
                || { id: Number(l.service_id), name: l.name, price: Number(l.unit_price) || 0, requires_doctor: l.doctor_id ? 1 : 0, tax_rate: 0 });
        const bk = rowKey(service, l.doctor_id);
        const twin = state.rows.find((x) => !x.booked && isBookedTwin(rowKey(x.service, x.doctorId), bk));
        const row = twin || pushRow(service, l.doctor_id ? { id: l.doctor_id } : null);
        if (twin && l.doctor_id && Number(twin.doctorId) !== Number(l.doctor_id)) { twin.doctorId = Number(l.doctor_id); twin.doctor = null; }
        if (twin && twin.package) delete twin.package;   // строку не вставляют второй раз — пакета ей не дать
        row.booked = { vsId: Number(l.visit_service_id), status: l.visit_status, unitPrice: Number(l.unit_price) || 0,
            doctorOrder: true, referrerName: l.referrer_name || '', note: l.referral_note || '', bonus: l.bonus_to || [] };
        markBookedPerformer(row, l.doctor_id);   // DIAG_ROUTE_V1 (ревью M-1) — направление, сделанное до 3.21
        state.bookedVisitId = Number(l.visit_id);
        return true;
    }

    /**
     * DIAG_ROUTE_V1 (ревью M-1) — СТРОКА ЗАПИСИ (или направления врача) БЕЗ ИСПОЛНИТЕЛЯ у
     * услуги кабинета: прежде она регистрировалась и выставлялась без исполнителя — её не
     * видел ни один кабинет. Теперь выбор исполнителя у неё открыт (booked.setDoctor), один
     * кандидат — сам, сохранение без исполнителя отказывает (checkDoctors), а выбранного
     * регистрация записывает в строку визита до счёта (registerWalkIn → setLinePerformer).
     * Услуга без колонки группы (не из каталога) маршрута не называет — её не трогаем.
     */
    function markBookedPerformer(row, bookedDoctorId) {
        if (!row || !row.booked || Number(bookedDoctorId) > 0) return;
        const svc = row.service;
        if (!svc || (!svc.__consult && !Object.prototype.hasOwnProperty.call(svc, 'type')) || !needsPerformer(svc)) return;
        row.booked.setDoctor = true;
        if (row.doctorId == null) {
            const one = soleCandidate(doctorPoolFor(state.doctors, svc));
            if (one) { row.doctorId = Number(one.id); row.doctor = { id: one.id, full_name: one.full_name }; }
        }
    }

    function paintDoctorOrders() {
        clear(doctorOrdersEl);
        const o = state.doctorOrders;
        const inTable = new Set(state.rows.filter((r) => r.booked).map((r) => Number(r.booked.vsId)));
        const added = new Set(state.rows.filter((r) => r.fromRec).map((r) => Number(r.fromRec)));
        const lines = o ? o.lines.filter((l) => !inTable.has(Number(l.visit_service_id))) : [];
        const recs = o ? o.recommendations.filter((r) => !added.has(Number(r.recommendation_id))) : [];
        doctorOrdersEl.style.display = lines.length || recs.length ? '' : 'none';
        if (!lines.length && !recs.length) return;
        const rowCss = { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '6px 0', borderTop: '1px solid var(--info-100, #dbeafe)' };
        doctorOrdersEl.appendChild(h('div', { class: 'cell-strong', style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13.5px', marginBottom: '4px' } },
            Icon('Stethoscope', { size: 14 }), tr('Направления врача')));
        for (const l of lines) {
            const st = orderStateText(l, o.today);
            const bonus = bonusText(l.bonus_to);
            const kind = orderKind(l, o.today);
            doctorOrdersEl.appendChild(h('div', { 'data-doctor-order': String(l.visit_service_id), style: rowCss },
                h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '13.5px' } }, l.name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, orderMeta([
                        trf('от врача · {name}', { name: l.referrer_name || '—' }), trf(st.template, st.params),
                        bonus ? trf(bonus.template, bonus.params) : null])),
                    l.referral_note ? h('div', { class: 'muted', style: { fontSize: '12.5px', fontStyle: 'italic' } }, l.referral_note) : null),
                kind === 'future'
                    ? h('span', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, tr('оформляется в мастере визита'))
                    // Сегодняшняя без счёта, убранная из таблицы, — вернуть её строкой.
                    : kind === 'ready' && !locked()
                        ? h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-doctor-order-add': String(l.visit_service_id),
                            onclick: () => {
                                if (locked()) return;
                                if (addOrderRow(l) === 'other-visit') toast(tr('Направления врача из другого визита — оформите их в окне визита.'), 'warn');
                                paintTable();
                                paintDoctorOrders();
                            } }, Icon('Plus', { size: 12 }), ' ', tr('Добавить'))
                        : null));
        }
        for (const r of recs) {
            const bonus = bonusText(r.bonus_to, r.bonus_if_other, r.bonus_if_self);   // ревью U10 LOW-7 — рекомендатель — условием; ревью полировки L2 — и направивший визита
            doctorOrdersEl.appendChild(h('div', { 'data-doctor-rec': String(r.recommendation_id), style: rowCss },
                h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '13.5px' } }, r.name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, orderMeta([
                        trf('от врача · {name}', { name: r.referrer_name || '—' }), tr('рекомендация врача'),
                        bonus ? trf(bonus.template, bonus.params) : null])),
                    r.notes ? h('div', { class: 'muted', style: { fontSize: '12.5px', fontStyle: 'italic' } }, r.notes) : null),
                r.service_id != null && !locked()
                    ? h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-doctor-rec-add': String(r.recommendation_id),
                        onclick: () => addRecRow(r) }, Icon('Plus', { size: 12 }), ' ', tr('Добавить'))
                    : null));
        }
    }

    /** DOCTOR_REFERRAL_DESK_V1 — «Добавить» рекомендацию: строка таблицы, помнящая рекомендацию. */
    function addRecRow(r) {
        if (locked()) return;
        const service = (state.catalog || []).find((s) => Number(s.id) === Number(r.service_id));
        if (!service) { toast(tr('Услуги рекомендации нет в каталоге — добавьте её вручную.'), 'warn'); return; }
        const row = addLine(service, null);
        if (row && !row.booked) row.fromRec = Number(r.recommendation_id);
        paintTable();
        paintDoctorOrders();
    }

    async function usePatient(p, { load = false } = {}) {
        clearBookedRows();   // CRM_LINK_ALL_V1 (R7a)
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
        // DOCTOR_REFERRAL_DESK_V1 — сначала направления врача: их строки «из записи» не берёт.
        // У карты, заведённой здесь же, направлений нет — сервер не спрашиваем.
        if (!patientCreatedHere) await showDoctorOrders(chosen.id);
        await showBookedRows(chosen.id);   // CRM_LINK_ALL_V1 (R7a)
        await loadDiscountChoices(chosen.id);   // DISCOUNT_V2
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
    // DIAG_ROUTE_V1 (D1, решение владельца 2026-11-03) — и у КАЖДОЙ услуги кабинета врача
    // (всё, кроме групп «Лаборатория» и «Процедуры»): без исполнителя строку не увидит ни один врач.
    function checkDoctors() {
        for (const row of state.rows) {
            // DIAG_ROUTE_V1 (ревью M-1) — и строка «из записи» без исполнителя: её исполнителя
            // назначают здесь (markBookedPerformer), с исполнителем — врач записи, проверка проходит.
            if (!row.doctorId && (row.service.requires_doctor || ((!row.booked || row.booked.setDoctor) && needsPerformer(row.service)))) {
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
        // LIVE_AUDIT_FIX_V1 (A4/A5) — строки проверяются ДО заведения карты:
        // «Строка без услуги» и хирургия без койки приходили уже после того,
        // как карта пациента легла в базу.
        if (state.rows.length) {
            const lines = state.rows.map((r) => ({ service: r.service, doctorId: r.doctorId }));
            const bad = walkInLinesRefusal(lines)
                || (!state.patient && state.rows.some((r) => isSurgeryPick(r.service)) ? tr(SURGERY_NEEDS_BED_TEXT) : null)
                || (state.patient ? await surgeryBedRefusal(state.patient.id, state.rows.map((r) => r.service)) : null);
            if (bad) { toast(bad, 'fail'); return null; }
        }
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
                // CRM_LINK_ALL_V1 (R7a) — строки «из записи» регистрируются как есть, убранные снимаются.
                lines: state.rows.map((r) => ({ service: r.service, doctorId: r.doctorId, packageId: r.package ? r.package.id : null,
                    bookedVsId: r.booked ? r.booked.vsId : null, bookedUnitPrice: r.booked ? r.booked.unitPrice : null,
                    bookedSetDoctor: !!(r.booked && r.booked.setDoctor),   // DIAG_ROUTE_V1 (ревью M-1) — исполнитель строки записи
                    recommendationId: r.fromRec || null })),   // DOCTOR_REFERRAL_DESK_V1 — строка по рекомендации врача
                dropVsIds: state.dropBooked,
                bookedVisitId: state.bookedVisitId,
                referralSourceId: referralSel.value || null,
                // DISCOUNT_V2 — выбранная скидка (одна); промокод — его стоимость на смете, сервер проверит и зажмёт.
                // ревью S1 L-3 — группа пациента не прочиталась и человек не выбирал — выбор не шлётся (пол группы — сервер).
                discount: { ...choiceArgs(choiceToSend(state.discountChoice, { groupKnown: state.groupKnown, picked: state.discountPicked })), discount_amount: String(state.discountChoice).startsWith('promo:') ? chosenDiscountBefore() : 0 },
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
        // CRM_REAL_BOOKING_V1 — визит дня перенесли: прежнего часа у пациента
        // больше нет, и сказать это надо сейчас, пока он у стойки.
        if (res.movedNote) toast(res.movedNote, 'info');
        if (res.quoteError) toast(trf('Тариф визита не спрошен: {msg}', { msg: res.quoteError }), 'warn');
        if (res.queueError) toast(trf('Номера очереди не выданы: {msg}', { msg: res.queueError }), 'warn');
        if (res.attachError) toast(trf('Рекомендация врача не закрыта: {msg}', { msg: res.attachError }), 'warn');   // DOCTOR_REFERRAL_DESK_V1
        // CRM_LINKS_V1 — ЗАПИСАННЫЙ ПО ТЕЛЕФОНУ ПРИШЁЛ И ОФОРМЛЕН ЗДЕСЬ.
        //
        // Строки заявки колл-центра закрывает СЕРВЕР, в той же транзакции, где
        // заводится визит (ensure_visit → settleCrmForVisit). Здесь стоял вызов
        // closeCrmLinesForPatient(), и он не работал НИКОГДА: его звали ПОСЛЕ
        // ensure_visit, а искал он родителей по ОТКРЫТЫМ ступеням — к тому
        // моменту сервер уже перевёл заявку в «Пришёл», открытых не
        // находилось, и строки оставались «pending». Окно оформляет визит и
        // счёт; про заявку оно больше не знает ничего — два писателя одной
        // таблицы дают заявке две разные истории.
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
        // INVOICE_APPEND_V1 (ревью m3) — дописанный счёт не «создан»: строки легли
        // в уже выставленный счёт визита, так и сказано.
        footHint.textContent = state.result && state.result.appended
            ? trf('Пациент и визит записаны, услуги добавлены в счёт № {no}. Печать счёта — кнопкой в шапке таблицы.', { no: (inv && (inv.invoice_number || inv.id)) || '—' })
            : tr('Пациент, визит и счёт созданы. Печать счёта — кнопкой в шапке таблицы.');
        paintTable();
        // INVOICE_APPEND_V1 — тот же номер, новая сумма: так и сказано.
        toast(state.result && state.result.appended
            ? invoiceAppendNote({ appended: true, invoice: inv })
            : tr('Пациент зарегистрирован, счёт выставлен.'));
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
        // INVOICE_APPEND_V1 — дописанный счёт печатается ЦЕЛИКОМ, из строк сервера
        // (receipt-print.js, как в мастере визита): бланк ниже собран из строк
        // этой таблицы и разошёлся бы с номером и суммой счёта.
        if (state.result.appended) {
            printInvoiceSheetById({ supabase, printableSheet, invoiceId: inv.id, title: 'Амбулаторные услуги', withPerformer: true })   // i18n-exempt: печатный счёт (бланк) — печатный документ
                .then((r) => { if (r && !r.ok) toast(trf('Счёт не напечатан: {msg}', { msg: tr(r.reason) }), 'fail'); })
                .catch((e) => toast(trf('Счёт не напечатан: {msg}', { msg: (e && e.message) || e }), 'fail'));
            return;
        }
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
            issueDate: new Date().toLocaleDateString('ru-RU'),   // V3120_FIX — «Дата» ставит бланк; было «Дата Дата …»
            status: 'unpaid',   // V3120_FIX — код, слово ставит бланк (было «UNPAID»)
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
                // PACKAGES_V1 — позиция счёта в том же порядке, что строки
                // (registerWalkIn → create_invoice_for_visit); сверка по услуге.
                const item = (state.result.items || [])[i];
                const lineOff = item && Number(item.service_id) === Number(row.service.id) ? item.discount_amount : 0;
                return {
                    // CLINIC_API_FIX_V1 — «пакет» на счёте только у пакета со скидкой (не у шаблона сметы).
                    name: packageItemName((row.service.name || '') + (dn ? ' · ' + dn : ''), packageLabel(row.package), lineOff),
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
                supabase.from('services').select('id, name, price, tax_rate, requires_doctor, active, category_id, ' + ROUTE_SELECT).eq('active', true).order('name').limit(1000),   // ROUTE_SELECT: DIAG_ROUTE_V1 — маршрут группы «Консультации»
                // EASYMED_DOCTOR_DETECTION — список врачей проверяет is_doctor, а
                // не role: у администратора-врача роли 'doctor' нет вовсе.
                // DIAG_ROUTE_V1 (D1) — и все, кому услуга отмечена в «Услугах и ставках» (медсестра на УЗИ):
                // performerCandidates; фолбэк «все врачи» — по is_doctor (doctorPoolFor).
                supabase.from('users').select('id, full_name, is_doctor, service_rates').eq('active', true).order('full_name'),
                supabase.from('referral_sources').select('id, name, code, category_id, doctor_id, active').eq('active', true).order('code'),
            ]);
            state.catalog = (svcRes && svcRes.data) || [];
            state.doctors = performerCandidates((docRes && docRes.data) || []);   // DIAG_ROUTE_V1 (D1)
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
        doctorOrdersEl,   // DOCTOR_REFERRAL_DESK_V1
        // FAST_REG_LAYOUT_V1 — два блока окна: реквизиты и услуги.
        patientBlock, servicesBlock, formEl: api.formEl,
    };
}
