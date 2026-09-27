// ═══════════════════════════════════════════════════════════════════════════
// CRM_CALENDAR_MIRROR_V1 (2026-09-27) — УСЛУГИ ЗАПИСИ ОТ КОЛЛ-ЦЕНТРА
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: заявка и календарь — одна запись, «and the services». Оператор
// колл-центра, записавший пациента в календаре, записывает его С УСЛУГАМИ, а не
// голым слотом («Записано. Услуги добавит регистратура.» — убрано).
//
// ПОЧЕМУ RPC, А НЕ /api/db. Строки visit_services реестр вставляет только
// admin/registrar/doctor, и открыть таблицу колл-центру значило бы отдать ему
// всё, что эта таблица умеет: цену, пакет, статус работы, любую запись, в том
// числе пришедшего пациента. Здесь — узкая дверь ровно на одно действие:
//
//   • только запись ДО ПРИХОДА: визит scheduled/confirmed, день не прошёл,
//     ни счёта, ни начатой работы;
//   • только своего здания (строки чужого уезжают туда и правятся там);
//   • строка 'added' — «в смете», не больше; цену считает сервер тем же
//     правилом, что касса (service_price_quote + lineUnitPrice);
//   • ни счёта, ни оплаты — их по-прежнему делает регистратура и касса;
//   • без хирургии: она оформляется на госпитализацию (SURGERY_NEEDS_BED_V1);
//   • консультация по виду приёма — строкой service_id NULL + consultation_type_id,
//     цена по ценам врача (BILLING_AUDIT_FIX_V1 B7), миграция 188.
//
// После записи строки сверяются с заявкой (crm/booking-mirror.js): запись
// колл-центра без заявки её получает, строки заявки появляются сами.
import { hasAnyRole } from '../roles.js';
import { today } from '../domain/day.js';
import {
  isPreArrival, visitHasWork, insertBookingLine, mirrorVisit, attachVisitToCrm, arrivedByEvidence, lineKey,
} from '../crm/booking-mirror.js';
import { localDate } from '../domain/day.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const ROLES = ['admin', 'registrar', 'callcenter'];
const MAX_LINES = 30;
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const VS_CHILDREN = [
  ['lab_results', 'по услуге уже есть результаты анализа'],
  ['visit_documents', 'по услуге уже есть документ'],
  ['lab_device_messages', 'по услуге уже пришли данные анализатора'],
];

/** Запись, к которой можно дописывать и с которой можно снимать услуги. */
function bookingOrRefuse(db, visitId) {
  const v = db.prepare(`SELECT id, patient_id, doctor_id, status, sync_origin, visit_date,
                               ${localDate('visit_date')} AS day FROM visits WHERE id = ?`).get(visitId);
  if (!v) throw new RpcError('Запись не найдена.', 404);
  if (v.sync_origin != null) throw new RpcError('Запись заведена в другом здании — её услуги правят там.', 400);
  if (!isPreArrival(v)) throw new RpcError('Пациент уже пришёл или запись отменена — услуги правит регистратура.', 400);
  if (v.day < today(db)) throw new RpcError('Приём уже прошёл — услуги правит регистратура.', 400);
  if (visitHasWork(db, v.id) || arrivedByEvidence(db, v.id)) throw new RpcError('По записи уже выставлен счёт или начата работа — услуги правит регистратура.', 400);
  return v;
}

/**
 * booking_lines_add { visit_id, lines: [{ service_id, doctor_id?, scheduled_at? }] }
 * → { visit_id, added: [{ id, service_id, unit_price }], skipped: [service_id] }
 * skipped — услуги, которые в записи уже есть: вторая строка той же услуги —
 * двойной счёт в день приёма.
 */
