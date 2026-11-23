// CASE_DOC_A4_V1 — ДОКУМЕНТ ИСТОРИИ БОЛЕЗНИ КАК ЛИСТ, А НЕ КАК ФОРМА.
//
// Владелец (2026-09-08): «documents are a4 format not with the fields, but use
// something like document of the doctors workplace in the documents».
//
// Кабинет врача (service-workspace.js) пишет заключение так: лист A4, на нём
// разделы с форматируемым текстом, сверху панель форматирования, справа —
// «Вставить в документ». Стационар писал то же самое подписанными полями
// ввода. Один и тот же врач получал два разных инструмента для одной работы.
//
// Здесь — разделы листа для истории болезни. Классы (.a4-sec, .a4-input,
// .a4-tool) ОБЩИЕ с кабинетом врача: документ обязан выглядеть одинаково, где
// бы его ни писали, и один набор правил стилей дешевле двух.
//
// ЧТО ХРАНИТСЯ. Разделы — разметка (жирный, курсив, списки, таблица
// вставленного результата). Диагноз — простой текст: он показывается в обзоре,
// в журнале и в списках, где разметка была бы мусором (то же решение на
// сервере, rpc/inpatient-reviews.js).
import { h, clear, Icon } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { sanitizeStoredHtml, richIsEmpty } from '../../shared/rich-text.js';
import { dateNumeric } from '../../shared/date-words.js';   // A4_LETTERHEAD_V2 — дата рождения числом
import { shortName, placeLine } from '../../shared/person-name.js';   // PERSON_NAME_SHORT_V1
// INPATIENT_REQUIRED_V1 — список разделов переехал в shared/case-doc-sections.js:
// обязательные разделы проверяет и сервер. Здесь — та же копия, не вторая.
import { KIND_SECTIONS, sectionsFor } from '../../shared/case-doc-sections.js';
export { KIND_SECTIONS, sectionsFor };

/** Разделы, которые пишутся разметкой. `diagnosis` сюда не входит намеренно. */
export const RICH_KEYS = Object.freeze(['complaints', 'objective', 'plan', 'body']);

// ---------------------------------------------------------------------------
// CASE_DOC_BLANK_V1 — БЛАНК ДОКУМЕНТА: ЗАГОТОВКА КЛИНИКИ, А НЕ ПУСТОЙ ЛИСТ.
//
// Владелец (2026-09-08): «we should be able to edit document in the #documents
// section».
//
// «Объективно: состояние удовлетворительное, кожные покровы обычной окраски,
// дыхание везикулярное…» — это не творчество врача, это формулировка клиники,
// которую он перепечатывает по десять раз в день. Здесь она пишется ОДИН раз
// в «Документах», и новый документ открывается уже с ней; врач правит её под
// пациента, а не набирает заново.
//
// ЧТО ЭТО НЕ ДЕЛАЕТ. Бланк подставляется ТОЛЬКО в новый документ, у которого
// ещё нет черновика: иначе заготовка затирала бы написанное. И только в пустые
// разделы — раздел с текстом остаётся как есть.
//
// ГДЕ ЛЕЖИТ. В тех же настройках документов (doc_branding.settings), что и
// текст договора и памятки: это настройка клиники, одна на всех, и заводить
// ради неё таблицу значило бы менять базу под одно текстовое поле.
export const CASE_BLANK_KEY = 'caseDocBlanks';

/** Виды документов, у которых бланк бывает. Согласие из набора убрано (CONSENT_OUT_V1). */
export const CASE_BLANK_KINDS = Object.freeze(Object.keys(KIND_SECTIONS).filter((k) => k !== 'consent'));

/** Бланк вида документа: {раздел: разметка}. Всегда объект, даже когда пусто. */
export function caseDocBlank(settings, kind) {
    const all = settings && settings[CASE_BLANK_KEY];
    const one = all && typeof all === 'object' ? all[kind] : null;
    const out = {};
    if (!one || typeof one !== 'object') return out;
    for (const key of RICH_KEYS) {
        const v = sanitizeStoredHtml(one[key] || '');
        if (v) out[key] = v;
    }
    return out;
}

/**
 * Все бланки с ОДНИМ изменённым разделом. Настройки не правятся на месте:
 * их сравнивают по ссылке, чтобы понять, есть ли несохранённые изменения.
 */
