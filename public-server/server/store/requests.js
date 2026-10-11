// PUBLIC_SERVER_V1 — ЗАЯВКИ ПАРТНЁРОВ И ОЧЕРЕДЬ КЛИНИКЕ.
//
// Заявка партнёра — две строки:
//   • requests — статус для GET /requests/{id}: номер, подключение, врач, время,
//     статус, даты. БЕЗ данных пациента. Живёт 90 дней (дизайн §1);
//   • inbox — элемент очереди клинике: данные пациента ЗАПЕЧАТАНЫ ключом-ящиком
//     клиники (sealFor — X25519 + AES-256-GCM, тот же код, что открывает
//     клиника), сервер их открыть не может. Строка стирается ЦЕЛИКОМ, как только
//     клиника подтвердила курсор (решение владельца 16), — так же, как это делает
//     поддельный сервер стенда 8a (server/test-helpers/fake-public-server.js).
//
// Статус ведёт клиника (её события), сервер лишь записывает своё:
//   • приём: «перезвоните» — new, онлайн-запись — pending (решение 19: и когда
//     клиника не на связи; срок держания назначает клиника при приёме и
//     сообщает в подтверждении очереди — held → hold_until);
//   • ответ партнёра: отмена, согласие и отказ на другое время;
//   • ЗАКРЫТИЕ БЕЗ ОТВЕТА (closed) — 8a оставил это серверу:
//       not_processed — клиника забрала онлайн-запись, но за 30 минут не держит
//         время и ничего не ответила (не открылось её ключом — ключ сменили;
//         клиника не смогла принять) — партнёру «позвоните в клинику»;
//       not_collected — клиника не забрала заявку за сутки (решение владельца 20,
//         2026-10-12; настройка PUBLIC_UNCOLLECTED_MAX_HOURS): шифротекст стёрт.
//     Элементы очереди БЕЗ данных пациента (отмена пациентом, ответ на другое
//     время) решение 20 не касается: они ждут клинику 7 суток — столько, сколько
//     партнёры ещё видят молчащую клинику (дальше — 503, routes/partner-auth.js),
//     иначе клиника, выключенная на выходные, не узнала бы об отмене визита.
//     Уведомления об этом нет: подписать его может только клиника (решение 5),
//     партнёр видит статус в GET /requests/{id}. Пришедшее позже событие клиники
//     сильнее закрытия — клиника правда.
import crypto from 'node:crypto';
import { sealFor } from '../../../server/services/api/sync-identity.js';
import { EVENTS, webhookUrlProblem } from '../../../public/js/shared/api-connections.js';
import { isoOf, msOf } from '../lib/time.js';
import { DEFAULT_UNCOLLECTED_MAX_HOURS } from '../config.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
export const ANSWER_TIMEOUT_MS = 30 * 60000;
/** Не забранная заявка с шифротекстом — сутки (решение владельца 20; config.js). */
export const UNCOLLECTED_MAX_MS = DEFAULT_UNCOLLECTED_MAX_HOURS * HOUR;
/** Элемент очереди без данных пациента — 7 суток (не короче срока заявок). */
export const PLAIN_ITEM_MAX_MS = 7 * DAY;
export const REQUEST_KEEP_MS = 90 * DAY;
export const EVENTS_SEEN_KEEP_MS = 30 * DAY;
export const INBOX_PAGE = 100;
export const BODY_MAX = 16384;

/** Статусы для партнёра (дизайн §7 + closed этого сервера). */
export const PARTNER_STATUSES = Object.freeze(['new', 'accepted', 'pending', 'offered', 'booked', 'declined', 'expired',
  'cancelled', 'arrived', 'no_show', 'closed']);
