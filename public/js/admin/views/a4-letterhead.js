// A4_LETTERHEAD_V2 — ОДНА ШАПКА У ВСЕХ ДОКУМЕНТОВ.
//
// Владелец (2026-09-09): «#service-workspace use this template in stationary
// documents too … so everywhere we have similar header of the documents»,
// «add to the right side of the title the id and the history number»,
// «b is looking good» (подпись НАД значением), «can we not use • between
// numbers».
//
// КАК БЫЛО. Три места рисовали шапку по-своему: кабинет врача — реквизиты
// клиники слева и название документа справа; история болезни — то же, но своей
// разметкой; бланк в «Документах» — третьей.
//
// КАК СТАЛО. Шапка одна и состоит из двух ярусов:
//
//   1. ЗНАК КЛИНИКИ │ НАЗВАНИЕ ДОКУМЕНТА с датой │ НОМЕРА справа. Номера — ID
//      пациента и номер, под которым бумага лежит в архиве (истории, анализа,
//      приёма). Они справа, СВОЕЙ колонкой, а не в строке названия: название
//      бывает в две строки («Информированное добровольное согласие…»), и
//      номера тогда уезжали бы вместе с ним.
//   2. ПОЛОСА РЕКВИЗИТОВ: четыре РАВНЫЕ колонки, в каждой подпись, под ней
//      значение, под ним подпись по-узбекски. Равные колонки — не про
//      красоту: ячейки по содержимому разъезжались на вторую строку, стоило
//      попасться длинной фамилии. Значение шире колонки обрезается многоточием,
//      целиком оно в подсказке.
//
// Реквизиты клиники берутся ОТТУДА ЖЕ, ОТКУДА ПЕЧАТЬ (A4_ONE_TEMPLATE_V1):
// настройки «Документов», а window.CLINIC — запасной вариант.
//
// ЛОГОТИП НЕ КВАДРАТ. Высота фиксирована, ширина своя: квадрат сплющивал бы
// широкий словесный знак и обрезал высокий герб. Ровняет строку не сам знак, а
// линейка после него, поэтому у клиники без логотипа название документа
// начинается на той же вертикали. Печать (shared/doc-render.js, logoMark) уже
// давно делает так же — здесь экран догоняет бумагу, а не наоборот.
import { h } from '../ui.js';
import { tr } from '../i18n.js';
import { loadDocSettings } from './doc-settings.js?v=noqr1';   // A4_ONE_TEMPLATE_V1

/**
 * Реквизиты клиники для шапки листа.
 *
 * ОДИН ИСТОЧНИК. Раньше экранный лист брал их из window.CLINIC, а печатный
 * бланк — из настроек «Документов» (doc_branding). Клиника, настроившая себе
 * логотип, название и акцент для печати, видела на экране ДРУГУЮ шапку и
 * справедливо считала, что настройки не работают.
 *
 * Явно переданная клиника всё равно главнее: печать титульного листа обязана
 * показывать реквизиты СНИМКА, а не сегодняшние.
 */
export function clinicLetterheadData(clinic = null) {
    const c = clinic || (typeof window !== 'undefined' && window.CLINIC) || {};
    let s = null;
    if (!clinic) { try { s = loadDocSettings(); } catch (e) { s = null; } }
    const pick = (a, b) => (a === null || a === undefined || a === '' ? b : a);
    return {
        name:   pick(s && s.clinicName, c.name_ru || c.name || c.title) || tr('Клиника'),
        legal:  pick(s && s.tagline, c.legal_name) || '',
        addr:   pick(s && s.address, c.address) || '',
        phone:  pick(s && s.phone, c.phone) || '',
        logo:   pick(s && (s.logoUrl || s.logoDataUrl), c.logo_url) || '',
        accent: (s && s.accent) || '',
    };
}

/** Номер справа от названия: подпись и значение в одну строку. */
function idRow(f, accent) {
    if (!f || !f.label) return null;
    return h('div', { class: 'a4-lh-id' },
        h('span', { class: 'a4-lh-id-l' }, tr(f.label)),
        h('span', { class: 'a4-lh-id-v', style: accent ? { color: accent } : null }, f.value || '—'));
}

/** Ячейка полосы: подпись, под ней значение, под ним подпись по-узбекски. */
function fieldCell(f, accent) {
    if (!f || !f.label) return null;
    const value = f.value || '—';
    return h('div', { class: 'a4-lh-f' },
        h('div', { class: 'a4-lh-f-l' }, tr(f.label)),
        // Подсказка несёт значение ЦЕЛИКОМ: в колонке оно может не поместиться,
        // и обрезанная фамилия без способа её прочесть — хуже, чем перенос.
        h('div', { class: 'a4-lh-f-v', title: f.full || value }, value,
            f.extra ? h('span', { class: 'a4-lh-f-x' }, ' ' + f.extra) : null),
        f.uz ? h('div', { class: 'a4-lh-f-uz', style: accent ? { color: accent } : null }, f.uz) : null);
}

/**
 * Шапка листа.
 *
 * @param {{title:string, date?:Date|string, clinic?:object, ids?:Array, fields?:Array}} opts
 *        ids    — [{ label, value }] справа от названия (ID, № истории);
 *        fields — [{ label, uz, value, extra, full }] полосой под шапкой.
 */
export function a4Letterhead({ title, date = new Date(), clinic, ids = [], fields = [] } = {}) {
    const d = clinicLetterheadData(clinic);
    const when = date instanceof Date ? date.toLocaleDateString('ru-RU') : String(date || '');
    const idCells = (ids || []).map((f) => idRow(f, d.accent)).filter(Boolean);
    const cells = (fields || []).map((f) => fieldCell(f, d.accent)).filter(Boolean);
    return h('div', { class: 'a4-lh' },
        h('div', { class: 'a4-lh-top' },
            h('div', { class: 'a4-lh-brand' },
                d.logo ? h('img', { class: 'a4-lh-logo', src: d.logo, alt: '' }) : null,
                h('div', { class: 'a4-lh-name', title: d.name }, d.name)),
            h('div', { class: 'a4-lh-rule', style: d.accent ? { background: d.accent } : null }),
            h('div', { class: 'a4-lh-doc' },
                h('div', { class: 'a4-lh-title' }, title),
                when ? h('div', { class: 'a4-lh-date' }, tr('от') + ' ' + when) : null),
            idCells.length ? h('div', { class: 'a4-lh-ids' }, ...idCells) : null),
        cells.length ? h('div', { class: 'a4-lh-fields' }, ...cells) : null);
}

/**
 * Лист целиком: шапка и содержимое. Действия (кнопки) на лист не кладутся —
 * это не часть документа; вызывающий ставит их под листом.
 *
 * A4_REAL_V1 — бирюзовые полосы сверху и снизу убраны: на бумаге их нет, а на
 * экране они превращали лист в карточку продукта.
 */
export function a4Sheet({ title, date, clinic, ids = [], fields = [], children = [] } = {}) {
    return h('div', { class: 'a4-paper' },
        a4Letterhead({ title, date, clinic, ids, fields }),
        ...children.filter(Boolean),
    );
}
