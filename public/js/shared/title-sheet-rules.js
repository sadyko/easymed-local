// TITLE_SHEET_V1 — правила титульного листа, ОБЩИЕ для сервера и экрана.
//
// Диапазоны, обязательный состав и ИМТ живут в одном месте, потому что их
// спрашивают с двух сторон: сервер отказывает по ним (rpc/title-sheet.js), а
// экран считает ИМТ по мере ввода (views/title-sheet.js). Две копии разошлись
// бы на первой правке диапазона. Здесь нет русского текста намеренно: слова
// отказов — у сервера, подписи полей — у экрана (i18n).
import { missingTitleFields } from './inpatient-required.js';   // INPATIENT_REQUIRED_V1

export const MEASURES = Object.freeze({
    height_cm: { min: 30, max: 250, int: false },
    weight_kg: { min: 1,  max: 400, int: false },
    temp_c:    { min: 30, max: 45,  int: false },
    bp_sys:    { min: 40, max: 300, int: true  },
    bp_dia:    { min: 20, max: 200, int: true  },
    pulse_bpm: { min: 20, max: 250, int: true  },
});
export const MEASURE_KEYS = Object.freeze(Object.keys(MEASURES));
export const PEDICULOSIS = Object.freeze(['', 'none', 'found']);
export const SANITATION  = Object.freeze(['', 'full', 'partial', 'none']);
export const REQUIRED_KEYS = Object.freeze([...MEASURE_KEYS, 'pediculosis', 'sanitation']);
/**
 * Поля карточки пациента, которые титульный лист вправе поправить. ФИО и дата
 * рождения — нет: это личность, её правят в карточке.
 */
export const PATIENT_FIELDS = Object.freeze([
    'gender', 'phone', 'address', 'national_id', 'occupation',
    'emergency_contact_name', 'emergency_contact_phone', 'blood_type', 'allergies',
]);

/** '72,5' → 72.5; '' / null / undefined → null; не число → NaN. */
export function numOrNull(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    const s = String(v).trim().replace(',', '.');
    if (s === '') return null;
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/** ИМТ с одной цифрой после запятой; без роста или веса — null. */
export function bmiOf(heightCm, weightKg) {
    const hgt = numOrNull(heightCm);
    const wgt = numOrNull(weightKg);
    if (!hgt || !wgt || Number.isNaN(hgt) || Number.isNaN(wgt) || hgt <= 0) return null;
    const m = hgt / 100;
    return Math.round((wgt / (m * m)) * 10) / 10;
}

/**
 * Полон ли лист. INPATIENT_REQUIRED_V1 — список обязательных полей задаёт клиника
 * (лист, карточка пациента, отметки бумаг); без списка — прежние восемь, как было.
 * Есть ли лист вообще, решает вызывающий: без листа и без требований пустот нет.
 */
export function sheetCompleteness(row, keys = REQUIRED_KEYS, patient = null) {
    const missing = missingTitleFields({ sheet: row || null, patient }, keys);
    return { complete: missing.length === 0, missing };
}
