// PUBLIC_API_V1 — СОБЫТИЯ НАРУЖУ: статус заявки для партнёра и уведомление (вебхук).
//
// Каждое событие ложится строкой api_outbox (мигр. 245) и уходит на публичный
// сервер по порядку (services/api/public-sync.js). Публичный сервер обновляет
// по нему статус заявки (GET /requests/{id}) и, если есть адрес, доставляет
// уведомление с повторами.
//
// ПОДПИСЬ СТАВИТ КЛИНИКА: HMAC-SHA256 тела секретом подключения
// («X-EasyMed-Signature: sha256=<hex>», документация API). Секрет открывается
// здесь ключом шифрования клиники (secret-box.js) и никуда не уходит —
// публичный сервер получает готовые тело и подпись и подделать уведомление от
// имени клиники не может. Секрет не открывается (база на другом компьютере) —
// событие всё равно уходит (статус партнёр увидит), уведомления нет, пометка
// no_secret: экран подключения скажет «выпустите новый секрет».
//
// Тело — белый список (shared/api-booking.js webhookBody): данных пациента в
// событиях нет по построению.
import crypto from 'node:crypto';
import { webhookBody, PARTNER_STATUS, isoOf } from '../../../public/js/shared/api-booking.js';
import { loadKek, unseal } from './secret-box.js';

const arr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

/** Подпись тела — как в документации API: 'sha256=' + HMAC-SHA256(секрет, тело) в hex. */
export const signBody = (secret, raw) => 'sha256=' + crypto.createHmac('sha256', String(secret)).update(String(raw), 'utf8').digest('hex');

/**
 * Поставить событие в очередь наружу.
 * @param {object} request строка api_requests (id, public_id, external_id, connection_id)
 * @param {string} status внутренний статус ПОСЛЕ события (партнёру — PARTNER_STATUS)
 * @returns {number} id строки api_outbox
 */
export function enqueueEvent(db, { request, event, status, details = {}, now = Date.now(), kekPath = null } = {}) {
  const conn = db.prepare('SELECT id, webhook_url, webhook_events, secret_sealed, deleted_at FROM api_connections WHERE id = ?')
    .get(request.connection_id);
  const body = webhookBody({
    eventId: 'ev_' + crypto.randomBytes(12).toString('hex'), event, publicId: request.public_id,
    externalId: request.external_id, status: PARTNER_STATUS[status] || status, occurredAt: isoOf(now), details,
  });
  const raw = JSON.stringify(body);
  let url = '';
  let signature = '';
  let note = '';
  if (!conn || conn.deleted_at || !conn.webhook_url) note = 'no_webhook';
  else if (!arr(conn.webhook_events).includes(event)) note = 'not_subscribed';
  else {
    try {
      const kek = loadKek(kekPath ? { kekPath } : {});
      signature = signBody(unseal(conn.secret_sealed, kek), raw);
      url = conn.webhook_url;
    } catch { note = 'no_secret'; }
  }
  return Number(db.prepare(`INSERT INTO api_outbox (api_request_id, connection_id, event, status, body, webhook_url, signature, note)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(request.id, request.connection_id, event, body.status, raw, url, signature, note).lastInsertRowid);
}

/** Неотправленные события по порядку. */
export function unsentEvents(db, limit = 50) {
  try {
    return db.prepare('SELECT * FROM api_outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?').all(limit);
  } catch { return []; }
}

/** Публичный сервер принял эти события. */
export function markSent(db, ids, now = Date.now()) {
  const st = db.prepare('UPDATE api_outbox SET sent_at = ?, attempts = attempts + 1, last_error = \'\' WHERE id = ? AND sent_at IS NULL');
  db.transaction(() => { for (const id of ids) st.run(isoOf(now), id); })();
}

/** Попытка не удалась — события остаются в очереди. */
export function markFailed(db, ids, error) {
  const st = db.prepare('UPDATE api_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND sent_at IS NULL');
  db.transaction(() => { for (const id of ids) st.run(String(error || '').slice(0, 120), id); })();
}
