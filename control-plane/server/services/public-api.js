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
//
// РЕВЬЮ 8c, п. 1. Одна ячейка «последний присланный ключ» позволяла принять ключ
// копии: копия control.json, сверившаяся ПОСЛЕ настоящего нового ПК, занимала её,
// оператор звонил в клинику («да, мы сменили компьютер») и нажимал «Accept» —
// записи пациентов уходили копии, настоящий ПК получал invalid_signature.
// Теперь:
//   • каждый ключ, пришедший с установки, — своя строка sync_keys_seen;
//   • «Accept new key» принимает ЕДИНСТВЕННОГО кандидата и только с кодом
//     ключа, который клиника читает со своего экрана «Настройки → API»
//     (keyCode: первые 8 hex, «xxxx-xxxx»); панель этот код не показывает;
//   • больше одного кандидата после последнего принятия (в том числе
//     заблокированные) — принять нельзя никакой: только новая регистрация
//     установки, она стирает кандидатов (enrollment.js redeemEnrollmentCode);
//   • прежде принятый ключ, если снова сверяется, — «прежний», не «новый»;
//   • один ключ — одна клиника: ключ, принятый у другой, не принимается.
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
 * Код ключа обмена для телефона: первые 8 hex отпечатка, «xxxx-xxxx». Договор
 * с экраном клиники «Настройки → API и подключения» (тот же код; syncStatus
 * key_code) и с панелью (panel-logic.js keyCode). '' — не отпечаток.
 */
export function keyCode(fp) {
  const s = typeof fp === 'string' ? fp : '';
  return SYNC_FP_RE.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 8) : '';
}

/** Код, набранный оператором со слов клиники: регистр, пробелы и дефисы не важны. '' — не код. */
export function normaliseKeyCode(text) {
  const s = typeof text === 'string' ? text.toLowerCase().replace(/[\s-]/g, '') : '';
  return /^[0-9a-f]{8}$/.test(s) ? s : '';
}

/** Клиника (кроме exceptClinicId), у которой этот ключ уже принят, — или null. Один ключ — одна клиника. */
export function keyOwner(db, fp, exceptClinicId) {
  if (!fp) return null;
  const r = db.prepare('SELECT clinic_id FROM clinics WHERE api_sync_key = ? AND clinic_id <> ? LIMIT 1').get(fp, exceptClinicId || '');
  return r ? r.clinic_id : null;
}

/**
 * Ключ стал принятым: прежний принятый — «replaced» (его сменили), этот —
 * «accepted» и навсегда в истории принятых ключей клиники (sync_keys_history —
 * её не стирает и новая регистрация; перепроверка 8c, раунд 2).
 */
function markAccepted(db, clinicId, fp, at) {
  db.prepare("UPDATE sync_keys_seen SET state = 'replaced', state_at = ? WHERE clinic_id = ? AND state = 'accepted' AND fp <> ?").run(at, clinicId, fp);
  db.prepare("UPDATE sync_keys_seen SET state = 'accepted', state_at = ? WHERE clinic_id = ? AND fp = ?").run(at, clinicId, fp);
  db.prepare('INSERT OR IGNORE INTO sync_keys_history (clinic_id, fp, first_accepted_at) VALUES (?, ?, ?)').run(clinicId, fp, at);
}

/**
 * Все ключи, которые у клиники когда-либо были приняты (нынешний, прежние,
 * в том числе стёртые новой регистрацией из sync_keys_seen): их коды клиника
 * знает, их можно заблокировать по отпечатку, их код печатается в «Blocked keys».
 * @returns {Set<string>}
 */
export function formerSyncKeys(db, clinicId) {
  const own = new Set(db.prepare('SELECT fp FROM sync_keys_history WHERE clinic_id = ?').all(clinicId).map((r) => r.fp));
  for (const r of db.prepare("SELECT fp FROM sync_keys_seen WHERE clinic_id = ? AND state IN ('accepted', 'replaced')").all(clinicId)) own.add(r.fp);
  const c = db.prepare('SELECT api_sync_key FROM clinics WHERE clinic_id = ?').get(clinicId);
  if (c && c.api_sync_key) own.add(c.api_sync_key);
  return own;
}