const NEW_TYPES = Object.freeze(['request.new', 'appointment.new']);

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Номер заявки: rq_ + 24 знака латиницы и цифр (клиника ждёт ^rq_[A-Za-z0-9]{6,37}$). */
export function newRequestId() {
  let s = 'rq_';
  for (let i = 0; i < 24; i += 1) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

export const requestRow = (db, clinicId, id) => db.prepare('SELECT * FROM requests WHERE id = ? AND clinic_id = ?').get(String(id), clinicId) || null;
/** Заявка подключения по номеру партнёра (повтор отправки); нет — null. */
export const requestByExternal = (db, clinicId, connectionId, externalId) =>
  db.prepare('SELECT * FROM requests WHERE clinic_id = ? AND connection_id = ? AND external_id = ?').get(clinicId, connectionId, externalId) || null;

function enqueue(db, { clinicId, type, requestId, connectionId, now, data = {}, sealed = null }) {
  db.prepare('INSERT INTO inbox (clinic_id, type, request_id, connection_id, received_at, data, sealed) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(clinicId, type, requestId, connectionId, isoOf(now), JSON.stringify(data), sealed);
}

/**
 * Приём заявки партнёра. Данные пациента запечатываются здесь и открытыми не
 * хранятся нигде. Повтор с тем же external_id того же подключения — та же заявка.
 * @param {{clinic:object, connectionId:number, kind:'request'|'appointment', externalId?:string, lang?:string,
 *   doctorId?:number, branchId?:number, serviceId?:number, packageId?:number, consultation?:string,
 *   startAt?:string, durationMin?:number, patient:{name:string, phone:string, comment:string}, now:number}} a
 * @returns {{created:boolean, row:object} | {error:'clinic_offline'}}
 */
export function createRequest(db, a) {
  const clinicId = a.clinic.clinic_id;
  if (a.externalId) {
    const existing = requestByExternal(db, clinicId, a.connectionId, a.externalId);
    if (existing) return { created: false, row: existing };
  }
  if (!a.clinic.box_key) return { error: 'clinic_offline' };
  const id = newRequestId();
  const at = isoOf(a.now);
  const sealed = sealFor(a.clinic.box_key, { name: a.patient.name, phone: a.patient.phone, comment: a.patient.comment || '' });
  const appt = a.kind === 'appointment';
  const data = {
    external_id: a.externalId || '', lang: a.lang || '', doctor_id: a.doctorId || null, branch_id: a.branchId || null,
    service_id: a.serviceId || null, package_id: a.packageId || null,
    ...(appt ? { consultation: a.consultation || '', start: a.startAt } : {}),
  };
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO requests (id, clinic_id, connection_id, kind, external_id, doctor_id, branch_id, service_id, package_id,
                    consultation, start_at, duration_min, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, clinicId, a.connectionId, a.kind, a.externalId || null, a.doctorId || null, a.branchId || null, a.serviceId || null,
          a.packageId || null, appt ? (a.consultation || null) : null, appt ? a.startAt : null, appt ? a.durationMin : null,
          appt ? 'pending' : 'new', at, at);
      enqueue(db, { clinicId, type: appt ? 'appointment.new' : 'request.new', requestId: id, connectionId: a.connectionId, now: a.now, data, sealed });
    })();
  } catch (e) {
    // Два одинаковых запроса партнёра в одну миллисекунду: второй получает первую заявку.
    if (a.externalId && String(e && e.code).startsWith('SQLITE_CONSTRAINT')) {
      const existing = requestByExternal(db, clinicId, a.connectionId, a.externalId);
      if (existing) return { created: false, row: existing };
    }
    throw e;
  }
  return { created: true, row: requestRow(db, clinicId, id) };
}

/**
 * Время врача занято своей очередью: онлайн-запись ждёт клинику (pending, срок
 * держания не вышел или ещё не назначен) или встречное предложение ждёт
 * партнёра. Первая линия против двух партнёров на одно время в пределах такта;
 * правду скажет клиника при приёме (slot_taken).
 */
export function queueOverlaps(db, clinicId, doctorId, startMs, durationMin, now) {
  const end = startMs + durationMin * 60000;
  const rows = db.prepare(`SELECT status, start_at, duration_min, hold_until, offered_start, offer_until FROM requests
                           WHERE clinic_id = ? AND doctor_id = ? AND kind = 'appointment' AND status IN ('pending', 'offered')`).all(clinicId, doctorId);
  return rows.some((r) => {
    const live = r.status === 'pending' ? (r.hold_until == null || msOf(r.hold_until) > now) : msOf(r.offer_until) > now;
    const s = msOf(r.status === 'pending' ? r.start_at : r.offered_start);
    const d = (Number(r.duration_min) || 15) * 60000;
    return live && s != null && s < end && startMs < s + d;
  });
}

