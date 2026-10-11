// PUBLIC_SERVER_V1 — ДОСТАВКА УВЕДОМЛЕНИЙ ПАРТНЁРАМ (дизайн §8).
//
// Строку deliveries кладёт приём событий клиники (store/requests.js
// applyEvents): адрес, готовое тело и подпись клиники. Здесь — попытки:
//   • 2xx — доставлено;
//   • иначе повтор через 1, 5, 10, 30 и 60 минут (макет: «Повторяем 5 раз»),
//     после шестой неудачной попытки — «не доставлено»;
//   • негодный адрес — сразу «не доставлено» (лучше он не станет);
//   • тело уведомления стирается, как только доставка кончилась: хранить его
//     дальше незачем (в нём нет данных пациента, но и пользы нет).
// Каждая попытка — строка журнала доставок для клиники (8d: вкладка «Уведомления»).
import { appendDeliveryLog } from './logs.js';
import { checkWebhookUrl } from '../lib/webhook-send.js';
import { isoOf } from '../lib/time.js';

export const RETRY_MINUTES = Object.freeze([1, 5, 10, 30, 60]);
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
export const DELIVERY_KEEP_MS = 30 * 86400000;

function record(db, d, r, now, out) {
  const attempt = d.attempts + 1;
  const ok = r.status >= 200 && r.status < 300;
  const final = ok ? 'delivered' : attempt >= MAX_ATTEMPTS || r.error === 'bad_url' ? 'failed' : null;
  const nextAt = final ? null : isoOf(now + RETRY_MINUTES[attempt - 1] * 60000);
  const at = isoOf(now);
  db.transaction(() => {
    db.prepare(`UPDATE deliveries SET attempts = ?, state = ?, next_at = ?, last_code = ?, last_error = ?, updated_at = ?,
                  body = CASE WHEN ? = 1 THEN NULL ELSE body END WHERE id = ?`)
      .run(attempt, final || 'pending', nextAt, r.status || null, r.error || null, at, final ? 1 : 0, d.id);
    appendDeliveryLog(db, { clinicId: d.clinic_id, deliveryId: d.id, connectionId: d.connection_id, requestId: d.request_id, eventId: d.event_id,
      event: d.event, attempt, code: r.status || null, error: r.error || null, at, nextAt, final });
  })();
  out.attempts += 1;
  if (final === 'delivered') out.delivered += 1;
  else if (final === 'failed') out.failed += 1;
  else out.retrying += 1;
}

/**
 * Одна волна доставки: подошедшие по времени, не больше limit, по parallel
 * одновременно. send({url, headers, body}) → {status, error?} (lib/webhook-send.js
 * makeSender в работе; в тестах — подделка).
 * @returns {Promise<{attempts:number, delivered:number, failed:number, retrying:number}>}
 */
export async function deliverDue(db, { now = Date.now(), send, limit = 20, parallel = 4 } = {}) {
  const due = db.prepare("SELECT * FROM deliveries WHERE state = 'pending' AND next_at <= ? ORDER BY next_at, id LIMIT ?").all(isoOf(now), limit);
  const out = { attempts: 0, delivered: 0, failed: 0, retrying: 0 };
  const one = async (d) => {
    if (checkWebhookUrl(d.url)) return { status: 0, error: 'bad_url' };
    try {
      return await send({ url: d.url, body: d.body || '', headers: {
        'Content-Type': 'application/json', 'X-EasyMed-Signature': d.signature, 'X-EasyMed-Event': d.event, 'X-EasyMed-Event-Id': d.event_id,
      } });
    } catch { return { status: 0, error: 'send_failed' }; }
  };
  for (let i = 0; i < due.length; i += parallel) {
    const batch = due.slice(i, i + parallel);
    const results = await Promise.all(batch.map(one));
    batch.forEach((d, k) => record(db, d, results[k] || { status: 0, error: 'send_failed' }, now, out));
  }
  return out;
}

/** Уборка: законченные доставки старше 30 дней. */
export function purgeDeliveries(db, now) {
  return db.prepare("DELETE FROM deliveries WHERE state <> 'pending' AND updated_at < ?").run(isoOf(now - DELIVERY_KEEP_MS)).changes;
}
