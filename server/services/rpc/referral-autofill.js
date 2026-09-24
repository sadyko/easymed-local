// REPORTS_V2, ревью I3/I5 — направивший врач на визите, когда пациента
// приводит рекомендация из кабинета.
//
// Владелец (24.09): «внешний партнёр сохраняет своё». Поэтому свой источник
// врача (referral_sources.doctor_id, мигр. 122) ставится на визит, ТОЛЬКО если
// направившего нет ни у визита, ни у пациента: пациент партнёра остаётся
// пациентом партнёра, а пациент без направившего засчитывается врачу.
//
// Правило живёт на сервере одним местом: колонка visits.referral_source_id
// через /api/db не пишется, а проверять «есть ли уже направивший» в браузере
// двумя запросами — значит гоняться с регистратурой.
//
// Визит, НА КОТОРОМ врач сам рекомендовал (source_visit_id), не помечается:
// направивший — признак визита, а не строки, и пометка засчитала бы врачу
// «направлением» его собственный приём. Рекомендация, добавленная в тот же
// визит дня, поэтому вознаграждения не приносит — это предел модели
// «направивший на визите».
import { hasAnyRole } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const ROLES = ['admin', 'registrar', 'doctor', 'nurse', 'callcenter', 'cashier'];
const isPosInt = (v) => Number.isInteger(v) && v > 0;

/**
 * visit_set_doctor_referrer({ visit_id, doctor_id, source_visit_id? })
 * → { set: boolean, reason: 'set'|'own_visit'|'visit_has'|'patient_has'|'no_source', referral_source_id? }
 */
export function visitSetDoctorReferrer(db, args, user) {
  if (!hasAnyRole(user, ROLES)) throw new RpcError('Ваша роль не может выполнить это действие.', 403);
  const visitId = Number(args && args.visit_id);
  const doctorId = Number(args && args.doctor_id);
  const sourceVisitId = args && args.source_visit_id != null ? Number(args.source_visit_id) : null;
  if (!isPosInt(visitId)) throw new RpcError('visit_id must be a positive integer.', 400);
  if (!isPosInt(doctorId)) throw new RpcError('doctor_id must be a positive integer.', 400);
  const run = db.transaction(() => {
    const visit = db.prepare('SELECT id, patient_id, referral_source_id FROM visits WHERE id = ?').get(visitId);
    if (!visit) throw new RpcError('Визит не найден.', 404);
    if (sourceVisitId != null && sourceVisitId === visitId) return { set: false, reason: 'own_visit' };
    if (visit.referral_source_id != null) return { set: false, reason: 'visit_has' };
    const pt = db.prepare('SELECT referral_source_id FROM patients WHERE id = ?').get(visit.patient_id);
    if (pt && pt.referral_source_id != null) return { set: false, reason: 'patient_has' };
    const src = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ? ORDER BY active DESC, id LIMIT 1').get(doctorId);
    if (!src) return { set: false, reason: 'no_source' };
    db.prepare('UPDATE visits SET referral_source_id = ? WHERE id = ? AND referral_source_id IS NULL').run(src.id, visitId);
    return { set: true, reason: 'set', referral_source_id: src.id };
  });
  return run();
}