const touch = (db, id, fields, now) => {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE requests SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => fields[c]), isoOf(now), id);
};

/**
 * DELETE /appointments/{id} — пациент отменил у партнёра. Ждущая или с
 * предложением — сразу «cancelled» (клиника освободит время без события);
 * записанная — остаётся «booked», пока клиника не отменит визит (событие
 * appointment.cancelled) или не решит вручную (визит уже в работе).
 * @returns {{row:object} | {error:'not_cancellable'}}
 */
export function partnerCancel(db, row, now) {
  if (row.status === 'cancelled' || (row.status === 'booked' && row.cancel_requested_at)) return { row };
  if (!['pending', 'offered', 'booked'].includes(row.status)) return { error: 'not_cancellable' };
  db.transaction(() => {
    const fields = { cancel_requested_at: isoOf(now) };
    if (row.status !== 'booked') Object.assign(fields, { status: 'cancelled', hold_until: null, offered_start: null, offer_until: null });
    touch(db, row.id, fields, now);
    enqueue(db, { clinicId: row.clinic_id, type: 'appointment.cancel', requestId: row.id, connectionId: row.connection_id, now });
  })();
  return { row: requestRow(db, row.clinic_id, row.id) };
}

/**
 * POST /appointments/{id}/accept|decline — ответ партнёра на «другое время».
 * Согласие — снова pending на предложенном времени (срок держания назначит
 * клиника при приёме ответа и сообщит в held); отказ — cancelled.
 * @returns {{row:object} | {error:'not_offered'|'offer_expired'}}
 */
export function partnerAnswerOffer(db, row, accept, now) {
  if (row.status !== 'offered') return { error: 'not_offered' };
  if (accept && !(msOf(row.offer_until) > now)) return { error: 'offer_expired' };
  db.transaction(() => {
    if (accept) {
      touch(db, row.id, { status: 'pending', start_at: row.offered_start, offered_start: null, offer_until: null, hold_until: null,
        delivered_at: null, answered_at: null }, now);
    } else {
      touch(db, row.id, { status: 'cancelled', offered_start: null, offer_until: null, hold_until: null }, now);
    }
    enqueue(db, { clinicId: row.clinic_id, type: accept ? 'offer.accept' : 'offer.decline', requestId: row.id, connectionId: row.connection_id, now });
  })();
  return { row: requestRow(db, row.clinic_id, row.id) };
}

/** GET /_sync/v1/inbox — элементы после курсора, по порядку, как их ждёт parseInboxItem клиники. */
export function inboxItems(db, clinicId, after, limit = INBOX_PAGE) {
  return db.prepare('SELECT * FROM inbox WHERE clinic_id = ? AND cursor > ? ORDER BY cursor LIMIT ?')
    .all(clinicId, Number(after) || 0, Math.min(limit, INBOX_PAGE))
    .map((r) => {
      let data = {};
      try { data = JSON.parse(r.data); } catch { data = {}; }
      return {
        cursor: String(r.cursor), type: r.type, public_id: r.request_id, connection_id: r.connection_id, received_at: r.received_at, data,
        ...(r.sealed ? { sealed: r.sealed } : {}),
      };
    });
}

/**
 * POST /_sync/v1/inbox/ack {cursor, held} — клиника применила всё до курсора.
 * Элементы до курсора стираются ЦЕЛИКОМ вместе с шифротекстом (решение 16);
 * held — заявки, которые клиника держит, и до какого мгновения (решения 18–19).
 * @returns {{ok:true, deleted:number} | {error:'bad_request'}}
 */