export function withCaseDocBlank(settings, kind, section, html) {
    const all = Object.assign({}, (settings && settings[CASE_BLANK_KEY]) || {});
    const one = Object.assign({}, all[kind] || {});
    // Пустой раздел УБИРАЕТ запись, а не сохраняет пустоту: <p><br></p> из
    // редактора — это не текст бланка, и «заполнено разделов» посчитало бы его.
    const html2 = sanitizeStoredHtml(html || '');
    const clean = richIsEmpty(html2) ? '' : html2;
    if (clean) one[section] = clean; else delete one[section];
    if (Object.keys(one).length) all[kind] = one; else delete all[kind];
    return all;
}

/** Есть ли у документа диагноз (карточка слева спрашивает это). */
export function hasDiagnosis(kind) { return sectionsFor(kind).includes('diagnosis'); }

const LABEL = {
    complaints: 'Жалобы',
    objective:  'Объективно',
    diagnosis:  'Диагноз',
    plan:       'План обследования и лечения',
    body:       'Дополнительно',
};
const BODY_LABEL = { operation: 'Протокол операции', consent: 'Текст документа', other: 'Текст документа', rationale: 'Обоснование' };
const PH = {
    complaints: 'Что беспокоит пациента',
    objective:  'Состояние, осмотр по системам, витальные показатели',
    diagnosis:  'Диагноз при поступлении',
    plan:       'Обследование, лечение, режим, стол',
    body:       'Анамнез, сопутствующее, обоснование',
};

// Разделы документа (диагноз есть у каждого) — sectionsFor из shared/case-doc-sections.js
// (INPATIENT_REQUIRED_V1, импорт вверху файла).
export function sectionLabel(kind, key) {
    return key === 'body' && BODY_LABEL[kind] ? BODY_LABEL[kind] : LABEL[key] || key;
}
export function sectionPlaceholder(key) { return PH[key] || ''; }

/**
 * ОФОРМЛЕНИЕ ТЕКСТА У САМОГО РАЗДЕЛА.
 *
 * CASE_DOC_FORMAT_V1 (2026-09-10) — владелец: «add a rich text toolbar, into a
 * fields on top, when pressed edit button. make design appealing, using maybe
 * icons … but do not do sloppy font written text panel».
 *
 * Прежняя панель стояла ОДНА на весь лист и была набрана буквами — «B», «I»,
 * «U», «• •», «1.», «Aa». Буква вместо значка — это не значок, а надпись, и
 * читается она как отладочная. Здесь у каждого раздела своя кнопка, и по ней
 * над полем встаёт ряд НАСТОЯЩИХ иконок набора.
 *
 * Панель появляется НАД полем и исчезает по второму нажатию: она инструмент, а
 * не часть документа, и на бумагу не идёт (.no-print).
 *
 * @param {HTMLElement} input редактируемая область раздела
 * @returns {{bar:HTMLElement, toggle:HTMLElement}}
 */
export function fieldFormatBar(input) {
    // mousedown + preventDefault: нажатие на кнопку НЕ уводит курсор из текста,
    // иначе команда применилась бы к пустому выделению.
    const run = (cmd, value = null) => (e) => {
        if (e && e.preventDefault) e.preventDefault();
        if (input && input.focus) input.focus();
        try { document.execCommand(cmd, false, value); } catch (err) { /* браузер без execCommand */ }
    };
    const tool = (title, icon, cmd) => {
        const b = h('button', { class: 'a4-fmt-b', type: 'button', title: tr(title), 'aria-label': tr(title) },
            Icon(icon, { size: 15 }));
        b.addEventListener('mousedown', run(cmd));
        return b;
    };
    const bar = h('div', { class: 'a4-fmt no-print', role: 'toolbar', 'aria-label': tr('Оформление текста') },
        tool('Полужирный', 'Bold', 'bold'),
        tool('Курсив', 'Italic', 'italic'),
        tool('Подчёркнутый', 'Underline', 'underline'),
        h('span', { class: 'a4-fmt-sep' }),
        tool('Маркированный список', 'ListBullet', 'insertUnorderedList'),
        tool('Нумерованный список', 'ListNumber', 'insertOrderedList'),
        h('span', { class: 'a4-fmt-sep' }),
        tool('Убрать оформление', 'TextPlain', 'removeFormat'));
    // Скрыта СВОЙСТВОМ, а не атрибутом: атрибут h() ставит только у истинных
    // значений, и панель открывалась бы сразу.
    bar.hidden = true;

    const toggle = h('button', {
        class: 'a4-fmt-t no-print', type: 'button',
        title: tr('Оформление текста'), 'aria-label': tr('Оформление текста'), 'aria-expanded': 'false',
        onclick: () => {
            const on = bar.hidden;
            bar.hidden = !on;
            toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
            if (on && input && input.focus) input.focus();
        },
    }, Icon('Format', { size: 14 }));

    return { bar, toggle };
}

