// PUBLIC_API_V1 — ОБМЕН С ПУБЛИЧНЫМ СЕРВЕРОМ (api.easymed.uz): отправка снимка,
// свободного времени, ключей и событий; сбор заявок.
//
// Клиника за NAT, к ней не достучаться — каждый разговор начинает она. Ритм:
//   • такт каждые 15 секунд (POLL_MS) — сбор заявок (по образцу опроса
//     телефонии: telephony/poller.js — один процесс, такт не роняет сервер,
//     неудача — «попробуем в следующий такт»);
//   • ключи и права — каждый такт, если изменились (быстрый канал: выключенный
//     ключ перестаёт подходить в пределах такта; RPC подключений будят такт
//     сразу — wakePublicSync);
//   • снимок — каждый такт, если изменился, и не реже раза в 15 минут;
//   • свободное время — раз в минуту и сразу после принятой заявки;
//   • события (api_outbox) — каждый такт, по порядку, пока не примут (по
//     образцу выгрузки журнала между зданиями: branch-sync/relay.js — неудача
//     не теряет, следующий такт шлёт то же).
//
// КТО ГОВОРИТ: каждый запрос подписан ключом клиники (sync-identity.js), к нему
// приложена её подписанная лицензия — публичный сервер проверяет подпись
// производителя, срок (не продлена — 503, решение владельца 4) и отпечаток
// ключа в лицензии. Лицензия уходит как лежит, байт в байт: отметку «не
// оплачено», которую сервер лицензий впишет в подписанную лицензию (8c),
// публичный сервер видит сам (решение владельца 17 — 503 партнёрам, 8b).
// Своего правила о неоплате клиника не держит: очередь, принятую до отметки,
// разбирает как обычно (программа работает по лестнице блокировки). Сервер лицензий здесь не участвует и данных пациентов не
// видит: адрес обмена — api.easymed.uz, не settings.easymed.uz (страж
// no-patient-data-to-vendor.test.js).
//
// ПОКА НЕ ВКЛЮЧЁН: обмен молчит (ни одного запроса в сеть), пока в лицензии
// клиники нет отпечатка её ключа — его вписывает сервер лицензий, когда
// Easy-Med включит публичный сервер (шаг 8c). До этого экран «API» честно
// говорит «ждём включения».
//
// СРОК ДЕРЖАНИЯ назначает клиника в миг приёма заявки (решения владельца 18–19:
// 30 рабочих минут от приёма, bookings.js) и сообщает его в подтверждении
// очереди: POST /inbox/ack {cursor, held:[{request_id, hold_until}]}.
//
// НИКОГДА НЕ БРОСАЕТ: syncOnce ловит всё и записывает итог в api_sync_state.
import fs from 'node:fs';
import path from 'node:path';
import { readBounded } from '../control/checkin.js';
import { loadSyncIdentity, signRequest, openSealed, SYNC_KEY_FILE, SyncIdentityError } from './sync-identity.js';
import { buildSnapshot, buildSlots, buildKeys, contentHash } from './snapshot.js';
import { unsentEvents, markSent, markFailed } from './outbox.js';
import { ingestItem, expireDue } from './bookings.js';
import { syncVisitOutcomes } from './visit-events.js';
import { isoOf } from '../../../public/js/shared/api-booking.js';

export const DEFAULT_PUBLIC_URL = 'https://api.easymed.uz';
export const SYNC_PREFIX = '/_sync/v1';
export const POLL_MS = 15_000;
export const SLOTS_EVERY_MS = 60_000;
export const HEARTBEAT_MS = 15 * 60_000;
const INITIAL_DELAY_MS = 20_000;
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const EVENTS_BATCH = 50;
/** Ревью 8a, C1: сколько тактов подряд элемент очереди может ронять приём, прежде чем его пропустят (≈ 5 минут). */
export const STUCK_MAX_TRIES = 20;
/** Сколько последних номеров пропущенных заявок помнит состояние обмена (для поддержки Easy-Med). */
const SKIPPED_IDS_KEEP = 10;

export function publicBaseUrl(env = process.env) {
  return String((env && env.EASYMED_PUBLIC_URL) || DEFAULT_PUBLIC_URL).trim().replace(/\/+$/, '');
}

