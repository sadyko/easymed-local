// PUBLIC_LICENCE_V1 — СЕРВЕР ЛИЦЕНЗИЙ И ПУБЛИЧНЫЙ СЕРВЕР (шаг 8c API клиники).
//
// Публичный сервер api.easymed.uz узнаёт клинику по её ПОДПИСАННОЙ лицензии
// (public-server/server/clinic-auth.js) и сервера лицензий во время работы не
// спрашивает. Поэтому всё, что Easy-Med решает о клинике в панели, доходит до
// него двумя путями:
//   • в лицензии, которую несёт клиника (ежечасная сверка) — только у
//     ОПЛАЧЕННОЙ:
//       subscription  — 'active';
//       api_sync_key  — отпечаток принятого ключа обмена, только когда в панели
//                       включено «Онлайн-запись / API». Нет поля — обмен клиники
//                       молчит (8a public-sync.js vendorBlocker), публичный
//                       сервер её не пускает (invalid_signature);
//   • в списке производителя, который публичный сервер забирает сам раз в
//     минуту (routes/public-feed.js): неоплаченные, снятые, выключенные — и для
//     клиники без связи или с подменённой программой.
//
// НЕОПЛАЧЕННОЙ КЛИНИКЕ — НИКАКОЙ ЛИЦЕНЗИИ, РОВНО КАК ДО 8c (план 8c, Р14,
// решение 2026-10-12). Она доживает выданное, лестница блокировки не меняется
// (память easymed-licence-lockout). Отметку «не оплачено» публичному серверу
// несёт только список производителя (решение владельца 17 — партнёры не видят
// её через минуту). Лицензия «unpaid» с тем же сроком, как задумывал план,
// оказалась ЗАМЕТНОЙ клиникам v3.16.0 (checkin-v3160-clinic.test.js): модули и
// имя из панели доходили до неоплаченной, день блокировки сдвигался при
// потерянной лицензии, выданная руками на 60 дней укорачивалась до 14.
//
// НОВЫЙ КЛЮЧ ОБМЕНА (другой ПК). Первый присланный ключ принимается сам: до него
// у клиники онлайн-записи не было. Каждый следующий другой — «ждёт подтверждения»
// в панели (NEW_SYNC_KEY_NEEDS_CONFIRMATION, вопрос владельцу 1 плана 8c): копия
// install_token не должна молча забирать онлайн-записи клиники вместе с данными
// пациентов. Отозванный ключ не принимается никогда.
import { SYNC_FP_RE, KEY_HASH_RE } from '../../../server/services/control/vendor-feed.js';

export { SYNC_FP_RE, KEY_HASH_RE };

/** Вопрос владельцу 1 (план 8c): false — новый ключ принимается сам, как первый. */
export const NEW_SYNC_KEY_NEEDS_CONFIRMATION = true;

