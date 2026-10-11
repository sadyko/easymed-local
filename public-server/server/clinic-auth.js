// PUBLIC_SERVER_V1 — КТО ПИШЕТ: проверка запроса клиники к /_sync/v1/*.
//
// Дизайн шага 8, §4 (вариант А) и §10. Заголовки каждого запроса клиники
// (services/api/public-sync.js call()):
//   X-EasyMed-Clinic    — id клиники;
//   X-EasyMed-Time      — ISO-время клиники;
//   X-EasyMed-Key       — открытая половина её ключа подписи Ed25519 (base64 DER SPKI);
//   X-EasyMed-Signature — Ed25519 от «МЕТОД\nПУТЬ+query\nВРЕМЯ\nsha256(тело)»;
//   X-EasyMed-Licence   — base64 licence.dat, байт в байт.
// Порядок проверки — от дешёвого к дорогому, и подпись производителя ДО того,
// как поверить хоть одному полю лицензии:
//   1. лицензия подписана производителем и выдана этой клинике (verifyLicence —
//      тот же код, что в программе клиники);
//   2. отпечаток присланного ключа (первые 32 hex SHA-256 от DER — как его
//      считает sync-identity.js) = payload.api_sync_key лицензии (шаг 8c);
//   3. время клиники не дальше PUBLIC_SYNC_SKEW_MIN от часов сервера — подпись
//      старого запроса нельзя проиграть заново через сутки;
//   4. подпись запроса этим ключом.
// Общих секретов нет; сервер лицензий во время работы не спрашивается.
import crypto from 'node:crypto';
import { verifyLicence } from '../../server/services/control/licence.js';
import { verifyRequest } from '../../server/services/api/sync-identity.js';
import { subscriptionOf } from './licence-gate.js';
import { isoOf } from './lib/time.js';
import { DEFAULT_SYNC_SKEW_MIN } from './config.js';

/** Допуск часов клиники — 15 минут (решение контролёра 2026-10-12; config.js). */
export const DEFAULT_SKEW_MS = DEFAULT_SYNC_SKEW_MIN * 60000;
const CLINIC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LICENCE_MAX = 16384;

/** Отпечаток открытого ключа подписи: первые 32 hex SHA-256 от DER (SPKI); не Ed25519 — ''. */
export function keyFingerprint(signPublicB64) {
  try {
    const der = Buffer.from(String(signPublicB64 || ''), 'base64');
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return '';
    return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  } catch { return ''; }
}

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

/**
 * @param {{method:string, url:string, headers:object, body:Buffer}} req url — путь с query, как пришёл (originalUrl)
 * @param {{licencePublicKey?:import('node:crypto').KeyObject|null, now:number, skewMs?:number}} opts
 * @returns {{ok:true, clinicId:string, fingerprint:string, licence:{issued_at:string, valid_until:string, subscription:string}}
 *   | {ok:false, code:string, server_time?:string}}
 */
export function verifyClinicRequest({ method, url, headers, body }, { licencePublicKey = null, now, skewMs = DEFAULT_SKEW_MS }) {
  const h = (k) => String((headers && headers[k]) || '');
  const clinicId = h('x-easymed-clinic');
  if (!CLINIC_ID_RE.test(clinicId)) return fail('invalid_signature');
  const lic = h('x-easymed-licence');
  if (!lic || lic.length > LICENCE_MAX) return fail('licence_invalid');
  const v = verifyLicence(Buffer.from(lic, 'base64').toString('utf8'), { publicKey: licencePublicKey, clinicId });
  if (!v.ok) return fail('licence_invalid');
  const fingerprint = keyFingerprint(h('x-easymed-key'));
  if (!fingerprint || v.licence.api_sync_key !== fingerprint) return fail('invalid_signature');
  const time = h('x-easymed-time');
  const t = Date.parse(time);
  if (!Number.isFinite(t) || Math.abs(t - now) > skewMs) return fail('clock_skew', { server_time: isoOf(now) });
  const ok = verifyRequest(h('x-easymed-key'), { method: String(method).toUpperCase(), path: url, time, body: body || Buffer.alloc(0) },
    h('x-easymed-signature'));
  if (!ok) return fail('invalid_signature');
  return {
    ok: true, clinicId, fingerprint,
    licence: {
      issued_at: String(v.licence.issued_at || ''),
      valid_until: String(v.licence.valid_until || ''),
      subscription: subscriptionOf(v.licence),
    },
  };
}