/**
 * Раздел листа: подпись и редактируемая область.
 *
 * CASE_DOC_FREE_SEC_V1 (2026-09-09) — ПОДПИСЬ ПЕРЕИМЕНОВЫВАЕТСЯ. Владелец:
 * «only rename and add option to create free field». Подпись остаётся текстом
 * листа — не поле ввода в каждой строке, а кнопка, которая подменяется полем
 * по нажатию: документ не должен выглядеть анкетой, пока его просто читают.
 *
 * Имя, которым назвали раздел, уезжает В ЗАПИСЬ, а не в справочник: документ
 * печатают через год, и он обязан читаться так, как его писали.
 *
 * CASE_DOC_SEC_MANAGER_V2 (2026-09-10) — РАЗДЕЛ СВОРАЧИВАЕТСЯ В СТРОКУ, как на
 * листе приёма: выключенная коробка показывает пунктирное «+ Добавить: имя», и
 * это ОДНА И ТА ЖЕ коробка, а не список где-то сбоку. Владелец показал лист
 * кабинета: «here is how the sections look like in the doctors workspace.
 * apply same thing».
 *
 * @param {(key:string, title:string) => void} [onRename] без него подпись не
 *        правится вовсе (бланк, чтение опубликованного).
 * @param {() => void} [onAdd] включить раздел (нажатие на свёрнутую строку).
 * @param {() => void} [onRemove] убрать раздел (крестик в углу коробки).
 */
export function richSection(kind, key, { title = '', onRename = null, onAdd = null, onRemove = null } = {}) {
    const input = h('div', {
        // A4_SHEETS_V1 — по этой пометке раскладка находит текст раздела и, если
        // он не помещается, делит его по абзацам между листами.
        class: 'a4-input', 'data-field': key, 'data-a4-field': key, contentEditable: 'true',
        'data-ph': tr(sectionPlaceholder(key)),
    });
    const shown = () => (String(title || '').trim() || tr(sectionLabel(kind, key)));
    const tag = onRename
        ? h('button', {
            class: 'a4-sec-tag a4-sec-tag-b', type: 'button',
            title: tr('Переименовать раздел'),
            'aria-label': trf('Переименовать раздел: {name}', { name: shown() }),
        }, shown())
        : h('span', { class: 'a4-sec-tag' }, shown());
    // CASE_DOC_FORMAT_V1 — своё оформление у каждого раздела: кнопка рядом с
    // подписью, ряд иконок над полем.
    const fmt = onRename || onRemove ? fieldFormatBar(input) : null;
    // Порядок детей — тот же, что у a4Section в кабинете: свёрнутая строка,
    // подпись, крестик, текст. На нём держится и вся раскладка (CSS прячет
    // ровно этих детей, когда на коробке стоит a4-sec-off).
    const addRow = onAdd
        ? h('button', {
            class: 'a4-sec-add', type: 'button',
            onclick: () => onAdd(),
        }, trf('+ Добавить: {name}', { name: shown() }))
        : null;
    const xBtn = onRemove
        ? h('button', {
            class: 'a4-sec-x no-print', type: 'button', title: tr('Убрать раздел'),
            'aria-label': tr('Убрать раздел'), onclick: () => onRemove(),
        }, '×')
        : null;
    const sec = h('div', { class: 'a4-sec cd-sec', 'data-sec': key, style: { position: 'relative' } },
        addRow,
        tag,
        fmt ? fmt.toggle : null,
        xBtn,
        fmt ? fmt.bar : null,
        input);

    // INPATIENT_REQUIRED_V1 (ревью) — ИМЯ РАЗДЕЛА ОДНИМ МЕСТОМ: подпись, её aria-label и
    // свёрнутая строка «+ Добавить: …». Редактор зовёт это, раскладывая сохранённую запись
    // (давняя ошибка: он писал имя в первого ребёнка коробки, а это строка «+ Добавить»),
    // и правка подписи открывается потом с этим же именем, а не с именем рода.
    // textContent стирает скрытое «обязательно» подписи — его возвращают отметки (remark).
    const setTitle = (value) => {
        title = String(value || '').trim();
        tag.textContent = shown();
        if (onRename) tag.setAttribute('aria-label', trf('Переименовать раздел: {name}', { name: shown() }));
        if (addRow) addRow.textContent = trf('+ Добавить: {name}', { name: shown() });
    };
    // INPATIENT_REQUIRED_V1 (ревью) — обязательный раздел крестика не несёт; правила клиники
    // приходят и после того, как раздел нарисован, — крестик уходит и возвращается на своё
    // место (перед панелью оформления или текстом). DOM-методами: в браузере sec.children —
    // HTMLCollection.
    const setRemovable = (on) => {
        if (!xBtn) return;
        const here = Array.from(sec.children || []).includes(xBtn);
        if (on && !here) sec.insertBefore(xBtn, fmt ? fmt.bar : input);
        else if (!on && here) sec.removeChild(xBtn);
    };

    if (onRename) {
        tag.addEventListener('click', () => {
            const field = h('input', { type: 'text', class: 'a4-sec-name', placeholder: tr('Название раздела') });
            field.value = shown();
            let closed = false;
            // Подменяется РОВНО подпись: коробка держит ещё свёрнутую строку,
            // крестик и текст, и пересобирать её целиком значило бы потерять их.
            // INPATIENT_REQUIRED_V1 (ревью, давняя ошибка) — в браузере sec.children —
            // HTMLCollection: ни indexOf, ни splice у неё нет, и переименование подписи
            // падало при первом щелчке (тесты молчали: подделка DOM держала массив).
            // Узел меняется на месте DOM-методом, порядок остальных детей не трогаем.
            const swap = (from, to) => {
                if (!Array.from(sec.children || []).includes(from)) return;
                sec.replaceChild(to, from);
            };
            const stop = () => { if (closed) return; closed = true; swap(field, tag); };
            const save = () => {
                if (closed) return;
                closed = true;
                const value = String(field.value || '').trim();
                setTitle(value === tr(sectionLabel(kind, key)) ? '' : value);
                swap(field, tag);
                onRename(key, title);
            };
            field.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); save(); }
                if (e.key === 'Escape') { e.preventDefault(); stop(); }
            });
            field.addEventListener('blur', save);
            swap(tag, field);
            field.focus();
        });
    }
    // INPATIENT_REQUIRED_V1 — и подпись: на ней отметки ставят звезду и скрытое
    // «обязательно» (views/required-marks.js), а у коробки первым ребёнком бывает
    // свёрнутая строка «+ Добавить», не подпись.
    return { sec, input, tag, setTitle, setRemovable };
}

