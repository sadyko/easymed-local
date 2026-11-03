// ═══════════════════════════════════════════════════════════════════════════
// DUP_STOP_V1 (2026-11-02) — ОДНА УСЛУГА — ОДИН РАЗ В ВИЗИТЕ: ПРАВИЛО ДЛЯ СЕРВЕРА И ЭКРАНОВ
// ═══════════════════════════════════════════════════════════════════════════
//
// Решение владельца (3.21.0, п. 3): жёсткий запрет повторного направления — в пределах
// одного визита. На dev визит 411: врач направил на две услуги дважды с разницей в
// минуту, и все четыре строки ушли в счёт. Проверка жила только в браузере (мастер,
// SINGLE_PER_VISIT_V1) и только внутри одного сеанса.
//
// ПРАВИЛО «ТА ЖЕ УСЛУГА» (ключ orderKey):
//   • услуга каталога — та же услуга ('s:12');
//   • консультация — тот же вид И тот же врач: строка вида приёма ('c:5|d:10',
//     service_id пуст) или услуга типа «консультация», которой нужен врач
//     (services.requires_doctor = 1, 's:30|d:10'); консультация у ДРУГОГО врача —
//     другое назначение, её можно;
//   • DUP_STOP_V1 (ревью m4) — услуга типа «консультация» БЕЗ «нужен врач» — просто
//     услуга ('s:70'): services.type по умолчанию 'consultation' (миграция 022), и
//     анализ без проставленного типа с врачом в ключе проходил у каждого врача заново.
//     Врач в ключе — как needsDoctor CRM (вид приёма или requires_doctor);
//   • повтор разрешён товару (clinic_item_id) и процедуре (services.type = 'procedure'):
//     у них количество, и капельница дважды за визит — обычное дело.
// Отменённая строка и строка, отпущенная со счёта с возвратом, — не назначение
// (это решает сервер, server/services/domain/dup-order.js).
//
// Чистый модуль, без DOM и базы: его берут и сервер, и экраны.

export const REPEAT_REASON_KEY = '__repeat_reason';   // DUP_STOP_V1 — снимается дверью до compile(), как __notes_base
export const REPEAT_REASON_MIN = 3;
export const REPEAT_REASON_MAX = 300;
export const REPEAT_ROLES = Object.freeze(['admin', 'head_doctor']);   // DUP_STOP_V1 — обход с причиной

// DUP_STOP_V1 — шаблоны отказа (ключи словаря public/js/admin/i18n-strings.js).
export const DUP_TEMPLATE_BILLED = 'Эта услуга уже назначена в этом визите: «{service}» — {who}, {when}, счёт № {invoice}.';
export const DUP_TEMPLATE_UNBILLED = 'Эта услуга уже назначена в этом визите: «{service}» — {who}, {when}, счёта ещё нет.';
export const DUP_TEMPLATE_TWICE = 'Услуга «{service}» выбрана дважды — в визит её назначают один раз.';
// DUP_STOP_V1 (ревью M2) — тем, кому строки визита и счета не отдаются (колл-центр): без
// «кем, когда, счёт № …» — это данные пациента; название — той услуги, которую выбрал сам.
export const DUP_TEMPLATE_PLAIN = 'Эта услуга уже назначена в этом визите: «{service}».';
// DUP_STOP_V1 (остаток A5) — ПРАВКА (возврат из отмены, вид приёма) ролью, которой строки
// визита не читаются: и без названия — услугу правимой строки она не выбирала и не видит.
export const DUP_TEMPLATE_NAMELESS = 'Эта услуга уже назначена в этом визите — второй раз её не назначают.';
export const DUP_TEMPLATE_TWICE_NAMELESS = 'Одна и та же услуга выбрана дважды — в визит её назначают один раз.';

const pos = (v) => (v != null && v !== '' && typeof v !== 'boolean' && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** DUP_STOP_V1 — строке повтор разрешён: товар или процедура. */
export function repeatableLine({ clinicItemId = null, serviceType = null } = {}) {
  return pos(clinicItemId) != null || serviceType === 'procedure';
}

/** DUP_STOP_V1 (ревью m4) — флаг «нужен врач» из базы (0/1, '0'/'1') или экрана (true/false). */
const flagOn = (v) => v === true || Number(v) === 1;

/**
 * DUP_STOP_V1 — ключ «та же услуга». null — сравнивать нечего (товар, пустая строка).
 * requiresDoctor — services.requires_doctor (ревью m4): врач в ключе услуги — только у
 * консультации, которой нужен врач.
 * @param {{serviceId?:any, consultationTypeId?:any, doctorId?:any, serviceType?:string|null, requiresDoctor?:any}} line
 */
export function orderKey({ serviceId = null, consultationTypeId = null, doctorId = null, serviceType = null, requiresDoctor = null } = {}) {
  const d = pos(doctorId);
  if (serviceId != null && serviceId !== '') {
    const s = pos(serviceId);
    if (s == null) return null;
    return serviceType === 'consultation' && flagOn(requiresDoctor) ? `s:${s}|d:${d ?? ''}` : `s:${s}`;   // DUP_STOP_V1 (ревью m4)
  }
  const c = pos(consultationTypeId);
  return c != null ? `c:${c}|d:${d ?? ''}` : null;
}

/** DUP_STOP_V1 — причина обхода годится: не короче 3 знаков после обрезки пробелов (длиннее 300 — обрезается). */
export function repeatReasonOk(reason) {
  return typeof reason === 'string' && reason.trim().length >= REPEAT_REASON_MIN;
}
