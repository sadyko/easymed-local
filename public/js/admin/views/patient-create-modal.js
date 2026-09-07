// PATIENT_ONE_WINDOW_V1 (2026-09-05) — заведение пациента ОДНИМ окном без
// прокрутки (docs/plans/2026-09-05-ui-redesign-and-calendar.md, задача 7).
//
// Что было: views/registration.js рисовал ЦЕЛУЮ СТРАНИЦУ — шапка раздела,
// левая карточка из пяти пронумерованных разделов и липкая правая колонка.
// На 1366×768 в неё помещалось около 800–900 px, а содержимого было
// 1150–1300 px, поэтому два раздела из пяти уже пришлось свернуть в
// «гармошку»: регистратор заводил человека, листая страницу.
//
// Что стало: тот же набор полей живёт в двухколоночном сгруппированном окне
// (.modal-card.modal-grouped.has-groups — образец visit-modal.js), а лишнее
// убрано за раскрытие «Подробнее» ВНУТРИ того же окна. Плотность даёт не
// мелкий шрифт (12.5 px — пол шкалы, закреплённый type-scale.test.mjs), а
// поле высотой 32 px вместо 38 и окно шириной 1240 px вместо страницы:
// поля стали КОРОЧЕ, а окно ШИРЕ.
//
// Высота первого экрана не «на глаз»: LAYOUT ниже описывает ряды, METRICS —
// размеры из admin.css, firstScreenHeight() их складывает, а
// __tests__/patient-create-modal.test.mjs сверяет METRICS с самим CSS и
// проверяет, что сумма влезает в calc(100vh - 60px) и при 768, и при 648
// (то же 768-е железо, но в окне Chrome с его панелями).
//
// Сохранены ВСЕ возможности прежней страницы: живой поиск существующего
// пациента, серверный страж дубликатов с принудительным созданием, правило
// «голый +998 сохраняется пустым», расчёт возраста, автоподстановка
// категории по возрасту, каскад страна→регион→район, съёмка с веб-камеры,
// блок Telegram и обе кнопки подвала (сохранить · сохранить и добавить
// услугу).

import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
// MOTION_DIALOG_V1 — окно ОТКРЫВАЕТСЯ чистым CSS (правило на .modal), а
// закрывается через общий помощник: угасание и снятие из документа одной
// строкой. Помощник обязан убрать окно в любом случае — нет анимации (старый
// браузер, «меньше движения», фоновая вкладка) — убирает немедленно.
import { fadeOutAndRemove } from '../motion.js?v=mo1';
import { h, Icon, toast, clear, fmtDate } from '../ui.js';
import { savePatient, loadPatientById } from '../data.js';
import { supabase } from '../../supabase.js';
import { uploadFile } from '../storage.js';
import { phoneInput, isCodeOnly } from '../phone-input.js?v=ph1';
// PATIENT_CREATE_GATE_V1 — заведение пациента снова под правом. Ключ тот же,
// что проверял маршрут #registration до PATIENT_ONE_WINDOW_V1; спрашивается он
// в openPatientCreateModal() — единственной двери этого окна.
import { canCreatePatient } from '../permissions.js';
import { openAccessDeniedDialog } from '../access-denied.js';
// PATIENT_PHOTO_V1 — правила фотографии ОДНИ на браузер и сервер
// (public/js/shared/), как у вложений карты. Здесь они стоят, чтобы отказ
// пришёл СРАЗУ и назвал причину, а не после отправки восьми мегабайт по
// клинической сети; сервер проверяет то же самое ещё раз.
import { photoRefusal, ALLOWED_PHOTO_EXT } from '../../shared/patient-file-limits.js?v=pph1';
import { downscalePhoto } from '../../shared/photo-downscale.js?v=pph1';

// AURORA_REG_FORM_V1 — корзина фотографий: photo_url хранит постоянный URL,
// который карточка пациента отдаёт прямо в <img src>.
//
// PATIENT_PHOTO_V1 (2026-09-05) — эта корзина НЕ БЫЛА ОБЪЯВЛЕНА на сервере
// (routes/storage.js BUCKETS), поэтому каждая загрузка отсюда — и съёмка с
// веб-камеры, и выбор файла — отвечала 400 «Invalid storage path». Форма пути
// («patients/<ключ>», ровно два сегмента) теперь ЧАСТЬ ДОГОВОРА: сервер
// проверяет по ней право, и путь другой формы в эту корзину не примут.
const PHOTO_BUCKET = 'patient-photos';
const PHOTO_PREFIX = 'patients/';

// ===========================================================================
// Модель высоты. Числа — из admin.css (блок .mg-dense); тест сверяет их с CSS,
// поэтому «подогнать модель» под желаемый ответ нельзя, не подогнав вёрстку.
// ===========================================================================
export const METRICS = Object.freeze({
    cardWidth:       1240,   // ширина окна, px (визуально — как у visit-modal.js)
    viewportGap:     60,     // .modal-card { max-height: calc(100vh - 60px) }
    headPadV:        16,     // .modal-head { padding: 16px 22px }
    headRowH:        32,     // самый высокий элемент шапки — красная «Закрыть» (9+9 + строка 13.5)
    footPadV:        14,     // .modal-foot { padding: 14px 22px }
    footRowH:        36,     // .btn { height: 36px }
    sectionPadV:     14,     // .mg-dense .mg-section { padding: 14px 22px }
    sectionTitleH:   17,     // .mg-dense .mg-section h3 { line-height: 17px }
    sectionTitleGap: 14,     // 10 (зазор раздела) + 4 (h3 margin-bottom) — SECTION_HEAD_AIR_V1
    labelH:          17,     // .mg-dense .field label { line-height: 17px }
    labelGap:        4,      // .mg-dense .field { gap: 4px }
    fieldH:          32,     // .mg-dense .field input/select { height: 32px }
    rowGap:          10,     // .mg-dense .mg-grid { gap: 10px } — и он же зазор секции
    moreRowH:        38,     // .mg-more-btn { height: 38px }
    border:          1,
});

// Первый экран, рядами. Меняешь состав окна — меняется и посчитанная высота.
export const LAYOUT = Object.freeze({
    // Строка поиска существующего пациента — во всю ширину, над колонками.
    search: Object.freeze({ labelled: true, rows: 1 }),
    // PATIENT_FORM_REWRITE_V1 — три раздела ОДИН ПОД ДРУГИМ во всю ширину.
    // Колонок больше нет, поэтому высоты складываются, а не берутся по
    // максимуму. Фото стоит СБОКУ от рядов первого раздела и его высоты не
    // добавляет — плитка растянута ровно по ним (.pc-id-photo в admin.css).
    s1: Object.freeze(['last/first/middle', 'dob/age/sex', 'phone/phone2/email']),
    s2: Object.freeze(['residency/lang', 'pinfl/document/citizenship', 'category/behaviour']),
    s3: Object.freeze(['country/region/district', 'mahalla/street']),
});

