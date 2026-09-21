// QUICK_PATIENT_V1 (2026-09-21) — ОДНО ОКНО «НОВЫЙ ПАЦИЕНТ» НА ВСЕ ПОТОКИ.
// docs/plans/2026-09-21-quick-patient-everywhere.md, задача Q1.
//
// ЧТО БЫЛО. Пациента заводят не только на своей странице: его заводят по
// дороге — привязывая к набранному счёту в калькуляторе услуг, записывая на
// слот в календаре, превращая звонок в карточке CRM в визит. Каждый из этих
// потоков рисовал СВОЮ мини-форму из пяти полей: фамилия, имя, телефон и
// что-нибудь ещё. Пол и дату рождения там не спрашивали вовсе — а от них
// зависят возраст, категория со скидкой, нормы анализов и печатные бланки.
// Карта, заведённая «по дороге», выходила хуже карты, заведённой на странице,
// и разницу никто не видел: обе выглядели как заведённая карта.
//
// ЧТО СТАЛО. Один модуль, который эти потоки зовут вместо своих форм.
// Владелец: «the linking patient, and the creating patient in the linking, in
// the calendar and in the calculator should add a new patient by flow of fast
// registration» — то есть ровно блок «Реквизиты пациента» быстрой регистрации.
//
// ПОЛЯ ЗДЕСЬ НЕ СВОИ, И В ЭТОМ ВЕСЬ СМЫСЛ. Их рисует buildPatientFields
// (PATIENT_FIELDS_V1) компактной раскладкой — тот же сборщик, те же контролы,
// те же обязательные поля и тот же collect(). Четвёртый набор полей разошёлся
// бы с первыми тремя молча — ровно это и случилось с мини-формами.
//
// А ВОТ СОХРАНЕНИЕ — СВОЁ, И ЭТО РЕШЕНИЕ (та же развилка, что у быстрой
// регистрации). api.save() сборщика на «Открыть существующего» в диалоге
// дубликата УХОДИТ В КАРТУ пациента: для формы заведения это правильно — она
// на этом и заканчивается. Здесь уход потерял бы всё, из чего окно позвали:
// набранный счёт калькулятора, выбранный слот календаря, заявку колл-центра.
// Поэтому savePatient() зовётся тут напрямую, а диалог дубликата
// (openDuplicatePatientDialog — тот же самый) получает свои обработчики, и оба
// исхода значат одно: «вот карта, продолжай с ней» — onCreated.
//
// ФОТО ЗДЕСЬ НЕ ЗАГРУЖАЕТСЯ НАМЕРЕННО. Компактная раскладка плитку снимка не
// рисует (photoBlock живёт в разделе «Личные данные» полной раскладки),
// значит выбрать или снять фото в этом окне нечем, и uploadPendingPhoto
// отправляла бы в хранилище заведомую пустоту. Фото — работа карты пациента.