// Тот же страж, что control/prod-guard.js у сервера лицензий: тест, забывший
// подставить fetchImpl или адрес, не уходит на настоящий api.easymed.uz.
export function assertPublicUrlIsTestSafe(env, fetchImpl) {
  if (env && env.EASYMED_PUBLIC_URL) return;
  if (fetchImpl && fetchImpl !== globalThis.fetch) return;
  if (!process.env.NODE_TEST_CONTEXT) return;
  throw new Error('refusing to reach the production public API server from inside a test process — inject a fetchImpl or set EASYMED_PUBLIC_URL');
}

// Ревью 8a, I3: при этих отказах дальше в такте делать нечего — сервер не
// примет ничего. Отказ снимку или времени (например, 409 slug_taken — имя в
// адресе заняла другая клиника) — нет: события и очередь идут своим чередом.
const FATAL_REASONS = new Set(['offline', 'unauthorized', 'paused']);

class SyncFail extends Error { constructor(reason, detail = '') { super(reason); this.reason = reason; this.detail = detail; } }

// ─── СОСТОЯНИЕ ──────────────────────────────────────────────────────────────

function readState(db) {
  try { return db.prepare('SELECT * FROM api_sync_state WHERE id = 1').get() || null; } catch { return null; }
}
function saveState(db, fields) {
  const cols = Object.keys(fields);
  try { db.prepare(`UPDATE api_sync_state SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = 1`).run(...cols.map((c) => fields[c])); } catch { /* база до мигр. 245 */ }
}

// Ревью 8a, C1 — пропущенные элементы очереди помнятся до сброса администратором.
// kind: 'failed' — клиника не смогла принять; 'sealed' — не открылось её ключом (I4).
function noteSkipped(db, ids, now, kind = 'failed') {
  if (!ids.length) return;
  const st = readState(db) || {};
  let prev = [];
  try { prev = JSON.parse(st.skipped_last_ids || '[]'); } catch { prev = []; }
  const col = kind === 'sealed' ? 'skipped_sealed' : 'skipped_failed';
  saveState(db, {
    [col]: (Number(st[col]) || 0) + ids.length,
    skipped_last_at: isoOf(now),
    skipped_last_ids: JSON.stringify([...prev, ...ids].slice(-SKIPPED_IDS_KEEP)),
  });
}
// Ограничение базы (внешний ключ, CHECK, запрет триггера) — свойство самого
// элемента: следующий такт откажет так же. Сбой программы — может пройти.
const isPermanent = (e) => !!e && String(e.code || '').startsWith('SQLITE_CONSTRAINT');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

/** Есть ли что отдавать: главное здание, имя в адресе, хоть одно подключение. '' — есть. */
export function localBlocker(db) {
  try {
    const i = db.prepare('SELECT role FROM branch_identity WHERE id = 1').get();
    if (i && i.role === 'secondary') return 'not_main';
  } catch { /* нет таблицы — главное */ }
  let slug = '';
  try { slug = (db.prepare('SELECT slug FROM api_settings WHERE id = 1').get() || {}).slug || ''; } catch { return 'no_slug'; }
  if (!slug) return 'no_slug';
  try { if (!db.prepare('SELECT 1 FROM api_connections WHERE deleted_at IS NULL LIMIT 1').get()) return 'no_connections'; } catch { return 'no_connections'; }
  return '';
}

/** Включил ли Easy-Med публичный сервер для клиники: в лицензии — отпечаток её ключа. */
export function vendorBlocker(dataDir, identity) {
  const control = readJson(path.join(dataDir, 'control.json'));
  if (!control || typeof control.clinic_id !== 'string' || !control.clinic_id) return 'not_enrolled';
  const lic = readJson(path.join(dataDir, 'licence.dat'));
  if (!lic || !lic.payload) return 'not_enrolled';
  if (!identity || lic.payload.api_sync_key !== identity.fingerprint) return 'not_enabled';
  return '';
}

// ─── ЗАПРОСЫ ────────────────────────────────────────────────────────────────

