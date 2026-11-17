// WAIT_REG_V1 (3.25.0, 2026-11-17) — «ЖДУТ РЕГИСТРАЦИИ»: КОГО СЕГОДНЯ ЖДЁТ СТОЙКА.
//
// Владелец: «in the registrator window we should show the patients that were sent and patients
// for which we created a booking so registrators won't be confused; create a forcing function».
// Решение владельца: запись колл-центра (CRM) выставляется в счёт ПО ПРИХОДУ — при записи счёта
// нет; регистратор нажимает «Оформить по записи», окно визита выставляет счёт ровно на записанные
// услуги, и пациент идёт в кассу.
//
// registrar_waiting({ patient_id? }) — ТОЛЬКО ЧТЕНИЕ. Сегодняшний (МЕСТНЫЙ день клиники) список
// ожидаемых пациентов всей клиники, по строке на пациента. Три источника:
//   а) ЗАПИСЬ: визит сегодня «Записан» / «Подтверждён» (не «Пришёл», не отменён, не «Не пришёл»),
//      своего здания, со строками записи — 'added', без счёта, не товар (календарь, колл-центр /
//      CRM — booking-mirror.js insertBookingLine, booking_lines_add, calendar_book; онлайн-запись
//      сайта и партнёров — services/api/bookings.js). Визит, по которому уже выставлен счёт или
//      начата работа, — зарегистрирован (оставшиеся строки без счёта — дело кассы, «Ждут счёта»);
//   б) АНАЛИЗ «НА ДАТУ»: строка заявки CRM на сегодня без врача и времени — визита у неё нет, пока
//      стойка не заведёт визит дня. Строки — ТЕМ ЖЕ правилом, которым их посадит ensure_visit
//      (crm/visit-link.js stepALines — его же читает смета регистратуры, crm_day_lines);
//   в) НАПРАВИЛ ВРАЧ: строка визита сегодня без счёта, на которую направил врач — правило
//      patient_referral_orders (rpc/referral-orders.js DOCTOR_ORDER_SQL: внутренний источник врача
//      или строку завёл врач к другому исполнителю). Визит может быть и «Пришёл» (направили с
//      приёма): пациент уходит из списка, когда строку выставили в счёт.
// Пациент уходит из списка, когда зарегистрирован: строки записи — в выставленном счёте, визит
// пришёл или по нему работа. Кто остался к концу дня — не пришёл или его не оформили.
//
// Отдельный RPC, а не cashier_unbilled: тот закрыт ролями смены кассы и показывает строки без
// счёта за 30 дней. Форма выборки — та же (визиты дня по индексу, строки по визиту).
//
// ДОСТУП — стойка: администратор и регистратура (DESK_ROLES, domain/line-referral.js — те, кому
// регистрация на стойке верится и в шаге связи CRM). Плюс ворота данных пациента, как у
// patient_referral_orders (patientDataRefusal): роль, которой клиника закрыла строки визита, их и
// здесь не получает. Остальным — 403.
import { hasAnyRole } from '../roles.js';
import { today, localRangeWhere } from '../domain/day.js';
import { DESK_ROLES } from '../domain/line-referral.js';
import { patientDataRefusal, PATIENT_DATA_DENIED } from '../../db/patient-data-gate.js';
import { dayVisitOf } from './visits.js';
import { stepALines, dayLineStatuses } from '../crm/visit-link.js';
import { DOCTOR_ORDER_SQL, REFERRER_ID_SQL, NOT_REFUNDED_SQL } from './referral-orders.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

/** Роли, которым открыт список (зеркало экрана: patients-hub.js, вкладка «Ждут регистрации»). */
export const WAITING_ROLES = DESK_ROLES;
const PRE_ARRIVAL = ['scheduled', 'confirmed'];
const holes = (a) => a.map(() => '?').join(',');
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const nameOfUser = (u) => `COALESCE(NULLIF(${u}.full_name, ''), ${u}.username)`;

// Визит ЗАРЕГИСТРИРОВАН: живой (не отменённый) счёт или строка дальше «в смете» (работа, товар).
const REGISTERED_SQL = `(EXISTS (SELECT 1 FROM invoices ri WHERE ri.visit_id = v.id AND COALESCE(ri.status, '') <> 'void')
   OR EXISTS (SELECT 1 FROM visit_services rw WHERE rw.visit_id = v.id
               AND (rw.status NOT IN ('added', 'cancelled', 'removed') OR rw.clinic_item_id IS NOT NULL)))`;

