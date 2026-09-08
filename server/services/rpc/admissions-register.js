// ADMISSIONS_REGISTER_V1 (2026-09-08) — ЖУРНАЛ ГОСПИТАЛИЗАЦИЙ ОДНОЙ ТАБЛИЦЕЙ
//
// Владелец показал образец (Aurora): пациент с аватаром и номером, дата
// рождения с возрастом, № истории, статус, госпитализация, выписка,
// отделение, койка, врач, покрытие, сумма акта, выставлено, баланс — и
// фильтр под каждой колонкой. Три денежные колонки — АГРЕГАТЫ по услугам и
// счетам госпитализации, поэтому таблицу отдаёт сервер одним вызовом, а не
// экран тремя запросами на строку.
//
//   сумма акта   — всё, что оказано (строки admission_services, вкл. проживание);
//   выставлено   — сумма счетов госпитализации;
//   баланс       — оплачено минус выставлено: минус — долг пациента, ноль —
//                  рассчитан, плюс — переплата/аванс.
//
// «Филиал» из образца не показывается: у госпитализаций в этой базе филиала
// нет (стационар живёт в одном здании) — рисовать пустую колонку значит врать.
import { RpcError } from './inpatient-flow.js';
import { hasAnyRole } from '../roles.js';

export const REGISTER_ROLES = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse', 'registrar', 'cashier'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function admissionsRegister(db, args, user) {
  if (!hasAnyRole(user, REGISTER_ROLES)) throw new RpcError('Журнал госпитализаций — недоступно вашей роли.', 403);
  const raw = Number(args && args.limit);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 1000) : 500;
  const rows = db.prepare(`
    SELECT a.id, a.admission_no, a.status, a.admitted_at, a.discharged_at, a.department, a.admission_type,
           a.planned_discharge_at,
           p.id AS patient_id, p.mrn, p.full_name, p.date_of_birth,
           w.name AS ward_name, b.code AS bed_code,
           doc.full_name AS attending_name,
           py.name AS payer_name,
           (SELECT COALESCE(SUM(s.total), 0) FROM admission_services s WHERE s.admission_id = a.id) AS act_total,
           (SELECT COALESCE(SUM(i.total_amount), 0) FROM invoices i WHERE i.admission_id = a.id) AS invoiced_total,
           (SELECT COALESCE(SUM(i.paid_amount), 0) FROM invoices i WHERE i.admission_id = a.id) AS paid_total
      FROM admissions a
      LEFT JOIN patients p ON p.id = a.patient_id
      LEFT JOIN wards w ON w.id = a.ward_id
      LEFT JOIN beds b ON b.id = a.bed_id
      LEFT JOIN users doc ON doc.id = a.attending_doctor_id
      LEFT JOIN payers py ON py.id = p.payer_id
     ORDER BY COALESCE(a.admitted_at, a.created_at) DESC, a.id DESC
     LIMIT ?`).all(limit);
  return {
    rows: rows.map((r) => ({
      ...r,
      act_total: round2(r.act_total),
      invoiced_total: round2(r.invoiced_total),
      paid_total: round2(r.paid_total),
      balance: round2(r.paid_total - r.invoiced_total),
    })),
    total: rows.length,
  };
}
