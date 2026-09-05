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
import { h, Icon, toast, clear, fmtDate } from '../ui.js';
import { savePatient, loadPatientById } from '../data.js';
import { supabase } from '../../supabase.js';
import { uploadFile } from '../storage.js';
import { phoneInput, isCodeOnly } from '../phone-input.js?v=ph1';

// AURORA_REG_FORM_V1 — публичный бакет фотографий: photo_url хранит постоянный
// URL, который карточка пациента отдаёт прямо в <img src>.
const PHOTO_BUCKET = 'patient-photos';

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
    sectionTitleGap: 10,     // .mg-dense .mg-section { gap: 10px }
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
    left:  Object.freeze(['last/first/middle', 'dob/age/sex', 'phone/phone2/lang']),
    right: Object.freeze(['pinfl/document', 'category/blank']),
    // «Подробнее» — последняя строка правой колонки.
    rightHasMoreRow: true,
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

/** Высота содержимого окна на ПЕРВОМ экране (раскрытие «Подробнее» закрыто). */
export function firstScreenHeight() {
    const search  = sectionH(LAYOUT.search.rows, { titled: false });
    const left    = sectionH(LAYOUT.left.length);
    const right   = sectionH(LAYOUT.right.length, {
        extraRows: LAYOUT.rightHasMoreRow ? [METRICS.moreRowH] : [],
    });
    // Две колонки — один ряд грида: его высота равна более высокой колонке.
    return headHeight() + search + Math.max(left, right) + footHeight();
}

/** Влезает ли первый экран в окно высотой innerH без прокрутки. */
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
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const card = h('div', {
        class: 'modal-card modal-grouped has-groups mg-dense',
        'data-dialog': 'patient-create',
        style: {
            width: METRICS.cardWidth + 'px',
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: 'calc(100vh - ' + METRICS.viewportGap + 'px)',
        },
    });
    overlay.appendChild(card);

    card.appendChild(h('header', { class: 'modal-head' },
        h('h2', null, Icon('Patients', { size: 16 }), ' ', tr('Создать пациента')),
        h('button', { class: 'modal-close', onclick: close }, '×'),
    ));

    const body = h('div', { class: 'modal-body' });
    card.appendChild(body);

    // ---- Поиск существующего пациента (одной строкой, во всю ширину) -------
    const search = searchStrip(navigate, close);
    body.appendChild(search.el);

    // ---- Левая колонка: личные данные --------------------------------------
    const dobInput = reg('date_of_birth', h('input', { name: 'date_of_birth', type: 'date' }));
    const ageInput = h('input', { name: '__age', readOnly: true, placeholder: '—' });
    const categorySel = reg('patient_category', categorySelect());
    dobInput.addEventListener('input', () => {
        const age = computeAge(dobInput.value);
        ageInput.value = (age == null || age < 0 || age > 130) ? '' : String(age);
        if (!categorySel.value) categorySel.value = categoryFromAge(age);
    });

    const sexChips = radioChips('gender',
        [['M', 'Мужской'], ['F', 'Женский']],
        () => state.gender,
        (v) => { state.gender = v; },
        { nowrap: true });

    body.appendChild(mgSection('Личные данные', [
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
            field('Предпочитаемый язык', reg('language', select('language', ['Узбекский', 'Русский', 'Английский', 'Каракалпакский']))),
        ),
    ]));

    // ---- Правая колонка: документы и учёт ----------------------------------
    const moreLabel = h('span', { class: 'mg-more-t' }, tr('Подробнее'));
    const moreBtn = h('button', {
        type: 'button', class: 'mg-more-btn', 'data-more-toggle': '1',
        'aria-expanded': 'false',
        onclick: () => setMore(!state.moreOpen),
    }, Icon('ChevronDown', { size: 14 }), ' ', moreLabel);

    body.appendChild(mgSection('Документы и учёт', [
        mgGrid(2,
            field('ПИНФЛ (ЖШШИР)',        reg('national_id',     h('input', { name: 'national_id', placeholder: '14 цифр', maxLength: '14' }))),
            field('Паспорт / документ №', reg('passport_number', h('input', { name: 'passport_number', placeholder: 'AB1234567' }))),
        ),
        mgGrid(2,
            field('Категория пациента', categorySel),
            h('div'),
        ),
        h('div', { class: 'mg-more' }, moreBtn,
            h('span', { class: 'mg-more-hint muted' }, tr('Фото, Telegram, адрес, гражданство, поведение'))),
    ]));

    // ---- «Подробнее» — то же окно, второй экран -----------------------------
    const photo = photoBlock(state);
    const geo   = geoCascade();
    reg('country',  geo.countrySel);
    reg('region',   geo.regionSel);
    reg('district', geo.districtSel);

    const moreSection = mgSection('Подробнее о пациенте', [
        mgGrid(4,
            h('div', { class: 'field' }, h('label', null, tr('Фото пациента')), photo.el),
            field('Улица, дом, квартира', reg('address', h('input', { name: 'address', placeholder: 'ул. Амира Темура 12, кв. 47' })), 2),
            field('Махалля', reg('mahalla', h('input', { name: 'mahalla', placeholder: 'Юнусабад-3' }))),
        ),
        mgGrid(4,
            field('Страна', geo.countrySel),
            field('Регион', geo.regionSel),
            field('Район',  geo.districtSel),
            field('Email',  reg('email', h('input', { name: 'email', placeholder: 'name@example.com' }))),
        ),
        mgGrid(4,
            field('Резидентство', radioChips('__residency',
                [['resident', 'Резидент РУз'], ['nonresident', 'Нерезидент']],
                () => state.residency,
                (v) => { state.residency = v; }), 2),
            field('Гражданство / национальность', reg('nationality', h('input', { name: 'nationality', placeholder: 'Узбек' }))),
            field('Telegram-бот', telegramBlock(state, () => fields.phone && fields.phone.value)),
        ),
        mgGrid(1,
            field('Поведение / предупреждение',
                reg('behavior_note', h('textarea', {
                    name: 'behavior_note', rows: '2',
                    placeholder: 'напр. Грубил регистратуре; приходил в нетрезвом виде; отказывается ждать — будьте внимательны.',
                }))),
        ),
    ], { spanFull: true });
    moreSection.style.display = 'none';
    body.appendChild(moreSection);

    function setMore(open) {
        state.moreOpen = !!open;
        moreSection.style.display = state.moreOpen ? '' : 'none';
        moreBtn.setAttribute('aria-expanded', state.moreOpen ? 'true' : 'false');
        moreLabel.textContent = state.moreOpen ? tr('Свернуть подробности') : tr('Подробнее');
    }

    // ---- Подвал -------------------------------------------------------------
    const saveOnlyBtn = h('button', { class: 'btn btn-outline', type: 'button',
        onclick: (ev) => guarded(ev, () => save({ openVisit: false })) },
        Icon('Check', { size: 14 }), ' ', tr('Сохранить пациента'));
    const saveAndServiceBtn = h('button', { class: 'btn btn-primary', type: 'button',
        onclick: (ev) => guarded(ev, () => save({ openVisit: true })) },
        Icon('Plus', { size: 14 }), ' ', tr('Добавить услугу'));
    card.appendChild(h('footer', { class: 'modal-foot' },
        h('span', { class: 'grow' }),
        saveOnlyBtn,
        saveAndServiceBtn,
    ));

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
        moreSection, moreBtn, moreLabel, setMore,
        isMoreOpen: () => state.moreOpen,
        setGender: (v) => { state.gender = v; sexChips.setValue(v); },
        searchInput: search.input,
        runSearch: search.run,
        collect, save,
        saveOnlyBtn, saveAndServiceBtn,
    };
}

