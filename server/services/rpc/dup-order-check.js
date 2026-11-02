// ═══════════════════════════════════════════════════════════════════════════
// DUP_STOP_V1 (2026-11-02) — visit_dup_check: ЧТО УЖЕ НАЗНАЧЕНО В ВИЗИТЕ ДНЯ
// ═══════════════════════════════════════════════════════════════════════════
//
// Только чтение. Экраны записи (мастер визита, калькулятор услуг, быстрая регистрация,
// кабинет врача) спрашивают ДО первой записи — до ensure_visit и calendar_book: отказ
// не оставляет ни пустого визита, ни строк, ни счёта. Последнее слово — у дверей
// записи (routes/db.js visitOrderCheck, RPC кассы): здесь то же правило
// (domain/dup-order.js) и те же поблажки двери /api/db (строка записи колл-центра под
// одиночной вставкой — R7b; строка CRM, уступающая строке человека).
//
// args: { visit_id } | { patient_id, date ('YYYY-MM-DD' местный день или ISO) },
//       lines?: [{ service_id?, consultation_type_id?, doctor_id? }] (до 50),
//       exclude_ids?: [visit_service_id] — строки, которые экран сам снимет до записи.
// → { visit_id|null, ordered: [...], duplicates: [{ index, message, template, params, line_id }], can_override }
//   ordered — назначенное (без строк, которые уступят новой строке той же услуги): по нему
//   каталоги гасят услуги («уже назначено»).
// DUP_STOP_V1 (ревью M2) — ЧЬИ ЭТО ДАННЫЕ. Строки визита и счета — данные пациента: тем, кому
// /api/db их не отдаёт (patientDataRefusal('visit_services') — разделы и вкладки роли;
// колл-центр), ordered пуст, а повтор назван без «кем, когда, счёт № …» и без номера строки
// (DUP_TEMPLATE_PLAIN): название — той услуги, которую выбрал сам. Визит по номеру — только
// своего здания (как у дверей записи); визит дня и так свой (dayVisitOf).
import { hasAnyRole } from '../roles.js';
import { patientDataRefusal } from '../../db/patient-data-gate.js';   // DUP_STOP_V1 (ревью M2)
import { assertOwnBuilding } from './billing.js';   // DUP_STOP_V1 (ревью M2) — BRANCH_MONEY_GUARD_V1
import { localDate } from '../domain/day.js';
import { liveOrders, duplicateHits, refusalOf, canRepeatOrder, keyOfRow } from '../domain/dup-order.js';
import { dayVisitOf } from './visits.js';
import { bookedTwinFor } from '../crm/booked-twin.js';
import { autoTwinFor } from '../crm/one-way.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'callcenter'];
const MAX_LINES = 50;
const pos = (v) => (v != null && v !== '' && typeof v !== 'boolean' && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

export function visitDupCheck(db, args, user) {
  if (!hasAnyRole(user, ROLES)) throw new RpcError('Вашей роли это действие недоступно.', 403);
  const a = args || {};
  let visitId = pos(a.visit_id);
  if (visitId != null) {   // DUP_STOP_V1 (ревью M2) — визит соседнего здания отсюда не правят
    const v = db.prepare('SELECT id, sync_origin FROM visits WHERE id = ?').get(visitId);
    if (!v) visitId = null;
    else assertOwnBuilding(db, v, 'Визит');
  } else {
    const patientId = pos(a.patient_id);
    const raw = typeof a.date === 'string' ? a.date.trim() : '';
    if (patientId == null || !/^\d{4}-\d{2}-\d{2}/.test(raw)) throw new RpcError('Укажите визит или пациента и день.', 400);
    const day = raw.length > 10 ? db.prepare(`SELECT ${localDate('?')} AS d`).get(raw).d : raw.slice(0, 10);
    const v = day ? dayVisitOf(db, patientId, day) : null;
    visitId = v ? Number(v.id) : null;
  }
  const raw = Array.isArray(a.lines) ? a.lines : [];
  if (raw.length > MAX_LINES) throw new RpcError('Слишком много услуг в одной проверке.', 400);
  const canOverride = canRepeatOrder(user);
  if (visitId == null) return { visit_id: null, ordered: [], duplicates: [], can_override: canOverride };

  const exclude = (Array.isArray(a.exclude_ids) ? a.exclude_ids : []).map(pos).filter((x) => x != null);
  // Поблажки двери /api/db: строка записи колл-центра (R7b) и строка CRM уступят новой.
  const spare = (line) => [bookedTwinFor(db, line), autoTwinFor(db, line)].filter(Boolean).map((x) => Number(x.id));
  const lines = raw.map((l) => ({
    visit_id: visitId,
    service_id: pos(l && l.service_id),
    consultation_type_id: pos(l && l.consultation_type_id),
    doctor_id: pos(l && l.doctor_id),
  }));
  const hits = duplicateHits(db, lines, { excludeIds: exclude, spare });
  const hidden = patientDataRefusal('visit_services', user, db) != null;   // DUP_STOP_V1 (ревью M2)
  const ordered = hidden ? [] : liveOrders(db, visitId)
    .filter((r) => !exclude.includes(Number(r.id)))
    .filter((r) => !spare({ visit_id: visitId, service_id: r.service_id, consultation_type_id: r.service_id == null ? r.consultation_type_id : null, doctor_id: r.doctor_id }).includes(Number(r.id)))
    .map((r) => ({
      id: r.id, service_id: r.service_id, consultation_type_id: r.service_id == null ? r.consultation_type_id : null,
      doctor_id: r.doctor_id, service_type: r.service_type || null, key: keyOfRow(r),
      name: r.service_name || r.consultation_name || '', doctor_name: r.doctor_name || '',
      who: r.creator_name || '', when: r.created_local || '', invoice_number: r.invoice_number || null,
    }));
  const duplicates = hits.map((h) => {
    const e = refusalOf(db, h, { plain: hidden });   // DUP_STOP_V1 (ревью M2)
    return { index: h.index, message: e.message, template: e.template, params: e.params, line_id: !hidden && h.existing ? h.existing.id : null };
  });
  return { visit_id: visitId, ordered, duplicates, can_override: canOverride };
}