/**
 * Сверка принесла отпечаток ключа обмена клиники. Запомнить его (каждый ключ —
 * своя строка sync_keys_seen) и когда он появился; принять, если это первый
 * ключ клиники (или подтверждение выключено), не отозван и не принят у другой
 * клиники. Внутри транзакции сверки: только простые INSERT/UPDATE, неверный
 * отпечаток — ничего.
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
  db.prepare(`INSERT INTO sync_keys_seen (clinic_id, fp, first_seen, last_seen, state, state_at) VALUES (?, ?, ?, ?, 'candidate', ?)
              ON CONFLICT (clinic_id, fp) DO UPDATE SET last_seen = excluded.last_seen`).run(clinic.clinic_id, fp, at, at, at);
  if (fp === accepted) {
    // Принятый другим путём (до этой таблицы) — пусть и строка это говорит.
    db.prepare("UPDATE sync_keys_seen SET state = 'accepted' WHERE clinic_id = ? AND fp = ? AND state = 'candidate'").run(clinic.clinic_id, fp);
  }
  const accept = fp !== accepted && !isRevoked(db, 'sync_key', fp)
    && (!clinic.api_sync_key_accepted_at || !NEW_SYNC_KEY_NEEDS_CONFIRMATION)
    && !keyOwner(db, fp, clinic.clinic_id);
  if (accept) {
    markAccepted(db, clinic.clinic_id, fp, at);
    db.prepare('UPDATE clinics SET api_sync_key = ?, api_sync_key_accepted_at = ?, api_sync_key_seen = ?, api_sync_key_seen_at = ? WHERE clinic_id = ?')
      .run(fp, at, fp, seenAt, clinic.clinic_id);
    return { apiSyncKey: fp, changed };
  }
  if (changed || !clinic.api_sync_key_seen_at) {
    db.prepare('UPDATE clinics SET api_sync_key_seen = ?, api_sync_key_seen_at = ? WHERE clinic_id = ?').run(fp, seenAt, clinic.clinic_id);
  }
  return { apiSyncKey: accepted, changed };
}

/**
 * Ключи, пришедшие с установки после последнего принятия и не принятые, — по
 * одному на ключ, старые первыми. revoked — заблокирован: ждать не может, но
 * СОРЕВНОВАЛСЯ (блокировка копии не открывает «Accept» без новой регистрации).
 * other_clinic — этот ключ уже принят у другой клиники.
 * @returns {{id:number, fp:string, code:string, first_seen:string, last_seen:string, revoked:boolean, other_clinic:string|null}[]}
 */
export function syncKeyCandidates(db, clinic) {
  return db.prepare(
    "SELECT id, fp, first_seen, last_seen FROM sync_keys_seen WHERE clinic_id = ? AND state = 'candidate' AND fp <> ? ORDER BY first_seen, fp",
  ).all(clinic.clinic_id, clinic.api_sync_key || '').map((r) => ({
    id: r.id, fp: r.fp, code: keyCode(r.fp), first_seen: r.first_seen, last_seen: r.last_seen,
    revoked: isRevoked(db, 'sync_key', r.fp), other_clinic: keyOwner(db, r.fp, clinic.clinic_id),
  }));
}

/** Новый ключ ждёт подтверждения: есть незаблокированный кандидат. */
export function syncKeyPending(db, clinic) {
  return syncKeyCandidates(db, clinic).some((k) => !k.revoked);
}

/**
 * Прежде принятые ключи, которые снова сверялись после того, как их сменили:
 * старый ПК ещё работает — или у кого-то его копия. «Прежний», не «новый».
 * @returns {{id:number, fp:string, code:string, last_seen:string, replaced_at:string}[]}
 */
export function replacedKeysSeen(db, clinic) {
  return db.prepare(
    "SELECT id, fp, last_seen, state_at FROM sync_keys_seen WHERE clinic_id = ? AND state IN ('accepted', 'replaced') AND fp <> ? AND last_seen >= state_at ORDER BY last_seen DESC, fp",
  ).all(clinic.clinic_id, clinic.api_sync_key || '')
    .filter((r) => !isRevoked(db, 'sync_key', r.fp))
    .map((r) => ({ id: r.id, fp: r.fp, code: keyCode(r.fp), last_seen: r.last_seen, replaced_at: r.state_at }));
}