function fieldRowH() { return METRICS.labelH + METRICS.labelGap + METRICS.fieldH; }

function sectionH(rows, { titled = true, extraRows = [] } = {}) {
    const all = [...Array(rows).fill(fieldRowH()), ...extraRows];
    if (!all.length) return 0;
    const body = all.reduce((a, b) => a + b, 0) + (all.length - 1) * METRICS.rowGap;
    const head = titled ? METRICS.sectionTitleH + METRICS.sectionTitleGap : 0;
    return METRICS.sectionPadV * 2 + head + body + METRICS.border;
}

export function headHeight() { return METRICS.headPadV * 2 + METRICS.headRowH + METRICS.border; }
export function footHeight() { return METRICS.footPadV * 2 + METRICS.footRowH + METRICS.border; }

/** Высота всего содержимого окна: прятать в нём больше нечего. */
export function firstScreenHeight() {
    const search = sectionH(LAYOUT.search.rows, { titled: false });
    return headHeight() + search
        + sectionH(LAYOUT.s1.length) + sectionH(LAYOUT.s2.length) + sectionH(LAYOUT.s3.length)
        + footHeight();
}

/** Влезает ли окно в высоту innerH без прокрутки. */
export function fitsViewport(innerH) {
    return firstScreenHeight() <= innerH - METRICS.viewportGap;
}

// ===========================================================================
// Публичный вход
// ===========================================================================

/**
 * Открыть окно заведения пациента.
 * @param {object}   opts
 * @param {Function} opts.onNavigate  переход по приложению (как в ctx)
 * @param {Function} [opts.onSaved]   вызывается с сохранённым пациентом
 */
export function openPatientCreateModal(opts = {}) {
    // PATIENT_CREATE_GATE_V1 — ЕДИНСТВЕННАЯ проверка права на заведение
    // пациента, и стоит она здесь, потому что здесь сходятся ВСЕ входы: пустой
    // список, калькулятор услуг, кнопка шапки списка (views/patients.js) и сам
    // маршрут #registration (views/registration.js). Три копии проверки на
    // трёх кнопках разошлись бы при первой же новой кнопке — эта не разойдётся.
    // Отказ — видимый, тем же оформлением, каким оболочка отказывает маршруту:
    // кнопка, которая молча ничего не делает, читается как поломка.
    if (!canCreatePatient()) { openAccessDeniedDialog(); return null; }
    const dlg = buildPatientCreateDialog(opts);
    document.body.appendChild(dlg.overlay);
    document.addEventListener('keydown', dlg.onKey);
    setTimeout(() => { try { dlg.fields.last_name.focus(); } catch (e) { /* нет фокуса — не беда */ } }, 30);
    return dlg;
}

/**
 * Собрать окно, НЕ вставляя его в документ. Отдельно от open* ради теста:
 * проверять состав первого экрана, раскрытие и сбор значений можно без
 * document.body и без таймеров.
 */
