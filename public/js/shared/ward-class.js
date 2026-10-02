// JOURNALS_V1_WARD_CLASS (2026-10-02) — КЛАСС ПАЛАТЫ ОДНИМ СЛОВАРЁМ.
//
// Пишет его окно палаты («Настройки → Помещения», rooms-setup.js), печатает —
// «Реестр стационарных пациентов» (server/services/rpc/reports.js). Модуль
// чистый (без DOM и без node-встроенных), поэтому грузится в обоих — тот же
// приём, что payment-methods.js и goods-catalog.js. Значения — те, что
// пускает CHECK миграции 234; подписи — ключи словаря i18n-strings.js.
export const WARD_CLASSES = Object.freeze(['lux', 'semi_lux', 'standard']);

export const WARD_CLASS_RU = Object.freeze({ lux: 'Люкс', semi_lux: 'Полулюкс', standard: 'Обычная' });

/** Подпись класса; не задан или неизвестен — пусто. */
export const wardClassLabel = (v) => (Object.prototype.hasOwnProperty.call(WARD_CLASS_RU, v) ? WARD_CLASS_RU[v] : '');

/** Значение для записи: один из трёх классов или null («не задан»). */
export function normalizeWardClass(v) {
  const s = String(v == null ? '' : v).trim();
  return WARD_CLASSES.includes(s) ? s : null;
}