/**
 * Перепроверка 8c, F2 — сняли блокировку с ключа, который был ПРИНЯТЫМ, когда
 * его блокировали (строка осталась 'accepted', другой ключ с тех пор не принят):
 * он снова принятый, как до блокировки. Без этого клиника оставалась без
 * онлайн-записи навсегда: ключ не «новый» (его не принять кнопкой) и не
 * принятый. Ключ, принятый у другой клиники, не возвращается.
 * @returns {boolean} вернулся ли ключ
 */
export function restoreUnblockedSyncKey(db, clinicId, fp) {
  const c = db.prepare('SELECT api_sync_key FROM clinics WHERE clinic_id = ?').get(clinicId);
  if (!c || c.api_sync_key || !fp || isRevoked(db, 'sync_key', fp)) return false;
  if (!db.prepare("SELECT 1 FROM sync_keys_seen WHERE clinic_id = ? AND fp = ? AND state = 'accepted'").get(clinicId, fp)) return false;
  if (keyOwner(db, fp, clinicId)) return false;
  db.prepare('UPDATE clinics SET api_sync_key = ? WHERE clinic_id = ?').run(fp, clinicId);
  return true;
}

/**
 * Новая регистрация установки — чистый лист (перепроверка 8c, F3): ключи,
 * ждавшие при прежнем install_token, и прежние (сменённые) ключи больше не в
 * счёт. Так вернувшийся ПК (A → B → A; файл ключа переживает регистрацию) —
 * снова новый кандидат и принимается по своему коду. Остаётся только принятый
 * ключ; блокировки (revocations) остаются блокировками.
 */
export function clearSyncKeysOfOldInstall(db, clinicId) {
  db.prepare("DELETE FROM sync_keys_seen WHERE clinic_id = ? AND state IN ('candidate', 'replaced')").run(clinicId);
}

/**
 * «Accept new key» в панели. Принимается только ЕДИНСТВЕННЫЙ кандидат после
 * последнего принятия, только тот, что был на экране (fingerprint), и только
 * когда code — код, который клиника прочла со своего экрана, — совпал с ним.
 * @param {{fingerprint?:string, code?:string}} o
 * @returns {{ok:true} | {error:'not_pending'|'changed'|'revoked'|'bad_code'|'same_code'|'code_mismatch'}
 *   | {error:'competing', count:number} | {error:'shared', clinicId:string}}
 */
export function acceptPendingSyncKey(db, clinicId, { fingerprint, code } = {}, now = new Date()) {
  const c = db.prepare('SELECT clinic_id, api_sync_key FROM clinics WHERE clinic_id = ?').get(clinicId);
  if (!c) return { error: 'not_pending' };
  if (isRevoked(db, 'sync_key', fingerprint)) return { error: 'revoked' };
  const all = syncKeyCandidates(db, c);
  const live = all.filter((k) => !k.revoked);
  if (!live.length) return { error: 'not_pending' };
  if (all.length > 1) return { error: 'competing', count: all.length };
  const [only] = live;
  if (only.fp !== fingerprint) return { error: 'changed' };
  const typed = normaliseKeyCode(code);
  if (!typed) return { error: 'bad_code' };
  // Re-check F1 — a clinic that never changed computers reads the code of the
  // key it ALREADY uses. A copy of its install_token can grind an Ed25519 key
  // with the same first 8 hex (2^32 tries — hours on an ordinary machine) and
  // be the only new key. So a new key whose code equals the code of any key
  // this clinic has had accepted (now or before — round 2: before a
  // re-enrolment too) is refused, whatever was typed — unless it IS that key
  // (same full fingerprint): a clinic that went back to a former computer.
  const prefix = only.fp.slice(0, 8);
  if ([...formerSyncKeys(db, clinicId)].some((fp) => fp !== only.fp && fp.slice(0, 8) === prefix)) return { error: 'same_code' };
  if (typed !== prefix) return { error: 'code_mismatch' };
  if (only.other_clinic) return { error: 'shared', clinicId: only.other_clinic };
  const at = isoSeconds(now);
  db.transaction(() => {
    markAccepted(db, clinicId, only.fp, at);
    db.prepare('UPDATE clinics SET api_sync_key = ?, api_sync_key_accepted_at = ? WHERE clinic_id = ?').run(only.fp, at, clinicId);
  })();
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
