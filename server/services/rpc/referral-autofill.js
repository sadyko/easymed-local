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
import { hasAnyRole, effectiveRoles } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// V3120_FIX (M3) — кто вправе: те, кто добавляет рекомендацию в визит (окно
// визита — регистратура, врач, медсестра, администратор). Касса и колл-центр
// рекомендаций в визит не переносят и направившего не ставят.
const ROLES = ['admin', 'registrar', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];
// Кто вправе назвать направившим ДРУГОГО врача: стойка и администратор. Врач —
// только себя (иначе засчитывал бы коллеге или себе чужую рекомендацию).
const DESK_ROLES = ['admin', 'registrar', 'nurse', 'senior_nurse'];
const isPosInt = (v) => Number.isInteger(v) && v > 0;

/**
 * visit_set_doctor_referrer({ visit_id, doctor_id | recommendation_id, source_visit_id? })
 * → { set: boolean, reason: 'set'|'own_visit'|'visit_has'|'patient_has'|'no_source', referral_source_id? }
 *
 * V3120_FIX (M3) — ДОКАЗАТЕЛЬСТВО — ОТКРЫТАЯ РЕКОМЕНДАЦИЯ. Раньше обработчик
 * верил голому doctor_id: любой вошедший называл любого врача направившим
 * любого визита, то есть начислял ему вознаграждение. Теперь направивший
 * ставится, только если у пациента этого визита есть НЕЗАКРЫТАЯ рекомендация
 * этого врача (recommended_services.recommended_by) — окно визита зовёт
 * обработчик ДО того, как пометит её выполненной. Можно прислать и сам номер
 * рекомендации (recommendation_id): тогда врач и визит-источник берутся из неё.
 * Визит, по которому уже платили, не трогается: его деньги уже поделены.
 */
export function visitSetDoctorReferrer(db, args, user) {
  if (!hasAnyRole(user, ROLES)) throw new RpcError('Ваша роль не может выполнить это действие.', 403);
  const visitId = Number(args && args.visit_id);
  const recId = args && args.recommendation_id != null ? Number(args.recommendation_id) : null;
  let doctorId = Number(args && args.doctor_id);
  let sourceVisitId = args && args.source_visit_id != null ? Number(args.source_visit_id) : null;
  if (!isPosInt(visitId)) throw new RpcError('Визит указан неверно.', 400);
  if (recId !== null && !isPosInt(recId)) throw new RpcError('Рекомендация указана неверно.', 400);
  if (recId === null && !isPosInt(doctorId)) throw new RpcError('Врач указан неверно.', 400);
  const run = db.transaction(() => {
    const visit = db.prepare('SELECT id, patient_id, referral_source_id FROM visits WHERE id = ?').get(visitId);
    if (!visit) throw new RpcError('Визит не найден.', 404);
    const openRec = recId !== null
      ? db.prepare(`SELECT id, recommended_by, source_visit_id FROM recommended_services
                     WHERE id = ? AND patient_id = ? AND closed_at IS NULL AND status NOT IN ('done','cancelled')`).get(recId, visit.patient_id)
      : db.prepare(`SELECT id, recommended_by, source_visit_id FROM recommended_services
                     WHERE patient_id = ? AND recommended_by = ? AND closed_at IS NULL AND status NOT IN ('done','cancelled')
                     ORDER BY id DESC LIMIT 1`).get(visit.patient_id, doctorId);
    if (!openRec || !isPosInt(Number(openRec.recommended_by))) {
      throw new RpcError('Направившим врач становится только по своей рекомендации этому пациенту — открытой рекомендации нет.', 409);
    }
    doctorId = Number(openRec.recommended_by);
    if (recId !== null) sourceVisitId = openRec.source_visit_id ?? null;
    const mine = effectiveRoles(user);
    if (!mine.some((r) => DESK_ROLES.includes(r)) && Number(user && user.id) !== doctorId) {
      throw new RpcError('Врач может назвать направившим только себя.', 403);
    }
    const paid = db.prepare(`SELECT 1 FROM invoices WHERE visit_id = ?
        AND (COALESCE(paid_amount, 0) > 0 OR status IN ('paid','partial')) LIMIT 1`).get(visitId);
    if (paid) throw new RpcError('По визиту уже есть оплата — направившего в нём не меняют.', 409);
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
