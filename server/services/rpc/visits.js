// DAY_VISIT_V1 — the visit model: a visit is ONE CALENDAR DAY (00:00–23:59)
// per patient. The UI works in SERVICES; each service lands on the visit of
// its own date, and the visit row exists for statistics (counts, journals).
// ensure_visit is the single entry point: find the patient's visit for the
// given day or create it — so "how many visits" is computed here, in the
// backend, never hand-managed by the client.

import { hasAnyRole } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

const ENSURE_ROLES = ['admin', 'registrar', 'doctor', 'nurse'];

function requireRole(user, allowed) {
  // MULTI_ROLE_SERVER_V1 — extras count too, not the primary role alone.
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
  }
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

// args: { patient_id, date (ISO datetime or YYYY-MM-DD), doctor_id?,
//         visit_type?, referral_source_id?, branch_id?, notes? }
// Returns { visit, created } — the day's visit row, creating it if absent.
export function ensureVisit(db, args, user) {
  requireRole(user, ENSURE_ROLES);

  const patientId = args && args.patient_id;
  if (!isPositiveInt(patientId)) {
    throw new RpcError('patient_id must be a positive integer.', 400);
  }
  const rawDate = args && typeof args.date === 'string' ? args.date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
    throw new RpcError('date must be ISO (YYYY-MM-DD or full datetime).', 400);
  }
  const day = rawDate.slice(0, 10);
  const whenIso = rawDate.length > 10 ? rawDate : day + 'T09:00:00Z';

  const optInt = (v, name) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!isPositiveInt(n)) throw new RpcError(name + ' must be a positive integer.', 400);
    return n;
  };
  const doctorId = optInt(args.doctor_id, 'doctor_id');
  const branchId = optInt(args.branch_id, 'branch_id');
  const sourceId = optInt(args.referral_source_id, 'referral_source_id');
  const visitType = typeof args.visit_type === 'string' && args.visit_type ? args.visit_type : 'outpatient';
  const notes = typeof args.notes === 'string' ? args.notes.slice(0, 1000) : '';

  // CRM_AUTO_CAME_V1 — the patient actually showed up for a service: their
  // still-active CRM leads (incl. an earlier no_show) auto-flip to «Пришёл».
  // Only leads linked via patient_id flip — phone matching is unsafe.
  //
  // CRM_FUTURE_LEAD_V2 — but NOT a lead booked for a later day. Turning up for
  // today's blood test used to close every open lead the patient had, including
  // a consultation booked for next month: the appointment vanished from the
  // scheduled list and the funnel counted a conversion that had not happened.
  // A lead is closed by this visit only if it was for this day or earlier;
  // an undated (walk-in) lead still closes, as before.
  const flipCrmToCame = () => {
    db.prepare(`
      UPDATE crm_requests
         SET status = 'came', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE patient_id = ?
         AND status IN ('in_process','recall','scheduled','approved','no_show')
         AND (scheduled_date IS NULL OR scheduled_date = '' OR date(scheduled_date) <= date(?))
    `).run(patientId, day);
  };

  const run = db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(patientId)) {
      throw new RpcError('patient not found.', 400);
    }
    // One visit per patient per day: match on the DATE part of visit_date.
    // Cancelled/no-show days don't swallow new bookings — a fresh visit row
    // is opened for the same day instead.
    const existing = db.prepare(`
      SELECT * FROM visits
       WHERE patient_id = ? AND substr(visit_date, 1, 10) = ?
         AND status NOT IN ('cancelled', 'no_show')
       ORDER BY id LIMIT 1
    `).get(patientId, day);
    if (existing) {
      // Backfill a doctor onto a doctor-less day visit (first assigned wins).
      if (doctorId && existing.doctor_id == null) {
        db.prepare('UPDATE visits SET doctor_id = ? WHERE id = ?').run(doctorId, existing.id);
        existing.doctor_id = doctorId;
      }
      flipCrmToCame();
      return { visit: existing, created: false };
    }

    if (doctorId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(doctorId)) {
      throw new RpcError('doctor not found.', 400);
    }
    const info = db.prepare(`
      INSERT INTO visits (patient_id, doctor_id, branch_id, visit_date, visit_type, status, referral_source_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)
    `).run(patientId, doctorId, branchId, whenIso, visitType, sourceId, notes, user.id);
    flipCrmToCame();
    return { visit: db.prepare('SELECT * FROM visits WHERE id = ?').get(info.lastInsertRowid), created: true };
  });

  return run();
}