export function buildPatientCreateDialog({ onNavigate, onSaved } = {}) {
    const navigate = typeof onNavigate === 'function' ? onNavigate : () => {};
    const state = {
        gender:      '',
        residency:   'resident',   // → patients.citizenship
        photoFile:   null,
        photoUrl:    '',
        tgSent:      false,
        moreOpen:    false,
    };
    // Реестр полей. Собираем значения ПО НЕМУ, а не querySelectorAll по DOM:
    // телефонный контрол — обёртка со своим .value (голый «+998» отдаёт пустоту),
    // и обход живого дерева этого не увидел бы.
    const fields = {};
    const phoneFields = new Set();
    const reg = (name, el) => { fields[name] = el; return el; };
    const regPhone = (name, el) => { phoneFields.add(name); return reg(name, el); };

    const overlay = h('div', { class: 'modal', style: { zIndex: '150' } });
    const close = () => { document.removeEventListener('keydown', onKey); fadeOutAndRemove(overlay); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // MODAL_COMPACT_OPTOUT_V1 — .modal-compact ОБЯЗАТЕЛЕН, а не украшение:
    // admin.css растягивает всякую .modal-card, кроме помеченной этим классом,
    // до calc(100vw - 24px) × calc(100vh - 24px) с !important — а авторский
    // !important бьёт встроенный стиль, поэтому width: 1240px ниже без этого
    // класса не значил ничего. На мониторе 1920 выверенная двухколоночная
    // вёрстка расползалась на 1896 px. Тем же классом пользуются десять других
    // окон (admission-modal, cashier-desk, crm…).
    const card = h('div', {
        // PATIENT_FORM_REWRITE_V1 — `has-groups` убран: разделы идут ОДИН ПОД
        // ДРУГИМ во всю ширину, как на образце. Двухколоночная раскладка
        // экономила высоту, но разрывала порядок: «Документы» читались справа
        // от «Личных данных», а не после них.
        class: 'modal-card modal-grouped mg-dense modal-compact pc-form',
        'data-dialog': 'patient-create',
        style: {
            width: METRICS.cardWidth + 'px',
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: 'calc(100vh - ' + METRICS.viewportGap + 'px)',
        },
    });
    overlay.appendChild(card);

    // PATIENT_FORM_REWRITE_V1 — приглашение в Telegram переехало в ШАПКУ.
    // Это не поле карты, а действие над пациентом: раньше оно стояло полем в
    // ряду с адресом и гражданством, и его искали глазами среди того, что
    // заполняют. Номер берётся у поля телефона этого же окна.
    const tg = telegramBlock(state, () => fields.phone && fields.phone.value);
    card.appendChild(h('header', { class: 'modal-head' },
        h('h2', null, Icon('Patients', { size: 16 }), ' ', tr('Создать пациента')),
        h('span', { class: 'grow' }),
        tg,
        h('button', { class: 'modal-close', onclick: close }, '×'),
    ));

    const body = h('div', { class: 'modal-body' });
    card.appendChild(body);

    // ---- Поиск существующего пациента (одной строкой, во всю ширину) -------
    const search = searchStrip(navigate, close);
    body.appendChild(search.el);

    // ---- Левая колонка: личные данные --------------------------------------
    // DATE_NUMERIC_V1 — дата рождения показана цифрами: её сверяют с паспортом.
    // Подпись пустого поля — сама дата примером: «15.11.1994» объясняет порядок
    // чисел лучше, чем «ДД.ММ.ГГГГ», и не требует расшифровки.
    // `autocomplete="bday"` — браузер знает это поле в лицо и подставляет
    // сохранённую дату рождения; `off` здесь просто отказывался от помощи.
    const dobInput = reg('date_of_birth', h('input', {
        name: 'date_of_birth', type: 'date', placeholder: '15.11.1994',
        'data-date-numeric': '', autocomplete: 'bday',
    }));
    const ageInput = h('input', { name: '__age', readOnly: true, placeholder: '—' });
    const categorySel = reg('category_id', categorySelect());   // CATEGORY_DISCOUNT_V1 — имя поля = имя колонки, иначе collect() соберёт ключ, который сервер молча выбросит
    dobInput.addEventListener('input', () => {
        const age = computeAge(dobInput.value);
        ageInput.value = (age == null || age < 0 || age > 130) ? '' : String(age);
        // Подставляем ТОЛЬКО если такая категория есть в справочнике клиники.
        if (!categorySel.value) categorySel.value = categoryOptionByName(categorySel, categoryFromAge(age));
    });

    const sexChips = radioChips('gender',
        [['M', 'Мужской'], ['F', 'Женский']],
        () => state.gender,
        (v) => { state.gender = v; },
        { nowrap: true });

    // ── Раздел 1: личные данные ────────────────────────────────────────────
    // Фото стоит ПЛИТКОЙ слева и держит три ряда полей: карта пациента узнаётся
    // в лицо, и прятать снимок за раскрытием было неправильно. Email здесь же,
    // рядом с телефонами: это способ связи, а не документ.
    const photo = photoBlock(state);
    const geo   = geoCascade();
    reg('country',  geo.countrySel);
    reg('region',   geo.regionSel);
    reg('district', geo.districtSel);

    body.appendChild(mgSection('Личные данные', [
        h('div', { class: 'pc-id' },
            h('div', { class: 'pc-id-photo' }, photo.el),
            h('div', { class: 'pc-id-fields' },
                mgGrid(3,
                    field(['Фамилия ', req()], reg('last_name',   nameInput('last_name',   'Каримова'))),
                    field(['Имя ',     req()], reg('first_name',  nameInput('first_name',  'Азиза'))),
                    field('Отчество',          reg('middle_name', nameInput('middle_name', 'Рустамовна'))),
                ),
                mgGrid(3,
                    field(['Дата рождения ', req()], dobInput),
                    field('Возраст', ageInput),
                    field(['Пол ', req()], sexChips),
                ),
                mgGrid(3,
                    // REQUIRED_HONEST_V1 — у телефона звёздочки НЕТ: правило «голый
                    // +998 сохраняется пустым» означает, что карта без номера — штатный
                    // случай (сопровождающий, ребёнок, экстренный приём).
                    field('Номер телефона',      regPhone('phone',           phoneInput('phone', '+998 90 961 00 04'))),
                    field('Доп. номер телефона', regPhone('phone_secondary', phoneInput('phone_secondary', '+998 90 000 00 00'))),
                    field('Email', reg('email', h('input', { name: 'email', placeholder: 'name@example.com' }))),
                ),
            ),
        ),
    ], { step: 1 }));

    // ── Раздел 2: документы и резидентство ─────────────────────────────────
    // Резидентство и язык — сверху: от них зависит, какие документы вообще
    // спрашивать и на каком языке разговаривать с пациентом.
    body.appendChild(mgSection('Документы и резидентство', [
        mgGrid(3,
            field('Резидентство', radioChips('__residency',
                [['resident', 'Резидент РУз'], ['nonresident', 'Нерезидент']],
                () => state.residency,
                (v) => { state.residency = v; }), 2),
            field('Предпочитаемый язык', reg('language', select('language', ['Узбекский', 'Русский', 'Английский', 'Каракалпакский']))),
        ),
        mgGrid(3,
            field('ПИНФЛ (ЖШШИР)',        reg('national_id',     h('input', { name: 'national_id', placeholder: '14 цифр', maxLength: '14' }))),
            field('Паспорт / документ №', reg('passport_number', h('input', { name: 'passport_number', placeholder: 'AB1234567' }))),
            field('Гражданство / национальность', reg('nationality', h('input', { name: 'nationality', placeholder: 'Узбек' }))),
        ),
        // Категория несёт скидку группы (CATEGORY_DISCOUNT_V1), поведение —
        // предупреждение для регистратуры. Ни того, ни другого на образце нет,
        // но обе возможности живые: категория считает деньги, а предупреждение
        // читают перед приёмом. Место им здесь — это тоже «учёт пациента».
        mgGrid(3,
            field('Категория пациента', categorySel),
            field('Поведение / предупреждение',
                reg('behavior_note', h('textarea', {
                    name: 'behavior_note', rows: '1',
                    placeholder: 'напр. Грубил регистратуре; приходил в нетрезвом виде.',
                })), 2),
        ),
    ], { step: 2 }));

    // ── Раздел 3: контакты и адрес ─────────────────────────────────────────
    body.appendChild(mgSection('Контакты и адрес', [
        mgGrid(3,
            field('Страна', geo.countrySel),
            field('Регион', geo.regionSel),
            field('Район',  geo.districtSel),
        ),
        mgGrid(3,
            field('Махалля', reg('mahalla', h('input', { name: 'mahalla', placeholder: 'Юнусабад-3' }))),
            field('Улица, дом, квартира', reg('address', h('input', { name: 'address', placeholder: 'ул. Амира Темура 12, кв. 47' })), 2),
        ),
    ], { step: 3 }));

    // PATIENT_FORM_REWRITE_V1 — раскрытия «Подробнее» больше нет: всё, что оно
    // прятало, разошлось по трём разделам выше. setMore/isMoreOpen оставлены
    // заглушками — их зовут снаружи (возврат из мастера услуг открывал окно
    // сразу раскрытым), и падать на несуществующей функции они не должны.
    function setMore() { state.moreOpen = false; }

    // ---- Подвал -------------------------------------------------------------
    // PATIENT_FORM_REWRITE_V1 — подвал по образцу: «Отмена» и «Создать
    // пациента». «Добавить услугу» ОСТАВЛЕНА третьей кнопкой: на образце её
    // нет, но это дневной путь регистратуры — завести карту и сразу выписать
    // услугу; убрать её значило бы заставить искать пациента заново сразу
    // после того, как его завели.
    const cancelBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: close },
        tr('Отмена'));
    const saveAndServiceBtn = h('button', { class: 'btn btn-outline', type: 'button',
        onclick: (ev) => guarded(ev, () => save({ openVisit: true })) },
        Icon('Plus', { size: 14 }), ' ', tr('Добавить услугу'));
    const saveOnlyBtn = h('button', { class: 'btn btn-primary', type: 'button',
        onclick: (ev) => guarded(ev, () => save({ openVisit: false })) },
        Icon('Check', { size: 14 }), ' ', tr('Создать пациента'));
    // Горячая клавиша, о которой нигде не написано, не существует: подпись в
    // подвале — часть самой возможности, а не украшение.
    card.appendChild(h('footer', { class: 'modal-foot' },
        h('span', { class: 'mg-hint' }, h('kbd', null, 'Enter'), ' ', tr('— сохранить пациента')),
        h('span', { class: 'grow' }),
        cancelBtn,
        saveAndServiceBtn,
        saveOnlyBtn,
    ));

    // PATIENT_FORM_FLOW_V1 — Enter сохраняет пациента.
    //
    // Нажатие пропускается там, где Enter уже занят и значит другое:
    //   • <textarea> «Поведение» — там это перенос строки;
    //   • кнопка или ссылка в фокусе — Enter обязан нажать ИХ, иначе «Добавить
    //     услугу» с клавиатуры срабатывала бы как «Сохранить»;
    //   • открытый список (.uisel-pop) или календарь (.uidate-pop) — Enter
    //     выбирает строку в нём;
    //   • строка поиска существующего пациента — она ищет ДУБЛИКАТЫ, и
    //     сохранять по Enter оттуда значило бы заводить второго такого же
    //     ровно в тот миг, когда регистратор проверяет, нет ли первого;
    //   • ввод с подсказкой (isComposing) — там Enter подтверждает подсказку.
    function onEnter(e) {
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.isComposing || e.keyCode === 229) return;
        const t = e.target;
        const tag = ((t && t.tagName) || '').toLowerCase();
        if (tag === 'textarea' || tag === 'button' || tag === 'a') return;
        if (t && t.closest && t.closest('.mg-search')) return;
        if (typeof document !== 'undefined' && document.querySelector
            && document.querySelector('.uisel-pop, .uidate-pop')) return;
        e.preventDefault();
        if (saveOnlyBtn.disabled) return;
        saveOnlyBtn.click();
    }
    card.addEventListener('keydown', onEnter);

    function guarded(ev, fn) {
        const b = ev && ev.currentTarget;
        if (b && b.disabled) return;
        if (b) b.disabled = true;
        Promise.resolve(fn()).finally(() => { if (b) b.disabled = false; });
    }

    // ---- Сбор и сохранение ---------------------------------------------------
    function collect() {
        const payload = {};
        for (const [name, el] of Object.entries(fields)) {
            if (name.startsWith('__')) continue;
            // PHONE_INPUT_V1 — поле телефона предзаполнено «+998», поэтому
            // нетронутое поле всё равно НЕ пустое. Обёртка phoneInput отдаёт
            // пустоту сама; проверку повторяем явно, чтобы правило было видно
            // здесь, а не только в чужом модуле. Телефон узнаём по реестру, а
            // не по наличию свойства .input у элемента: «есть .input — значит
            // телефон» ломается о любой элемент с таким же именем.
            if (phoneFields.has(name)) {
                const inner = el.input;
                payload[name] = (inner && isCodeOnly(inner.value)) ? '' : el.value;
            } else {
                payload[name] = el.value;
            }
        }
        payload.gender = state.gender;
        payload.citizenship = state.residency === 'nonresident' ? 'nonresident' : 'resident';

        // REQUIRED_HONEST_V1 — звёздочка теперь значит проверку. Обязательны
        // фамилия, имя, дата рождения и пол: возраст и пол задают нормы
        // анализов, дозировки и печатные бланки, и карта без них опасна.
        if (!String(payload.last_name || '').trim() || !String(payload.first_name || '').trim()) {
            toast('Фамилия и имя обязательны.', 'fail');
            return null;
        }
        if (!payload.date_of_birth) {
            toast('Укажите дату рождения — от неё зависят возраст, категория и нормы анализов.', 'fail');
            return null;
        }
        const age = computeAge(payload.date_of_birth);
        if (age == null || age < 0 || age > 130) {
            toast('Проверьте дату рождения — такого возраста не бывает.', 'fail');
            return null;
        }
        if (!payload.gender) {
            toast('Укажите пол — от него зависят нормы анализов и печатные бланки.', 'fail');
            return null;
        }
        return payload;
    }

    async function save({ openVisit = false, force = false } = {}) {
        const payload = collect();
        if (!payload) return null;
        const photoUrl = await uploadPendingPhoto(state);
        if (photoUrl) payload.photo_url = photoUrl;
        if (state.tgSent) {
            payload.telegram_opt_in = true;
            payload.telegram_invited_at = new Date().toISOString();
        }
        let patient;
        try {
            patient = await savePatient(payload, { force });
        } catch (e) {
            if (e && e.code === 'DUPLICATE_PATIENT' && e.existing) {
                openDuplicatePatientDialog(e, {
                    onOpenExisting: async (c) => {
                        const p = await loadPatientById(c.id).catch(() => null);
                        close();
                        if (p) navigate('patient-card', p);
                        else   toast('Не удалось открыть карту пациента.', 'fail');
                    },
                    onForceCreate: () => save({ openVisit, force: true }),
                });
                return null;
            }
            toast(trf('Не удалось сохранить: {msg}', { msg: (e && e.message) || e }), 'fail');
            return null;
        }
        close();
        toast('Пациент сохранён.');
        if (typeof onSaved === 'function') onSaved(patient);
        else navigate('patients');
        // REG_ADD_SERVICE_V1 — мастер услуг монтируется в document.body и
        // переживает переход; грузим его лениво, чтобы окно заведения пациента
        // не тянуло каталог услуг при каждом открытии.
        if (openVisit && patient && patient.id) {
            import('./visit-wizard.js?v=aug17e')
                .then((mod) => mod.openVisitWizard(null, {
                    id: patient.id, full_name: patient.fullName, mrn: patient.mrn, phone: patient.phone,
                }))
                .catch((e) => toast(trf('Не удалось открыть мастер услуг: {msg}', { msg: (e && e.message) || e }), 'fail'));
        }
        return patient;
    }

    return {
        overlay, card, body, fields, state, onKey, close,
        setMore,                       // заглушка: раскрытия больше нет
        isMoreOpen: () => false,
        tg,                            // приглашение в бот живёт в шапке
        setGender: (v) => { state.gender = v; sexChips.setValue(v); },
        searchInput: search.input,
        runSearch: search.run,
        collect, save,
        saveOnlyBtn, saveAndServiceBtn, cancelBtn,
        photo,   // PATIENT_PHOTO_V1 — { acceptPhoto, setPhoto, fileInp } для теста

    };
}

