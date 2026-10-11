// PUBLIC_API_V1 — УДЕРЖАНИЕ ВРЕМЕНИ БЕЗ КАРТЫ ПАЦИЕНТА (решение владельца 3).
//
// Онлайн-запись партнёра карту не заводит: время держится строкой slot_holds
// (мигр. 245), а не визитом — у визита patient_id обязателен. Удержание ЗАНИМАЕТ
// время врача ровно там же, где его занимают визиты: rpc/calendar.js loadBusy
// читает liveHolds, поэтому calendar_slots, calendar_book, ensure_visit и окна
// для партнёров (doctorDayWindows) видят его одинаково, без второго правила.
//
// ЖИВО = released_at пуст И until_at впереди. Истечение освобождает время само,
// без таймера: следующий же вопрос «свободно ли» его не видит. Фон
// (bookings.js expireDue) только записывает итог и сообщает партнёру.
//
// Не бросает при чтении: база до мигр. 245 — удержаний нет.
import { isoOf } from '../../../public/js/shared/api-booking.js';

const DAY_MS = 24 * 3600 * 1000;

/**
 * Живые удержания врача, пересекающие [fromMs, toMs).
 * @returns {Array<{hold_id:number, api_request_id:number, startMs:number, endMs:number, durationMin:number, until:string, source:string}>}
 */
export function liveHolds(db, { doctorId, fromMs, toMs, excludeHoldId = null, now = Date.now() }) {
  if (!doctorId) return [];
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT h.id, h.api_request_id, h.start_at, h.duration_minutes, h.until_at, c.name AS source
        FROM slot_holds h
        JOIN api_requests r ON r.id = h.api_request_id
        LEFT JOIN api_connections c ON c.id = r.connection_id
       WHERE h.doctor_id = ? AND h.released_at IS NULL
         AND h.start_at >= ? AND h.start_at < ?
       ORDER BY h.start_at, h.id`).all(doctorId, isoOf(fromMs - DAY_MS), isoOf(toMs + DAY_MS));
  } catch { return []; }
  const out = [];
  for (const r of rows) {
    if (excludeHoldId && r.id === excludeHoldId) continue;
    const until = Date.parse(r.until_at);
    if (!(until > now)) continue;
    const startMs = Date.parse(r.start_at);
    if (!Number.isFinite(startMs)) continue;
    const durationMin = Math.max(1, Number(r.duration_minutes) || 15);
    const endMs = startMs + durationMin * 60000;
    if (endMs <= fromMs || startMs >= toMs) continue;
    out.push({ hold_id: r.id, api_request_id: r.api_request_id, startMs, endMs, durationMin, until: r.until_at, source: r.source || '' });
  }
  return out;
}

/** Живое удержание заявки или null. */
export function liveHoldOf(db, apiRequestId, now = Date.now()) {
  const r = db.prepare('SELECT * FROM slot_holds WHERE api_request_id = ? AND released_at IS NULL').get(apiRequestId);
  return r && Date.parse(r.until_at) > now ? r : null;
}

/** Поставить удержание. Прежнее живое у заявки должно быть снято (уникальный индекс мигр. 245). */
export function placeHold(db, { doctorId, startMs, durationMin, untilMs, apiRequestId, kind = 'booking' }) {
  return Number(db.prepare(`INSERT INTO slot_holds (doctor_id, start_at, duration_minutes, until_at, api_request_id, kind)
                            VALUES (?, ?, ?, ?, ?, ?)`)
    .run(doctorId, isoOf(startMs), durationMin, isoOf(untilMs), apiRequestId, kind).lastInsertRowid);
}

/** Снять удержания заявки (живые и истёкшие, но не записанные) с причиной. */
export function releaseHolds(db, apiRequestId, reason, now = Date.now()) {
  return db.prepare('UPDATE slot_holds SET released_at = ?, release_reason = ? WHERE api_request_id = ? AND released_at IS NULL')
    .run(isoOf(now), reason, apiRequestId).changes;
}