/** Время в виде, каким его пишет схема (strftime …%SZ, без миллисекунд). */
export function isoSeconds(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Действует ли запись отзыва этого вида на это значение. */
export function isRevoked(db, kind, value) {
  if (!value) return false;
  return !!db.prepare('SELECT 1 FROM revocations WHERE kind = ? AND value = ? AND removed_at IS NULL').get(kind, value);
}

/**
 * Сверка принесла отпечаток ключа обмена клиники. Записать, когда он появился;
 * принять, если это первый ключ клиники (или подтверждение выключено).
 * Внутри транзакции сверки: только простые UPDATE, неверный отпечаток — ничего.
 * @param {{clinic_id:string, api_sync_key:?string, api_sync_key_accepted_at:?string, api_sync_key_seen:?string, api_sync_key_seen_at:?string}} clinic
 * @param {string} fp '' — клиника ключа не прислала (старая версия, API не настроен)
 * @returns {{apiSyncKey: string|null, changed: boolean}} принятый ключ после записи; changed — пришёл не тот, что в прошлый раз
 */
export function noteSyncKey(db, clinic, fp, now = new Date()) {
  const accepted = clinic.api_sync_key || null;
  if (!SYNC_FP_RE.test(String(fp || ''))) return { apiSyncKey: accepted, changed: false };
  const at = isoSeconds(now);
  const changed = clinic.api_sync_key_seen !== fp;
  const seenAt = changed ? at : (clinic.api_sync_key_seen_at || at);
  const revoked = isRevoked(db, 'sync_key', fp);
  const accept = !revoked && fp !== accepted && (!clinic.api_sync_key_accepted_at || !NEW_SYNC_KEY_NEEDS_CONFIRMATION);
  if (accept) {
    db.prepare('UPDATE clinics SET api_sync_key = ?, api_sync_key_accepted_at = ?, api_sync_key_seen = ?, api_sync_key_seen_at = ? WHERE clinic_id = ?')
      .run(fp, at, fp, seenAt, clinic.clinic_id);
    return { apiSyncKey: fp, changed };
  }
  if (changed || !clinic.api_sync_key_seen_at) {
    db.prepare('UPDATE clinics SET api_sync_key_seen = ?, api_sync_key_seen_at = ? WHERE clinic_id = ?').run(fp, seenAt, clinic.clinic_id);
  }
  return { apiSyncKey: accepted, changed };
}

/** Новый ключ ждёт подтверждения: пришёл, не принят, не отозван. */
export function syncKeyPending(db, clinic) {
  const seen = clinic.api_sync_key_seen || null;
  return !!seen && seen !== (clinic.api_sync_key || null) && !isRevoked(db, 'sync_key', seen);
}

/**
 * «Принять новый ключ» в панели. fingerprint — тот, что видел человек: если с
 * тех пор клиника прислала другой, ничего не принимается.
 * @returns {{ok:true} | {error:'not_pending'|'changed'|'revoked'}}
 */
export function acceptPendingSyncKey(db, clinicId, fingerprint, now = new Date()) {
  const c = db.prepare('SELECT clinic_id, api_sync_key, api_sync_key_seen FROM clinics WHERE clinic_id = ?').get(clinicId);
  if (!c || !c.api_sync_key_seen || c.api_sync_key_seen === c.api_sync_key) return { error: 'not_pending' };
  if (c.api_sync_key_seen !== fingerprint) return { error: 'changed' };
  if (isRevoked(db, 'sync_key', fingerprint)) return { error: 'revoked' };
  db.prepare('UPDATE clinics SET api_sync_key = ?, api_sync_key_accepted_at = ? WHERE clinic_id = ?').run(fingerprint, isoSeconds(now), clinicId);
  return { ok: true };
}

/**
 * Какую лицензию выдать при сверке. null — никакой: неоплаченной клинике,
 * ровно как до 8c (Р14), что бы ей ни выдавали прежде.
 * @param {{entitled:boolean, apiEnabled:boolean, apiSyncKey:?string, lastIssuedAt:?string}} o
 * @returns {null | {subscription:'active', apiSyncKey:string|null, issuedAfter?:string}}
 */
export function licenceTerms({ entitled, apiEnabled, apiSyncKey, lastIssuedAt = null }) {
  if (!entitled) return null;
  const key = apiEnabled && SYNC_FP_RE.test(String(apiSyncKey || '')) ? apiSyncKey : null;
  const issuedAfter = typeof lastIssuedAt === 'string' && Number.isFinite(Date.parse(lastIssuedAt)) ? lastIssuedAt : undefined;
  return { subscription: 'active', apiSyncKey: key, ...(issuedAfter ? { issuedAfter } : {}) };
}

/**
 * Запомнить выданную лицензию: нижняя граница следующего issued_at и что
 * сейчас сказано клинике (панель: дошло ли включение онлайн-записи). Никогда
 * не бросает — лицензия уже подписана и уходит клинике.
 */
export function recordIssued(db, clinicId, payload) {
  const s = (v) => (typeof v === 'string' ? v : null);
  const p = payload && typeof payload === 'object' ? payload : {};
  try {
    db.prepare('UPDATE clinics SET licence_issued_at = ?, licence_valid_until = ?, licence_subscription = ?, licence_api_sync_key = ? WHERE clinic_id = ?')
      .run(s(p.issued_at), s(p.valid_until), s(p.subscription), s(p.api_sync_key), clinicId);
  } catch (e) {
    console.warn('[control-plane] could not record the issued licence:', e && e.message);
  }
}

/**
 * Что видят партнёры (и что публичный сервер получает в списке производителя):
 *   'visible' — видят;
 *   'retired' | 'unpaid' | 'off' (онлайн-запись выключена) | 'no_key' (нет
 *   принятого ключа обмена) — «клиника временно недоступна».
 * @param {{active:number|boolean, api_enabled:number|boolean, api_sync_key:?string}} clinic
 */
export function partnersSee(clinic, { entitled }) {
  if (!clinic.active) return 'retired';
  if (!entitled) return 'unpaid';
  if (!clinic.api_enabled) return 'off';
  if (!clinic.api_sync_key) return 'no_key';
  return 'visible';
}
