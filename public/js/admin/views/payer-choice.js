// PAYER_COMPANY_IN_ESTIMATE_V1 — чистая логика ряда компаний в СМЕТЕ.
//
// Почему отдельным файлом. visit-wizard.js ни один тест не импортирует: он
// тянет supabase, иконки и весь экран, и про него пишут проверки по исходнику
// (booking-doors.test.mjs, wizard-templates.test.mjs). Одиночность выбора и
// переполнение исходником не проверяются, а сломаться могут молча — поэтому
// они здесь, где их можно ВЫЗВАТЬ.
//
// Без DOM и без импортов: всё, что нужно, приходит аргументами.

// Четыре — сколько помещается в колонку сметы в два ряда, не съедая её высоту.
const DEFAULT_LIMIT = 4;

/**
 * Что показать сразу и что спрятать под «Ещё N».
 *
 * Выбранная компания показывается ВСЕГДА, даже если по порядку попала в
 * хвост: ряд без единой отметки выглядит как «ничего не выбрано», и компанию
 * выбирают второй раз. Она меняется местами с последней видимой, поэтому
 * длина ряда не скачет.
 *
 * @param {Array<{id:*, name:string}>} list  компании одного типа
 * @param {*} selectedId                     wiz.payerId ('self', если нет)
 * @param {number} [limit]
 * @returns {{shown:Array, hidden:Array, hiddenCount:number}}
 */
export function splitCompanies(list, selectedId, limit = DEFAULT_LIMIT) {
    const all = (Array.isArray(list) ? list : []).filter(Boolean);
    if (all.length <= limit) return { shown: all, hidden: [], hiddenCount: 0 };
    const shown = all.slice(0, limit);
    const hidden = all.slice(limit);
    const i = hidden.findIndex(p => String(p.id) === String(selectedId));
    if (i !== -1) {
        const displaced = shown[limit - 1];
        shown[limit - 1] = hidden[i];
        hidden[i] = displaced;
    }
    return { shown, hidden, hiddenCount: hidden.length };
}

/**
 * Что должно стать выбранным после клика по фишке.
 *
 * Выбор ОДИНОЧНЫЙ — у визита ровно один payer_id, поэтому клик по другой
 * компании переносит отметку, а не добавляет вторую. Повторный клик по
 * выбранной снимает её и возвращает 'self'; ТИП плательщика при этом остаётся,
 * и «Далее» не пропустит (nextBlockReason, PAYER_TYPE_THEN_COMPANY_V1).
 *
 * @returns {string} id компании или 'self'
 */
export function toggleCompanyId(currentId, clickedId) {
    return String(currentId) === String(clickedId) ? 'self' : String(clickedId);
}
