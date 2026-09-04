// MED_ADMIN_CHARGE_V1 — как узнать строку счёта, рождённую отметкой о введении.
//
// Тот же приём, что у проживания (shared/accommodation-line.js), и по той же
// причине: своего типа у `admission_services` нет, а заводить колонку в живой
// таблице ради одного признака дороже, чем метка в `notes`. Модуль лежит в
// shared, потому что метку ПИШЕТ сервер (rpc/treatment-orders.js), а ЧИТАЕТ
// браузер (лист назначений и список услуг госпитализации). Две копии этой
// строки разошлись бы молча — и строка за введённую дозу перестала бы
// узнаваться ровно тогда, когда её надо снять.
//
// ─── МЕТКА — ЭТО ЕЩЁ И КЛЮЧ ИДЕМПОТЕНТНОСТИ ─────────────────────────────────
//
// В метке стоит id ОТМЕТКИ (`treatment_administrations.id`), а не назначения:
//
//   MEDADMIN#41/dose · Цефтриаксон · 1 г
//   MEDADMIN#41/extra:7 · Шприц 5 мл
//
// Отсюда следует всё поведение Задачи 6. Отметка одна на (назначение, дату,
// слот) — значит и строка счёта одна: повторное нажатие находит её по префиксу
// и ничего не создаёт. Снятие отметки находит по тому же префиксу, что вернуть
// на склад и что убрать из счёта. А новая отметка после снятия получает НОВЫЙ
// id — и честно списывается заново, ничего не путая со снятой.
//
// Разделитель '/' между id и родом строки несущий: без него префикс «#4»
// совпал бы началом с «#41», и снятие отметки №4 забрало бы чужие деньги.

export const MED_ADMIN_NOTE_PREFIX = 'MEDADMIN';

/** Префикс строки за саму дозу. Им же ищут: notes LIKE prefix || '%'. */
export function doseNotePrefix(administrationId) {
  return `${MED_ADMIN_NOTE_PREFIX}#${administrationId}/dose `;
}

/** Префикс строки за расход СВЕРХ дозы (разбитая ампула, второй шприц). */
export function extraNotePrefix(administrationId, productId) {
  return `${MED_ADMIN_NOTE_PREFIX}#${administrationId}/extra:${productId} `;
}

/** Общий префикс всех строк одной отметки — по нему их собирают для снятия. */
export function administrationNotePrefix(administrationId) {
  return `${MED_ADMIN_NOTE_PREFIX}#${administrationId}/`;
}

/** Строка счёта, рождённая отметкой о введении? */
export function isMedAdminLine(row) {
    if (!row || typeof row !== 'object') return false;
    const notes = typeof row.notes === 'string' ? row.notes : '';
    return notes.startsWith(`${MED_ADMIN_NOTE_PREFIX}#`);
}

/** Расход сверх дозы — он показывается ОТДЕЛЬНОЙ строкой, а не в дозе. */
export function isExtraConsumptionLine(row) {
    if (!isMedAdminLine(row)) return false;
    return /^MEDADMIN#\d+\/extra:/.test(row.notes);
}

/** id отметки из метки, или null. */
export function medAdminIdOf(row) {
    if (!isMedAdminLine(row)) return null;
    const m = /^MEDADMIN#(\d+)\//.exec(row.notes);
    return m ? Number(m[1]) : null;
}

// Подписи для списка услуг госпитализации. Ключи перевода — они же
// (i18n-strings.js), как у ACCOMMODATION_LABEL.
export const MED_ADMIN_LABEL = 'Введено по листу назначений';
export const MED_ADMIN_EXTRA_LABEL = 'Расход сверх дозы';
