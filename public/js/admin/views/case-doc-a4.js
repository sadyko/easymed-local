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
import { PRINT_FONT_FACE_CSS, PRINT_FONT_STACK } from '../../shared/print-fonts.js';   // ONEST_TYPOGRAPHY_V1

/** Разделы, которые пишутся разметкой. `diagnosis` сюда не входит намеренно. */
export const RICH_KEYS = Object.freeze(['complaints', 'objective', 'plan', 'body']);

/**
 * ЧТО ЗА РАЗДЕЛЫ У ЭТОГО ДОКУМЕНТА.
 *
 * Протокол операции — это один сплошной текст, а дневник наблюдения — жалобы,
 * объективно и план. Одинаковый набор полей на все одиннадцать документов
 * заставлял врача пролистывать пустые разделы, которых у этой бумаги не
 * бывает. Разделы, которых нет в списке, НЕ ТЕРЯЮТСЯ: их прежнее значение
 * уходит обратно на сервер как было (см. buildReviewEditor).
 */
export const KIND_SECTIONS = Object.freeze({
    intake:      ['complaints', 'objective', 'diagnosis', 'plan'],
    primary:     ['complaints', 'objective', 'diagnosis', 'plan', 'body'],
    head_review: ['objective', 'diagnosis', 'plan'],
    rationale:   ['objective', 'diagnosis', 'body'],
    round:       ['complaints', 'objective', 'plan'],
    interim:     ['complaints', 'objective', 'diagnosis', 'plan'],
    discharge:   ['complaints', 'objective', 'diagnosis', 'plan', 'body'],
    anesthesia:  ['objective', 'plan', 'body'],
    preop:       ['objective', 'diagnosis', 'plan'],
    operation:   ['body'],
    consent:     ['body'],
    other:       ['body'],
});

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

/**
 * Разделы документа. ДИАГНОЗ ЕСТЬ У КАЖДОГО.
 *
 * CASE_DX_EVERYWHERE_V1 (2026-09-10) — владелец: «make diagnosis active in
 * every document so it wont confuse user». Раньше карточка «Диагноз» слева
 * появлялась у одних документов и пропадала у других (у дневника, протокола
 * операции, осмотра анестезиолога её не было), и врач каждый раз гадал, куда
 * делось поле. Диагноз — то, ради чего документ и читают; его место одно и то
 * же на всех бумагах.
 *
 * ЗАПОЛНЯТЬ его обязан только первичный осмотр — это правило публикации, и оно
 * не изменилось: у остальных документов поле есть, но пустым оно их не держит.
 */