/**
 * INPATIENT_REQUIRED_V1 (ревью) — СТОПКА ЛИСТОВ, в которой стоит поле раздела.
 *
 * A4_SHEETS_V1 (a4-sheets.js) кладёт хвост раздела, не влезшего на страницу, на
 * следующий лист той же стопки: листы (.a4-paper) — соседи. Возвращает стопку и лист
 * самого поля; поле не на листе (окно документа) — null.
 */
export function a4StackOf(field) {
    for (let n = field && field.parentNode; n; n = n.parentNode) {
        if (String(n.className || '').split(/\s+/).includes('a4-paper')) return n.parentNode ? { stack: n.parentNode, paper: n } : null;
    }
    return null;
}

/**
 * INPATIENT_REQUIRED_V1 (ревью) — ПРОДОЛЖЕНИЯ РАЗДЕЛА на следующих листах: второе окно
 * в то же поле ([data-a4-cont] с ключом поля, a4-sheets.js splitBlock). Пусто ли
 * обязательный раздел, решает раздел ЦЕЛИКОМ — поле и его продолжения. Ищем только на
 * других листах той же стопки: чужой документ соседней панели с тем же ключом сюда не
 * попадёт, а на одном листе (продолжений нет) обход ничего не стоит. Обход — по children:
 * так же работает поддельный DOM тестов.
 */
export function a4Continuations(field) {
    const key = field && typeof field.getAttribute === 'function' ? field.getAttribute('data-a4-field') : null;
    const at = key ? a4StackOf(field) : null;
    if (!at) return [];
    const out = [];
    const walk = (n) => {
        for (const c of Array.from((n && n.children) || [])) {
            const k = typeof c.getAttribute === 'function' ? c.getAttribute('data-a4-cont') : null;
            if (k !== null && k !== undefined) { if (k === key) out.push(c); continue; }
            // Текст чужого раздела (абзацы) продолжений не содержит — внутрь не ходим.
            if (String(c.className || '').split(/\s+/).includes('a4-input')) continue;
            walk(c);
        }
    };
    for (const sheet of Array.from(at.stack.children || [])) if (sheet !== at.paper) walk(sheet);
    return out;
}

