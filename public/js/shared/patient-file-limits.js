// PATIENT_FILE_ATTACH_V1 — что вообще можно приложить к карте пациента.
//
// Живёт в public/js/shared/ по той же причине, что chat-attachment.js: правила
// нужны ОБОИМ рантаймам. Браузер отбивает лишнее ДО загрузки (регистратор не
// ждёт минуту, чтобы узнать, что файл не приняли), сервер отбивает то же самое
// ещё раз — потому что браузер обойти можно, а curl проверку не спрашивает.
// Разъедься эти два набора, и появился бы файл, который экран принял, а сервер
// отказался хранить.
//
// Модуль чистый: ни DOM, ни node-встроенных.

import { extensionOf } from './chat-attachment.js';

export { extensionOf };

// ПОТОЛОК ОДИН НА ПРОДУКТ — 20 МБ, тот же, что у вложения в чат Telegram
// (chat-attachment.js) и у сырого тела POST /api/storage (routes/storage.js).
// Три разных числа означали бы три разных места, где файл «почему-то» не
// проходит, и клиника угадывала бы, какое из них сработало.
//
// Телефон снимает 40-мегабайтные фотографии, и это НЕ теоретический случай:
// именно так выглядит «сфотографировал направление в приёмной». Такой файл
// получает отказ, который называет РАЗМЕР и ПРЕДЕЛ, а не «ошибка загрузки», —
// человек должен понять, что делать (переснять, ужать, приложить PDF), а не
// нажимать ту же кнопку второй раз.
export const MAX_PATIENT_FILE_BYTES = 20 * 1024 * 1024;

export const MAX_PATIENT_FILE_MB = Math.round(MAX_PATIENT_FILE_BYTES / (1024 * 1024));

// СПИСОК РАЗРЕШЁННОГО, А НЕ СПИСОК ЗАПРЕЩЁННОГО. Клиника прикладывает сканы,
// фотографии, PDF направлений, иногда выписку в Word или таблицу анализов в
// Excel. Всё остальное — .exe, .bat, .ps1, .js, .lnk — к карте пациента
// отношения не имеет, а лежать будет на том же компьютере, где работает
// регистратура. Запретительный список пришлось бы дополнять после каждого
// нового способа сделать файл исполняемым; разрешительный не приходится.
export const ALLOWED_PATIENT_FILE_EXT = Object.freeze([
    // фотографии и сканы
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif',
    // документы
    '.pdf', '.doc', '.docx', '.rtf', '.odt',
    // таблицы (прайс лаборатории, выгрузка результатов)
    '.xls', '.xlsx', '.ods', '.csv',
    // простой текст
    '.txt',
]);

const ALLOWED = new Set(ALLOWED_PATIENT_FILE_EXT);

export function isAllowedPatientFile(name) {
    return ALLOWED.has(extensionOf(name));
}

// Человеческий размер для сообщения об отказе: «41.9 МБ», не «43920281 байт».
export function mb(bytes) {
    const n = Number(bytes) || 0;
    return (n / (1024 * 1024)).toFixed(1);
}

// ЕДИНСТВЕННОЕ МЕСТО, ГДЕ РЕШАЕТСЯ «ПРИМЕМ ИЛИ НЕТ», и единственное место, где
// формулируется отказ. Возвращает null, если файл годится, иначе — шаблон
// сообщения + params: перевод целиком по словарю, подстановка ПОТОМ
// (I18N_COVERAGE_V1, тот же приём, что у отказов вкладок карты).
export function patientFileRefusal({ name, size }) {
    if (!isAllowedPatientFile(name)) {
        return {
            code: 'file_type_not_allowed',
            template: 'Файлы «{ext}» к карте пациента не прикладываются. Подойдут фотографии и сканы (JPG, PNG, HEIC), PDF, Word, Excel и обычный текст.',
            params: { ext: extensionOf(name) || String(name || '').slice(-20) || '?' },
        };
    }
    if (!Number.isFinite(Number(size)) || Number(size) <= 0) {
        return { code: 'file_empty', template: 'Файл пустой — прикладывать нечего.', params: {} };
    }
    if (Number(size) > MAX_PATIENT_FILE_BYTES) {
        return {
            code: 'file_too_large',
            template: 'Файл {got} МБ — это больше предела в {max} МБ. Переснимите фотографию в меньшем качестве или приложите PDF.',
            params: { got: mb(size), max: String(MAX_PATIENT_FILE_MB) },
        };
    }
    return null;
}

// Готовая фраза (шаблон уже со значениями) — для сервера, которому нужно
// положить текст в message, и для тестов.
export function refusalText(refusal) {
    if (!refusal) return '';
    let out = refusal.template;
    for (const [k, v] of Object.entries(refusal.params || {})) out = out.split('{' + k + '}').join(v);
    return out;
}
