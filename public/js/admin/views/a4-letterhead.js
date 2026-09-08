// A4_LETTERHEAD_V1 — шапка клиники для документа на листе A4.
//
// Владелец: «treat this section as an A4 list with the header of the clinic
// from the documents section». Документ истории болезни оформляется на экране,
// но это ДОКУМЕНТ — и выглядеть он должен как лист, который потом распечатают:
// с той же шапкой клиники, что и на печатных бланках.
//
// Источник шапки ТОТ ЖЕ, что у кабинета врача (service-workspace.js, soapForm):
// window.CLINIC — строка companies, поднятая clinic-context.js. Отсюда же
// берут логотип и реквизиты печатные бланки, поэтому документ на экране и
// документ на бумаге показывают одну и ту же клинику. Классы .a4-* — общие,
// из admin-views.css; новых стилей это не добавляет.
//
// Вынесено отдельным модулем, а не вписано в case-workspace.js: та же шапка
// понадобится каждому документу, который решат показывать листом, и два
// экземпляра разошлись бы уже на первой правке реквизитов.
import { h } from '../ui.js';
import { tr } from '../i18n.js';

/** Реквизиты клиники для шапки — из window.CLINIC, с честными пустыми значениями. */
export function clinicLetterheadData(clinic = (typeof window !== 'undefined' && window.CLINIC) || {}) {
    const c = clinic || {};
    return {
        name:  c.name_ru || c.name || c.title || tr('Клиника'),
        legal: c.legal_name || '',
        addr:  c.address || '',
        phone: c.phone || '',
        logo:  c.logo_url || '',
    };
}

/**
 * Шапка листа: слева логотип и реквизиты, справа название документа и дата.
 * @param {{ title: string, date?: Date|string, clinic?: object }} opts
 */
export function a4Letterhead({ title, date = new Date(), clinic } = {}) {
    const d = clinicLetterheadData(clinic);
    const when = date instanceof Date ? date.toLocaleDateString('ru-RU') : String(date || '');
    return h('div', { class: 'a4-head' },
        h('div', { class: 'a4-clinic-wrap' },
            d.logo ? h('img', { class: 'a4-logo', src: d.logo, alt: '' }) : null,
            h('div', { class: 'a4-clinic' }, d.name,
                d.legal ? h('small', null, d.legal) : null,
                d.addr  ? h('small', null, d.addr) : null,
                d.phone ? h('small', null, d.phone) : null,
            ),
        ),
        h('div', { class: 'a4-doctitle' }, title,
            h('div', { class: 'a4-datebox' }, tr('Дата') + ': ' + when),
        ),
    );
}

/**
 * Лист целиком: шапка и содержимое. Действия (кнопки) на лист не кладутся —
 * это не часть документа; вызывающий ставит их под листом.
 *
 * A4_REAL_V1 (2026-09-08) — владелец: «remove the thin line above and use
 * document type ui. real a4». Бирюзовые полосы сверху и снизу были украшением
 * интерфейса на документе: на бумаге их нет, и на экране они превращали лист
 * в карточку продукта. Лист — это бумага: шапка клиники, текст, поля.
 */
export function a4Sheet({ title, date, clinic, children = [] } = {}) {
    return h('div', { class: 'a4-paper' },
        a4Letterhead({ title, date, clinic }),
        ...children.filter(Boolean),
    );
}
