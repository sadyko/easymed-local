// CALL_RING_V1 (2026-10-17) — ПРИЁМ ВЕБХУКА СТАНЦИИ: POST /_pbx/v1/{clinic}/{token}.
//
// Станция (onlinePBX: Сервисы → Интеграция → Webhooks) шлёт сюда «начало /
// ответ / конец звонка» клиники, потому что сама клиника за NAT. Адрес с
// секретом администратор клиники берёт с экрана «Телефония» (rpc/ring.js);
// секрет сюда приезжает хешем в теле ключей клиники (store/clinics.js saveKeys).
//
// ВОРОТА. Секрет сверяется без утечки по времени; чужой секрет, неизвестная
// клиника, чужой метод — один и тот же 404, что у всех неизвестных адресов:
// снаружи не видно, что здесь живёт приёмник. Секрет проверяется до чтения
// тела. Тело — JSON или form-urlencoded, не больше 16 КБ: одно событие, не
// набор данных.
//
// ПОТОЛКИ (FIX_318_V1, C1). onlinePBX шлёт вебхуки ВСЕХ клиник с одних и тех
// же адресов, поэтому общий потолок по IP отдавал клинике B 429 из-за звонков
// клиники A. Теперь по IP (PBX_LIMIT_PER_MIN) считаются только неверный секрет,
// неизвестная клиника и чужие адреса и методы — перебор секретов и мусор; а
// верный секрет считается ПОТОЛКОМ СВОЕЙ КЛИНИКИ (PBX_CLINIC_LIMIT_PER_MIN),
// уже после clinicByRingToken. Станция с устаревшим секретом одной клиники
// (адрес сменили, а в кабинете станции — прежний) забивает только счётчик
// неверных — верные секреты остальных клиник он не задевает.
//
// ЧТО ХРАНИТСЯ. Только номера, событие, направление, время — на десять минут
// (store/pbx-events.js). Непонятное событие — 200 (станция не должна
// повторять его 7 раз) и строка 'unknown' с именами полей и — FIX_318_V1 (C6)
// — именем события ('event=<имя>') для разбора схемы. Имена событий onlinePBX
// не сверены с настоящей станцией: см. шапку server/services/telephony/pbx-event.js.
import express from 'express';
import { sendError } from '../lib/errors.js';
import { normalizePbxEvent } from '../../../server/services/telephony/pbx-event.js';
import { clinicByRingToken, insertPbxEvent } from '../store/pbx-events.js';
import { isoOf } from '../lib/time.js';

/** Неверный секрет, неизвестная клиника, чужой адрес — с одного IP в минуту. */
export const PBX_LIMIT_PER_MIN = 120;
/** Верный секрет — событий одной клиники в минуту (звонок — 3 события, у группы трубок — больше). */
export const PBX_CLINIC_LIMIT_PER_MIN = 300;
const LIMIT = '16kb';

const ipOf = (req) => String(req.ip || '').replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/i, '');

export function pbxRouter(ctx) {
  const r = express.Router();
  // Отказ по потолку или null — пускать дальше.
  const limited = (req, res, key, limit) => {
    if (!ctx.limiter) return null;
    const hit = ctx.limiter.hit(key, limit, ctx.now());
    return hit.ok ? null : sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
  };
  const notFound = (req, res) => limited(req, res, 'pbx:' + ipOf(req), PBX_LIMIT_PER_MIN) || sendError(req, res, 'not_found');

  r.use((req, res, next) => {
    if (ctx.requireHttps && !req.secure) return sendError(req, res, 'https_required');
    return next();
  });
  // Секрет — до тела: чужой не заставит сервер разбирать тело.
  const gate = (req, res, next) => {
    const clinic = clinicByRingToken(ctx.db, req.params.clinic, req.params.token);
    if (!clinic) return notFound(req, res);
    const over = limited(req, res, 'pbxc:' + clinic.clinic_id, PBX_CLINIC_LIMIT_PER_MIN);
    if (over) return over;
    req.pbxClinic = clinic;
    return next();
  };
  const json = express.json({ limit: LIMIT, type: ['application/json', 'application/*+json', 'text/plain'] });
  const form = express.urlencoded({ extended: true, limit: LIMIT });

  r.post('/:clinic/:token', gate, json, form, (req, res) => {
    const clinic = req.pbxClinic;
    const now = ctx.now();
    const ev = normalizePbxEvent(req.body, { now });
    if (!ev) return sendError(req, res, 'bad_request');
    if (ev.unknown) {
      // FIX_318_V1 (C6) — и имя события (pbx-event.js unknownName: без номеров): по нему
      // имена событий onlinePBX сверяются с настоящей станцией. Клинике не выдаётся.
      const keys = ev.name ? [...ev.keys.slice(0, 39), 'event=' + ev.name] : ev.keys;
      insertPbxEvent(ctx.db, clinic.clinic_id, { uuid: 'unknown:' + isoOf(now), event: 'unknown', direction: '', caller: '', callee: '', at: isoOf(now) }, now, keys);
      return res.json({ ok: true, ignored: true });
    }
    insertPbxEvent(ctx.db, clinic.clinic_id, ev, now);
    return res.json({ ok: true });
  });

  r.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
    return sendError(req, res, err && (err.status === 413 || err.type === 'entity.too.large') ? 'too_large' : 'bad_request');
  });
  r.use(notFound);
  return r;
}
