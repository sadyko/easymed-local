// PUBLIC_LICENCE_V1 — СПИСОК ПРОИЗВОДИТЕЛЯ НА ПУБЛИЧНОМ СЕРВЕРЕ (шаг 8c).
//
// Лицензию несёт клиника — и только когда выходит на связь. Решение Easy-Med в
// панели (не оплачено, онлайн-запись выключена, ключ партнёра или ключ обмена
// клиники заблокирован) доходит сюда вторым путём, мимо клиники: служба сама
// забирает подписанный список с сервера лицензий (GET /cp/v1/public-feed, раз в
// PUBLIC_FEED_EVERY_SEC, jobs.js) и проверяет подпись тем же ключом
// производителя, что и лицензии (server/services/control/vendor-feed.js).
// «Не оплачено» и ключи партнёров, заблокированные в панели, доходят ТОЛЬКО
// этим путём: неоплаченной клинике сервер лицензий новой лицензии не выдаёт
// (решение контролёра 8c — сверка отвечает licence: null, как до 8c).
//
// ЧТО ОН ДЕЛАЕТ (routes/partner-auth.js, routes/sync.js):
//   • клиника в clinics_off или с отозванным ключом обмена — партнёрам 503
//     licence_lapsed «временно недоступна» (как при неоплате);
//   • ключ партнёра в partner_keys_revoked — 401 key_disabled, что бы ни
//     присылала клиника в PUT /keys;
//   • запрос клиники, подписанный отозванным ключом обмена, — 401
//     invalid_signature.
//
// ЕСЛИ СПИСКА НЕТ ИЛИ ОН СТАРЫЙ — держим последний хороший (и после перезапуска:
// он лежит в базе, vendor_feed, и проверяется заново). Сервер лицензий
// недоступен — партнёры этого не замечают (правило control-plane/README.md:
// день без сервера лицензий незаметен); его возраст видно в /_metrics
// (feed_age_s), наблюдение 8c поднимает тревогу. Список старше уже принятого
// не берётся (outdated): повтор перехваченного старого списка не снимет
// блокировку. Пустой список при первом запуске — ничего не блокирует.
import { verifyFeed, FEED_LIMITS } from '../../../server/services/control/vendor-feed.js';
import { isoOf, msOf } from '../lib/time.js';

export const FEED_TIMEOUT_MS = 10000;
export const PROD_FEED_HOST = 'settings.easymed.uz';

/** Пустой список: ничего не скрыто, ничего не отозвано. */
export function emptyFeed() {
  return {
    issued_at: null, received_at: null, checked_at: null, error: '',
    clinicsOff: new Set(), syncKeysRevoked: new Set(), partnerKeysRevoked: new Set(),
  };
}

function fill(holder, feed, receivedAt) {
  holder.issued_at = feed.issued_at;
  holder.received_at = receivedAt;
  holder.clinicsOff = new Set(feed.clinics_off);
  holder.syncKeysRevoked = new Set(feed.sync_keys_revoked);
  holder.partnerKeysRevoked = new Set(feed.partner_keys_revoked);
}

/** Последний принятый список из базы, проверенный заново; нет или испорчен — пустой. */
export function loadFeed(db, { publicKey = null } = {}) {
  const holder = emptyFeed();
  let row = null;
  try { row = db.prepare('SELECT doc, received_at FROM vendor_feed WHERE id = 1').get() || null; } catch { row = null; }
  if (!row) return holder;
  const v = verifyFeed(row.doc, { publicKey });
  if (v.ok) fill(holder, v.feed, row.received_at);
  else holder.error = 'stored_' + v.reason;
  return holder;
}

/**
 * Присланный текст: подпись производителя, вид, не старше принятого. Новее —
 * в базу и в память (holder меняется на месте: ctx.feed остаётся тем же объектом).
 * @returns {{ok:true, changed:boolean} | {ok:false, error:string}}
 */
