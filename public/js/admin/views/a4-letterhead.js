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
import { loadDocSettings } from './doc-settings.js?v=noqr1';   // A4_ONE_TEMPLATE_V1

/**
 * Реквизиты клиники для шапки листа.
 *
 * A4_ONE_TEMPLATE_V1 (2026-09-09) — владелец: «we have a documents section in
 * the settings, and the documents editing in the stationary cabinet, make them
 * similar design repeating the a4 template of the documents settings».
 *
 * ОДИН ИСТОЧНИК. Раньше экранный лист брал реквизиты из window.CLINIC, а
 * печатный бланк — из настроек «Документов» (doc_branding). Клиника, которая
 * настроила себе логотип, название и акцент для печати, видела на экране
 * ДРУГУЮ шапку — и справедливо считала, что настройки не работают. Теперь
 * экран спрашивает те же настройки, что и печать, а window.CLINIC остаётся
 * запасным вариантом, пока настройки не загрузились.
 *
 * Явно переданная клиника всё равно главнее: так печать титульного листа
 * подставляет реквизиты снимка, а не сегодняшние.
 */
export function clinicLetterheadData(clinic = null) {
    const c = clinic || (typeof window !== 'undefined' && window.CLINIC) || {};
    let s = null;
    if (!clinic) { try { s = loadDocSettings(); } catch (e) { s = null; } }
    const pick = (a, b2) => (a === null || a === undefined || a === '' ? b2 : a);
    return {
        name:   pick(s && s.clinicName, c.name_ru || c.name || c.title) || tr('Клиника'),
        legal:  pick(s && s.tagline, c.legal_name) || '',
        addr:   pick(s && s.address, c.address) || '',
        phone:  pick(s && s.phone, c.phone) || '',
        logo:   pick(s && (s.logoUrl || s.logoDataUrl), c.logo_url) || '',
        // Акцент бланка: та же линейка под шапкой, что печатается на бумаге.
        accent: (s && s.accent) || '',
    };
}

/**
 * Шапка листа: слева логотип и реквизиты, справа название документа и дата.
 * @param {{ title: string, date?: Date|string, clinic?: object }} opts
 */
export function a4Letterhead({ title, date = new Date(), clinic } = {}) {
    const d = clinicLetterheadData(clinic);
    const when = date instanceof Date ? date.toLocaleDateString('ru-RU') : String(date || '');
    // A4_ONE_TEMPLATE_V1 — линейка под шапкой красится акцентом клиники: он же
    // печатается на бумаге, и лист на экране обязан выглядеть тем же бланком.
    return h('div', { class: 'a4-head', style: d.accent ? { borderBottomColor: d.accent } : null },
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