// ===========================================================================
// Строительные блоки окна
// ===========================================================================
function mgSection(title, children, { spanFull = false, icon = null, step = null } = {}) {
    // PATIENT_FORM_REWRITE_V1 — у раздела НОМЕР. Заведение пациента — это
    // последовательность («сначала кто, потом документы, потом где живёт»), и
    // номер говорит об этом прямо, а значок только украшал. Кружок нарисован
    // в 22 px внутри строки заголовка и высоты ей не добавляет: на этой высоте
    // держится модель окна.
    return h('div', { class: 'mg-section' + (spanFull ? ' span-full' : '') },
        title ? h('h3', { class: step != null ? 'has-step' : (icon ? 'has-ic' : null) },
            step != null ? h('span', { class: 'mg-step' }, String(step))
                         : (icon ? Icon(icon, { size: 13 }) : null),
            tr(title)) : null,
        ...children,
    );
}
function mgGrid(cols, ...children) {
    return h('div', { class: 'mg-grid cols-' + cols }, ...children);
}
function field(label, input, span) {
    const labels = Array.isArray(label) ? label : [label];
    const wrap = h('div', { class: 'field' },
        h('label', null, ...labels.map((x) => (typeof x === 'string' ? tr(x) : x))),
        input);
    if (span) wrap.style.gridColumn = 'span ' + span;
    return wrap;
}
function req() { return h('span', { class: 'req' }, '*'); }