export function sectionsFor(kind) {
    const base = KIND_SECTIONS[kind] || ['complaints', 'objective', 'diagnosis', 'plan', 'body'];
    if (base.includes('diagnosis')) return base;
    // Место диагноза — сразу за «объективно», а если его нет — первым: так он
    // стоит во всех документах, где был, и не уезжает в конец у остальных.
    const at = base.indexOf('objective');
    const out = base.slice();
    out.splice(at < 0 ? 0 : at + 1, 0, 'diagnosis');
    return out;
}
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
        class: 'a4-input', 'data-field': key, contentEditable: 'true',
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
    const sec = h('div', { class: 'a4-sec cd-sec', 'data-sec': key, style: { position: 'relative' } },
        onAdd
            ? h('button', {
                class: 'a4-sec-add', type: 'button',
                onclick: () => onAdd(),
            }, trf('+ Добавить: {name}', { name: String(title || '').trim() || tr(sectionLabel(kind, key)) }))
            : null,
        tag,
        fmt ? fmt.toggle : null,
        onRemove
            ? h('button', {
                class: 'a4-sec-x no-print', type: 'button', title: tr('Убрать раздел'),
                'aria-label': tr('Убрать раздел'), onclick: () => onRemove(),
            }, '×')
            : null,
        fmt ? fmt.bar : null,
        input);

    if (onRename) {
        tag.addEventListener('click', () => {
            const field = h('input', { type: 'text', class: 'a4-sec-name', placeholder: tr('Название раздела') });
            field.value = shown();
            let closed = false;
            // Подменяется РОВНО подпись: коробка держит ещё свёрнутую строку,
            // крестик и текст, и пересобирать её целиком значило бы потерять их.
            const swap = (from, to) => {
                const i = sec.children.indexOf(from);
                if (i < 0) return;
                sec.removeChild(from);
                const rest = sec.children.splice(i);
                sec.appendChild(to);
                for (const el of rest) sec.appendChild(el);
            };
            const stop = () => { if (closed) return; closed = true; swap(field, tag); };
            const save = () => {
                if (closed) return;
                closed = true;
                const value = String(field.value || '').trim();
                title = value === tr(sectionLabel(kind, key)) ? '' : value;
                tag.textContent = shown();
                tag.setAttribute('aria-label', trf('Переименовать раздел: {name}', { name: shown() }));
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
    return { sec, input };
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

    // Слева — то, что документу помогает; справа — то, чем документ кончается.
    if (ed.applyTemplate) add('Заготовка', Icon('Copy', { size: 14 }), 'btn-ghost', () => { ed.applyTemplate(); return false; });
    if (ed.print) add('Печать', Icon('Print', { size: 14 }), 'btn-ghost', () => { ed.print(); return false; });
    bar.appendChild(h('span', { class: 'grow' }));
    if (ed.secondaryLabel) add(ed.secondaryLabel, Icon('Edit', { size: 14 }), 'btn-outline', () => { ed.secondary(); return false; });
    if (ed.submitLabel) add(ed.submitLabel, Icon('Check', { size: 14 }), 'btn-primary', () => ed.submit());
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
/**
 * Разметка печатной страницы.
 *
 * СТИЛИ ЕДУТ ВНУТРИ СТРАНИЦЫ, А НЕ ССЫЛКОЙ. Окно печати открывается ПУСТЫМ
 * (window.open('')), адрес у него about:blank, и ссылка «css/admin.css»
 * разрешаться ей не от чего — лист приезжал голым текстом, будто напечатали
 * исходник. Владелец дважды: «printing documents still not applied», «its like
 * rendering the html format».
 *
 * <base> это чинит, но только пока стили успевают загрузиться до печати —
 * то есть ставит бумагу в зависимость от сети и таймингов. Поэтому таблицы
 * стилей ВШИВАЮТСЯ: печать перестаёт зависеть от чего бы то ни было, кроме
 * самой разметки. <base> остаётся ради картинок (логотип клиники).
 *
 * ШРИФТ. Экранные правила приходят вместе со стилями, но САМИ ФАЙЛЫ шрифта в
 * новом окне надо объявить заново — иначе браузер печатает системным Times, и
 * бумага клиники выглядит чужой (владелец: «why? its looking like this?»).
 * Берём тот же @font-face, которым печатают все остальные документы.
 *
 * @param {{title?:string, base?:string, css?:string}} opts
 */
export function docPrintHtml(sheetHtml, { title = '', base = null, css = '' } = {}) {
    const safe = String(title || '').replace(/[<>&]/g, '');
    const origin = base !== null ? base
        : (typeof location !== 'undefined' && location.origin ? location.origin + '/' : '');
    const baseTag = origin ? `<base href="${String(origin).replace(/["<>]/g, '')}">` : '';
    // Ссылки остаются ПОЛОМ: если вшить стили не удалось (старый браузер,
    // отказ fetch), лист всё равно попробует взять их по адресу.
    const links = css ? '' : '<link rel="stylesheet" href="css/admin.css">'
        + '<link rel="stylesheet" href="css/admin-views.css">';
    // Служебное на бумагу не идёт: кнопки действий, крестики разделов и
    // свёрнутые строки «+ Добавить» — они в списке скрытого ниже.
    //
    // Шрифт задаётся ПОСЛЕ вшитых правил: иначе экранный body-стиль сильнее.
    // Высота листа снимается: экранные 1123 px гнали вторую, пустую страницу.
    // ПОЛЯ ЛИСТА ОСТАЮТСЯ ЭКРАННЫМИ. Обнулив их, я вжал документ в самый край
    // страницы — владелец сравнил экран с бумагой и увидел два разных
    // документа. Лист занимает всю ширину печатной области, а воздух внутри
    // у него тот же, что на экране; рамки полей ввода на бумаге сняты — на
    // экране они говорят «сюда можно писать», а на бумаге писать некуда.
    //
    // I18N_COVERAGE_V1 — русских слов внутри самой строки быть не должно: она
    // собирается из ${…}, и проверка ищет в таких строках непереведённый текст.
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
${baseTag}
<title>${safe}</title>
${links}
<style>
${PRINT_FONT_FACE_CSS}
${css}
  @page { size: A4; margin: 12mm; }
  html, body { margin: 0; background: #fff; font-family: ${PRINT_FONT_STACK}; }
  body * { font-family: inherit; }
  .no-print, .a4-sec-add, .a4-sec-x, .cd-acts, .a4-fmt, .a4-fmt-t { display: none !important; }
  .a4-sec-off { display: none !important; }
  .a4-paper { box-shadow: none !important; margin: 0 !important;
      width: 100% !important; max-width: none !important; min-height: 0 !important; }
  .a4-input { border-color: transparent !important; background: transparent !important;
      padding-left: 0 !important; padding-right: 0 !important; }
</style></head><body>${sheetHtml}</body></html>`;
}

/**
 * БУМАГА, В КОТОРОЙ ЛЕЖИТ ЭТОТ УЗЕЛ.
 *
 * Печать получала .cd-sheet — только разделы, — потому что звавший её код
 * смотрел на ОДНОГО родителя, а между разделами и листом лежит ещё обёртка
 * тела документа. На бумагу уходил текст без шапки клиники, без названия
 * документа и без полосы реквизитов.
 */
function paperOf(node) {
    let el = node;
    for (let i = 0; el && i < 12; i += 1) {
        const cls = String(el.className || '').split(/\s+/);
        if (cls.includes('a4-paper')) return el;
        el = el.parentNode;
    }
    return node;
}

/**
 * Собрать таблицы стилей САМОЙ СТРАНИЦЫ — те, по которым лист нарисован на
 * экране. Читаются правила уже загруженных стилей; если браузер их не отдаёт
 * (в этом приложении такого нет, но правило общее), возвращается пусто, и
 * печать откатывается на ссылки.
 */
function pageCss() {
    try {
        const out = [];
        for (const sheet of Array.from(document.styleSheets || [])) {
            let rules = null;
            try { rules = sheet.cssRules; } catch (e) { rules = null; }   // чужой домен
            if (!rules) continue;
            for (const rule of Array.from(rules)) out.push(rule.cssText);
        }
        return out.join('\n');
    } catch (e) { return ''; }
}

/** Служебное на листе: инструменты, а не документ. */
const PRINT_STRIP = '.no-print, .a4-sec-off, .a4-sec-add, .a4-sec-x, .a4-fmt, .a4-fmt-t, .cd-acts, .a4-pbreak';

/**
 * КОПИЯ ЛИСТА БЕЗ СЛУЖЕБНОГО.
 *
 * CASE_DOC_PRINT_V3 (2026-09-10) — раньше служебное пряталось правилами CSS в
 * печатной странице, и любое расхождение в этих правилах давало пустой лист:
 * владелец получил бумагу, на которой была только шапка. Правило, спрятавшее
 * лишнее, ровно так же прячет нужное — и молча.
 *
 * Теперь лишнее ВЫРЕЗАЕТСЯ из копии, а печатается то, что осталось. Копия — не
 * сам лист: врач продолжает писать в свой документ, пока открыто окно печати.
 */
function printableClone(paper) {
    if (!paper || typeof paper.cloneNode !== 'function') return paper;
    const copy = paper.cloneNode(true);
    try {
        const junk = copy.querySelectorAll ? copy.querySelectorAll(PRINT_STRIP) : [];
        for (const el of Array.from(junk)) { if (el && el.remove) el.remove(); }
    } catch (e) { /* нечего вырезать — печатаем как есть */ }

    // ПУСТОЙ ЛИСТ ОБЯЗАН СКАЗАТЬ, ЧТО ОН ПУСТ. Документ, у которого не
    // заполнен ни один раздел, печатался шапкой и белым полем — и выглядел
    // как сломанная печать, а не как пустой документ.
    try {
        const filled = Array.from(copy.querySelectorAll ? copy.querySelectorAll('.a4-input') : [])
            .some((el) => String(el.textContent || '').trim());
        if (!filled && copy.appendChild) {
            const note = document.createElement('div');
            note.className = 'a4-print-empty';
            note.textContent = tr('Документ ещё не заполнен.');
            copy.appendChild(note);
        }
    } catch (e) { /* не смогли проверить — печатаем как есть */ }
    return copy;
}

/** Открыть окно печати с этим листом. Разметку собирает docPrintHtml. */
export function printDocSheet(node, { title = '' } = {}) {
    const sheetEl = paperOf(node);
    if (!sheetEl) return false;
    const w = window.open('', '_blank', 'width=900,height=1100');
    if (!w) return false;
    const copy = printableClone(sheetEl);
    w.document.open();
    w.document.write(docPrintHtml(copy.outerHTML, { title, css: pageCss() }));
    w.document.close();
    // Печать зовём ПОСЛЕ загрузки: стили теперь внутри страницы, но картинки
    // (логотип) ещё едут. Если onload не случится, печатаем всё равно — через
    // секунду: молчащее окно печати выглядит так же, как сломанная кнопка.
    let done = false;
    const go = () => {
        if (done) return;
        done = true;
        try { w.focus(); w.print(); } catch (e) { /* пользователь напечатает сам */ }
    };
    try {
        w.onload = go;
        if (typeof w.setTimeout === 'function') w.setTimeout(go, 1200);
        else if (typeof setTimeout === 'function') setTimeout(go, 1200);
    } catch (e) { /* окно закрыли раньше */ }
    return true;
}

/**
 * СВОЙ РАЗДЕЛ — тот же, что в кабинете врача (service-workspace.js): имя
 * полем, крестик, текст. Имя МОЖНО НЕ ЗАПОЛНЯТЬ: врач дописывает абзац,
 * которому имя не нужно, и требовать его значило бы требовать всегда.
 *
 * @returns {{sec:HTMLElement, input:HTMLElement, name:HTMLElement}}
 */
export function freeSection({ title = '', html = '', onRemove = null, onEdit = null } = {}) {
    const name = h('input', {
        type: 'text', class: 'a4-sec-name', placeholder: tr('Название раздела — можно не заполнять'),
        'aria-label': tr('Название раздела'),
    });
    name.value = title || '';
    if (onEdit) name.addEventListener('input', onEdit);
    const input = h('div', { class: 'a4-input', contentEditable: 'true', 'data-ph': tr('Текст раздела…') });
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