async function call(ctx, method, p, body, { raw = null, type = 'application/json' } = {}) {
  const payload = raw != null ? raw : (body === undefined ? '' : JSON.stringify(body));
  const full = SYNC_PREFIX + p;
  const time = isoOf(ctx.now());
  let res;
  try {
    res = await ctx.fetchImpl(ctx.base + full, {
      method,
      headers: {
        'Content-Type': type,
        'X-EasyMed-Clinic': ctx.clinicId,
        // Открытая половина ключа: публичный сервер сверяет её отпечаток с лицензией и проверяет ею подпись.
        'X-EasyMed-Key': ctx.identity.signPublic,
        'X-EasyMed-Time': time,
        'X-EasyMed-Signature': signRequest(ctx.identity, { method, path: full, time, body: payload }),
        'X-EasyMed-Licence': ctx.licenceB64,
      },
      body: payload === '' ? undefined : payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { throw new SyncFail('offline'); }
  const text = await readBounded(res, MAX_RESPONSE_BYTES).catch(() => null);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (res.status === 401 || res.status === 403) throw new SyncFail('unauthorized');
  if (res.status === 503) throw new SyncFail('paused');
  if (res.status === 409) throw new SyncFail((json && json.error && json.error.code) || 'conflict');
  if (!res.ok) throw new SyncFail('server_error');
  return json || {};
}

// ─── ЧАСТИ ТАКТА ────────────────────────────────────────────────────────────

async function pushKeys(ctx, state) {
  const keys = { ...buildKeys(ctx.db, { now: ctx.now() }), box_key: ctx.identity.boxPublic };
  const hash = contentHash(keys);
  const stale = !state.keys_at || ctx.now() - Date.parse(state.keys_at) >= HEARTBEAT_MS;
  if (hash === state.keys_hash && !stale) return false;
  await call(ctx, 'PUT', '/keys', keys);
  saveState(ctx.db, { keys_hash: hash, keys_at: isoOf(ctx.now()) });
  return true;
}

async function pushSnapshot(ctx, state) {
  const { snapshot, media } = buildSnapshot(ctx.db, { storageDir: ctx.storageDir, now: ctx.now() });
  const hash = contentHash(snapshot);
  const stale = !state.snapshot_at || ctx.now() - Date.parse(state.snapshot_at) >= HEARTBEAT_MS;
  if (hash === state.snapshot_hash && !stale) return false;
  if (media.length) {
    const check = await call(ctx, 'POST', '/media/check', { hashes: media.map((m) => m.sha256) });
    const missing = new Set(Array.isArray(check.missing) ? check.missing : []);
    for (const m of media.filter((x) => missing.has(x.sha256))) {
      let buf;
      try { buf = fs.readFileSync(m.file); } catch { continue; }
      // Ревью 8a, I3: сервер не принял один файл (велик, 413) — пропустить его, а
      // не снимок целиком: партнёры увидят клинику без этой картинки; файл
      // попробуем снова, когда снимок пойдёт повторно (не реже 15 минут).
      try { await call(ctx, 'PUT', '/media/' + m.sha256 + '.' + m.ext, undefined, { raw: buf, type: m.type }); } catch (e) {
        if (!(e instanceof SyncFail) || FATAL_REASONS.has(e.reason)) throw e;
        console.warn('[public-api] файл', m.sha256.slice(0, 12), 'не принят публичным сервером:', e.reason);
      }
    }
  }
  await call(ctx, 'PUT', '/snapshot', snapshot);
  saveState(ctx.db, { snapshot_hash: hash, snapshot_at: isoOf(ctx.now()) });
  return true;
}

async function pushSlots(ctx, state, force) {
  const due = force || !state.slots_at || ctx.now() - Date.parse(state.slots_at) >= SLOTS_EVERY_MS;
  if (!due) return false;
  const slots = buildSlots(ctx.db, { now: ctx.now() });
  const hash = contentHash(slots);
  const stale = !state.slots_at || ctx.now() - Date.parse(state.slots_at) >= HEARTBEAT_MS;
  if (hash === state.slots_hash && !stale) { saveState(ctx.db, { slots_at: isoOf(ctx.now()) }); return false; }
  await call(ctx, 'PUT', '/slots', slots);
  saveState(ctx.db, { slots_hash: hash, slots_at: isoOf(ctx.now()) });
  return true;
}

async function pushEvents(ctx) {
  let sent = 0;
  for (;;) {
    const rows = unsentEvents(ctx.db, EVENTS_BATCH);
    if (!rows.length) return sent;
    const events = rows.map((r) => ({ seq: r.id, event: r.event, status: r.status, body: r.body, webhook_url: r.webhook_url, signature: r.signature }));
    let res;
    try { res = await call(ctx, 'POST', '/events', { events }); } catch (e) { markFailed(ctx.db, rows.map((r) => r.id), e.reason); throw e; }
    const accepted = new Set((Array.isArray(res.accepted) ? res.accepted : []).map(Number));
    const ids = rows.map((r) => r.id).filter((id) => accepted.has(id));
    markSent(ctx.db, ids, ctx.now());
    sent += ids.length;
    if (ids.length < rows.length) return sent;   // часть не приняли — остальное в следующий такт
  }
}

async function pullInbox(ctx, state) {
  // Повторная проверка 8a, п. 3: миг чтения — ДО запроса; конец такта (last_ok_at)
  // для этого не годится: медленный остаток такта уводит его за срок предложения.
  const readAt = ctx.now();
  const res = await call(ctx, 'GET', '/inbox?after=' + encodeURIComponent(state.inbox_cursor || ''));
  const items = Array.isArray(res.items) ? res.items : [];
  let cursor = state.inbox_cursor || '';
  let applied = 0;
  let skipped = 0;
  let stuck = false;
  const skippedIds = [];
  const sealedIds = [];
  // Решения владельца 18–19: срок держания назначает клиника в миг приёма —
  // публичный сервер узнаёт его из подтверждения очереди (held) и показывает в
  // GET /requests/{id}. Читается из строки заявки, а не из ответа ingestItem:
  // если прежнее подтверждение не дошло и элемент пришёл снова (повтор номера),
  // срок всё равно уходит.
  const held = new Map();
  const heldRow = ctx.db.prepare("SELECT public_id, hold_until FROM api_requests WHERE public_id = ? AND status = 'pending' AND hold_until IS NOT NULL");
  for (const it of items) {
    let item = it;
    if (it && it.sealed) {
      // Ревью 8a, I4: не открылось ключом клиники (ключ потерян и выпущен заново —
      // риск 6 дизайна) — открыть нельзя никогда: пропустить и подтвердить (сервер
      // сотрёт шифротекст, решение 16), но оставить след — номер заявки в журнале
      // сервера и в состоянии обмена (без данных пациента), а экран «API»
      // предупреждает, пока администратор не сбросит.
      try { item = { ...it, patient: openSealed(ctx.identity, it.sealed) }; } catch {
        const pub = String(it.public_id || '');
        console.warn('[public-api] заявка', pub, 'не открылась ключом клиники — пропущена, обратитесь в Easy-Med');
        sealedIds.push(pub);
        skipped += 1; cursor = String(it.cursor || cursor); continue;
      }
    }
    let r;
    try { r = await ctx.ingest(ctx.db, item, { now: ctx.now(), kekPath: ctx.kekPath }); } catch (e) {
      // Ревью 8a, C1. Ограничение базы — элемент не принять никогда: пропустить,
      // запомнить номер (без данных пациента), идти дальше — иначе один элемент
      // остановил бы приём всей очереди навсегда. Сбой программы — дальше не идём
      // и курсор не двигаем (следующий такт попробует снова), но не дольше
      // STUCK_MAX_TRIES тактов подряд на одном элементе; экран тем временем
      // говорит «ошибка», а не «работает».
      const pub = String((it && it.public_id) || '');
      const at = String((it && it.cursor) || '');
      const tries = state.stuck_cursor === at ? (Number(state.stuck_tries) || 0) + 1 : 1;
      if (isPermanent(e) || tries >= STUCK_MAX_TRIES) {
        console.warn('[public-api] заявка', pub, 'пропущена — клиника не может её принять:', e && e.message);
        skippedIds.push(pub);
        cursor = String(at || cursor);
        continue;
      }
      console.warn('[public-api] заявка', pub, 'не принята (попытка', tries + '):', e && e.message);
      saveState(ctx.db, { stuck_cursor: at, stuck_tries: tries });
      stuck = true;
      break;
    }
    if (r && r.applied) applied += 1;
    const h = it && typeof it.public_id === 'string' ? heldRow.get(it.public_id) : null;
    if (h) held.set(h.public_id, { request_id: h.public_id, hold_until: h.hold_until });
    cursor = String((it && it.cursor) || cursor);
  }
  if (cursor && cursor !== (state.inbox_cursor || '')) {
    await call(ctx, 'POST', '/inbox/ack', { cursor, held: [...held.values()] });
    saveState(ctx.db, { inbox_cursor: cursor });
  }
  noteSkipped(ctx.db, skippedIds, ctx.now());
  noteSkipped(ctx.db, sealedIds, ctx.now(), 'sealed');
  if (!stuck && (state.stuck_cursor || state.stuck_tries)) saveState(ctx.db, { stuck_cursor: '', stuck_tries: 0 });
  // Очередь прочитана до конца — всё, что лежало на сервере к readAt, принято.
  // Застрял элемент — нет: за ним может лежать ответ партнёра (п. 3).
  if (!stuck) saveState(ctx.db, { inbox_read_at: isoOf(readAt) });
  return { applied, skipped, stuck, received: items.length };
}

// ─── ТАКТ ───────────────────────────────────────────────────────────────────

let inFlight = false;

/**
 * Один такт обмена. Никогда не бросает.
 * @returns {Promise<{ok:boolean, reason?:string, applied?:number, sent?:number}>}
 */
export async function syncOnce(db, dataDir, opts = {}) {
  if (inFlight) return { ok: false, reason: 'busy' };
  inFlight = true;
  try { return await performSync(db, dataDir, opts); } catch (e) {
    console.warn('[public-api] такт обмена не удался:', e && e.message);
    const at = typeof opts.now === 'function' ? opts.now() : Date.now();   // M4 — часы такта
    saveState(db, { last_error: 'server_error', last_error_at: isoOf(at) });
    return { ok: false, reason: 'server_error' };
  } finally { inFlight = false; }
}

async function performSync(db, dataDir, opts) {
  const { fetchImpl = globalThis.fetch, env = process.env, now = () => Date.now(), keyPath = path.join(dataDir, SYNC_KEY_FILE),
    kekPath = null, storageDir = path.join(dataDir, 'storage'), ingestImpl = ingestItem } = opts;
  // Своя работа — всегда: истечение удержаний и судьба визитов (партнёр узнает,
  // когда связь будет).
  expireDue(db, { now: now(), kekPath });
  syncVisitOutcomes(db, { now: now(), kekPath });

  const local = localBlocker(db);
  if (local) return { ok: false, reason: local };
  // Ревью 8a, M4: испорчены оба файла ключа — не «ждём Easy-Med» и не общая
  // ошибка, а «ключ повреждён — обратитесь в Easy-Med»: само не заживёт (сверка
  // не отдаёт открытый ключ, пока файл испорчен).
  let identity;
  try { identity = loadSyncIdentity({ keyPath, create: true }); } catch (e) {
    if (!(e instanceof SyncIdentityError)) throw e;
    console.warn('[public-api] файл ключа обмена повреждён — обратитесь в Easy-Med');
    saveState(db, { last_error: 'key_broken', last_error_at: isoOf(now()) });
    return { ok: false, reason: 'key_broken' };
  }
  const vendor = vendorBlocker(dataDir, identity);
  if (vendor) return { ok: false, reason: vendor };

  assertPublicUrlIsTestSafe(env, fetchImpl);
  const control = readJson(path.join(dataDir, 'control.json'));
  const ctx = {
    db, fetchImpl, now, kekPath, storageDir, identity, ingest: ingestImpl,
    base: publicBaseUrl(env), clinicId: control.clinic_id,
    licenceB64: Buffer.from(readText(path.join(dataDir, 'licence.dat')) || '', 'utf8').toString('base64'),
  };
  saveState(db, { last_poll_at: isoOf(now()) });
  // Ревью 8a, I3: снимок (с файлами) и время — каждый в своём try: их отказ
  // записывается причиной и не останавливает события и очередь. Ключи, события
  // и очередь — как прежде: отказ любого кончает такт.
  let partial = '';
  const soft = async (fn) => {
    try { return await fn(); } catch (e) {
      if (!(e instanceof SyncFail) || FATAL_REASONS.has(e.reason)) throw e;
      console.warn('[public-api] часть обмена не принята сервером:', e.reason);
      if (!partial) partial = e.reason;
      return false;
    }
  };
  try {
    let state = readState(db) || {};
    await pushKeys(ctx, state);
    state = readState(db) || {};
    await soft(() => pushSnapshot(ctx, state));
    let sent = await pushEvents(ctx);
    state = readState(db) || {};
    const inbox = await pullInbox(ctx, state);
    state = readState(db) || {};
    await soft(() => pushSlots(ctx, state, inbox.applied > 0));
    if (inbox.applied) sent += await pushEvents(ctx);
    // C1: элемент, на котором приём стоит, — «ошибка» на экране, пока не пройдёт.
    // I4: неоткрывшееся — не «ошибка обмена» (обмен работает), а пропуск в skipped.
    const err = inbox.stuck ? 'intake_failed' : partial;
    saveState(db, { last_ok_at: isoOf(now()), last_error: err, last_error_at: err ? isoOf(now()) : null });
    return partial ? { ok: false, reason: partial, applied: inbox.applied, sent } : { ok: true, applied: inbox.applied, sent };
  } catch (e) {
    if (!(e instanceof SyncFail)) throw e;
    saveState(db, { last_error: e.reason, last_error_at: isoOf(now()) });
    return { ok: false, reason: e.reason };
  }
}

const skippedOf = (st) => ({ sealed: Number(st.skipped_sealed) || 0, failed: Number(st.skipped_failed) || 0, last_at: st.skipped_last_at || null, last_ids: parseIds(st.skipped_last_ids) });
const parseIds = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

/** Для экрана «API»: идёт ли обмен и что с ним. */
export function syncStatus(db, dataDir, { keyPath = path.join(dataDir, SYNC_KEY_FILE) } = {}) {
  const st = readState(db) || {};
  let pendingEvents = 0;
  let waiting = 0;
  try { pendingEvents = db.prepare('SELECT COUNT(*) AS n FROM api_outbox WHERE sent_at IS NULL').get().n; } catch { pendingEvents = 0; }
  try { waiting = db.prepare("SELECT COUNT(*) AS n FROM api_requests WHERE status IN ('new', 'pending', 'offered')").get().n; } catch { waiting = 0; }
  const local = localBlocker(db);
  let identity = null;
  let keyBroken = false;
  try { identity = loadSyncIdentity({ keyPath }); } catch (e) { identity = null; keyBroken = e instanceof SyncIdentityError; }
  const vendor = local || keyBroken ? '' : vendorBlocker(dataDir, identity);
  // M4: повреждённый ключ — «ошибка: key_broken»; нет файла — по-прежнему решает лицензия.
  if (!local && keyBroken) {
    return {
      state: 'error', reason: 'key_broken', last_ok_at: st.last_ok_at || null, last_error: 'key_broken', last_error_at: st.last_error_at || null,
      pending_events: pendingEvents, waiting_requests: waiting, skipped: skippedOf(st),
    };
  }
  const state = local ? 'off' : vendor ? 'waiting_vendor' : st.last_error && (!st.last_ok_at || st.last_error_at >= st.last_ok_at) ? 'error' : st.last_ok_at ? 'ok' : 'starting';
  return {
    state, reason: local || vendor || st.last_error || '',
    last_ok_at: st.last_ok_at || null, last_error: st.last_error || '', last_error_at: st.last_error_at || null,
    pending_events: pendingEvents, waiting_requests: waiting,
    // C1: пропущенные элементы очереди — до сброса администратором.
    skipped: skippedOf(st),
  };
}

/**
 * Ревью 8a, I4 — администратор увидел предупреждение о пропущенных заявках
 * (и, если нужно, позвонил в Easy-Med): счётчики и номера сбрасываются.
 */
export function ackSkipped(db) {
  saveState(db, { skipped_sealed: 0, skipped_failed: 0, skipped_last_at: null, skipped_last_ids: '[]' });
}

// ─── РАСПИСАНИЕ ─────────────────────────────────────────────────────────────

let timer = null;
let armFn = null;

/** Разбудить обмен сейчас (RPC подключений после записи; подтверждение заявки). */
export function wakePublicSync() { if (armFn) armFn(0); }

/** Включает такт в работающем процессе; { stop }. Таймеры unref — остановке сервера не мешают. */
export function schedulePublicSync(db, dataDir, opts = {}) {
  const { initialDelayMs = INITIAL_DELAY_MS, everyMs = POLL_MS, ...tickOpts } = opts;
  let stopped = false;
  const arm = (ms) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
    if (timer.unref) timer.unref();
  };
  const tick = () => {
    syncOnce(db, dataDir, tickOpts)
      .catch((e) => console.warn('[public-api] такт:', e && e.message))
      .finally(() => arm(everyMs));
  };
  armFn = arm;
  arm(initialDelayMs);
  return { stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; armFn = null; } };
}
