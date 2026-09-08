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
import { h, clear } from '../ui.js';
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