/**
 * ПОЛОСА ДЕЙСТВИЙ НАД ЛИСТОМ: заготовка · печать · черновик · сохранить.
 *
 * CASE_DOC_ACTIONS_V1 (2026-09-10) — владелец: «remove this, and please add
 * template, print, draft, save button instead». На месте панели форматирования
 * стоят действия НАД ДОКУМЕНТОМ: взять заготовку, напечатать, отложить
 * черновиком, сохранить. Оформление текста (Ж/К/П, списки, размер) с бумаги
 * истории болезни не спрашивают.
 *
 * Ряд один и тот же на рабочем экране и в окне — иначе «Сохранить» означало бы
 * в двух местах разное.
 */
export function docActionsBar(ed, { onDone = null } = {}) {
    if (!ed) return null;
    const bar = h('div', { class: 'cd-acts no-print' });
    // Значок передаётся ГОТОВЫМ, а не именем: имя переменной проверка набора
    // иконок не видит, и «Save», которого в наборе нет вовсе, годами рисовался
    // бы перечёркнутым кругом — ровно это владелец и увидел на «Черновике».
    const add = (label, icon, cls, fn) => bar.appendChild(h('button', {
        class: 'btn btn-sm ' + cls, type: 'button',
        onclick: async (ev) => {
            const btn = ev && ev.currentTarget;
            if (btn) btn.disabled = true;
            try { const r = await fn(); if (r !== false && onDone) await onDone(); }
            finally { if (btn) btn.disabled = false; }
        },
    }, icon, ' ', tr(label)));

    // ADMIN_ACT_AS_V1 (R3) — ed.signLock: текст отказа, пока администратор
    // работает от имени сотрудника (admission-modal.js buildReviewEditor).
    // Запись стационара — и черновик тоже — от чужого имени не пишется:
    // кнопки неактивны, подсказка — тот же текст, что у отказа сервера.
    const lock = (btn) => {
        if (ed.signLock && btn) {
            btn.disabled = true;
            btn.setAttribute('title', tr(ed.signLock));
            btn.setAttribute('data-act-as-lock', '');
        }
        return btn;
    };
    // Слева — то, что документу помогает; справа — то, чем документ кончается.
    if (ed.applyTemplate) add('Заготовка', Icon('Copy', { size: 14 }), 'btn-ghost', () => { ed.applyTemplate(); return false; });
    if (ed.print) add('Печать', Icon('Print', { size: 14 }), 'btn-ghost', () => { ed.print(); return false; });
    bar.appendChild(h('span', { class: 'grow' }));
    if (ed.secondaryLabel) lock(add(ed.secondaryLabel, Icon('Edit', { size: 14 }), 'btn-outline', () => { ed.secondary(); return false; }));
    if (ed.submitLabel) lock(add(ed.submitLabel, Icon('Check', { size: 14 }), 'btn-primary', () => ed.submit()));
    return bar.children.length ? bar : null;
}

/**
 * НАПЕЧАТАТЬ ЛИСТ, КОТОРЫЙ ВИДНО НА ЭКРАНЕ.
 *
 * CASE_DOC_ACTIONS_V1 (2026-09-10) — печатается РОВНО та разметка, что нарисована
 * (a4Sheet с шапкой клиники), теми же таблицами стилей, что и экран. Второй
 * генератор бумаги разошёлся бы с первым — это уже случалось с бланком
 * результатов, и печатались два разных документа под одним именем.
 *
 * Служебное (кнопки, крестики, свёрнутые строки) помечено .no-print и в окно
 * печати не попадает.
 */
/** Полных лет на сегодня — или null, если даты рождения нет. */
function ageYears(dob) {
    if (!dob) return null;
    const d = new Date(dob);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    let n = now.getFullYear() - d.getFullYear();
    const before = now.getMonth() < d.getMonth()
        || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
    if (before) n -= 1;
    return n >= 0 && n < 130 ? n : null;
}

/**
 * Номера справа от названия документа: ID пациента и номер истории. Их
 * спрашивают по телефону и ищут в стопке.
 */
