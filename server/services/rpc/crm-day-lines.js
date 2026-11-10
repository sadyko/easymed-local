// CRM_DAY_LINES_V1 (3.23.0) — «ЧТО ЖДЁТ ЭТОГО ПАЦИЕНТА В ЭТОТ ДЕНЬ» ДЛЯ СМЕТЫ РЕГИСТРАТУРЫ.
//
// Владелец (2026-11-10): «the booked patients cannot be seen in the registrar when adding
// services». Подстановка в смету (public/js/admin/crm-lines.js pendingCrmLines — мастер визита
// и каталог услуг) читала строки сама, через /api/db: только открытые колонки и «Пришёл», и под
// ограничением CRM по хозяину (регистратор видит ничьи и свои карточки, schema-registry.js).
// Карточку, взятую оператором «в работу», и карточку в «Не пришёл» регистратура не видела —
// а сервер их строки в визит сажал (crm/visit-link.js шаг A). Браузер и сервер расходились.
// Переименование колонок причиной не было: ни одна строка кода названий не читает.
//
// Теперь браузер спрашивает здесь. Правило — шага связи (dayLineStatuses: открытые колонки,
// конверсия и колонка с ролью «не пришёл»; без ограничения по хозяину), выбор строк — общий
// (public/js/shared/crm-day-lines.js pickDayLines: строки этого приёма, одна услуга — одна
// строка). Наружу — ТОЛЬКО услуга, врач и дата строки (и её номер и визит — смете выбрать
// приём): ни заметок, ни телефонов, ни имени карточки, ни её хозяина. Чтение.
import { canRead } from '../../db/schema-registry.js';
import { effectiveRoles } from '../roles.js';
import { dayLineStatuses } from '../crm/visit-link.js';
import { localDate } from '../domain/day.js';
import { pickDayLines } from '../../../public/js/shared/crm-day-lines.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

/**
 * crm_day_lines { patient_id, day: 'YYYY-MM-DD', visit_id? } →
 *   [{ id, service_id, consultation_type_id, doctor_id, scheduled_date, visit_id }]
 * Ждущие строки этого дня у карточек пациента; без пациента или дня — пусто.
 */
export function crmDayLines(db, args, user) {
  if (!canRead('crm_request_services', effectiveRoles(user))) {
    throw new RpcError('Заявки CRM вам недоступны.', 403);
  }
  const a = args || {};
  const pid = Number(a.patient_id);
  const day = String(a.day ?? '').slice(0, 10);
  if (!Number.isInteger(pid) || pid <= 0 || !day) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RpcError('День указан неверно.', 400);
  const vid = a.visit_id == null || a.visit_id === '' ? null : Number(a.visit_id);
  const statuses = dayLineStatuses(db);
  if (!statuses.length) return [];
  // Строка, оставшаяся на отменённой записи того же дня (до CRM_ONE_WAY_V1), — отпущенная: шаг
  // связи её не берёт (crm/visit-link.js takeSql), и смета не предлагает.
  const lines = db.prepare(`
    SELECT l.id, l.service_id, l.consultation_type_id, l.doctor_id, l.scheduled_date, l.visit_id
      FROM crm_request_services l JOIN crm_requests r ON r.id = l.request_id
     WHERE r.patient_id = ? AND r.status IN (${statuses.map(() => '?').join(',')})
       AND l.status = 'pending' AND date(l.scheduled_date) = date(?)
       AND NOT EXISTS (SELECT 1 FROM visits w
                        WHERE w.status = 'cancelled' AND ${localDate('w.visit_date')} = date(l.scheduled_date)
                          AND (w.id = l.visit_id
                               OR w.id = (SELECT vs.visit_id FROM visit_services vs WHERE vs.id = l.visit_service_id)))
     ORDER BY l.id`).all(pid, ...statuses, day);
  return pickDayLines(lines, Number.isInteger(vid) && vid > 0 ? vid : null)
    .map((l) => ({ id: l.id, service_id: l.service_id ?? null, consultation_type_id: l.consultation_type_id ?? null,
      doctor_id: l.doctor_id ?? null, scheduled_date: l.scheduled_date, visit_id: l.visit_id ?? null }));
}