export function ackInbox(db, clinicId, cursor, held, now) {
  const c = Number(cursor);
  if (!Number.isInteger(c) || c < 0) return { error: 'bad_request' };
  const at = isoOf(now);
  let deleted = 0;
  db.transaction(() => {
    const delivered = db.prepare(`SELECT request_id FROM inbox WHERE clinic_id = ? AND cursor <= ? AND type IN ('request.new', 'appointment.new', 'offer.accept')`)
      .all(clinicId, c);
    const mark = db.prepare(`UPDATE requests SET delivered_at = COALESCE(delivered_at, ?),
                               answered_at = CASE WHEN kind = 'request' THEN COALESCE(answered_at, ?) ELSE answered_at END
                             WHERE id = ? AND clinic_id = ?`);
    for (const r of delivered) mark.run(at, at, r.request_id, clinicId);
    const hold = db.prepare(`UPDATE requests SET hold_until = ?, answered_at = COALESCE(answered_at, ?), updated_at = ?
                             WHERE id = ? AND clinic_id = ? AND status = 'pending'`);
    for (const h of Array.isArray(held) ? held.slice(0, 1000) : []) {
      const until = msOf(h && h.hold_until);
      if (until != null && h && typeof h.request_id === 'string') hold.run(isoOf(until), at, at, h.request_id, clinicId);
    }
    deleted = db.prepare('DELETE FROM inbox WHERE clinic_id = ? AND cursor <= ?').run(clinicId, c).changes;
  })();
  return { ok: true, deleted };
}

/** Статус заявки по событию клиники (тело — белый список webhookBody клиники). */
function applyStatus(db, clinicId, body, now) {
  const row = typeof body.request_id === 'string' ? requestRow(db, clinicId, body.request_id) : null;
  if (!row || !PARTNER_STATUSES.includes(body.status)) return row;
  const at = isoOf(now);
  // Партнёр уже отменил, а клиника, не дойдя до отмены в очереди, отпустила время
  // («истекло» / отказ): для партнёра заявка остаётся отменённой.
  if (row.cancel_requested_at && row.status === 'cancelled' && ['declined', 'expired'].includes(body.status)) {
    touch(db, row.id, { answered_at: row.answered_at || at }, now);
    return row;
  }
  const iso = (v) => { const t = msOf(v); return t == null ? null : isoOf(t); };
  const fields = { status: body.status, answered_at: row.answered_at || at,
    reason: ['declined', 'expired'].includes(body.status) ? String(body.reason || '').slice(0, 32) || null : null };
  if (body.start) fields.start_at = iso(body.start) || row.start_at;
  if (Number.isInteger(body.doctor_id) && body.doctor_id > 0) fields.doctor_id = body.doctor_id;
  if (Number.isInteger(body.branch_id) && body.branch_id > 0) fields.branch_id = body.branch_id;
  if (body.status === 'offered') Object.assign(fields, { offered_start: iso(body.offered_start), offer_until: iso(body.offer_until), hold_until: null });
  else Object.assign(fields, { offered_start: null, offer_until: null });
  if (body.status !== 'pending' && body.status !== 'offered') fields.hold_until = null;
  touch(db, row.id, fields, now);
  return requestRow(db, clinicId, row.id);
}

const SIGNATURE_RE = /^sha256=[0-9a-f]{64}$/;

/**
 * POST /_sync/v1/events — события клиники по порядку. Принимается КАЖДОЕ
 * событие с номером, даже испорченное: клиника шлёт события строго по порядку и
 * повторяет непринятое каждый такт, так что одно отвергнутое навсегда
 * остановило бы все следующие (public-sync.js pushEvents).
 * Есть адрес и подпись клиники — уведомление встаёт в очередь доставки.
 *
 * Повтор — тот же seq С ТЕМ ЖЕ содержимым (клиника повторяет непринятое байт в
 * байт). Тот же seq с другим содержимым — новое событие: клиника восстановила
 * свою базу из копии, и номера api_outbox пошли заново (ревью 8b, C2); иначе
 * подтверждения, отказы и отмены после восстановления пропадали бы молча.
 * @returns {{accepted:number[]}}
 */
