// PUBLIC_SERVER_V1 — ЖУРНАЛЫ ДЛЯ КЛИНИКИ: запросы партнёров с ключом и
// попытки доставки уведомлений. Без тел запросов и ответов — метод, путь с
// разрешёнными параметрами, код ответа, подключение, IP, время (дизайн §1).
// Хранятся 30 дней; клиника забирает их в очереди (GET /_sync/v1/inbox с
// access_after / deliveries_after — экраны журнала строит 8d).
import { isoOf } from '../lib/time.js';

export const LOG_KEEP_DAYS = 30;
const DAY = 86400000;
const PAGE_MAX = 200;

export function recordAccess(db, { clinicId, connectionId = null, at, method, path, status, ip = null, ms = null }) {
  db.prepare('INSERT INTO access_log (clinic_id, connection_id, at, method, path, status, ip, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(clinicId, connectionId, at, String(method).slice(0, 8), String(path).slice(0, 300), status, ip ? String(ip).slice(0, 64) : null, ms);
}

/** Записи журнала запросов клиники после номера after (по возрастанию). */
export function accessSince(db, clinicId, after, limit = PAGE_MAX) {
  return db.prepare(`SELECT id, connection_id, at, method, path, status, ip, ms FROM access_log
                     WHERE clinic_id = ? AND id > ? ORDER BY id LIMIT ?`).all(clinicId, Number(after) || 0, Math.min(limit, PAGE_MAX));
}

export function appendDeliveryLog(db, e) {
  db.prepare(`INSERT INTO delivery_log (clinic_id, delivery_id, connection_id, request_id, event_id, event, attempt, code, error, at, next_at, final)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(e.clinicId, e.deliveryId ?? null, e.connectionId ?? null, e.requestId ?? null, e.eventId ?? null, e.event, e.attempt, e.code ?? null,
      e.error ?? null, e.at, e.nextAt ?? null, e.final ?? null);
}

/** Попытки доставки клиники после номера after (по возрастанию). */
export function deliveryLogSince(db, clinicId, after, limit = PAGE_MAX) {
  return db.prepare(`SELECT id, delivery_id, connection_id, request_id, event_id, event, attempt, code, error, at, next_at, final FROM delivery_log
                     WHERE clinic_id = ? AND id > ? ORDER BY id LIMIT ?`).all(clinicId, Number(after) || 0, Math.min(limit, PAGE_MAX));
}

export function purgeLogs(db, now) {
  const old = isoOf(now - LOG_KEEP_DAYS * DAY);
  return {
    access: db.prepare('DELETE FROM access_log WHERE at < ?').run(old).changes,
    deliveries: db.prepare('DELETE FROM delivery_log WHERE at < ?').run(old).changes,
  };
}
