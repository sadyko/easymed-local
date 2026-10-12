// PUBLIC_SERVER_V1 — КАНАЛ КЛИНИКИ /_sync/v1/* (дизайн шага 8, §10).
//
// Ровно тот протокол, на котором сторона клиники (services/api/public-sync.js)
// прогнана против поддельного сервера (server/test-helpers/fake-public-server.js):
//   PUT  /keys           {generated_at, box_key, connections:[…]}        → {ok}
//   POST /media/check    {hashes:[sha256…]}                              → {missing:[…]}
//   PUT  /media/<sha256>.<ext>  байты файла                              → {ok}
//   PUT  /snapshot       {version, generated_at, slug, clinic, …}        → {ok} | 409 slug_taken
//   PUT  /slots          {generated_at, slot_minutes, doctors:{…}}       → {ok}
//   POST /events         {events:[{seq, event, status, body, webhook_url, signature}]} → {accepted:[seq…]}
//   GET  /inbox?after=<курсор>                                           → {items:[…], last_used:{…}}
//   POST /inbox/ack      {cursor, held:[{request_id, hold_until}]}       → {ok}
// Ответы-отказы: 401 (подпись, ключ, лицензия, часы), 503 licence_lapsed
// (срок лицензии вышел), 409 slug_taken, 429 (с Retry-After).
//
// Сверх протокола 8a — для экранов журнала 8d (клиника 8a их не просит, и
// ничего лишнего ей не уходит): GET /inbox?…&access_after=<id> добавляет
// access (журнал запросов с ключом), &deliveries_after=<id> — deliveries
// (попытки доставки уведомлений); last_used — «последний запрос» подключений.
//
// ТЕЛО ЧИТАЕТСЯ СЫРЫМ: подпись клиники — от sha256 точных байтов тела, поэтому
// сначала байты (express.raw), потом подпись, потом разбор.
//
// ПОРЯДОК (ревью 8b, C1): потолок по IP → https → заголовки без тела (лицензия
// производителя, отпечаток ключа, часы — clinic-auth.js verifyClinicHeaders;
// устаревшая и истёкшая лицензия — store/clinics.js admissionOf, без записи) →
// тело → подпись → запись клиники. Сжатое тело не распаковывается (415):
// клиника 8a не сжимает, а распаковка до проверки делала из 4 КБ gzip 4 МБ в
// памяти. Предел тела — свой у адреса: снимку и времени — 4 МБ (проверка
// исправлений 8b, C: 200 врачей по записи × 30 дней — ~3 МБ времени), файлу —
// 2 МБ, остальному — 1 МБ. Любое тело JSON — не больше PARSE_CONTAINERS_MAX
// объектов и списков (store/clinics.js parseBounded, проверка исправлений 8b, E).
import express from 'express';
import { verifyClinicHeaders, verifyClinicSignature } from '../clinic-auth.js';
import { licenceStanding } from '../licence-gate.js';
import { admitClinic, admissionOf, saveKeys, saveSnapshot, saveSlots, parseBounded } from '../store/clinics.js';
import { missingMedia, putMedia, MEDIA_MAX_BYTES } from '../store/media.js';
import { inboxItems, ackInbox, applyEvents } from '../store/requests.js';
import { accessSince, deliveryLogSince } from '../store/logs.js';
import { feedRevokedSyncKey } from '../store/feed.js';
import { sendError } from '../lib/errors.js';

export const SYNC_LIMIT_PER_MIN = 600;
const MEDIA_RE = /^([0-9a-f]{64})\.([a-z]{3,4})$/;
const raw = (limit) => express.raw({ type: () => true, limit, inflate: false });
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const BODY = { big: raw(SNAPSHOT_MAX_BYTES), media: raw(MEDIA_MAX_BYTES), small: raw('1mb') };
const bodyFor = (p) => (/^\/(?:snapshot|slots)\/?$/.test(p) ? BODY.big : /^\/media\/[^/]+$/.test(p) ? BODY.media : BODY.small);

/**
 * @param {{db, dataDir:string, now:()=>number, licencePublicKey?:object|null, skewMs?:number, requireHttps?:boolean,
 *   limiter?:{hit:(key:string, limit:number, now:number)=>{ok:boolean, retryAfterSec?:number}}}} ctx
 */