/** registrar_waiting({ patient_id? }) → { today, count, rows } */
export function registrarWaiting(db, args, user) {
  if (!hasAnyRole(user, WAITING_ROLES)) throw new RpcError('Список «Ждут регистрации» доступен регистратуре и администратору.', 403);
  if (patientDataRefusal('visit_services', user, db) || patientDataRefusal('visits', user, db)) {
    throw new RpcError(PATIENT_DATA_DENIED, 403);
  }
  const a = args || {};
  const onlyRaw = a.patient_id == null || a.patient_id === '' ? null : Number(a.patient_id);
  if (onlyRaw != null && !isPosInt(onlyRaw)) throw new RpcError('Пациент указан неверно.', 400);
  const only = onlyRaw;
  const day = today(db);
  const rows = new Map();   // patient_id → строка ответа
  const rowOf = (p) => {
    let r = rows.get(Number(p.patient_id));
    if (!r) {
      r = { patient_id: Number(p.patient_id), patient_name: p.patient_name || '', mrn: p.mrn || '', phone: p.phone || '',
        time: null, visit_id: null, visit_status: null, sources: [], doctors: [], services: [], booked_by: [], lines: [] };
      rows.set(r.patient_id, r);
    }
    return r;
  };
  const addUnique = (list, v) => { if (v && !list.includes(v)) list.push(v); };
  const addSource = (r, kind, name = '') => {
    if (!r.sources.some((s) => s.kind === kind && (s.name || '') === (name || ''))) r.sources.push({ kind, name: name || '' });
  };
  const earlier = (r, t) => { if (t && (!r.time || t < r.time)) r.time = t; };

  // ── а) и в): строки визитов сегодняшнего дня без счёта ───────────────────
  const range = localRangeWhere('v.visit_date', day, day);
  const lines = db.prepare(`
    SELECT vs.id AS vs_id, vs.visit_id, vs.service_id, vs.consultation_type_id,
           v.patient_id, v.status AS visit_status, v.booked_at,
           -- время — местное, тем же правилом SQLite, что и день (domain/day.js), а не часами Node
           CASE WHEN vs.scheduled_at IS NOT NULL AND vs.scheduled_at <> '' THEN strftime('%H:%M', vs.scheduled_at, 'localtime') END AS line_hhmm,
           strftime('%H:%M', v.visit_date, 'localtime') AS visit_hhmm,
           pt.full_name AS patient_name, pt.mrn, pt.phone,
           COALESCE(s.name, ct.name_ru, ct.name, '') AS name,
           ${nameOfUser('du')} AS doctor_name,
           ${nameOfUser('cu')} AS line_creator, cu.role AS line_creator_role,
           ${nameOfUser('vu')} AS visit_creator, vu.role AS visit_creator_role,
           CASE WHEN ${DOCTOR_ORDER_SQL} THEN 1 ELSE 0 END AS doctor_order,
           COALESCE(NULLIF(ru.full_name, ''), ru.username, lrs.name, '') AS referrer_name,
           (SELECT ac.name FROM api_requests ar JOIN api_connections ac ON ac.id = ar.connection_id
             WHERE ar.visit_id = v.id ORDER BY ar.id LIMIT 1) AS partner_name,
           (EXISTS (SELECT 1 FROM crm_request_services cl WHERE cl.visit_id = v.id AND cl.status <> 'cancelled')
            OR EXISTS (SELECT 1 FROM crm_booking_links bl WHERE bl.visit_id = v.id AND bl.source = 'callcenter')) AS crm_booked,
           ${REGISTERED_SQL} AS registered
      FROM visits v
     CROSS JOIN visit_services vs ON vs.visit_id = v.id
      JOIN patients pt ON pt.id = v.patient_id
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN consultation_types ct ON ct.id = vs.consultation_type_id
      LEFT JOIN users du ON du.id = vs.doctor_id
      LEFT JOIN users cu ON cu.id = vs.created_by
      LEFT JOIN users vu ON vu.id = v.created_by
      LEFT JOIN referral_sources lrs ON lrs.id = vs.referred_by_source_id
      LEFT JOIN users ru ON ru.id = ${REFERRER_ID_SQL}
     WHERE ${range.sql}
       AND v.sync_origin IS NULL AND vs.sync_origin IS NULL
       AND COALESCE(v.status, '') NOT IN ('cancelled', 'no_show')
       AND vs.status = 'added' AND vs.invoice_item_id IS NULL AND vs.clinic_item_id IS NULL
       AND (vs.service_id IS NOT NULL OR vs.consultation_type_id IS NOT NULL)
       AND ${NOT_REFUNDED_SQL}
       ${only != null ? 'AND v.patient_id = ?' : ''}
     ORDER BY v.visit_date, vs.id`).all(...range.params, ...(only != null ? [only] : []));

  for (const l of lines) {
    const doctor = Number(l.doctor_order) === 1;
    // Запись — только до прихода и пока визит не зарегистрирован; направление врача — пока строка без счёта.
    if (!doctor && (!PRE_ARRIVAL.includes(l.visit_status) || Number(l.registered) === 1)) continue;
    const r = rowOf(l);
    if (r.visit_id == null) { r.visit_id = Number(l.visit_id); r.visit_status = l.visit_status; }
    let source;
    if (doctor) source = 'doctor';
    else if (l.partner_name) source = 'partner';
    else if (Number(l.crm_booked) === 1 || l.visit_creator_role === 'callcenter' || l.line_creator_role === 'callcenter') source = 'crm';
    else source = 'calendar';
    addSource(r, source, source === 'doctor' ? l.referrer_name : source === 'partner' ? l.partner_name : '');
    // Время строки (своё, не полночь «на дату»), иначе время ЗАПИСИ (booked_at — его ставил calendar_book);
    // у визита дня без записи (ensure_visit без брони, 09:00Z) времени нет.
    const lineTime = l.line_hhmm && l.line_hhmm !== '00:00' ? l.line_hhmm : null;
    const visitTime = String(l.booked_at || '').trim() ? (l.visit_hhmm || null) : null;
    const time = lineTime || visitTime;
    earlier(r, time);
    addUnique(r.services, l.name);
    addUnique(r.doctors, l.doctor_name);
    addUnique(r.booked_by, doctor ? l.line_creator : (l.visit_creator || l.line_creator));
    r.lines.push({ kind: doctor ? 'doctor' : 'booked', visit_service_id: Number(l.vs_id), visit_id: Number(l.visit_id),
      service_id: l.service_id ?? null, consultation_type_id: l.service_id == null ? (l.consultation_type_id ?? null) : null,
      name: l.name || '', doctor_name: l.doctor_name || '', source, time,
      referrer_name: doctor ? (l.referrer_name || '') : '' });
  }

  // ── б) анализы «на дату»: желания заявок CRM на сегодня без визита ────────
  const stages = dayLineStatuses(db);
  if (stages.length) {
    const cands = db.prepare(`
      SELECT DISTINCT r.patient_id FROM crm_request_services l
        JOIN crm_requests r ON r.id = l.request_id
       WHERE l.status = 'pending' AND l.visit_service_id IS NULL
         AND l.scheduled_date IS NOT NULL AND l.scheduled_date <> '' AND date(l.scheduled_date) = date(?)
         AND r.patient_id IS NOT NULL AND r.status IN (${holes(stages)})
         ${only != null ? 'AND r.patient_id = ?' : ''}`)
      .all(day, ...stages, ...(only != null ? [only] : []));
    const patient = db.prepare('SELECT id AS patient_id, full_name AS patient_name, mrn, phone FROM patients WHERE id = ?');
    const visitDone = db.prepare(`SELECT ${REGISTERED_SQL} AS registered FROM visits v WHERE v.id = ?`);
    const svc = db.prepare('SELECT name FROM services WHERE id = ?');
    const ct = db.prepare('SELECT COALESCE(name_ru, name) AS name FROM consultation_types WHERE id = ?');
    const usr = db.prepare(`SELECT ${nameOfUser('u')} AS name FROM users u WHERE u.id = ?`);
    const card = db.prepare('SELECT assigned_to, created_by FROM crm_requests WHERE id = ?');
    const partnerOf = db.prepare(`SELECT ac.name FROM api_requests ar JOIN api_connections ac ON ac.id = ar.connection_id
                                   WHERE ar.crm_request_id = ? ORDER BY ar.id LIMIT 1`);
    for (const { patient_id: pid } of cands) {
      const dv = dayVisitOf(db, pid, day);
      // Визит дня уже пришёл или зарегистрирован — пациента оформили; строка заявки сядет правилом прихода.
      if (dv && (!PRE_ARRIVAL.includes(dv.status) || Number(visitDone.get(dv.id).registered) === 1)) continue;
      const p = patient.get(pid);
      if (!p) continue;
      for (const { card: c, lines: ls } of stepALines(db, { patientId: pid, day, visitId: dv ? dv.id : null, undated: false })) {
        for (const l of ls) {
          if (!l.scheduled_date) continue;   // stepALines без undated отдаёт только строки этого дня — страховка
          const r = rowOf(p);
          if (r.visit_id == null && dv) { r.visit_id = Number(dv.id); r.visit_status = dv.status; }
          const cr = card.get(c.id) || {};
          let partner = null;
          try { partner = (partnerOf.get(c.id) || {}).name || null; } catch { partner = null; }
          const source = partner ? 'partner' : 'crm';
          addSource(r, source, partner || '');
          const name = l.service_id != null ? ((svc.get(l.service_id) || {}).name || '') : ((ct.get(l.consultation_type_id) || {}).name || '');
          const doctorName = l.doctor_id != null ? ((usr.get(l.doctor_id) || {}).name || '') : '';
          addUnique(r.services, name);
          addUnique(r.doctors, doctorName);
          const who = cr.assigned_to != null ? usr.get(cr.assigned_to) : (cr.created_by != null ? usr.get(cr.created_by) : null);
          addUnique(r.booked_by, who && who.name);
          r.lines.push({ kind: 'wish', crm_line_id: Number(l.id), request_id: Number(c.id),
            service_id: l.service_id ?? null, consultation_type_id: l.service_id == null ? (l.consultation_type_id ?? null) : null,
            name, doctor_name: doctorName, source, time: null, referrer_name: '' });
        }
      }
    }
  }

  const out = [...rows.values()].sort((x, y) => {
    if (x.time && y.time && x.time !== y.time) return x.time < y.time ? -1 : 1;
    if (!!x.time !== !!y.time) return x.time ? -1 : 1;
    return String(x.patient_name).localeCompare(String(y.patient_name), 'ru') || x.patient_id - y.patient_id;
  });
  return { today: day, count: out.length, rows: out };
}
