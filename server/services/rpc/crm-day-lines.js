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
//
// РЕВЬЮ 3.23.0:
//   • ОДНО ПРАВИЛО С ensure_visit — строки отбирает шаг A шага связи (crm/visit-link.js
//     stepALines, undated: true), как их посадит визит дня: желания без даты живых карточек
//     (никогда не записанные), строки мёртвого визита, строки, державшие этот визит без строки
//     визита; не строки другого живого визита и не строки карточки, привязанной к визиту по
//     телефону. Визит не назван — визит дня пациента (тот, что возьмёт ensure_visit), если он есть;
//   • ДОСТУП — тем, кто открывает мастер визита и каталог услуг: администратор, регистратура,
//     касса, врач, медсестра — все строки дня (ограничения по хозяину нет: визит их строки и так
//     сажает). Колл-центр — только строки карточек, которые видит сам (свои и ничьи; руководитель
//     с «crm.all» — все), как /api/db. Остальным — 403.
import { canRead } from '../../db/schema-registry.js';
import { effectiveRoles, hasAnyRole } from '../roles.js';
import { stepALines } from '../crm/visit-link.js';
import { leadVisible } from '../crm/visibility.js';
import { dayVisitOf } from './visits.js';
import { pickDayLines } from '../../../public/js/shared/crm-day-lines.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

/** CRM_DAY_LINES_V1 (ревью) — роли, которые открывают мастер визита и каталог услуг: все строки дня. */
export const DAY_LINES_ROLES = Object.freeze(['admin', 'registrar', 'cashier', 'doctor', 'nurse']);

/**
 * crm_day_lines { patient_id, day: 'YYYY-MM-DD', visit_id? } →
 *   [{ id, service_id, consultation_type_id, doctor_id, scheduled_date, visit_id }]
 * Строки заявок пациента, которые возьмёт визит этого дня; без пациента или дня — пусто.
 */
export function crmDayLines(db, args, user) {
  const full = hasAnyRole(user, DAY_LINES_ROLES);
  const scoped = !full && hasAnyRole(user, ['callcenter']);
  if ((!full && !scoped) || !canRead('crm_request_services', effectiveRoles(user))) {
    throw new RpcError('Заявки CRM вам недоступны.', 403);
  }
  const a = args || {};
  const pid = Number(a.patient_id);
  const day = String(a.day ?? '').slice(0, 10);
  if (!Number.isInteger(pid) || pid <= 0 || !day) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RpcError('День указан неверно.', 400);
  const asked = a.visit_id == null || a.visit_id === '' ? null : Number(a.visit_id);
  const named = Number.isInteger(asked) && asked > 0 ? asked : null;
  const dayVisit = named == null ? dayVisitOf(db, pid, day) : null;
  const visitId = named != null ? named : (dayVisit ? dayVisit.id : null);
  const lines = [];
  for (const { card, lines: ls } of stepALines(db, { patientId: pid, day, visitId, undated: true })) {
    if (scoped && !leadVisible(db, user, card.assigned_to)) continue;   // колл-центр — как /api/db
    lines.push(...ls);
  }
  lines.sort((x, y) => x.id - y.id);
  return pickDayLines(lines, named)
    .map((l) => ({ id: l.id, service_id: l.service_id ?? null, consultation_type_id: l.consultation_type_id ?? null,
      doctor_id: l.doctor_id ?? null, scheduled_date: l.scheduled_date || null, visit_id: l.visit_id ?? null }));
}
