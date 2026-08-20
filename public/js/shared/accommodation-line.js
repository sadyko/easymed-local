// ACCOMMODATION_AS_SERVICE_V1 — как узнать строку проживания.
//
// Внесённое проживание — строка admission_services без service_id и без
// clinic_item_id: своей услуги в каталоге у койки нет, а заводить колонку в
// живой таблице ради одного признака дороже, чем метка в notes.
//
// Модуль лежит в shared, потому что notes пишет СЕРВЕР (rpc/accommodation.js), а
// читает БРАУЗЕР (views/admission-modal.js). Две копии этой строки разошлись бы
// молча: проживание перестало бы узнаваться, и в списке услуг снова появилось
// бы «(removed)» — сумма, за которой будто ничего нет. Тот же приём, что с
// payment-methods.js и doc-render.js.

export const ACCOMMODATION_NOTE_PREFIX = 'ACCOMMODATION';

// Название для списка услуг. Ключ перевода — он же: i18n-strings.js держит
// ru/en/uz, а ui.js h() прогоняет текстовые узлы через tr(), поэтому подпись
// переводится там же, где и всё остальное.
export const ACCOMMODATION_LABEL = 'Проживание в палате';

export function isAccommodationLine(row) {
    if (!row || typeof row !== 'object') return false;
    // Настоящая услуга или расходник — не проживание, даже если кто-то впишет
    // слово в примечание.
    if (row.service_id || row.clinic_item_id) return false;
    const notes = typeof row.notes === 'string' ? row.notes : '';
    // Именно НАЧАЛО строки: примечание «пациент просил ACCOMMODATION поменять»
    // — это заметка медсестры, а не строка за койку.
    return notes.startsWith(ACCOMMODATION_NOTE_PREFIX);
}

// Куда строка попадает на экране стационара.
//
// Экраны делят admission_services на «Услуги» и «Товары» по тому, какой ключ
// заполнен. У проживания не заполнен НИ ОДИН — из-за этого оно провалилось
// между двумя списками и не показывалось нигде, хотя продолжало попадать в
// счёт. Строка, которую нельзя увидеть, но можно выставить, — худший вариант,
// поэтому правило теперь одно и проверяется тестом.
export function isGoodsLine(row) {
    return !!(row && row.clinic_item_id);
}

export function isServiceLine(row) {
    if (!row || typeof row !== 'object') return false;
    if (isGoodsLine(row)) return false;
    return row.service_id != null || isAccommodationLine(row);
}