function select(name, options, def) {
    const sel = h('select', { name });
    for (const opt of options) sel.appendChild(h('option', { value: opt, selected: def === opt }, opt));
    return sel;
}

// NAME_CAPS_V1 — ФИО с большой буквы по мере набора (и после пробела/дефиса).
function capitalizeNameInput(el) {
    const pos = el.selectionStart;
    const v = el.value;
    const nv = v.replace(/(^|[\s\-])(\p{Ll})/gu, (m, sep, ch) => sep + ch.toLocaleUpperCase());
    if (nv !== v) {
        el.value = nv;
        try { el.setSelectionRange(pos, pos); } catch (e) { /* не текстовое поле */ }
    }
}
function nameInput(nameAttr, ph) {
    const el = h('input', { name: nameAttr, placeholder: ph, autocapitalize: 'words', autocomplete: 'off' });
    el.addEventListener('input', () => capitalizeNameInput(el));
    el.addEventListener('blur',  () => capitalizeNameInput(el));
    return el;
}

/** Целые годы по ISO-дате. null — если даты нет или она не читается. */
export function computeAge(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const t = new Date();
    let age = t.getFullYear() - d.getFullYear();
    const m = t.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < d.getDate())) age--;
    return age;
}

// CATEGORY_DISCOUNT_V1 (2026-09-06) — КАТЕГОРИЯ ИЗ СПРАВОЧНИКА, И ОНА
// НАКОНЕЦ СОХРАНЯЕТСЯ.
//
// Владелец: «the category of the patient should come from the patient category
// settings».
//
// Здесь стоял список из трёх значений, зашитых в код (Взрослый / Ребёнок /
// Новорождённый). Хуже того: колонки для него в таблице `patients` не
// существовало вовсе, а компилятор запросов молча выбрасывает ключи, которых
// нет в списке разрешённых колонок, — то есть выбранная категория не
// сохранялась НИКОГДА. Регистратор её выбирал, и она исчезала.
//
// Теперь поле называет `category_id` (миграция 107 завела и колонку, и ссылку),
// а варианты приезжают из справочника «Категории пациентов» — того самого, где
// администратор задаёт скидку группы.
function categorySelect() {
    const sel = h('select', { name: 'category_id' });
    sel.appendChild(h('option', { value: '' }, '—'));
    const fill = (rows) => {
        for (const c of rows) {
            const pct = Number(c.discount_percent) || 0;
            // Имя лежит на самом варианте: подстановка по возрасту ищет
            // категорию ПО ИМЕНИ, и разбирать ради этого готовую подпись
            // «VIP (−15%)» значило бы ломаться от смены формата подписи.
            sel.appendChild(h('option', { value: String(c.id), 'data-name': c.name },
                pct > 0 ? c.name + '  (−' + pct + '%)' : c.name));
        }
    };

    // CATEGORY_LIST_RESILIENT_V1 — СНАЧАЛА СПИСОК, ПОТОМ СКИДКА.
    //
    // Колонку `discount_percent` заводит миграция 107. На установке, где она
    // ещё не применилась, запрос с этой колонкой отвергается ЦЕЛИКОМ — и
    // регистратор видит «Список пуст» при полном справочнике категорий.
    // Поэтому отказ здесь не молчаливый выход, а вторая попытка: без скидки.
    // Категорию можно выбрать и без подписи «−15 %»; выбрать её из пустого
    // списка нельзя никак.
    //
    // Список дозагружается: окно обязано открыться сразу, а не ждать базу.
    // Пустой справочник — это пустой список, а не выдуманные значения.
    supabase.from('patient_categories').select('id, name, discount_percent')
        .eq('active', true).order('name')
        .then(({ data, error }) => {
            if (!error && Array.isArray(data)) { fill(data); return null; }
            console.warn('[patient-categories] со скидкой не вышло, читаем без неё:',
                (error && error.message) || error);
            return supabase.from('patient_categories').select('id, name')
                .eq('active', true).order('name')
                .then(({ data: plain, error: e2 }) => {
                    if (e2 || !Array.isArray(plain)) return;
                    fill(plain);
                });
        })
        .catch(() => { /* нет справочника — поле просто останется с прочерком */ });
    return sel;
}

// Возрастная подсказка осталась, но теперь она ИЩЕТ категорию с таким именем в
// справочнике, а не назначает её. Клиника, назвавшая категории по-своему (VIP,
// сотрудники, льготники), не получит подставленного «Взрослый», которого у неё
// нет; клиника, оставившая три возрастные — получит, как и раньше.
export function categoryFromAge(age) {
    if (age == null) return '';
    if (age < 1)  return 'Новорождённый';
    if (age < 18) return 'Ребёнок';
    return 'Взрослый';
}

/** id категории с таким именем среди вариантов уже загруженного списка. */
export function categoryOptionByName(sel, name) {
    if (!sel || !name) return '';
    const want = String(name).trim().toLowerCase();
    for (const o of (sel.children || [])) {
        if (String(o.tagName || '').toUpperCase() !== 'OPTION') continue;
        const name = o.getAttribute ? o.getAttribute('data-name') : null;
        if (name && String(name).trim().toLowerCase() === want) return o.value;
    }
    return '';
}

