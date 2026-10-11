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
// сначала байты (express.raw, не больше 4 МБ), потом проверка, потом разбор.
import express from 'express';
import { verifyClinicRequest } from '../clinic-auth.js';
import { licenceStanding } from '../licence-gate.js';
import { admitClinic, saveKeys, saveSnapshot, saveSlots } from '../store/clinics.js';
import { missingMedia, putMedia } from '../store/media.js';
import { inboxItems, ackInbox, applyEvents } from '../store/requests.js';
import { accessSince, deliveryLogSince } from '../store/logs.js';
import { sendError } from '../lib/errors.js';

export const SYNC_LIMIT_PER_MIN = 600;
const BODY_LIMIT = '4mb';
const MEDIA_RE = /^([0-9a-f]{64})\.([a-z]{3,4})$/;

/**
 * @param {{db, dataDir:string, now:()=>number, licencePublicKey?:object|null, skewMs?:number, requireHttps?:boolean,
 *   limiter?:{hit:(key:string, limit:number, now:number)=>{ok:boolean, retryAfterSec?:number}}}} ctx
 */
export function syncRouter(ctx) {
  const r = express.Router();
  // Потолок по IP — ДО чтения тела: чужой без подписи не заставит сервер
  // принимать мегабайты в память раз за разом.
  r.use((req, res, next) => {
    if (!ctx.limiter) return next();
    const ip = String(req.ip || '').replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/i, '');
    const hit = ctx.limiter.hit('syncip:' + ip, SYNC_LIMIT_PER_MIN, ctx.now());
    return hit.ok ? next() : sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
  });
  r.use(express.raw({ type: () => true, limit: BODY_LIMIT }));
  r.use((req, res, next) => {
    if (ctx.requireHttps && !req.secure) return sendError(req, res, 'https_required');
    const now = ctx.now();
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const auth = verifyClinicRequest({ method: req.method, url: req.originalUrl, headers: req.headers, body },
      { licencePublicKey: ctx.licencePublicKey || null, now, skewMs: ctx.skewMs });
    if (!auth.ok) return sendError(req, res, auth.code, auth.server_time ? { server_time: auth.server_time } : {});
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

  const parse = (req) => { try { return JSON.parse(req.raw.length ? req.raw.toString('utf8') : '{}'); } catch { return undefined; } };
  const withJson = (fn) => (req, res) => {
    const body = parse(req);
    if (body === undefined) return sendError(req, res, 'bad_json');
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
  r.post('/events', withJson((req, body, now) => ({ payload: applyEvents(ctx.db, req.clinic.clinic_id, body.events, now) })));
  r.get('/inbox', (req, res) => {
    const id = req.clinic.clinic_id;
    const out = { items: inboxItems(ctx.db, id, req.query.after) };
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
