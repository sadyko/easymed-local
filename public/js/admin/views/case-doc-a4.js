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
import { h } from '../ui.js';
import { tr } from '../i18n.js';
import { sanitizeStoredHtml } from '../../shared/rich-text.js';

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

export function sectionsFor(kind) {
    return KIND_SECTIONS[kind] || ['complaints', 'objective', 'diagnosis', 'plan', 'body'];
}
export function sectionLabel(kind, key) {
    return key === 'body' && BODY_LABEL[kind] ? BODY_LABEL[kind] : LABEL[key] || key;
}
export function sectionPlaceholder(key) { return PH[key] || ''; }

/** Раздел листа: подпись и редактируемая область. */
export function richSection(kind, key) {
    const input = h('div', {
        class: 'a4-input', 'data-field': key, contentEditable: 'true',
        'data-ph': tr(sectionPlaceholder(key)),
    });
    const sec = h('div', { class: 'a4-sec cd-sec', 'data-sec': key },
        h('span', { class: 'a4-sec-tag' }, tr(sectionLabel(kind, key))),
        input);
    return { sec, input };
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