export function radioChips(name, options, getter, setter, { nowrap = false } = {}) {
    const wrap = h('div', { class: 'radio-chips', role: 'radiogroup', 'aria-label': tr(name),
        style: nowrap ? { flexWrap: 'nowrap' } : {} });
    // KEYBOARD_FLOW_V1 — ГРУППА как ОДНА остановка Tab.
    //
    // Раньше каждая плашка была обычной <button>, то есть «Пол» стоил два
    // нажатия Tab, «Резидентство» — ещё два, и по форме приходилось идти
    // вдвое дольше, чем в ней полей. Так ведут себя переключатели везде:
    // Tab входит в группу и выходит из неё, а выбор внутри — стрелками.
    // Поэтому фокус держит ТОЛЬКО выбранная плашка (а если не выбрано ничего
    // — первая), остальные из обхода убраны.
    function focusIndex() {
        const i = options.findIndex(([v]) => getter() === v);
        return i >= 0 ? i : 0;
    }
    function repaint({ moveFocus = false } = {}) {
        clear(wrap);
        const fi = focusIndex();
        options.forEach(([val, lbl], i) => {
            const on = getter() === val;
            wrap.appendChild(h('button', {
                type: 'button',
                class: 'radio-chip' + (on ? ' on' : ''),
                role: 'radio', 'aria-checked': on ? 'true' : 'false',
                tabindex: i === fi ? 0 : -1,   // имя атрибута, а не свойства: h() кладёт всё неизвестное через setAttribute
                style: nowrap ? { flex: '1', justifyContent: 'center', padding: '0 8px', whiteSpace: 'nowrap' }
                              : { flex: '1', justifyContent: 'center' },
                onclick: () => { setter(val); repaint(); },
                dataset: { name, value: val },
            }, h('span', { class: 'rc-dot' }), ' ', tr(lbl)));
        });
        if (moveFocus && wrap.children[fi] && wrap.children[fi].focus) wrap.children[fi].focus();
    }
    // Стрелки выбирают соседа и СРАЗУ его отмечают — так же, как родные
    // radio-кнопки: у группы из двух значений отдельное «подтвердить» лишнее.
    wrap.addEventListener('keydown', (e) => {
        const step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1
                   : (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = (focusIndex() + step + options.length) % options.length;
        setter(options[next][0]);
        repaint({ moveFocus: true });
    });
    repaint();
    wrap.setValue = (v) => { setter(v); repaint(); };
    return wrap;
}

export function mailInput(name, ph) {
    return h('div', { style: { position: 'relative' } },
        h('span', { style: { position: 'absolute', left: '12px', top: '12px', color: 'var(--ink-400)' } }, Icon('Mail', { size: 14 })),
        h('input', { name, style: { paddingLeft: '36px', width: '100%' }, placeholder: ph }),
    );
}
export { phoneInput };

// ---------------------------------------------------------------------------
// Живой поиск существующего пациента — одной строкой над колонками. Он и
// остаётся первой защитой от дубликата: регистратор ищет прежде, чем заводит.
// ---------------------------------------------------------------------------
function searchStrip(navigate, closeDialog) {
    const input = h('input', {
        type: 'search', autocomplete: 'off',
        class: 'mg-search-input',
        placeholder: 'Поиск по ФИО, MRN, телефону или ПИНФЛ…',
    });
    const results = h('div', { class: 'mg-search-results', style: { display: 'none' } });
    const run = (term) => runPatientSearch(term, results, async (p) => {
        const full = await loadPatientById(p.id).catch(() => null);
        closeDialog();
        navigate('patient-card', full || p);
    });
    input.addEventListener('input', () => run(input.value));

    const el = h('div', { class: 'mg-section span-full mg-search' },
        h('div', { class: 'field' },
            h('label', null, tr('Найти существующего пациента'), ' ',
                h('span', { class: 'muted', style: { fontWeight: '400' } }, tr('— проверьте перед созданием дубликата'))),
            h('div', { class: 'mg-search-box' },
                h('span', { class: 'mg-search-ic' }, Icon('Search', { size: 15 })),
                input, results),
        ),
    );
    return { el, input, run, results };
}

export async function runPatientSearch(term, resultsEl, onPick) {
    const t = String(term || '').trim();
    if (t.length < 2) {
        clear(resultsEl);
        resultsEl.style.display = 'none';
        return [];
    }
    const searchable = ['full_name', 'last_name', 'first_name', 'middle_name', 'phone', 'mrn', 'national_id'];
    const cols = 'id, mrn, full_name, last_name, first_name, middle_name, phone, date_of_birth, national_id';
    const seen = new Set();
    const rows = [];
    await Promise.all(searchable.map(async (f) => {
        try {
            let q = supabase.from('patients').select(cols).ilike(f, '%' + t + '%').limit(8);
            // TENANT_SCOPE_V3 — только пациенты этой клиники
            const cid = (typeof window !== 'undefined' && window.CLINIC && window.CLINIC.id) || null;
            if (cid) q = q.eq('company_id', cid);
            const { data } = await q;
            for (const r of (data || [])) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
        } catch (e) { /* колонки нет на этой базе — пропускаем */ }
    }));

    clear(resultsEl);
    if (!rows.length) {
        resultsEl.appendChild(h('div', { class: 'mg-search-empty' },
            trf('Совпадений по запросу «{q}» нет. Заполните форму — карта будет новой.', { q: t })));
    } else {
        for (const p of rows.slice(0, 8)) {
            const name = [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' ').trim() || p.full_name || '—';
            const meta = [p.mrn, p.phone, p.national_id, p.date_of_birth].filter(Boolean).join(' · ');
            resultsEl.appendChild(h('button', {
                type: 'button', class: 'mg-search-opt',
                onclick: () => { resultsEl.style.display = 'none'; onPick(p); },
            },
                h('div', { style: { flex: '1', minWidth: '0' } },
                    h('div', { class: 'cell-strong' }, name),
                    meta ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, meta) : null),
                Icon('ArrowRight', { size: 14 }),
            ));
        }
    }
    resultsEl.style.display = '';
    return rows;
}

