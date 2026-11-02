// REPEAT_VISIT_V1 (2026-11-02) — «ЗАПИСИ ВПЕРЁД» В КАБИНЕТЕ ВРАЧА.
//
// Врач не видел своих будущих записей нигде: «Мой день» кончается сегодня
// (doctor-dashboard.js, окно до конца дня), «Мои записи» показывают строки
// после оплаты (consultation.js). Пациент, которого врач сам записал на
// повторный визит через неделю, пропадал из виду до дня приёма.
//
// doctor_upcoming_visits({ days = 30 }) → { from, to, rows: [...] } — СВОИ записи
// с завтрашнего местного дня на `days` дней вперёд:
//   • визит, где врач — врач записи (visits.doctor_id), или где у него есть
//     живая строка услуги (запись к другому врачу с его УЗИ);
//   • только ждущие записи (scheduled / confirmed) своего здания (sync_origin
//     IS NULL — как «Мой день»: приехавшая запись живёт в кабинете своего
//     здания);
//   • в строке — день и время (местные), пациент, вид визита и что записано
//     к этому врачу.
// Чей кабинет — решает СЕССИЯ (user.id), аргумента «чей» нет: параметр и
// означал бы «покажи чужие записи» (то же правило, что у загрузчиков дашборда).
import { hasAnyRole } from '../roles.js';
import { today, localDate, localRangeWhere } from '../domain/day.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const UPCOMING_DEFAULT_DAYS = 30;
export const UPCOMING_MAX_DAYS = 60;
const MAX_ROWS = 300;

/**
 * @param {object} db
 * @param {{ days?: number }} args
 * @param {object} user — сессия
 * @param {{ todayYmd?: string }} [opts] — только для тестов: «сегодня» клиники
 */
export function doctorUpcomingVisits(db, args, user, { todayYmd = null } = {}) {
  const me = Number(user && user.id);
  const row = Number.isInteger(me) && me > 0 ? db.prepare('SELECT id, role, is_doctor FROM users WHERE id = ?').get(me) : null;
  const isDoctor = !!row && (Number(row.is_doctor) === 1 || row.role === 'doctor' || hasAnyRole(user, ['doctor', 'head_doctor']));
  if (!isDoctor) throw new RpcError('«Записи вперёд» открываются только врачу.', 403);
  const asked = Math.round(Number(args && args.days));
  const days = Number.isFinite(asked) && asked > 0 ? Math.min(asked, UPCOMING_MAX_DAYS) : UPCOMING_DEFAULT_DAYS;
  const t = todayYmd || today(db);
  const span = db.prepare("SELECT date(?, '+1 day') AS f, date(?, ?) AS t").get(t, t, `+${days} days`);
  const w = localRangeWhere('v.visit_date', span.f, span.t);
  const rows = db.prepare(`
    SELECT v.id AS visit_id, v.visit_date, v.duration_minutes, v.status, v.visit_kind,
           ${localDate('v.visit_date')} AS day,
           strftime('%H:%M', v.visit_date, 'localtime') AS time,
           v.patient_id, p.full_name AS patient_name, p.mrn
      FROM visits v
      JOIN patients p ON p.id = v.patient_id
     WHERE ${w.sql}
       AND v.status IN ('scheduled', 'confirmed')
       AND v.sync_origin IS NULL
       AND (v.doctor_id = ? OR EXISTS (SELECT 1 FROM visit_services vs
                                        WHERE vs.visit_id = v.id AND vs.doctor_id = ? AND vs.status <> 'cancelled'))
     ORDER BY v.visit_date, v.id
     LIMIT ${MAX_ROWS}`).all(...w.params, me, me);
  const what = new Map();
  if (rows.length) {
    const ids = rows.map((r) => r.visit_id);
    const lines = db.prepare(`
      SELECT vs.visit_id, COALESCE(NULLIF(s.name, ''), NULLIF(ct.name_ru, ''), ct.name) AS name
        FROM visit_services vs
        LEFT JOIN services s ON s.id = vs.service_id
        LEFT JOIN consultation_types ct ON ct.id = vs.consultation_type_id
       WHERE vs.visit_id IN (${ids.map(() => '?').join(', ')}) AND vs.doctor_id = ? AND vs.status <> 'cancelled'
       ORDER BY vs.id`).all(...ids, me);
    for (const l of lines) {
      if (!l.name) continue;
      const list = what.get(l.visit_id) || [];
      list.push(l.name);
      what.set(l.visit_id, list);
    }
  }
  return {
    from: span.f,
    to: span.t,
    rows: rows.map((r) => ({ ...r, patient_name: r.patient_name || '', mrn: r.mrn || '', what: what.get(r.visit_id) || [] })),
  };
}