export function docHeadIds(admission) {
    const a = admission || {};
    return [
        { label: 'ID', value: (a.patients || {}).mrn || '' },
        { label: '№ истории', value: a.admission_no || '' },
    ];
}

/**
 * Реквизиты в полосе под шапкой.
 *
 * A4_LETTERHEAD_V2 — владелец: «add necessary fields». К пациенту и дате
 * рождения добавлены те, без которых стационарная бумага не опознаётся:
 * отделение с койкой и лечащий врач.
 *
 * Имя — ФАМИЛИЯ С ИНИЦИАЛАМИ (PERSON_NAME_SHORT_V1): полное не помещается в
 * четверть листа и уводит соседнюю ячейку на вторую строку.
 *
 * CASE_DOC_PRINT_V4 — собирается ОДНИМ местом на экран и на печать: две копии
 * этого списка разошлись бы, и бумага называла бы пациента иначе, чем экран.
 */
export function docHeadFields(admission) {
    const a = admission || {};
    const p = a.patients || {};
    const age = ageYears(p.date_of_birth);
    return [
        { label: 'Пациент', uz: 'Bemor', value: shortName(p.full_name), full: p.full_name || '' },
        { label: 'Дата рождения', uz: 'Tugʻilgan sana',
          value: p.date_of_birth ? dateNumeric(p.date_of_birth) : '',
          extra: age === null ? '' : trf('({n} лет)', { n: age }) },
        { label: 'Отделение · койка', uz: 'Boʻlim · koyka',
          value: placeLine(a.department, a.wards && a.wards.name, a.beds && a.beds.code) },
        { label: 'Лечащий врач', uz: 'Davolovchi shifokor',
          value: shortName((a.attending && a.attending.full_name) || '') },
    ];
}

/**
 * ТЕЛО ДОКУМЕНТА ДЛЯ ПЕЧАТНОГО ЛИСТА.
 *
 * CASE_DOC_PRINT_V4 (2026-09-10) — владелец: «#service-workspace print working
 * properly, but in the stationary its not».
 *
 * И был прав по существу: кабинет врача печатает через ОДИН общий механизм
 * приложения (doc-settings → buildSheetHtml), которым печатают счета, справки
 * и заключения, — с бумагой клиники, её шрифтом, полями, водяным знаком и
 * подписью. История болезни печаталась моим собственным: я снимал разметку с
 * экрана, вшивал в неё экранные стили и раз за разом чинил то поля, то рамки,
 * то шрифт. Так и должно было кончиться: два печатных механизма расходятся.
 *
 * Здесь остаётся ровно то, чего у общего механизма нет и быть не может, —
 * ЗНАНИЕ О РАЗДЕЛАХ ЭТОГО ДОКУМЕНТА. Всё остальное делает он.
 *
 * @param {Array<{title:string, html:string}>} parts разделы по порядку
 * @returns {string} разметка тела листа
 */
export function caseDocPrintBody(parts) {
    const rows = (parts || []).filter((p) => p && String(p.html || '').trim());
    if (!rows.length) {
        return `<div class="body muted" style="margin-top:18px;">${escHtml(tr('Документ ещё не заполнен.'))}</div>`;
    }
    return rows.map((p) => {
        const name = String(p.title || '').trim();
        // Раздел без имени печатается без заголовка — так его и завели.
        const head = name
            ? `<div class="sect"><span class="txt">${escHtml(name)}</span><span class="rule"></span></div>`
            : '';
        return `${head}<div class="body" style="text-align:left;">${sanitizeStoredHtml(p.html)}</div>`;
    }).join('');
}

