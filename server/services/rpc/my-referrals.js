// MY_REFERRALS_V1 (3.22.0, решение владельца 2026-11-07, п. 11) — «МОИ НАПРАВЛЕНИЯ» КАБИНЕТА ВРАЧА.
//
// Врач направлял пациента на УЗИ, анализы, к коллеге — и дальше терял его из виду: узнать, оплачено
// ли, сделано ли и что вышло, можно было только открывая карты пациентов по одной. Теперь вкладка
// кабинета показывает всё, что направил ЭТОТ врач, по всем пациентам, со статусом и «Результатом».
//
// ЧТО СЧИТАЕТСЯ НАПРАВЛЕНИЕМ ВРАЧА — правило «от врача» стойки (referral-orders.js REFERRER_ID_SQL,
// DOCTOR_ORDER_SQL), а не своё: строка визита, у которой
//   • направивший — этот врач: внутренний источник врача на строке (REFERRAL_LINE_V1), иначе его
//     рекомендация, которую строка закрыла, иначе он завёл строку (created_by ставит сервер) — и
//     завёл ВРАЧОМ, а не стойкой: администратор-врач у стойки записывает пациента, это не
//     направление (то же, что у «Направлений врача» регистратуры);
//   • исполнитель — не он сам (своя строка — его приём, она в «Моих приёмах»);
//   • своего здания (направления между зданиями не ездят), не товар.
// Плюс его рекомендации, ещё не ставшие строкой визита: открытая — «не выставлено», отменённая —
// «отменено». Рекомендация, закрытая строкой, — это строка выше.
//
// СТАТУС: отменено (строка или визит) · готово (completed) · возвращено (касса вернула деньги и
// не выставила заново — pay_refund_releases 'out', то же правило, что у кассы) · в работе (начата:
// in_progress, взят материал, внесены результаты) · иначе по счёту: нет живого счёта — не
// выставлено; счёт оплачен — оплачено; иначе — ждёт оплаты (в том числе в долг).
//
// ПЕРИОД — по дню НАПРАВЛЕНИЯ (vs.created_at, местный день); по умолчанию последние 30 дней,
// не длиннее года. Группа и поиск — на экране по этому ответу.
//
// «РЕЗУЛЬТАТ» — права не шире прежних. Документ открывает окно, которое читает
// patient_doc_sources, — с правилом карты пациента (раздел «Пациенты», вкладки «Документы» /
// «Лаборатория», реестр таблиц). Здесь то же правило решает, есть ли у строки кнопка: готово,
// документ есть (живая копия архива или подписанная запись строки, у анализа — показатели) и
// вкладка роли открыта. Иначе — только статус.
//
// ТОЛЬКО ЧТЕНИЕ (READ_ONLY_RPCS в control/gate.js).
import { canRead } from '../../db/schema-registry.js';
import { today } from '../domain/day.js';
import { isDoctorActor, isDeskActor } from '../domain/line-referral.js';
import { patientDataRefusal, PATIENT_DATA_DENIED } from '../../db/patient-data-gate.js';
import { patientCardAccess } from './patient-card.js';
import { serviceRoute, serviceGroup } from '../../../public/js/shared/service-route.js';
import { hasColumn } from '../domain/buildings.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const MY_REFERRALS_DAYS = 30;
const MAX_DAYS = 366;
const LINE_LIMIT = 1000;
const REC_LIMIT = 500;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Группа строки для экрана: consult | diag | lab | procedure | other (маршрут — shared/service-route.js). */
export function referralGroup(r) {
  if (r.service_id == null) return r.consultation_type_id != null ? 'consult' : 'other';
  const route = serviceRoute({
    type: r.svc_type, is_lab: r.is_lab, dept_kind: r.dept_kind || '',
    service_types: r.type_name ? { name: r.type_name } : null,
  });
  if (route === 'lab') return 'lab';
  if (route === 'procedure') return 'procedure';
  const g = serviceGroup({ type: r.svc_type });
  if (g === 'imaging' || g === 'radiology') return 'diag';
  if (g === 'other') return 'other';
  return 'consult';
}

const WORK_DONE = 'completed';
/** Статус строки направления (см. шапку). */
export function referralStatus(r) {
  if (r.status === 'cancelled' || r.status === 'removed' || r.visit_status === 'cancelled' || r.visit_status === 'no_show') return 'cancelled';
  if (r.status === WORK_DONE) return 'done';
  if (Number(r.refunded) === 1 || r.status === 'refunded' || r.invoice_status === 'refunded') return 'refunded';
  if (r.status !== 'added' && r.status !== 'queued') return 'in_work';
  if (r.invoice_status == null || r.invoice_status === 'void') return 'not_billed';
  if (r.invoice_status === 'paid') return 'paid';
  return 'awaiting_payment';
}