import { h, Icon, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { savePatient, loadPatientById } from '../data.js';
// PATIENT_CREATE_GATE_V1 — тот же ключ и тот же видимый отказ, что у формы
// заведения и у быстрой регистрации: окно, открывающееся в обход права, — это
// дыра, а молчащая кнопка читается как поломка.
import { canCreatePatient } from '../permissions.js';
import { openAccessDeniedDialog } from '../access-denied.js';
import { fadeOutAndRemove } from '../motion.js?v=mo1';   // MOTION_DIALOG_V1
// MODULE_INSTANCE_V1 — строка запроса ТА ЖЕ, что у картотеки, регистрации и
// быстрой регистрации (?v=onewin1). Для браузера адрес с другим ?v это ДРУГОЙ
// модуль: вторая копия сборщика со своим состоянием, и расхождение ничем не
// видно, кроме потерянных данных.
import { buildPatientFields, openDuplicatePatientDialog } from './patient-create-modal.js?v=onewin1';
// MODAL_STACK_V1 — «стоит ли кто-то поверх меня» считает ОДИН помощник на всё
// приложение. Здесь и в каталоге услуг это правило было написано дважды и
// по-разному (один читал только встроенный z-index, другой — ещё и
// вычисленный), а две копии одного правила расходятся молча: наружу это
// выходит как «Esc закрыл не то окно».
import { coveredByHigherModal } from './modal-stack.js?v=ms1';

/**
 * ЭТАЖ ЭТОГО ОКНА — и он вынесен наружу намеренно.
 *
 * Окно зовут ИЗ окон: из привязки пациента внутри каталога услуг (150), из
 * календаря, из карточки CRM. Само оно открывает поверх себя стража
 * дубликатов (160) и окно отказа (160). Кто кого накрывает, решает ТОЛЬКО
 * z-index, и ошибка здесь не видна ничем, кроме «кнопка не работает»: окно
 * открыто, но ЗА тем, кто его позвал.
 *
 * Порядок продукта: страничные окна 100 · быстрая регистрация 120 · каталог
 * услуг 130 · привязка пациента в каталоге 150 · ЭТО ОКНО 155 · страж
 * дубликатов и отказ 160 · веб-камера 170 · выбор пакета 180.
 *
 * Число вынесено, чтобы зовущий мог на него сослаться, а не переписать своё
 * «на глаз»: два числа, живущие порознь, разойдутся в первый же месяц.
 */
export const QUICK_PATIENT_Z = 155;

/**
 * Ширину окна задаёт КЛАСС .fr-card-narrow (admin-views.css), а не стиль
 * отсюда: у этого окна нет таблицы услуг, поэтому оно уже быстрой регистрации.
 *
 * Здесь стоял встроенный style + setProperty('width', …, 'important') — и
 * встроенный !important не перебивается ничем, кроме такого же. Медиазапрос
 * .fr-card (≤ 960 px) остался бы ни с чем, и на узком экране окно в 1100 px
 * вылезало бы за край. Класс живёт в одном весе с .fr-card и стоит ниже него.
 */
const QUICK_CARD_CLASS = 'modal-card fr-card fr-card-narrow';

/**
 * Окно «Новый пациент» — блок реквизитов быстрой регистрации отдельным окном.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.onCreated]  получает ГОТОВУЮ карту (shapePatient) —
 *   и заведённую здесь, и выбранную в диалоге дубликата. Для позвавшего это
 *   одно и то же событие: «пациент есть, продолжай с ним».
 * @param {Function} [opts.onNavigate] переход по разделам (нужен сборщику полей)
 * @param {string}   [opts.title]      заголовок окна
 * @param {string}   [opts.hint]       строка под формой: где заполняют остальное
 * @returns {{overlay, card, body, formEl, close, state, saveBtn}|null}
 *   null — права нет, и отказ уже показан.
 */
export function openQuickPatientModal({
    onCreated,
    onNavigate,
    title = 'Новый пациент',
    hint = 'Полная анкета — в карте пациента.',
} = {}) {
    if (!canCreatePatient()) { openAccessDeniedDialog(); return null; }

    const navigate = typeof onNavigate === 'function' ? onNavigate : () => {};
    const notifyCreated = typeof onCreated === 'function' ? onCreated : () => {};

    const overlay = h('div', { class: 'modal', style: { zIndex: String(QUICK_PATIENT_Z) } });

    /** Снять окно с экрана. Своё решение окна — оно и знает, что запись дошла. */
    const dismiss = () => { document.removeEventListener('keydown', onKey); fadeOutAndRemove(overlay); };

    /**
     * Закрытие ПО ЖЕЛАНИЮ ЧЕЛОВЕКА: Esc, щелчок мимо, «Отмена», крестик.
     *
     * Пока идёт запись, оно не срабатывает. Закрытие вставку не остановит (она
     * уже в пути), и карта появилась бы молча: позвавший её не получил бы и
     * завёл бы вторую на того же человека.
     */
    const close = () => { if (state.saving) return; dismiss(); };

    /**
     * Стоит ли ПОВЕРХ этого окна чужой диалог.
     *
     * Окно открывает поверх себя стража дубликатов, а тот слушает тот же
     * document. Без этой проверки Esc, закрывающий вопрос о дубле, сносил бы
     * заодно и само окно вместе с набранными полями.
     *
     * СЧИТАЕТСЯ ТОЛЬКО ЭТАЖ ВЫШЕ НАШЕГО, и это вся суть проверки (правило —
     * в modal-stack.js). Соседняя подложка — это ещё и ТЕ, КТО ОКНО ПОЗВАЛ:
     * каталог услуг (130), привязка пациента в нём (150), карточка CRM. Они
     * стоят ПОД окном и заслонить его не могут. Считая их дочерними, окно
     * глохло ровно в самом частом случае — когда его открыли из каталога: Esc
     * не закрывал, Enter не сохранял, и на экране это читалось как «окно
     * зависло».
     */
    const childDialogOpen = () => coveredByHigherModal(overlay);

    const onKey = (e) => { if (e.key === 'Escape' && !childDialogOpen()) close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // Раскладку формы задаёт .fr-card/.fr-form (admin-views.css) — та же, что у
    // быстрой регистрации: подпись слева, поле справа, по две пары в строке.
    const card = h('div', {
        class: QUICK_CARD_CLASS,
        'data-dialog': 'quick-patient',
    });
    overlay.appendChild(card);

    const body = h('div', { class: 'modal-body' });

    // Состояние окна. `api` лежит здесь, а не рядом: позвавший (и проверка)
    // добирается до полей через ОДНУ дверь — и в эту дверь проходит НЕ ВЕСЬ
    // сборщик анкеты, а только подстановка значений (см. publicApi ниже).
    const state = { saving: false, api: null };

    card.appendChild(h('header', { class: 'modal-head' },
        h('h2', null, Icon('Patients', { size: 16 }), ' ', tr(title)),
        h('span', { class: 'grow' }),
        h('button', { class: 'modal-close', onclick: close }, '×'),
    ));
    card.appendChild(body);

    // ── поля ──────────────────────────────────────────────────────────────
    // FAST_REG_COMPACT_V1 — ровно образец владельца: ФИО, дата рождения, пол,
    // телефон, паспортные данные, резидентство, область, адрес, тип скидки.
    //
    // withSearchStrip: false — искать существующего здесь нечего. Это окно
    // открывают ИЗ поиска (привязка в каталоге ищет сама), и второй поиск
    // внутри означал бы «найдите его ещё раз».
    const api = buildPatientFields(body, {
        layout: 'compact',
        withSearchStrip: false,
        onNavigate: navigate,
        close,
    });

    /**
     * ЧТО ОКНО ОТДАЁТ ПОЗВАВШЕМУ — и почему не всё.
     *
     * Позвавшему нужно ровно одно: подставить известное (карточка CRM кладёт
     * в поля имя и телефон из заявки). Сборщик анкеты умеет куда больше, и
     * среди этого — api.save(), который на «Открыть существующего» в диалоге
     * дубликата УХОДИТ В КАРТУ пациента. Ровно от этого пути окно и отказалось
     * (см. шапку модуля): уход потерял бы всё, из чего окно позвали — набранный
     * счёт калькулятора, слот календаря, заявку колл-центра. Отдать наружу
     * вторую дверь к нему значило бы перечеркнуть решение молча.
     */
    const publicApi = {
        /** Реестр полей: имя колонки → элемент. Отсюда берут .value и .focus(). */
        fields: api.fields,
        /**
         * Подставить значение поля.
         *
         * @param {string}  name             имя колонки (реестр полей)
         * @param {*}       value            что подставить; пустое игнорируется
         * @param {boolean} [opts.notify]    разбудить слушателя поля — так же,
         *   как его будит набор руками. От даты рождения зависят возраст рядом
         *   с полем и подставляемый тип скидки, а их считает слушатель:
         *   положенное молча значение он не увидит.
         * @returns {boolean} подставили ли
         */
        setValue(name, value, { notify = false } = {}) {
            const el = api.fields[name];
            if (!el || value === null || value === undefined || value === '') return false;
            el.value = String(value);
            if (notify) {
                try { el.dispatchEvent(new Event('input')); }
                catch (e) { /* без события — просто не пересчитается зависимое */ }
            }
            return true;
        },
        /** Пол живёт не в поле, а в плитках выбора — у него своя подстановка. */
        setGender: (v) => api.setGender(v),
    };
    state.api = publicApi;

    // Строка под формой — ответ на вопрос, который возникает сразу: «а где
    // всё остальное?». Без неё короткий набор полей читается как потеря.
    body.appendChild(h('div', {
        class: 'mg-hint',
        style: { padding: '0 16px 14px' },
    }, tr(hint)));

    // ── подвал ────────────────────────────────────────────────────────────
    const cancelBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: close },
        tr('Отмена'));
    const saveBtn = h('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: () => { void doSave(); },
    }, Icon('Check', { size: 14 }), ' ', tr('Создать пациента'));
    // Горячая клавиша, о которой нигде не написано, не существует: подпись в
    // подвале — часть самой возможности, а не украшение.
    card.appendChild(h('footer', { class: 'modal-foot' },
        h('span', { class: 'mg-hint' }, h('kbd', null, 'Enter'), ' ', tr('— создать пациента')),
        h('span', { class: 'grow' }),
        cancelBtn, saveBtn,
    ));

    // PATIENT_FORM_FLOW_V1 — Enter нажимает ГЛАВНОЕ действие окна. Пропускаем
    // там, где Enter уже занят и значит другое: перенос строки в <textarea>,
    // нажатие самой кнопки или ссылки, выбор строки в открытом списке...
    card.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.isComposing || e.keyCode === 229) return;
        const t = e.target;
        const tag = ((t && t.tagName) || '').toLowerCase();
        if (tag === 'textarea' || tag === 'button' || tag === 'a') return;
        if (typeof document !== 'undefined' && document.querySelector
            && document.querySelector('.uisel-pop, .uidate-pop')) return;
        // ...и пока поверх стоит страж дубликатов — по той же причине, что и
        // Esc. Это тот самый миг, когда вопрос «не второй ли это такой же
        // человек» ещё не решён: Enter из живого поля прошёл бы мимо него и
        // запустил сохранение ЗАНОВО.
        if (childDialogOpen()) return;
        e.preventDefault();
        // Окно открывают ИЗ окон, и у позвавшего свой Enter: у формы заявки в
        // карточке CRM, у каталога услуг. Всплывший наверх Enter — это второе
        // действие на одно нажатие, и увидят его только по последствиям.
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        if (saveBtn.disabled) return;
        saveBtn.click();
    });

    // =======================================================================
    // Сохранение
    // =======================================================================

    /**
     * Карта есть — отдать её позвавшему и уйти.
     *
     * СБОЙ ПОЗВАВШЕГО ОКНО НЕ ДЕРЖИТ. onCreated — чужой код: привязка к смете,
     * мастер визита, хвост регистрации заявки. К этому мигу карта УЖЕ в базе и
     * окно своё дело сделало; оставшись на экране, оно показывает ту же форму с
     * теми же полями — и следующее нажатие «Создать пациента» заводит вторую
     * карту на того же человека. Поэтому dismiss() зовётся в любом случае, а
     * сбой не проглатывается: молчание здесь — это «всё хорошо» на экране и
     * потерянный поток на самом деле (пациент есть, а смета/заявка его не
     * получили).
     */
    function finish(patient, { saved = true } = {}) {
        // Найденного пациента никто не сохранял: «Пациент сохранён» здесь
        // читалось бы как «изменения записаны», и регистратор уходил бы
        // уверенным, что что-то поменял в чужой карте.
        if (saved) toast('Пациент сохранён.');
        try {
            notifyCreated(patient);
        } catch (e) {
            console.warn('[quick-patient] onCreated:', e);
            toast('Пациент заведён, но продолжить не удалось.', 'fail');
        }
        dismiss();   // не close(): запись дошла, и решение — наше
    }

    async function doSave() {
        if (state.saving) return null;
        const payload = api.collect();   // проверки и отказы — его работа
        if (!payload) return null;
        return runSave(payload, false);
    }

    /**
     * Завести карту, а на возражение стража дубликатов — спросить.
     *
     * @param {object}  payload  собранное collect()
     * @param {boolean} force    создать вопреки найденному совпадению
     */
    async function runSave(payload, force) {
        if (state.saving) return null;
        state.saving = true;
        saveBtn.disabled = true;
        try {
            const created = await savePatient(payload, { force });
            finish(created);
            return created;
        } catch (e) {
            if (!force && e && e.code === 'DUPLICATE_PATIENT' && e.existing) {
                openDuplicatePatientDialog(e, {
                    // «Открыть существующего» здесь значит «привязать
                    // найденного»: строку стража берём полной карточкой — она
                    // в диалоге урезана до полей сравнения, а позвавшему нужна
                    // та же карта, что и у заведённой (номер, телефон, имя).
                    onOpenExisting: async (c) => {
                        const p = await loadPatientById(c.id).catch(() => null);
                        if (!p) { toast('Не удалось открыть карту пациента.', 'fail'); return; }
                        finish(p, { saved: false });
                    },
                    onForceCreate: () => runSave(payload, true),
                });
                return null;
            }
            toast(trf('Не удалось сохранить: {msg}', { msg: (e && e.message) || e }), 'fail');
            return null;
        } finally {
            state.saving = false;
            saveBtn.disabled = false;
        }
    }

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    // Курсор в фамилию: окно открывают, чтобы набирать, а не чтобы целиться.
    try { if (api.fields.last_name && api.fields.last_name.focus) api.fields.last_name.focus(); }
    catch (e) { /* нет фокуса — не беда */ }

    return { overlay, card, body, formEl: api.formEl, close, state, saveBtn };
}
