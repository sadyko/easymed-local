// CALL_RING_V1 (2026-10-17) — ПРИЁМ ВЕБХУКА СТАНЦИИ: POST /_pbx/v1/{clinic}/{token}.
//
// Станция (onlinePBX: Сервисы → Интеграция → Webhooks) шлёт сюда «начало /
// ответ / конец звонка» клиники, потому что сама клиника за NAT. Адрес с
// секретом администратор клиники берёт с экрана «Телефония» (rpc/ring.js);
// секрет сюда приезжает хешем в теле ключей клиники (store/clinics.js saveKeys).
//
// ВОРОТА. Секрет сверяется без утечки по времени; чужой секрет, неизвестная
// клиника, чужой метод — один и тот же 404, что у всех неизвестных адресов:
// снаружи не видно, что здесь живёт приёмник. Потолок по IP — до чтения тела.
// Тело — JSON или form-urlencoded, не больше 16 КБ: одно событие, не набор данных.
//
// ЧТО ХРАНИТСЯ. Только номера, событие, направление, время — на десять минут
// (store/pbx-events.js). Непонятное событие — 200 (станция не должна
// повторять его 7 раз) и строка 'unknown' с именами полей для разбора схемы.
import express from 'express';
import { sendError } from '../lib/errors.js';
import { normalizePbxEvent } from '../../../server/services/telephony/pbx-event.js';
import { clinicByRingToken, insertPbxEvent } from '../store/pbx-events.js';
import { isoOf } from '../lib/time.js';

export const PBX_LIMIT_PER_MIN = 120;
const LIMIT = '16kb';

export function pbxRouter(ctx) {
  const r = express.Router();
  r.use((req, res, next) => {
    if (ctx.requireHttps && !req.secure) return sendError(req, res, 'https_required');
    if (!ctx.limiter) return next();
    const ip = String(req.ip || '').replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/i, '');
    const hit = ctx.limiter.hit('pbx:' + ip, PBX_LIMIT_PER_MIN, ctx.now());
    return hit.ok ? next() : sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
  });
  r.use(express.json({ limit: LIMIT, type: ['application/json', 'application/*+json', 'text/plain'] }));
  r.use(express.urlencoded({ extended: true, limit: LIMIT }));

  r.post('/:clinic/:token', (req, res) => {
    const clinic = clinicByRingToken(ctx.db, req.params.clinic, req.params.token);
    if (!clinic) return sendError(req, res, 'not_found');
    const now = ctx.now();
    const ev = normalizePbxEvent(req.body, { now });
    if (!ev) return sendError(req, res, 'bad_request');
    if (ev.unknown) {
      insertPbxEvent(ctx.db, clinic.clinic_id, { uuid: 'unknown:' + isoOf(now), event: 'unknown', direction: '', caller: '', callee: '', at: isoOf(now) }, now, ev.keys);
      return res.json({ ok: true, ignored: true });
    }
    insertPbxEvent(ctx.db, clinic.clinic_id, ev, now);
    return res.json({ ok: true });
  });

  r.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
    return sendError(req, res, err && (err.status === 413 || err.type === 'entity.too.large') ? 'too_large' : 'bad_request');
  });
  r.use((req, res) => sendError(req, res, 'not_found'));
  return r;
}