// ---------------------------------------------------------------------------
// Диалог дубликата — открывает существующую карту или создаёт принудительно.
// Экспортируется: тот же диалог показывает встроенная форма в мастере услуг.
// ---------------------------------------------------------------------------
export function openDuplicatePatientDialog(err, { onOpenExisting, onForceCreate }) {
    const list = Array.isArray(err.existing) ? err.existing : (err.existing ? [err.existing] : []);

    const overlay = h('div', { class: 'modal', style: { zIndex: '160' } });
    const close = () => { document.removeEventListener('keydown', onKey); fadeOutAndRemove(overlay); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const rowsEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' } },
        ...list.map((c) => {
            const name = [c.last_name, c.first_name, c.middle_name].filter(Boolean).join(' ').trim() || c.full_name || '—';
            const reasonChips = (c._reasons || []).map((r) => h('span', {
                style: {
                    fontSize: '12.5px', fontWeight: '600', padding: '1px 8px',
                    borderRadius: '999px', background: 'var(--primary-50)',
                    color: 'var(--primary-700)', textTransform: 'uppercase', letterSpacing: '0.04em',
                },
            }, r));
            return h('button', {
                type: 'button', class: 'dup-row',
                style: {
                    display: 'flex', alignItems: 'center', gap: '12px',
                    padding: '11px 13px', borderRadius: '10px',
                    border: '1px solid var(--ink-200)', background: 'white',
                    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', width: '100%',
                },
                onclick: async (ev) => {
                    const b = ev.currentTarget;
                    b.disabled = true;
                    try { await onOpenExisting(c); close(); }
                    finally { if (b && b.isConnected) b.disabled = false; }
                },
            },
                h('div', { style: { flex: '1', minWidth: '0' } },
                    h('div', { class: 'row', style: { gap: '8px', marginBottom: '3px', flexWrap: 'wrap' } },
                        h('span', { class: 'cell-strong', style: { fontSize: '13.5px' } }, name),
                        c.mrn ? h('span', { class: 'cell-mono muted', style: { fontSize: '12.5px' } }, c.mrn) : null),
                    h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '4px' } },
                        [
                            trf('Дата рождения: {d}', { d: fmtDate(c.date_of_birth) }),
                            c.phone || '—',
                            c.national_id ? trf('ПИНФЛ {id}', { id: c.national_id }) : null,
                        ].filter(Boolean).join(' · ')),
                    reasonChips.length ? h('div', { class: 'row', style: { gap: '5px', flexWrap: 'wrap' } }, ...reasonChips) : null,
                ),
                Icon('ArrowRight', { size: 14 }),
            );
        }),
    );

    overlay.appendChild(h('div', { class: 'modal-card', 'data-dialog': 'patient-duplicate', style: { width: '560px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Warning', { size: 16 }), ' ', tr('Возможный дубликат пациента')),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            h('div', {
                style: {
                    padding: '11px 14px', border: '1px solid #f0d29b',
                    background: 'var(--warn-50)', borderRadius: '10px',
                    fontSize: '12.5px', color: 'var(--ink-800)',
                },
            }, list.length === 1
                ? tr('Найдено 1 возможное совпадение. Выберите существующего пациента — или принудительно создайте нового, если уверены, что это другой человек.')
                : trf('Найдено совпадений: {n}. Выберите существующего пациента — или принудительно создайте нового, если ни один из них не тот же человек.', { n: list.length })),
            rowsEl),
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),
            h('button', { class: 'btn', onclick: close }, tr('Отмена')),
            h('button', {
                class: 'btn btn-outline', 'data-act': 'force-create',
                style: { color: 'var(--crit-700)', borderColor: 'var(--crit-500)' },
                onclick: async (ev) => {
                    const b = ev.currentTarget;
                    b.disabled = true;
                    try { await onForceCreate(); close(); }
                    finally { if (b && b.isConnected) b.disabled = false; }
                },
            }, Icon('Plus', { size: 13 }), ' ', tr('Создать принудительно'))),
    ));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    return { overlay, close };
}

// ---------------------------------------------------------------------------
// Фото: выбор файла, съёмка с веб-камеры, ссылка. Загружается в Storage — не
// в base64 — и в карту едет URL.
// ---------------------------------------------------------------------------
function photoBlock(state) {
    const img = h('img', { alt: 'Фото пациента', style: { display: 'none', width: '96px', height: '96px', objectFit: 'cover', borderRadius: '10px' } });
    // PATIENT_PHOTO_TILE_V1 — в пустой плитке силуэт пациента и подпись, а не
    // значок «картинка»: карточку узнают в лицо, и место под лицо должно быть
    // видно ещё до того, как фото появилось.
    const ph  = h('div', { class: 'cam-ph' },
        h('span', { class: 'cam-ph-ic' }, Icon('Patients', { size: 30 })),
        h('span', { class: 'cam-ph-t' }, tr('Фото пациента')));
    const box = h('div', { class: 'cam-box mg-cam' }, ph, img);
    const setPhoto = (url) => {
        if (!url) { img.style.display = 'none'; ph.style.display = ''; return; }
        img.src = url; img.style.display = ''; ph.style.display = 'none';
    };
    // PATIENT_PHOTO_V1 — ОДНА ДВЕРЬ ДЛЯ ОБОИХ ИСТОЧНИКОВ. Файл с диска и кадр
    // с веб-камеры раньше расходились по двум обработчикам, и правило,
    // добавленное в один, обошло бы второй. Теперь и то и другое приходит
    // сюда: уменьшить → проверить → показать.
    //
    // Порядок «сначала уменьшить, потом проверять» намеренный: 9-мегабайтный
    // кадр после уменьшения весит четверть мегабайта, и отказывать по размеру
    // ИСХОДНИКУ значило бы отказывать в том, что мы прекрасно умеем принять.
    // Формат при этом проверяется по тому, что реально уйдёт на сервер.
    async function acceptPhoto(fileOrBlob) {
        if (!fileOrBlob) return null;
        const named = asPhotoFile(fileOrBlob);
        const small = await downscalePhoto(named);
        const bad = photoRefusal({ name: small.name || named.name, size: small.size });
        if (bad) { toast(trf(bad.template, bad.params), 'fail'); return null; }
        state.photoFile = small; state.photoUrl = '';
        setPhoto(URL.createObjectURL(small));
        return small;
    }
    const fileInp = h('input', {
        // accept — ТОТ ЖЕ список, что отбивает отказ ниже: диалог выбора файла
        // не должен предлагать то, что мы всё равно не примем.
        type: 'file', accept: ALLOWED_PHOTO_EXT.join(','), style: { display: 'none' },
        onchange: async (e) => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            const ok = await acceptPhoto(f);
            if (ok) toast(trf('Фото загружено: {name}', { name: f.name || tr('файл') }));
        },
    });
    const acts = h('div', { class: 'cam-acts' },
        h('button', { class: 'cam-act', type: 'button', title: 'Сфотографировать с веб-камеры', 'aria-label': 'Сфотографировать',
            onclick: () => openWebcamModal(async (blob) => {
                if (await acceptPhoto(blob)) toast('Фото снято с камеры');
            }) }, Icon('Camera', { size: 14 })),
        h('button', { class: 'cam-act', type: 'button', title: 'Загрузить файл с компьютера', 'aria-label': 'Загрузить с компьютера',
            onclick: () => fileInp.click() }, Icon('Download', { size: 14 })),
        h('button', { class: 'cam-act', type: 'button', title: 'Добавить фото по ссылке (URL)', 'aria-label': 'По ссылке',
            onclick: () => {
                const u = window.prompt(tr('Ссылка на фото (URL)'));
                if (u && u.trim()) {
                    state.photoFile = null; state.photoUrl = u.trim();
                    setPhoto(u.trim());
                    toast('Фото по ссылке добавлено');
                }
            } }, Icon('Globe', { size: 14 })),
    );
    return { el: h('div', { class: 'cam-wrap mg-cam-wrap' }, box, fileInp, acts), setPhoto, acceptPhoto, fileInp };
}

// Кадр с веб-камеры приходит безымянным Blob'ом, а имя решает и формат
// (расширение → Content-Type на сервере), и отказ. Даём его один раз здесь.
export function asPhotoFile(fileOrBlob) {
    if (fileOrBlob instanceof File) return fileOrBlob;
    const type = (fileOrBlob && fileOrBlob.type) || 'image/jpeg';
    try { return new File([fileOrBlob], 'photo.jpg', { type }); }
    catch (e) { try { fileOrBlob.name = 'photo.jpg'; } catch (e2) {} return fileOrBlob; }
}

