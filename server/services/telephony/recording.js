// CALL_RECORDING_V1 (2026-09-17) — ГДЕ У ЗВОНКА ЛЕЖИТ ЗАПИСЬ РАЗГОВОРА.
//
// Владелец: «also include into a card the audio record of the call».
//
// Три телефонии — три названия одного и того же поля, и ни одно из них не
// обязано быть на месте:
//   • «Мои Звонки» — recording, «ссылка на запись разговора, если ответили»
//     (их документация, раздел о событии call.finish);
//   • onlinePBX — ссылка приходит в истории звонка, поле встречается как
//     record_url / records / download;
//   • Binotel — recordingLink / recordUrl рядом с прочими полями звонка.
//
// Поэтому имя поля не угадывается, а ИЩЕТСЯ по списку — и найденное проверяется:
// это должен быть http(s)-адрес и ничего больше. Без проверки в карточку мог бы
// попасть любой текст из ответа вендора, который потом ушёл бы в src плеера.
//
// ЧТО СЧИТАЕТСЯ ИМЕНЕМ ЗАПИСИ. Только поля, в названии которых есть «record»
// или «audio», плюс явные mp3/wav. Общее «url» или «link» намеренно НЕ берётся:
// у вендора это чаще адрес карточки звонка в их кабинете, и подсунуть его
// плееру значило бы показать клинике молчащую кнопку «прослушать».
const NAME_RE = /(record|audio|mp3|wav)/i;
const URL_RE = /^https?:\/\/[^\s"'<>]+$/i;

// Вглубь ответа лезем ограниченно: сырые ответы вендоров бывают с событиями и
// вложенными списками, но запись всегда лежит близко к самому звонку, а
// бесконечный обход чужого JSON — это способ однажды встать на большом ответе.
const MAX_DEPTH = 4;

/**
 * Адрес записи разговора в сыром ответе телефонии — или '' , если его там нет.
 *
 * @param {any} raw  объект звонка, как его прислал вендор
 * @returns {string}
 */
export function recordingUrlOf(raw, depth = 0) {
    if (!raw || typeof raw !== 'object' || depth > MAX_DEPTH) return '';

    if (Array.isArray(raw)) {
        for (const item of raw) {
            const found = recordingUrlOf(item, depth + 1);
            if (found) return found;
        }
        return '';
    }

    // Сначала — поля этого уровня: запись звонка лежит у самого звонка, а не в
    // третьем вложенном списке, и найденное ближе вернее.
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== 'string' || !NAME_RE.test(key)) continue;
        const v = value.trim();
        if (URL_RE.test(v)) return v;
    }
    for (const value of Object.values(raw)) {
        if (!value || typeof value !== 'object') continue;
        const found = recordingUrlOf(value, depth + 1);
        if (found) return found;
    }
    return '';
}
