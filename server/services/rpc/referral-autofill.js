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
// REFERRAL_LINE_V1 (3.21.0) — этот предел снят на уровне СТРОКИ: строка, заведённая по
// рекомендации, получает направившего сама (visit_services.referred_by_source_id —
// rpc/referral-orders.js referral_recommendation_attach), и «Рефералы» платят ему за неё
// (reports.js referralLines). Здесь по-прежнему — только источник визита.
// REFERRAL_LINE_V1 (ревью полировки M1, 3.21.0) — ЭКРАНЫ ЭТОТ ВЫЗОВ БОЛЬШЕ НЕ ЗОВУТ. Окно визита
// звало его после каждой добавленной рекомендации врача: врач становился направившим ВСЕГО визита
// и получал процент со всех его строк (проба PB1: 18 000 вместо 8 000), а в мастере и быстрой
// регистрации — только за услугу рекомендации. Правило владельца — врач получает бонус за услугу,
// которую направил: это делает привязка. Вызов оставлен зарегистрированным (только стойка, правила
// ниже без изменений) — его могут звать другие клиенты; направившего всего визита стойка
// по-прежнему выбирает сама («Кто направил»).
import { hasAnyRole } from '../roles.js';
import { DESK_ROLES } from '../domain/line-referral.js';   // REFERRAL_LINE_V1 (полировка, п. 7) — стойка: администратор и регистратура

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// REFERRAL_LINE_V1 (полировка 3.21.0, п. 7; ревью U10 — MEDIUM, «врач делает себя направившим
// визита») — НАПРАВИВШЕГО ВИЗИТА ПО РЕКОМЕНДАЦИИ СТАВИТ ТОЛЬКО СТОЙКА (администратор,
// регистратура — и дополнительной ролью). Источник визита платит за КАЖДУЮ строку визита, и
// прежде врач писал рекомендацию на любую услугу задним числом и называл себя направившим всего
// визита стойки (проба R1e: 8 000 за чужое УЗИ); медсёстры ставили его по рекомендации, хотя
// привязку рекомендаций (attach) им закрыли. Врач, добавивший свою рекомендацию в визит, получает
// бонус за строку — привязкой (referral_recommendation_attach), а не за весь визит.
// Доказательство — то же, что у привязки: живая строка услуги рекомендации В ЭТОМ визите,
// которую завёл сам вызывающий и не раньше, чем написана рекомендация (окно визита вставляет её
// прямо перед вызовом). Отказ окно визита не показывает (console.warn).
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const NOT_DESK = 'Направившего визита по рекомендации врача ставит регистратура или администратор.';
const NO_LINE = 'Направившего ставят по услуге рекомендации, которую вы сами добавили в этот визит после рекомендации, — такой строки нет.';

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
 * REFERRAL_LINE_V1 (полировка, п. 7) — только стойка (403 остальным) и только по живой строке
 * услуги рекомендации в этом визите, заведённой самим вызывающим не раньше рекомендации (см.
 * шапку). По doctor_id берётся самая новая открытая рекомендация врача, у которой такая строка есть.
 */
export function visitSetDoctorReferrer(db, args, user) {
  if (!hasAnyRole(user, DESK_ROLES)) throw new RpcError(NOT_DESK, 403);   // REFERRAL_LINE_V1 (полировка, п. 7)
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
    const open = recId !== null
      ? db.prepare(`SELECT id, recommended_by, source_visit_id, service_id, created_at FROM recommended_services
                     WHERE id = ? AND patient_id = ? AND closed_at IS NULL AND status NOT IN ('done','cancelled')`).all(recId, visit.patient_id)
      : db.prepare(`SELECT id, recommended_by, source_visit_id, service_id, created_at FROM recommended_services
                     WHERE patient_id = ? AND recommended_by = ? AND closed_at IS NULL AND status NOT IN ('done','cancelled')
                     ORDER BY id DESC`).all(visit.patient_id, doctorId);
    const recs = open.filter((r) => isPosInt(Number(r.recommended_by)));
    if (!recs.length) {
      throw new RpcError('Направившим врач становится только по своей рекомендации этому пациенту — открытой рекомендации нет.', 409);
    }
    // REFERRAL_LINE_V1 (полировка, п. 7) — доказательство строкой (то же, что у привязки:
    // не отменена и не снята, не возвращена, своё здание, завёл вызывающий, рекомендация не моложе строки).
    const lineOf = db.prepare(`SELECT 1 FROM visit_services vs
        WHERE vs.visit_id = ? AND vs.service_id = ? AND vs.created_by = ?
          AND vs.status NOT IN ('cancelled', 'removed') AND vs.sync_origin IS NULL
          AND NOT (vs.invoice_item_id IS NULL
                   AND EXISTS (SELECT 1 FROM pay_refund_releases prr WHERE prr.kind = 'out' AND prr.line_id = vs.id))
          AND COALESCE(julianday(?) > julianday(vs.created_at), 0) = 0
        LIMIT 1`);
    const me = Number(user && user.id);
    const openRec = recs.find((r) => r.service_id != null && isPosInt(me) && lineOf.get(visitId, r.service_id, me, r.created_at));
    if (!openRec) throw new RpcError(NO_LINE, 409);
    doctorId = Number(openRec.recommended_by);
    if (recId !== null) sourceVisitId = openRec.source_visit_id ?? null;
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
