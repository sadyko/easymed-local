// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (2026-10-16, повторное ревью денег S1) — «ТА ЖЕ УСЛУГА»: ОДНО ПРАВИЛО
// У СЕТИ R7b И У ЭКРАНОВ РЕГИСТРАЦИИ
// ═══════════════════════════════════════════════════════════════════════════
//
// Сеть R7b (server/services/crm/booked-twin.js) убирает строку записи X, когда стойка
// вставляет строку Y той же услуги. Окна регистрации (быстрая регистрация, мастер визита,
// registerWalkIn) по тому же признаку прицепляют свою строку к строке записи и не вставляют
// вторую — иначе сеть убрала бы строку, которую экран выставляет в счёт. Правил было два:
// экран сравнивал врача всегда, сеть — только у услуги, без врача которой не бывает. ЭКГ записи
// у исполнителя 10 и ЭКГ экрана у исполнителя 11 экран пропускал второй строкой, сеть убирала
// строку записи, касса отказывала («Строка услуги № … не найдена»). Теперь правило одно — здесь.
//
// ПРАВИЛО (то же, что sameService зеркала, server/services/crm/booking-mirror.js — проверка
// равенства во всех клетках: server/routes/crm-link-all-twin.test.js):
//   • ключ услуги один: услуга каталога ('s:12') или вид приёма ('c:5', без услуги);
//   • у строки записи врача нет — та же услуга;
//   • услуге врач не нужен (не консультация по виду приёма и не requires_doctor) — врач не
//     сравнивается: та же услуга;
//   • иначе — тот же врач (консультация у другого врача — другая запись, разбор ревью I1).
//
// ЭКРАН (isBookedTwin, views/booked-rows.js) берёт это правило и одно расширение: строка, врач
// которой ЕЩЁ НЕ ВЫБРАН (пакет, каталог без врача), — тоже строка записи. Расширение безопасно:
// экран прицепляет не реже, чем сеть убирает, а строку услуги с врачом без врача ни одно окно не
// записывает (проверка «нужен врач» — до визита).
//
// Строки — в форме экрана: { serviceId, consultationTypeId, doctorId }. Чистый модуль, без DOM
// и базы: его зовут и сервер, и браузер.

const posNum = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Ключ услуги строки: 's:<услуга>' или 'c:<вид приёма>'; null — сравнивать нечего. */
export function serviceKeyOf(line) {
  if (!line) return null;
  const s = posNum(line.serviceId);
  if (line.serviceId != null) return s == null ? null : 's:' + s;
  const c = posNum(line.consultationTypeId);
  return c == null ? null : 'c:' + c;
}

// Врач в ключе — как у зеркала (matchKey: `doctor_id || ''`): пусто и 0 — «без врача».
const doctorKey = (v) => (v ? String(Number(v)) : '');

/**
 * Строка `other` — та же услуга, что строка записи `booked` (правило сети R7b).
 * @param {{serviceId?:number|null, consultationTypeId?:number|null, doctorId?:number|null}} booked
 * @param {{serviceId?:number|null, consultationTypeId?:number|null, doctorId?:number|null}} other
 * @param {{needsDoctor?:boolean}} [opts] — услуге нужен врач (services.requires_doctor);
 *   у вида приёма врач нужен всегда
 */
export function sameBookedService(booked, other, { needsDoctor = false } = {}) {
  const k = serviceKeyOf(booked);
  if (!k || k !== serviceKeyOf(other)) return false;
  if (booked.doctorId == null) return true;
  const needs = k.startsWith('c:') || !!needsDoctor;
  if (!needs) return true;
  return doctorKey(booked.doctorId) === doctorKey(other.doctorId);
}

/**
 * Экран: строка `line` — строка записи `booked` (прицепить, второй не вставлять). Правило
 * сети R7b, и строка без выбранного врача — тоже (см. шапку).
 */
export function screenTakesBooked(line, booked, { needsDoctor = false } = {}) {
  if (sameBookedService(booked, line, { needsDoctor })) return true;
  const k = serviceKeyOf(line);
  return !!k && k === serviceKeyOf(booked) && line.doctorId == null;
}