/** Экранирование для печатной разметки: имя раздела пишет человек. */
function escHtml(v) {
    return String(v === null || v === undefined ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * СВОЙ РАЗДЕЛ — тот же, что в кабинете врача (service-workspace.js): имя
 * полем, крестик, текст. Имя МОЖНО НЕ ЗАПОЛНЯТЬ: врач дописывает абзац,
 * которому имя не нужно, и требовать его значило бы требовать всегда.
 *
 * @returns {{sec:HTMLElement, input:HTMLElement, name:HTMLElement}}
 */
let freeSeq = 0;

export function freeSection({ title = '', html = '', onRemove = null, onEdit = null } = {}) {
    const name = h('input', {
        type: 'text', class: 'a4-sec-name', placeholder: tr('Название раздела — можно не заполнять'),
        'aria-label': tr('Название раздела'),
    });
    name.value = title || '';
    if (onEdit) name.addEventListener('input', onEdit);
    // A4_SHEETS_V1 — своему разделу имени в наборе нет, а раскладке по листам
    // нужен ключ, по которому хвост вернётся в своё поле. Номер счётчика для
    // этого достаточен: он живёт ровно столько, сколько открыт документ.
    const input = h('div', {
        class: 'a4-input', contentEditable: 'true', 'data-ph': tr('Текст раздела…'),
        'data-a4-field': 'free_' + (freeSeq += 1),
    });
    if (html) applyRich(input, html);
    if (onEdit) input.addEventListener('input', onEdit);
    const fmt = onRemove ? fieldFormatBar(input) : null;
    const sec = h('div', { class: 'a4-sec cd-sec cd-sec-free', style: { position: 'relative' } },
        name,
        fmt ? fmt.toggle : null,
        onRemove
            ? h('button', { class: 'a4-sec-x no-print', type: 'button', title: tr('Убрать раздел'),
                'aria-label': tr('Убрать раздел'), onclick: () => onRemove(sec) }, '×')
            : null,
        fmt ? fmt.bar : null,
        input);
    return { sec, input, name };
}

/** Раздел «Диагноз» — та же рамка листа, но одна строка простого текста. */
export function plainSection(kind, key, input) {
    return h('div', { class: 'a4-sec cd-sec cd-sec-plain', 'data-sec': key },
        h('span', { class: 'a4-sec-tag' }, tr(sectionLabel(kind, key))),
        input);
}

/** Разметка раздела: то, что уйдёт на сервер. Чистится и здесь, и там. */
export function readRich(el) {
    if (!el) return '';
    const html = sanitizeStoredHtml(el.innerHTML || '');
    // Пустой раздел контенте-редактируемой области — это <br> или пробелы;
    // сохранять их значит записать «документ заполнен» там, где ничего нет.
    return /(\w|\d|[а-яёa-z])/i.test(html.replace(/<[^>]*>/g, '')) ? html : '';
}

export function applyRich(el, html) {
    if (!el) return;
    el.innerHTML = sanitizeStoredHtml(html || '');
}

// ---------------------------------------------------------------------------
// Панель форматирования
// ---------------------------------------------------------------------------
// Команды применяются к РАЗДЕЛУ, В КОТОРОМ СТОИТ КУРСОР. Кнопка срабатывает на
// mousedown с preventDefault: клик по кнопке иначе уводит фокус из текста, и
// выделение, к которому команда применяется, пропадает раньше самой команды.
export function richToolbar(container) {
    let last = null;
    const track = (e) => {
        const el = e.target && e.target.closest && e.target.closest('.a4-input');
        if (el) last = el;
    };
    if (container && container.addEventListener) {
        container.addEventListener('focusin', track);
        container.addEventListener('click', track);
    }
    const focusTarget = () => {
        const el = (last && last.isConnected) ? last : (container && container.querySelector && container.querySelector('.a4-input'));
        if (el && el.focus) el.focus();
        return el;
    };
    const exec = (cmd, value = null) => () => {
        focusTarget();
        try { document.execCommand(cmd, false, value); } catch (e) { /* браузер без execCommand — текст останется без оформления */ }
    };
    const btn = (title, label, onRun) => {
        const el = h('button', { class: 'a4-tool', type: 'button', title: tr(title), 'aria-label': tr(title) }, label);
        el.addEventListener('mousedown', (e) => { if (e.preventDefault) e.preventDefault(); onRun(); });
        return el;
    };
    const bar = h('div', { class: 'a4-tools' },
        btn('Полужирный', h('b', null, 'B'), exec('bold')),
        btn('Курсив', h('i', null, 'I'), exec('italic')),
        btn('Подчёркнутый', h('u', null, 'U'), exec('underline')),
        h('span', { class: 'a4-tool-sep' }),
        btn('Маркированный список', h('span', null, '• •'), exec('insertUnorderedList')),
        btn('Нумерованный список', h('span', null, '1.'), exec('insertOrderedList')),
        h('span', { class: 'a4-tool-sep' }),
        btn('Убрать оформление', h('span', null, 'Aa'), exec('removeFormat')));
    bar.insertInto = (el) => { last = el; };
    return { bar, target: () => (last && last.isConnected ? last : null), focusTarget };
}

/**
 * Вставить готовый блок в раздел, где стоит курсор.
 *
 * Владелец: «Вставить в документ». Блок кладётся туда, где врач писал, а если
 * он ещё нигде не писал — в первый раздел листа: молча ничего не вставить хуже,
 * чем вставить не совсем туда.
 */
export function insertBlock(toolbar, html) {
    const el = toolbar && toolbar.focusTarget ? toolbar.focusTarget() : null;
    if (!el) return false;
    const safe = sanitizeStoredHtml(html);
    if (!safe) return false;
    let ok = false;
    try { ok = document.execCommand('insertHTML', false, safe); } catch (e) { ok = false; }
    if (!ok) el.innerHTML = (el.innerHTML || '') + safe;
    return true;
}


// ---------------------------------------------------------------------------
// CASE_DX_PICK_V1 — ДИАГНОЗ: СВОИМИ СЛОВАМИ ИЛИ КОДОМ ИЗ СПРАВОЧНИКА.
//
// Владелец (2026-09-08): «here we have list of icd codes in the system … also
// user should be able write his own diagnosis».
//
// Поэтому это ОДНО поле, а не выбор из списка: врач печатает, и пока он
// печатает, снизу предлагаются коды МКБ-10 из справочника клиники (таблица
// icd10, миграция 106 — те же 14 000 кодов, что и в кабинете врача). Выбрал
// подсказку — в поле встало «K35.8 — Острый аппендицит»; не выбрал — осталось
// написанное им. Ни один диагноз не теряется из-за того, что его нет в
// справочнике: так пишут «состояние после…», «обострение…» и всё, чему кода
// не существует.
// ---------------------------------------------------------------------------
const ICD_KINDS = ['category', 'sub'];   // класс и блок — разделы классификации, а не диагнозы

/** Похоже ли на код: буква и цифра в начале («K35», «I21.0»). */
const looksLikeCode = (q) => /^[A-Za-zА-Яа-я]\s?\d/.test(q.trim());

export function icdSuggest(input, supabase) {
    const list = h('div', { class: 'cd-icd-list', role: 'listbox' });
    list.hidden = true;
    const hide = () => { list.hidden = true; clear(list); };
    let token = 0;
    const run = async () => {
        const q = String(input.value || '').trim();
        if (q.length < 2) { hide(); return; }
        const my = ++token;
        let rows = [];
        try {
            const base = () => supabase.from('icd10').select('code,name').in('kind', ICD_KINDS).eq('active', 1);
            const [byCode, byName] = await Promise.all([
                looksLikeCode(q) ? base().ilike('code', q.replace(/\s+/g, '') + '%').order('code').limit(10) : Promise.resolve({ data: [] }),
                base().ilike('name', '%' + q + '%').order('code').limit(10),
            ]);
            const seen = new Set();
            for (const r of [...((byCode && byCode.data) || []), ...((byName && byName.data) || [])]) {
                if (!r || seen.has(r.code)) continue;
                seen.add(r.code);
                rows.push(r);
            }
        } catch (e) { rows = []; }
        if (my !== token) return;
        clear(list);
        if (!rows.length) { hide(); return; }
        for (const r of rows.slice(0, 10)) {
            const btn = h('button', { class: 'cd-icd-row', type: 'button', role: 'option' },
                h('span', { class: 'cd-icd-code' }, r.code),
                h('span', { class: 'cd-icd-name' }, r.name));
            // mousedown, а не click: click приходит ПОСЛЕ blur, и к этому моменту
            // список уже скрыт — подсказка не срабатывала бы вовсе.
            btn.addEventListener('mousedown', (e) => {
                if (e.preventDefault) e.preventDefault();
                input.value = r.code + ' — ' + r.name;
                hide();
                input.dispatchEvent(new Event('input'));
            });
            list.appendChild(btn);
        }
        list.hidden = false;
    };
    input.addEventListener('input', run);
    input.addEventListener('focus', run);
    input.addEventListener('blur', () => setTimeout(hide, 120));
    return list;
}

/**
 * Сообщить полю, что значение изменили КОДОМ. Карточка диагнозов слушает своё
 * поле-носитель: черновик приезжает с сервера позже, чем рисуется карточка, и
 * без этого события список остался бы пустым у заполненного документа.
 */
export function fireInput(el) {
    if (!el || !el.dispatchEvent) return;
    try { el.dispatchEvent(typeof Event === 'function' ? new Event('input') : { type: 'input' }); }
    catch (e) { try { el.dispatchEvent({ type: 'input' }); } catch (e2) { /* среда без событий */ } }
}