async function uploadPendingPhoto(state) {
    if (state.photoUrl) return state.photoUrl;
    if (!state.photoFile) return '';
    const file = asPhotoFile(state.photoFile);
    try {
        const { path } = await uploadFile(PHOTO_BUCKET, file, PHOTO_PREFIX);
        const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
        return (data && data.publicUrl) || '';
    } catch (e) {
        // PATIENT_PHOTO_V1 — сервер отвечает НАЗВАННЫМ отказом (формат, предел,
        // право), и человек должен прочитать именно его, а не «ошибку
        // загрузки»: только из него понятно, что делать дальше.
        toast(trf('Не удалось загрузить фото: {msg}', { msg: (e && e.message) || e }), 'fail');
        return '';
    }
}

// Экспортировано ради теста: съёмка с камеры — путь, который до
// PATIENT_PHOTO_V1 не проверялся ничем и молча падал на 400.
export function openWebcamModal(onCapture) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '170' } });
    let stream = null;
    const stop = () => { if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; } };
    const close = () => { stop(); document.removeEventListener('keydown', onKey); fadeOutAndRemove(overlay); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const video = h('video', { autoplay: true, playsinline: true, muted: true, class: 'cam-video' });
    const errEl = h('div', { class: 'cam-err', style: { display: 'none' } });
    const snapBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true,
        onclick: () => {
            const w = video.videoWidth || 1280, ht = video.videoHeight || 960;
            const cv = document.createElement('canvas'); cv.width = w; cv.height = ht;
            cv.getContext('2d').drawImage(video, 0, 0, w, ht);
            cv.toBlob((blob) => { if (blob) onCapture(blob); close(); }, 'image/jpeg', 0.9);
        } }, Icon('Camera', { size: 14 }), ' ', tr('Сделать снимок'));

    const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = ''; };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showErr(tr('Камера не поддерживается этим браузером.'));
    } else {
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
            .then((s) => { stream = s; video.srcObject = s; snapBtn.removeAttribute('disabled'); })
            .catch((e) => showErr(trf('Нет доступа к камере: {msg}. Разрешите доступ в браузере.', { msg: (e && e.message) || e })));
    }

    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '520px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Camera', { size: 16 }), ' ', tr('Съёмка фото пациента')),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' }, errEl, video),
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),
            h('button', { class: 'btn', onclick: close }, tr('Отмена')),
            snapBtn)));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
}

// ---------------------------------------------------------------------------
// Telegram: приглашение в бот (реальные колонки telegram_opt_in / _invited_at
// проставляются при сохранении).
// ---------------------------------------------------------------------------
function telegramBlock(state, getPhone) {
    const chipText = h('span', { class: 'tg-chip-t' }, tr('Не подключён'));
    const chip = h('span', { class: 'tg-chip' }, Icon('Send', { size: 13 }), ' ', chipText);
    const note = h('div', { class: 'muted', style: { fontSize: '12.5px', display: 'none', marginTop: '6px' } });
    const btn = h('button', { class: 'btn btn-outline btn-sm', type: 'button',
        onclick: () => {
            state.tgSent = true;
            chip.classList.add('on');
            chipText.textContent = tr('Приглашение отправлено');
            btn.style.display = 'none';
            // Номер берём у ПОЛЯ этого окна, а не поиском по документу: окон с
            // input[name=phone] на экране может быть несколько.
            const phone = (typeof getPhone === 'function' && getPhone()) || tr('номер пациента');
            note.textContent = trf('Ссылка на бота отправлена на {phone} — подключение после перехода по ней.', { phone });
            note.style.display = '';
            toast('Приглашение отправлено');
        } },
        Icon('Send', { size: 13 }), ' ', tr('Отправить приглашение в бот'));
    return h('div', { class: 'tg-wrap' }, h('div', { class: 'tg-row' }, chip, btn), note);
}

// ---------------------------------------------------------------------------
// Каскад страна → регион → район. Значение каждого select — ИМЯ, поэтому
// payload по-прежнему пишет в patients.country / region / district текст.
// ---------------------------------------------------------------------------
export function geoCascade() {
    const countrySel  = h('select', { name: 'country'  });
    const regionSel   = h('select', { name: 'region'   });
    const districtSel = h('select', { name: 'district' });

    function paintSelect(sel, rows, placeholder, selectedName) {
        clear(sel);
        sel.appendChild(h('option', { value: '' }, placeholder));
        for (const r of rows) {
            const opt = h('option', { value: r.name }, r.name);
            opt.dataset.id = r.id;
            if (selectedName && selectedName === r.name) opt.selected = true;
            sel.appendChild(opt);
        }
    }
    function selectedId(sel) {
        const o = sel.options ? sel.options[sel.selectedIndex] : null;
        return o ? (o.dataset.id || '') : '';
    }
    const load = async (table, filter) => {
        try {
            let q = supabase.from(table).select('id, name').eq('active', true).order('name');
            if (filter) q = q.eq(filter[0], filter[1]);
            const { data, error } = await q;
            if (error) return [];
            return data || [];
        } catch (e) { return []; }
    };

    paintSelect(countrySel,  [], tr('Загрузка…'));
    paintSelect(regionSel,   [], tr('Сначала выберите страну'));
    paintSelect(districtSel, [], tr('Сначала выберите регион'));

    countrySel.addEventListener('change', async () => {
        paintSelect(regionSel,   [], tr('Загрузка…'));
        paintSelect(districtSel, [], tr('Сначала выберите регион'));
        const cid = selectedId(countrySel);
        const regs = cid ? await load('regions', ['country_id', cid]) : [];
        paintSelect(regionSel, regs, regs.length ? tr('Выберите регион') : tr('Регионы не заведены — Настройки → География'));
    });
    regionSel.addEventListener('change', async () => {
        paintSelect(districtSel, [], tr('Загрузка…'));
        const rid = selectedId(regionSel);
        const dists = rid ? await load('districts', ['region_id', rid]) : [];
        paintSelect(districtSel, dists, dists.length ? tr('Выберите район') : tr('Районы не заведены — Настройки → География'));
    });

    (async () => {
        const countries = await load('countries', null);
        paintSelect(countrySel, countries,
            countries.length ? tr('Выберите страну') : tr('Страны не заведены — Настройки → География'),
            'Uzbekistan');
        const cid = selectedId(countrySel);
        if (cid) {
            const regs = await load('regions', ['country_id', cid]);
            paintSelect(regionSel, regs, regs.length ? tr('Выберите регион') : tr('Регионы не заведены — Настройки → География'));
        }
    })();

    return { countrySel, regionSel, districtSel };
}