// ===========================================================================
// Строительные блоки окна
// ===========================================================================
function mgSection(title, children, { spanFull = false } = {}) {
    return h('div', { class: 'mg-section' + (spanFull ? ' span-full' : '') },
        title ? h('h3', null, tr(title)) : null,
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

function categorySelect() {
    const sel = h('select', { name: 'patient_category' });
    sel.appendChild(h('option', { value: '' }, '—'));
    for (const opt of ['Взрослый', 'Ребёнок', 'Новорождённый']) sel.appendChild(h('option', { value: opt }, opt));
    return sel;
}
export function categoryFromAge(age) {
    if (age == null) return '';
    if (age < 1)  return 'Новорождённый';
    if (age < 18) return 'Ребёнок';
    return 'Взрослый';
}

export function radioChips(name, options, getter, setter, { nowrap = false } = {}) {
    const wrap = h('div', { class: 'radio-chips', style: nowrap ? { flexWrap: 'nowrap' } : {} });
    function repaint() {
        clear(wrap);
        for (const [val, lbl] of options) {
            wrap.appendChild(h('button', {
                type: 'button',
                class: 'radio-chip' + (getter() === val ? ' on' : ''),
                style: nowrap ? { flex: '1', justifyContent: 'center', padding: '0 8px', whiteSpace: 'nowrap' }
                              : { flex: '1', justifyContent: 'center' },
                onclick: () => { setter(val); repaint(); },
                dataset: { name, value: val },
            }, h('span', { class: 'rc-dot' }), ' ', tr(lbl)));
        }
    }
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
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
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
    const ph  = h('div', { class: 'cam-ph' }, Icon('Image', { size: 22 }));
    const box = h('div', { class: 'cam-box mg-cam' }, ph, img);
    const setPhoto = (url) => {
        if (!url) { img.style.display = 'none'; ph.style.display = ''; return; }
        img.src = url; img.style.display = ''; ph.style.display = 'none';
    };
    const fileInp = h('input', {
        type: 'file', accept: 'image/*', style: { display: 'none' },
        onchange: (e) => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            state.photoFile = f; state.photoUrl = '';
            setPhoto(URL.createObjectURL(f));
            toast(trf('Фото загружено: {name}', { name: f.name || tr('файл') }));
        },
    });
    const acts = h('div', { class: 'cam-acts' },
        h('button', { class: 'cam-act', type: 'button', title: 'Сфотографировать с веб-камеры', 'aria-label': 'Сфотографировать',
            onclick: () => openWebcamModal((blob) => {
                state.photoFile = blob; state.photoUrl = '';
                setPhoto(URL.createObjectURL(blob));
                toast('Фото снято с камеры');
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
    return { el: h('div', { class: 'cam-wrap mg-cam-wrap' }, box, fileInp, acts), setPhoto };
}

async function uploadPendingPhoto(state) {
    if (state.photoUrl) return state.photoUrl;
    if (!state.photoFile) return '';
    const file = state.photoFile instanceof File
        ? state.photoFile
        : new File([state.photoFile], 'photo.jpg', { type: state.photoFile.type || 'image/jpeg' });
    try {
        const { path } = await uploadFile(PHOTO_BUCKET, file, 'patients/');
        const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
        return (data && data.publicUrl) || '';
    } catch (e) {
        toast(trf('Не удалось загрузить фото: {msg}', { msg: (e && e.message) || e }), 'fail');
        return '';
    }
}

function openWebcamModal(onCapture) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '170' } });
    let stream = null;
    const stop = () => { if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; } };
    const close = () => { stop(); overlay.remove(); document.removeEventListener('keydown', onKey); };
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