export function applyEvents(db, clinicId, events, now) {
  const accepted = [];
  const at = isoOf(now);
  const seen = db.prepare('SELECT identity FROM events_seen WHERE clinic_id = ? AND seq = ?');
  for (const e of Array.isArray(events) ? events.slice(0, 500) : []) {
    const seq = Number(e && e.seq);
    if (!Number.isInteger(seq) || seq <= 0) continue;
    const identity = crypto.createHash('sha256').update(String(e.event == null ? '' : e.event) + '\n' + (typeof e.body === 'string' ? e.body : ''))
      .digest('hex');
    const prev = seen.get(clinicId, seq);
    if (prev && prev.identity === identity) { accepted.push(seq); continue; }
    db.transaction(() => {
      db.prepare('INSERT OR REPLACE INTO events_seen (clinic_id, seq, identity, received_at) VALUES (?, ?, ?, ?)').run(clinicId, seq, identity, at);
      const raw = typeof e.body === 'string' && e.body.length <= BODY_MAX ? e.body : '';
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      if (!body || typeof body !== 'object' || !EVENTS.includes(e.event) || body.event !== e.event) return;
      const row = applyStatus(db, clinicId, body, now);
      const url = String(e.webhook_url || '');
      const signature = String(e.signature || '');
      if (!url || !SIGNATURE_RE.test(signature) || webhookUrlProblem(url)) return;
      db.prepare(`INSERT INTO deliveries (clinic_id, connection_id, request_id, event_id, event, url, body, signature, next_at, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(clinicId, row ? row.connection_id : null, String(body.request_id || '') || null, String(body.event_id || '').slice(0, 64), e.event,
          url, raw, signature, at, at, at);
    })();
    accepted.push(seq);
  }
  return { accepted };
}

/**
 * Фон: закрыть то, на что клиника не ответит. → {not_processed, not_collected}
 * uncollectedMaxMs — срок не забранной заявки с шифротекстом (config.js
 * uncollectedMaxMs, PUBLIC_UNCOLLECTED_MAX_HOURS); элементы без данных пациента
 * ждут PLAIN_ITEM_MAX_MS, но не меньше этого срока.
 */
export function closeOverdue(db, now, { uncollectedMaxMs = UNCOLLECTED_MAX_MS } = {}) {
  const at = isoOf(now);
  const sealedBefore = isoOf(now - uncollectedMaxMs);
  const plainBefore = isoOf(now - Math.max(PLAIN_ITEM_MAX_MS, uncollectedMaxMs));
  let notProcessed = 0;
  let notCollected = 0;
  db.transaction(() => {
    notProcessed = db.prepare(`UPDATE requests SET status = 'closed', reason = 'not_processed', updated_at = ?
                               WHERE kind = 'appointment' AND status = 'pending' AND delivered_at IS NOT NULL AND answered_at IS NULL
                                 AND hold_until IS NULL AND delivered_at <= ?`).run(at, isoOf(now - ANSWER_TIMEOUT_MS)).changes;
    // plainBefore не позже sealedBefore (срок без данных — не короче), поэтому
    // кандидаты — всё, что старше sealedBefore.
    const old = db.prepare('SELECT cursor, clinic_id, type, request_id, received_at FROM inbox WHERE received_at <= ?').all(sealedBefore);
    const close = db.prepare(`UPDATE requests SET status = 'closed', reason = 'not_collected', updated_at = ?
                              WHERE id = ? AND clinic_id = ? AND status IN ('new', 'pending')`);
    const del = db.prepare('DELETE FROM inbox WHERE cursor = ?');
    for (const it of old) {
      if (NEW_TYPES.includes(it.type)) {
        if (it.received_at > sealedBefore) continue;
        notCollected += close.run(at, it.request_id, it.clinic_id).changes;
      } else if (it.received_at > plainBefore) continue;
      del.run(it.cursor);
    }
  })();
  return { not_processed: notProcessed, not_collected: notCollected };
}

/** Фон: статусы старше 90 дней и номера событий старше 30 дней. */
export function purgeRequests(db, now) {
  return {
    requests: db.prepare('DELETE FROM requests WHERE updated_at < ?').run(isoOf(now - REQUEST_KEEP_MS)).changes,
    events: db.prepare('DELETE FROM events_seen WHERE received_at < ?').run(isoOf(now - EVENTS_SEEN_KEEP_MS)).changes,
  };
}