export function applyFeedText(db, holder, text, { publicKey = null, now }) {
  holder.checked_at = isoOf(now);
  const v = verifyFeed(text, { publicKey });
  if (!v.ok) { holder.error = v.reason; return { ok: false, error: v.reason }; }
  const t = msOf(v.feed.issued_at);
  const cur = msOf(holder.issued_at);
  if (cur !== null && t < cur) { holder.error = 'outdated'; return { ok: false, error: 'outdated' }; }
  holder.error = '';
  if (cur !== null && t === cur) return { ok: true, changed: false };
  const at = isoOf(now);
  db.prepare('INSERT OR REPLACE INTO vendor_feed (id, issued_at, doc, received_at) VALUES (1, ?, ?, ?)').run(v.feed.issued_at, String(text), at);
  fill(holder, v.feed, at);
  return { ok: true, changed: true };
}

// Тот же страж, что у клиники (control/prod-guard.js, api/public-sync.js): тест,
// забывший подставить адрес или fetchImpl, не уходит на настоящий сервер лицензий.
export function assertFeedUrlIsTestSafe(url, fetchImpl) {
  if (!process.env.NODE_TEST_CONTEXT) return;
  if (fetchImpl && fetchImpl !== globalThis.fetch) return;
  let host = '';
  try { host = new URL(String(url)).hostname; } catch { host = ''; }
  if (host === PROD_FEED_HOST) {
    throw new Error('refusing to reach the production control plane from inside a test process — pass a local feed URL or a fetchImpl');
  }
}

async function readCapped(res, maxBytes) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) { const t = await res.text(); return Buffer.byteLength(t, 'utf8') > maxBytes ? null : t; }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* бросаем ответ всё равно */ } return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Забрать список с сервера лицензий. Никогда не бросает (кроме стража тестов):
 * сбой — причина в holder.error, прежний список остаётся.
 * @param {{url:string, token:string, publicKey?:object|null, fetchImpl?:typeof fetch, now:number, timeoutMs?:number}} o
 */
export async function pullFeed(db, holder, { url, token, publicKey = null, fetchImpl = globalThis.fetch, now, timeoutMs = FEED_TIMEOUT_MS }) {
  assertFeedUrlIsTestSafe(url, fetchImpl);
  const fail = (error) => { holder.checked_at = isoOf(now); holder.error = error; return { ok: false, error }; };
  let res;
  try {
    // redirect: 'error' — токен не уходит туда, куда его не посылали.
    res = await fetchImpl(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch { return fail('unreachable'); }
  if (!res.ok) return fail('http_' + res.status);
  let text = null;
  try { text = await readCapped(res, FEED_LIMITS.bytes); } catch { return fail('unreachable'); }
  if (text === null) return fail('too_large');
  try { return applyFeedText(db, holder, text, { publicKey, now }); } catch { return fail('store_failed'); }
}

/** Клиника скрыта от партнёров списком: в clinics_off или её ключ обмена отозван. */
export function feedBlocksClinic(holder, clinic) {
  if (!holder || !clinic) return false;
  return holder.clinicsOff.has(clinic.clinic_id) || holder.syncKeysRevoked.has(clinic.key_fp);
}
export const feedRevokedPartnerKey = (holder, keyHash) => !!holder && holder.partnerKeysRevoked.has(keyHash);
export const feedRevokedSyncKey = (holder, fp) => !!holder && holder.syncKeysRevoked.has(fp);

/** Для /_metrics: только числа и время. */
export function feedMetrics(holder, now) {
  const h = holder || emptyFeed();
  const issued = msOf(h.issued_at);
  return {
    feed_issued_at: h.issued_at,
    feed_age_s: issued === null ? null : Math.max(0, Math.round((now - issued) / 1000)),
    feed_checked_at: h.checked_at,
    feed_error: h.error,
    feed_clinics_off: h.clinicsOff.size,
    feed_sync_keys_revoked: h.syncKeysRevoked.size,
    feed_partner_keys_revoked: h.partnerKeysRevoked.size,
  };
}
