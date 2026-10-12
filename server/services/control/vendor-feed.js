// PUBLIC_LICENCE_V1 — СПИСОК ПРОИЗВОДИТЕЛЯ ДЛЯ ПУБЛИЧНОГО СЕРВЕРА: какие клиники
// партнёрам не показывать и какие ключи больше не действуют. Договор двух служб:
// подписывает сервер лицензий (control-plane/server/services/signing.js signFeed,
// отдаёт routes/public-feed.js), проверяет публичный сервер
// (public-server/server/store/feed.js). Живёт здесь, рядом с canonical.js и
// licence.js, по той же причине, что и лицензия: обе стороны берут ОДНО
// определение и проверяются в одном репозитории.
//
// Зачем, если есть лицензия. Лицензию несёт клиника — и только она может её
// предъявить. Клиника без связи (или с подменённой программой) отметку «не
// оплачено» и выключенный API публичному серверу не принесёт, а украденный ключ
// подписи будет работать до конца срока лицензии (до 14 дней). Список несёт
// ПРОИЗВОДИТЕЛЬ: публичный сервер забирает его сам раз в минуту.
//
//   clinics_off          — клиники, которых партнёры не видят (503 «временно
//                          недоступна»): не оплачено, снята, удалена, API
//                          выключен, нет принятого ключа обмена;
//   sync_keys_revoked    — отпечатки ключей подписи клиник (32 hex), которым
//                          канал клиники отвечает 401, а клиника с таким ключом
//                          партнёрам не видна;
//   partner_keys_revoked — SHA-256 ключей партнёров (64 hex) — ответ 401
//                          key_disabled, что бы ни присылала клиника.
//
// ПОДПИСЬ — тем же ключом производителя, что и лицензии, но над другими байтами:
// FEED_CONTEXT + canonical(payload). Лицензия подписана над canonical(payload) —
// начинается с «{», список — с «easymed-public-feed/v1»: подпись одного никогда
// не сойдётся как подпись другого, даже если поля совпадут.
//
// verifyFeed НИКОГДА НЕ БРОСАЕТ: испорченный или чужой список — отказ с причиной,
// публичный сервер держит последний хороший.
import { verify } from 'node:crypto';
import { canonical } from './canonical.js';
import { vendorPublicKey } from './licence.js';

export const FEED_KIND = 'easymed-public-feed';
export const FEED_VERSION = 1;
export const FEED_CONTEXT = 'easymed-public-feed/v1\n';
/** Потолки: тело — 2 МБ, клиник и ключей каждого вида — по 20 тысяч. */
export const FEED_LIMITS = Object.freeze({ bytes: 2_000_000, clinics: 20000, keys: 20000 });

export const CLINIC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SYNC_FP_RE = /^[0-9a-f]{32}$/;
export const KEY_HASH_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Байты, над которыми стоит подпись списка. */
export function feedMessage(payload) {
  return Buffer.from(FEED_CONTEXT + canonical(payload), 'utf8');
}

const sortedUnique = (list) => [...new Set(list)].sort();

/**
 * Полезная часть списка в одном виде на обеих сторонах: списки без повторов и
 * по порядку (canonical() сохраняет порядок массивов — один и тот же список в
 * другом порядке дал бы другую подпись).
 * @param {{issuedAt:string, clinicsOff?:string[], syncKeysRevoked?:string[], partnerKeysRevoked?:string[]}} o
 */
export function makeFeedPayload({ issuedAt, clinicsOff = [], syncKeysRevoked = [], partnerKeysRevoked = [] }) {
  return {
    kind: FEED_KIND,
    v: FEED_VERSION,
    issued_at: issuedAt,
    clinics_off: sortedUnique(clinicsOff),
    sync_keys_revoked: sortedUnique(syncKeysRevoked),
    partner_keys_revoked: sortedUnique(partnerKeysRevoked),
  };
}

function listOk(list, re, max) {
  return Array.isArray(list) && list.length <= max && list.every((x) => typeof x === 'string' && re.test(x));
}

/**
 * Проверить список производителя.
 * @param {string|Buffer|null} raw тело ответа сервера лицензий
 * @param {{publicKey?:import('node:crypto').KeyObject|null}} [opts] null — ключ, вшитый в программу
 * @returns {{ok:true, feed:{issued_at:string, clinics_off:string[], sync_keys_revoked:string[], partner_keys_revoked:string[]}}
 *   | {ok:false, reason:'too_large'|'malformed'|'bad_signature'}}
 */
export function verifyFeed(raw, { publicKey = null } = {}) {
  const text = String(raw ?? '');
  if (Buffer.byteLength(text, 'utf8') > FEED_LIMITS.bytes) return { ok: false, reason: 'too_large' };
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'malformed' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'malformed' };
  const { payload, sig } = doc;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'malformed' };
  if (payload.kind !== FEED_KIND || payload.v !== FEED_VERSION) return { ok: false, reason: 'malformed' };
  if (typeof payload.issued_at !== 'string' || !Number.isFinite(Date.parse(payload.issued_at))) return { ok: false, reason: 'malformed' };
  if (!listOk(payload.clinics_off, CLINIC_ID_RE, FEED_LIMITS.clinics)
    || !listOk(payload.sync_keys_revoked, SYNC_FP_RE, FEED_LIMITS.keys)
    || !listOk(payload.partner_keys_revoked, KEY_HASH_RE, FEED_LIMITS.keys)) return { ok: false, reason: 'malformed' };
  if (typeof sig !== 'string' || !BASE64_RE.test(sig)) return { ok: false, reason: 'malformed' };
  let good = false;
  try {
    good = verify(null, feedMessage(payload), publicKey || vendorPublicKey(), Buffer.from(sig, 'base64'));
  } catch { return { ok: false, reason: 'malformed' }; }
  if (!good) return { ok: false, reason: 'bad_signature' };
  return {
    ok: true,
    feed: {
      issued_at: payload.issued_at,
      clinics_off: payload.clinics_off.slice(),
      sync_keys_revoked: payload.sync_keys_revoked.slice(),
      partner_keys_revoked: payload.partner_keys_revoked.slice(),
    },
  };
}
