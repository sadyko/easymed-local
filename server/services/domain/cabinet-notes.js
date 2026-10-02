// CABINET_FIX_V1_R4 (ревью 4, п. 2) — ПОДПИСАННАЯ ВЕРСИЯ ДОКУМЕНТА СТРОКИ НЕ
// СТИРАЕТСЯ ЗАПИСЬЮ.
// CABINET_FIX_V1_R5 (ревью 5, A) — правило стало «сравнить и заменить» и живёт
// в одном модуле для сервера и кабинета врача: public/js/shared/cabinet-notes.js
// (там — описание). Здесь — то же, под прежним путём сервера.
export {
    NOTES_TAG, NOTES_BASE_KEY, notesBaseOf, storedIsCabinet, signedVersionsDropped, notesWriteRefusal,
    NOTES_CONFLICT_MESSAGE, NOTES_NOT_CABINET_MESSAGE, mergeNurseNote, nurseNoteOf,
    notesCompatValue,   // CABINET_FIX_V1_R6 — совместимость с вкладками 3.15.0
} from '../../../public/js/shared/cabinet-notes.js';
// Прежнее имя (ревью 4) — то же сообщение о конфликте.
export { NOTES_CONFLICT_MESSAGE as SIGNED_CONFLICT_MESSAGE } from '../../../public/js/shared/cabinet-notes.js';