export function syncRouter(ctx) {
  const r = express.Router();
  // Пропущенные уведомления (очередь клиники полна — ревью 8b, C8): только счётчик для /_metrics.
  if (!ctx.counters) ctx.counters = { queue_full: 0 };
  // Потолок по IP — ДО чтения тела: чужой без подписи не заставит сервер
  // принимать мегабайты в память раз за разом.
  r.use((req, res, next) => {
    if (!ctx.limiter) return next();
    const ip = String(req.ip || '').replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/i, '');
    const hit = ctx.limiter.hit('syncip:' + ip, SYNC_LIMIT_PER_MIN, ctx.now());
    return hit.ok ? next() : sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
  });
  r.use((req, res, next) => {
    if (ctx.requireHttps && !req.secure) return sendError(req, res, 'https_required');
    const now = ctx.now();
    const auth = verifyClinicHeaders({ headers: req.headers }, { licencePublicKey: ctx.licencePublicKey || null, now, skewMs: ctx.skewMs });
    if (!auth.ok) return sendError(req, res, auth.code, auth.server_time ? { server_time: auth.server_time } : {});
    // PUBLIC_LICENCE_V1 — ключ обмена отозван в панели производителя (ПК украден):
    // лицензия с его отпечатком ещё жива, но говорить за клинику он больше не может.
    if (feedRevokedSyncKey(ctx.feed, auth.fingerprint)) return sendError(req, res, 'invalid_signature');
    const pre = admissionOf(ctx.db, auth);
    if (!pre.ok) return sendError(req, res, pre.code);
    if (licenceStanding(pre.licence, now) === 'lapsed') return sendError(req, res, 'licence_lapsed');
    req.clinicAuth = auth;
    return next();
  });
  r.use((req, res, next) => bodyFor(req.path)(req, res, next));
  r.use((req, res, next) => {
    const now = ctx.now();
    const auth = req.clinicAuth;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyClinicSignature({ method: req.method, url: req.originalUrl, headers: req.headers, body })) return sendError(req, res, 'invalid_signature');
    const adm = admitClinic(ctx.db, auth, now);
    if (!adm.ok) return sendError(req, res, adm.code);
    if (licenceStanding(adm.clinic, now) === 'lapsed') return sendError(req, res, 'licence_lapsed');
    if (ctx.limiter) {
      const hit = ctx.limiter.hit('sync:' + auth.clinicId, SYNC_LIMIT_PER_MIN, now);
      if (!hit.ok) return sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
    }
    req.clinic = adm.clinic;
    req.raw = body;
    return next();
  });

  const withJson = (fn) => (req, res) => {
    const parsed = parseBounded(req.raw.toString('utf8'));
    if (parsed.error) return sendError(req, res, parsed.error);
    const body = parsed.value;
    const out = fn(req, body, ctx.now());
    if (out && out.error) return sendError(req, res, out.error);
    return res.json(out && out.payload ? out.payload : { ok: true });
  };

  r.put('/keys', withJson((req, body, now) => saveKeys(ctx.db, req.clinic.clinic_id, body, now)));
  r.put('/snapshot', withJson((req, body, now) => saveSnapshot(ctx.db, req.clinic.clinic_id, body, now)));
  r.put('/slots', withJson((req, body, now) => saveSlots(ctx.db, req.clinic.clinic_id, body, now)));
  r.post('/media/check', withJson((req, body) => ({ payload: { missing: missingMedia(ctx.db, req.clinic.clinic_id, body.hashes) } })));
  r.put('/media/:file', (req, res) => {
    const m = MEDIA_RE.exec(String(req.params.file || ''));
    if (!m) return sendError(req, res, 'bad_request');
    const out = putMedia(ctx.db, ctx.dataDir, req.clinic.clinic_id, m[1], m[2], req.raw, ctx.now());
    return out.error ? sendError(req, res, out.error) : res.json({ ok: true });
  });
  r.post('/events', withJson((req, body, now) => {
    const out = applyEvents(ctx.db, req.clinic.clinic_id, body.events, now);
    if (out.queue_full) ctx.counters.queue_full = (ctx.counters.queue_full || 0) + out.queue_full;
    return { payload: { accepted: out.accepted } };   // ответ протокола — как у поддельного сервера 8a
  }));
  r.get('/inbox', (req, res) => {
    const id = req.clinic.clinic_id;
    const out = { items: inboxItems(ctx.db, id, req.query.after, { now: ctx.now() }) };
    out.last_used = Object.fromEntries(ctx.db.prepare('SELECT id, last_used_at FROM connections WHERE clinic_id = ? AND last_used_at IS NOT NULL')
      .all(id).map((c) => [String(c.id), c.last_used_at]));
    if (req.query.access_after !== undefined) out.access = accessSince(ctx.db, id, req.query.access_after);
    if (req.query.deliveries_after !== undefined) out.deliveries = deliveryLogSince(ctx.db, id, req.query.deliveries_after);
    return res.json(out);
  });
  r.post('/inbox/ack', withJson((req, body, now) => ackInbox(ctx.db, req.clinic.clinic_id, body.cursor, body.held, now)));
  r.use((req, res) => sendError(req, res, 'not_found'));
  return r;
}
