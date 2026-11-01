// SMS_PUSH_V1 — SMS-рассылка пациентам через Play Mobile («Коммерческие
// инструменты» → Push-уведомление → канал SMS).
//
// Отбор — ТЕ ЖЕ фильтры и то же их толкование, что у рассылки в Telegram
// (telegram/broadcast.js normalizeFilters + passingPatientIds): «Приходил с»,
// врач, услуга, пол, возраст, долг. Разница в том, кто вообще в списке: в
// Telegram — подключившиеся к боту, здесь — активные карты с номером
// Узбекистана. Один номер — одно SMS: карты с общим телефоном (мама и дети)
// не получают по сообщению на каждую.
//
// Отправка — вне HTTP-запроса, пачками (Play Mobile принимает массив
// сообщений одним запросом); ход читается из строки sms_broadcasts.

import crypto from 'node:crypto';
import { normalizeFilters, passingPatientIds } from '../telegram/broadcast.js';
import { normalizeUzPhone, sendBatch } from './playmobile.js';

export const BATCH_SIZE = 50;
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

/** [{ patient_id, full_name, phone }] — по одному на номер, активные карты, новые первыми. */
export function resolveSmsAudience(db, filters = {}) {
  const f = normalizeFilters(filters);
  const rows = db.prepare(`SELECT id, full_name, phone FROM patients
                            WHERE COALESCE(active, 1) = 1 AND phone IS NOT NULL AND phone <> ''
                            ORDER BY id DESC`).all();
  const pass = Object.keys(f).length ? passingPatientIds(db, rows.map((r) => Number(r.id)), f) : null;
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (pass && !pass.has(Number(r.id))) continue;
    const phone = normalizeUzPhone(r.phone);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    out.push({ patient_id: Number(r.id), full_name: r.full_name || '', phone });
  }
  return out;
}

// Живой счётчик окна — короткий кэш, как у Telegram (FIX_318_V1 H2): иначе
// каждое изменение фильтра заново проходит всю картотеку.
export const AUDIENCE_CACHE_MS = 10_000;
const cache = new WeakMap();
function cachedAudience(db, filters, now = Date.now()) {
  const key = JSON.stringify(normalizeFilters(filters));
  const hit = cache.get(db);
  if (hit && hit.key === key && now - hit.at < AUDIENCE_CACHE_MS) return hit.audience;
  const audience = resolveSmsAudience(db, filters);
  cache.set(db, { key, at: now, audience });
  return audience;
}

export function previewSmsAudience(db, filters = {}, { cache: useCache = false, sampleSize = 8 } = {}) {
  const audience = useCache ? cachedAudience(db, filters) : resolveSmsAudience(db, filters);
  return { count: audience.length, sample: audience.slice(0, sampleSize).map((a) => ({ name: a.full_name })) };
}

/** SMS по-кириллице — 70 символов в одной части (67 в склейке), латиницей — 160 (153). */
export function smsParts(text) {
  const t = String(text || '');
  if (!t) return 0;
  const unicode = /[^\x00-\x7F]/.test(t);
  const one = unicode ? 70 : 160, multi = unicode ? 67 : 153;
  return t.length <= one ? 1 : Math.ceil(t.length / multi);
}

/**
 * Запускает рассылку и СРАЗУ возвращает { id, audience_count }; отправка идёт
 * в фоне. conn — connectionSettings() с расшифрованным паролем.
 */
export function startSmsBroadcast(db, conn, { text, filters = {}, userId = null, audience }, deps = {}) {
  const bc = db.prepare(`INSERT INTO sms_broadcasts (text, filters, audience_count, created_by)
                         VALUES (?, ?, ?, ?) RETURNING id`)
    .get(text, JSON.stringify(normalizeFilters(filters)), audience.length, userId);
  const add = db.prepare(`INSERT OR IGNORE INTO sms_broadcast_targets (broadcast_id, patient_id, phone, message_id)
                          VALUES (?, ?, ?, ?)`);
  db.transaction(() => {
    for (const a of audience) add.run(bc.id, a.patient_id, a.phone, 'emb' + crypto.randomBytes(8).toString('hex'));
  })();
  runSmsBroadcast(db, conn, bc.id, text, deps).catch((e) => {
    console.warn('[sms] broadcast', bc.id, 'failed:', (e && e.message) || e);
    try { db.prepare(`UPDATE sms_broadcasts SET status = 'failed', finished_at = ${NOW_SQL} WHERE id = ?`).run(bc.id); }
    catch { /* база уже закрыта */ }
  });
  return { id: bc.id, audience_count: audience.length };
}

export async function runSmsBroadcast(db, conn, broadcastId, text, deps = {}) {
  const targets = db.prepare(`SELECT * FROM sms_broadcast_targets WHERE broadcast_id = ? AND status = 'pending' ORDER BY id`).all(broadcastId);
  const mark = db.prepare(`UPDATE sms_broadcast_targets SET status = ?, error = ?, sent_at = CASE WHEN ? = 'sent' THEN ${NOW_SQL} END WHERE id = ?`);
  let sent = 0, failed = 0;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const r = await sendBatch(conn, batch.map((t) => ({ phone: t.phone, text, messageId: t.message_id })), deps);
    const status = r.ok ? 'sent' : 'failed';
    const error = r.ok ? '' : String(r.error || r.reason || '').slice(0, 300);
    db.transaction(() => { for (const t of batch) mark.run(status, error, status, t.id); })();
    if (r.ok) sent += batch.length; else failed += batch.length;
    db.prepare('UPDATE sms_broadcasts SET sent_count = ?, failed_count = ? WHERE id = ?').run(sent, failed, broadcastId);
  }
  db.prepare(`UPDATE sms_broadcasts SET status = 'done', sent_count = ?, failed_count = ?, finished_at = ${NOW_SQL} WHERE id = ?`)
    .run(sent, failed, broadcastId);
  return { sent, failed };
}

export function smsBroadcastStatus(db, id) {
  return db.prepare('SELECT * FROM sms_broadcasts WHERE id = ?').get(Number(id)) || null;
}