function period(db, args) {
  const day = today(db);
  const to = args && args.to != null && args.to !== '' ? String(args.to) : day;
  const from = args && args.from != null && args.from !== '' ? String(args.from)
    : db.prepare(`SELECT date(?, '-${MY_REFERRALS_DAYS - 1} days') AS d`).get(to).d;
  if (!YMD.test(from) || !YMD.test(to)) throw new RpcError('Период указан неверно.', 400);
  const span = db.prepare('SELECT julianday(?) - julianday(?) AS n').get(to, from).n;
  if (!(span >= 0)) throw new RpcError('Период указан неверно.', 400);
  if (span > MAX_DAYS) throw new RpcError('Период — не длиннее года.', 400);
  // [lo, hi) — UTC-мгновения местных полуночей (как utcRange в domain/day.js): префикс любого ISO.
  const b = db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M', date(?), 'utc') AS lo,
                               strftime('%Y-%m-%dT%H:%M', date(?), '+1 day', 'utc') AS hi`).get(from, to);
  return { from, to, lo: b.lo, hi: b.hi };
}

/** Какие документы роль открыла бы в карте пациента (то же, что patient_doc_sources). */
function resultAccess(db, user) {
  let acc;
  try { acc = patientCardAccess(db, user); } catch { return { doc: false, labs: false }; }
  const { roles, tabs } = acc;
  const lineRead = canRead('visits', roles) && canRead('visit_services', roles);
  return {
    doc: tabs.docs !== 'none' && lineRead,
    labs: tabs.labs !== 'none' && lineRead && canRead('lab_results', roles),
  };
}

const patientName = (r) => [r.last_name, r.first_name].filter(Boolean).join(' ').trim() || r.full_name || '';

/** my_referrals({ from?, to? }) → { from, to, rows, truncated } */
export function myReferrals(db, args, user) {
  if (!user || !isDoctorActor(user)) throw new RpcError('«Мои направления» — у врача.', 403);
  if (patientDataRefusal('visit_services', user, db)) throw new RpcError(PATIENT_DATA_DENIED, 403);
  const me = Number(user.id);
  const { from, to, lo, hi } = period(db, args);
  // Завёл строку врачом, а не стойкой (isDoctorActor и не isDeskActor) — правило referral-orders.js.
  const createdCounts = isDoctorActor(user) && !isDeskActor(user) ? 1 : 0;
  const own = (t, a) => (hasColumn(db, t, 'sync_origin') ? ` AND ${a}.sync_origin IS NULL` : '');
  const refundSql = hasColumn(db, 'pay_refund_releases', 'line_id')
    ? `(vs.invoice_item_id IS NULL AND EXISTS (SELECT 1 FROM pay_refund_releases prr WHERE prr.kind = 'out' AND prr.line_id = vs.id))`
    : '0';

  const lineRows = db.prepare(`
    SELECT vs.id, vs.visit_id, vs.status, vs.created_at, vs.doctor_id, vs.service_id, vs.consultation_type_id,
           v.visit_date, v.status AS visit_status, v.patient_id,
           p.full_name, p.last_name, p.first_name, p.mrn,
           COALESCE(s.name, ct.name_ru, ct.name, '') AS service_name,
           s.type AS svc_type, s.is_lab, d.kind AS dept_kind, st.name AS type_name,
           COALESCE(NULLIF(pu.full_name, ''), pu.username, '') AS performer_name,
           COALESCE(NULLIF(vb.full_name, ''), vb.username, '') AS verifier_name,
           i.status AS invoice_status,
           ${refundSql} AS refunded,
           EXISTS (SELECT 1 FROM lab_results lr WHERE lr.visit_service_id = vs.id) AS has_lab,
           (EXISTS (SELECT 1 FROM visit_documents dd WHERE dd.visit_service_id = vs.id AND dd.voided_at IS NULL
                     AND dd.doc_type IN ('protocol', 'diag'))
            OR (NOT EXISTS (SELECT 1 FROM visit_documents dx WHERE dx.visit_service_id = vs.id AND dx.doc_type IN ('protocol', 'diag'))
                AND instr(COALESCE(vs.notes, ''), '"signed"') > 0)) AS has_doc
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
      JOIN patients p ON p.id = v.patient_id
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN departments d ON d.id = s.department_id
      LEFT JOIN service_types st ON st.id = s.type_id
      LEFT JOIN consultation_types ct ON ct.id = vs.consultation_type_id
      LEFT JOIN users pu ON pu.id = vs.doctor_id
      LEFT JOIN users vb ON vb.id = vs.verified_by
      LEFT JOIN referral_sources lrs ON lrs.id = vs.referred_by_source_id
      LEFT JOIN invoice_items ii ON ii.id = vs.invoice_item_id
      LEFT JOIN invoices i ON i.id = ii.invoice_id
     WHERE vs.created_at >= ? AND vs.created_at < ?
       AND vs.clinic_item_id IS NULL${own('visit_services', 'vs')}${own('visits', 'v')}
       AND COALESCE(vs.doctor_id, 0) <> ?
       AND (lrs.doctor_id = ?
            OR (lrs.doctor_id IS NULL AND (
                 (SELECT rr.recommended_by FROM recommended_services rr
                   WHERE rr.visit_service_id = vs.id AND rr.recommended_by IS NOT NULL ORDER BY rr.id LIMIT 1) = ?
                 OR (? = 1 AND vs.created_by = ?
                     AND NOT EXISTS (SELECT 1 FROM recommended_services rx
                                      WHERE rx.visit_service_id = vs.id AND rx.recommended_by IS NOT NULL)))))
     ORDER BY vs.created_at DESC, vs.id DESC
     LIMIT ?`).all(lo, hi, me, me, me, createdCounts, me, LINE_LIMIT + 1);

  const recRows = db.prepare(`
    SELECT r.id, r.patient_id, r.service_id, r.status, r.closed_at, r.created_at,
           COALESCE(s.name, r.service_name, '') AS service_name,
           s.type AS svc_type, s.is_lab, d.kind AS dept_kind, st.name AS type_name,
           p.full_name, p.last_name, p.first_name, p.mrn
      FROM recommended_services r
      LEFT JOIN patients p ON p.id = r.patient_id
      LEFT JOIN services s ON s.id = r.service_id
      LEFT JOIN departments d ON d.id = s.department_id
      LEFT JOIN service_types st ON st.id = s.type_id
     WHERE r.recommended_by = ? AND r.visit_service_id IS NULL
       AND r.created_at >= ? AND r.created_at < ?
       AND (COALESCE(r.status, '') = 'cancelled'
            OR (r.closed_at IS NULL AND COALESCE(r.status, '') NOT IN ('done', 'cancelled')))
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ?`).all(me, lo, hi, REC_LIMIT + 1);

  const access = resultAccess(db, user);
  const rows = [];
  for (const r of lineRows.slice(0, LINE_LIMIT)) {
    const group = referralGroup(r);
    const status = referralStatus(r);
    let result = null;
    if (status === 'done') {
      if (group === 'lab') result = access.labs && Number(r.has_lab) === 1 ? 'labs' : null;
      else if (access.doc && (Number(r.has_doc) === 1 || (access.labs && Number(r.has_lab) === 1))) result = 'doc';
    }
    rows.push({
      kind: 'line', id: r.id, visit_service_id: r.id, visit_id: r.visit_id, patient_id: r.patient_id,
      patient_name: patientName(r), patient_mrn: r.mrn || '',
      service: r.service_name || '', group, status,
      sent_at: r.created_at, visit_date: r.visit_date || null,
      performer: r.performer_name || (status === 'done' ? r.verifier_name || '' : ''),
      result,
    });
  }
  for (const r of recRows.slice(0, REC_LIMIT)) {
    rows.push({
      kind: 'rec', id: r.id, visit_service_id: null, visit_id: null, patient_id: r.patient_id,
      patient_name: patientName(r), patient_mrn: r.mrn || '',
      service: r.service_name || '',
      group: r.service_id == null ? 'other' : referralGroup(r),
      status: r.status === 'cancelled' ? 'cancelled' : 'not_billed',
      sent_at: r.created_at, visit_date: null, performer: '', result: null,
    });
  }
  rows.sort((a, b) => String(b.sent_at || '').localeCompare(String(a.sent_at || '')) || (b.id - a.id));
  return { from, to, rows, truncated: lineRows.length > LINE_LIMIT || recRows.length > REC_LIMIT };
}