export function bookingLinesAdd(db, args, user) {
  if (!hasAnyRole(user, ROLES)) throw new RpcError('Добавлять услуги к записи может колл-центр, регистратура или администратор.', 403);
  const visitId = Number(args && args.visit_id);
  if (!isPosInt(visitId)) throw new RpcError('Не выбрана запись.', 400);
  const raw = Array.isArray(args && args.lines) ? args.lines : [];
  if (!raw.length) throw new RpcError('Не выбраны услуги.', 400);
  if (raw.length > MAX_LINES) throw new RpcError(`За один раз можно добавить не больше ${MAX_LINES} услуг.`, 400);

  const run = db.transaction(() => {
    const v = bookingOrRefuse(db, visitId);
    const added = [];
    const skipped = [];
    const seen = new Set(db.prepare('SELECT service_id, consultation_type_id FROM visit_services WHERE visit_id = ?')
      .all(visitId).map(lineKey).filter(Boolean));
    for (const l of raw) {
      // Строка — либо услуга каталога, либо консультация по виду приёма
      // (service_id NULL + consultation_type_id; цена — по ценам врача, B7).
      // Цену, присланную экраном, сервер не читает вовсе.
      const hasService = l && l.service_id != null && l.service_id !== '';
      const serviceId = hasService ? Number(l.service_id) : null;
      const consultId = !hasService && l && l.consultation_type_id != null && l.consultation_type_id !== '' ? Number(l.consultation_type_id) : null;
      if (hasService) {
        if (!isPosInt(serviceId)) throw new RpcError('Услуга указана неверно.', 400);
        const svc = db.prepare('SELECT id, name, type, active FROM services WHERE id = ?').get(serviceId);
        if (!svc || Number(svc.active) === 0) throw new RpcError('Услуга не найдена или снята с продажи.', 400);
        // 'other' — это и есть хирургия (миграция 109; routes/db.js refuseSurgeryWithoutBed).
        if (svc.type === 'other') {
          throw new RpcError(`«${svc.name}» — хирургия: она оформляется на госпитализацию, её записывает регистратура.`, 400);
        }
      } else {
        if (!isPosInt(consultId)) throw new RpcError('Услуга указана неверно.', 400);
        const ct = db.prepare('SELECT id, active FROM consultation_types WHERE id = ?').get(consultId);
        if (!ct || Number(ct.active) === 0) throw new RpcError('Вид приёма не найден или выключен.', 400);
      }
      const doctorId = l && l.doctor_id != null && l.doctor_id !== '' ? Number(l.doctor_id) : null;
      if (doctorId != null && (!isPosInt(doctorId) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(doctorId))) {
        throw new RpcError('Врач не найден.', 400);
      }
      const key = lineKey({ service_id: serviceId, consultation_type_id: consultId });
      if (seen.has(key)) { skipped.push(serviceId || consultId); continue; }
      seen.add(key);
      const scheduledAt = l && typeof l.scheduled_at === 'string' && l.scheduled_at ? l.scheduled_at : null;
      const id = insertBookingLine(db, { visit: v, serviceId, consultationTypeId: consultId, doctorId, createdBy: user && user.id, scheduledAt });
      const row = db.prepare('SELECT id, service_id, consultation_type_id, unit_price FROM visit_services WHERE id = ?').get(id);
      added.push(row);
    }
    return { visit_id: visitId, added, skipped };
  });
  const out = run();
  // Запись без заявки получает её (колл-центр), строки заявки — сами.
  attachVisitToCrm(db, visitId, user);
  mirrorVisit(db, visitId, { actorId: user && user.id });
  return out;
}

/** booking_line_remove { visit_service_id } → { removed: true, id } */
export function bookingLineRemove(db, args, user) {
  if (!hasAnyRole(user, ROLES)) throw new RpcError('Снимать услуги с записи может колл-центр, регистратура или администратор.', 403);
  const id = Number(args && args.visit_service_id);
  if (!isPosInt(id)) throw new RpcError('Не выбрана услуга записи.', 400);
  const run = db.transaction(() => {
    const row = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
    if (!row) throw new RpcError('Услуга записи не найдена.', 404);
    if (row.sync_origin != null) throw new RpcError('Услуга заведена в другом здании — снять её можно только там.', 400);
    bookingOrRefuse(db, row.visit_id);
    if (row.invoice_item_id != null || row.status !== 'added') throw new RpcError('Услуга уже в счёте или в работе — снять её нельзя.', 400);
    if (row.clinic_item_id != null) throw new RpcError('Это выданный товар, а не услуга записи.', 400);
    for (const [table, why] of VS_CHILDREN) {
      let has = false;
      try { has = !!db.prepare(`SELECT 1 FROM ${table} WHERE visit_service_id = ? LIMIT 1`).get(id); }
      catch { has = false; }
      if (has) throw new RpcError('Снять нельзя: ' + why + '.', 400);
    }
    try { db.prepare('DELETE FROM service_queue_tickets WHERE visit_service_id = ?').run(id); } catch { /* нет таблицы */ }
    db.prepare('DELETE FROM visit_services WHERE id = ?').run(id);
    return row.visit_id;
  });
  const visitId = run();
  mirrorVisit(db, visitId, { actorId: user && user.id });
  return { removed: true, id };
}
