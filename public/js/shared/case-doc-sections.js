// INPATIENT_REQUIRED_V1 — РАЗДЕЛЫ ДОКУМЕНТОВ ИСТОРИИ БОЛЕЗНИ, ОДНА КОПИЯ НА СЕРВЕР И ЭКРАН.
// Список жил в views/case-doc-a4.js — экранном файле, который сервер импортировать не
// может (он тянет ui.js). Обязательные разделы документа проверяют обе стороны, и две
// копии списка разошлись бы на первой правке. Русского текста здесь нет: подписи
// разделов — у экрана (case-doc-a4.js LABEL) и у сервера (patient-doc-sources.js).

/** Разделы, у которых есть своя колонка в admission_reviews. */
export const SECTION_KEYS = Object.freeze(['complaints', 'objective', 'diagnosis', 'plan', 'body']);
const DEFAULT_SECTIONS = Object.freeze(['complaints', 'objective', 'diagnosis', 'plan', 'body']);

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
    // INPATIENT_REQUIRED_V1 — у неизвестного рода (свой документ клиники) — полный набор;
    // копия, а не сам замороженный список: вызывающие вправе её менять.
    const base = KIND_SECTIONS[kind] || DEFAULT_SECTIONS.slice();
    if (base.includes('diagnosis')) return base;
    // Место диагноза — сразу за «объективно», а если его нет — первым: так он
    // стоит во всех документах, где был, и не уезжает в конец у остальных.
    const at = base.indexOf('objective');
    const out = base.slice();
    out.splice(at < 0 ? 0 : at + 1, 0, 'diagnosis');
    return out;
}
