// VISIT_TIER_PRICING_V1 — service_price_quote: what these services cost THIS
// patient today, by the tier rule in domain/visit-tier.js.
//
// Asked by the booking wizard the moment a patient is attached and a service
// is in the смета, and by the doctor's «добавить услугу». The answer is a
// quote, not a write: the caller puts the price and the tier word on the line
// it inserts, and the cashier (billing.js) re-derives the price from that
// word, so a line always says why it costs what it costs.
//
// «Previous visit» = the patient's most recent EARLIER line of the same
// service on a visit that happened (not cancelled / no-show), excluding the
// visit being edited. Its local calendar day is what the window counts from.
import { hasAnyRole } from '../roles.js';
import { tierFor, hasTiers } from '../domain/visit-tier.js';
import { today, localDate } from '../domain/day.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const QUOTE_ROLES = ['admin', 'registrar', 'doctor', 'nurse', 'cashier', 'callcenter'];

/**
 * args: { patient_id, service_ids: [id…], visit_id?, date?: 'YYYY-MM-DD' }
 * `date` — the day the visit is PLANNED for (the wizard books tomorrow as
 * readily as today); the window is counted to that day, and only visits up
 * to that day are «earlier». Absent → the clinic's today.
 * → { quotes: { [service_id]: { tier, price, base_price, days_since, reason, prev_day } } }
 */
export function servicePriceQuote(db, args, user) {
  if (!hasAnyRole(user, QUOTE_ROLES)) throw new RpcError('Нет доступа к ценам услуг.', 403);
  const a = args || {};
  const patientId = Number(a.patient_id);
  if (!Number.isInteger(patientId) || patientId <= 0) throw new RpcError('patient_id обязателен.', 400);
  const ids = Array.isArray(a.service_ids) ? [...new Set(a.service_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
  if (!ids.length) return { quotes: {} };
  const visitId = a.visit_id == null ? null : Number(a.visit_id);

  const todayYmd = /^\d{4}-\d{2}-\d{2}$/.test(String(a.date || '')) ? String(a.date) : today(db);
  const getService = db.prepare('SELECT id, price, price_secondary, secondary_days_from, secondary_days_to, price_repeat, repeat_days_from, repeat_days_to FROM services WHERE id = ?');
  // The most recent earlier line of this service for this patient. Lines
  // cancelled at the desk and visits that never happened do not count: a
  // patient who booked and did not come has not had a first visit.
  const prevStmt = db.prepare(`
    SELECT ${localDate('v.visit_date')} AS day, vs.price_tier AS tier
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
     WHERE v.patient_id = ? AND vs.service_id = ?
       AND v.status NOT IN ('cancelled', 'no_show')
       AND COALESCE(vs.status, '') NOT IN ('cancelled', 'void', 'removed')
       AND (? IS NULL OR vs.visit_id != ?)
       AND ${localDate('v.visit_date')} <= ?
     ORDER BY v.visit_date DESC, vs.id DESC
     LIMIT 1`);

  const quotes = {};
  for (const id of ids) {
    const svc = getService.get(id);
    if (!svc) continue;
    if (!hasTiers(svc)) {
      quotes[id] = { tier: 'primary', price: Number(svc.price) || 0, base_price: Number(svc.price) || 0, days_since: null, reason: 'no_tiers', prev_day: null };
      continue;
    }
    const prev = prevStmt.get(patientId, id, visitId, visitId, todayYmd) || null;
    const q = tierFor(svc, prev, todayYmd);
    quotes[id] = { ...q, prev_day: prev ? prev.day : null };
  }
  return { quotes };
}
