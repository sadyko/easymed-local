// CALL_RING_V1 (2026-10-17) — ЖИВЫЕ ЗВОНКИ: ЧТО ЗВОНИТ ПРЯМО СЕЙЧАС.
//
// Владелец: «is it possible to ring here and number with patient name appear».
// Журнал звонков (таблица calls) — это прошлое: строка появляется, когда звонок
// кончился и станция отдала историю. Здесь — настоящее: звонок, о котором
// станция сказала «начался», пока не сказала «кончился». Память процесса, не
// база: через три минуты это уже не новость, а строка журнала.
//
// ОТКУДА СОБЫТИЯ. Три двери, один разборщик (pbx-event.js):
//   • вебхук onlinePBX на публичном сервере — клиника за NAT, поэтому забирает
//     события сама ДЛИННЫМ ОПРОСОМ по подписанному каналу обмена
//     (GET /_sync/v1/pbx-events?after&wait=20; контекст — buildSyncContext из
//     api/public-sync.js: тот же ключ, та же лицензия, тот же адрес);
//   • тот же вебхук прямо на клинике (ring-webhook.js), если у неё есть адрес;
//   • Binotel «кто звонит» (webhooks.js callSettings).
//
// ОПРОС ИДЁТ ТОЛЬКО ПРИ СПРОСЕ. Панель «Телефон» спрашивает telephony_live раз в
// две секунды у каждого, кому телефон положен; каждый вопрос продлевает спрос на
// 30 секунд. Нет открытых программ — нет запросов к публичному серверу: ночью
// канал молчит, как и такт обмена без работы.
//
// ИМЯ ПАЦИЕНТА ПОДБИРАЕТСЯ ЗДЕСЬ, НА КЛИНИКЕ: на публичный сервер уезжают только
// номера, и то на десять минут. Тот же поиск по номеру, что у журнала и бота
// (findPatientsByPhone), и та же заявка, что нашла бы доска (leadsForPhone).
import { findPatientsByPhone } from '../telegram/documents.js';
import { leadsForPhone } from '../crm/lead-from-call.js';
import { buildSyncContext, call as syncCall, vendorBlocker } from '../api/public-sync.js';
import { loadSyncIdentity, SYNC_KEY_FILE } from '../api/sync-identity.js';
import { readSettingsRow } from './settings.js';
import { RING, ANSWER, END } from './pbx-event.js';
import path from 'node:path';

/** Спрос панели живёт полминуты: опрос раз в 2 с продлевает его, закрытая программа — нет. */
export const DEMAND_TTL_MS = 30_000;
/** Законченный звонок виден ещё 15 секунд («Пропущен» + «Перезвонить»), потом — только журнал. */
export const ENDED_KEEP_MS = 15_000;
/** Звонок без «кончился» (событие потерялось) — не вечно: три минуты для звонящего, час для разговора. */
export const RINGING_MAX_MS = 3 * 60_000;
export const ANSWERED_MAX_MS = 60 * 60_000;
/** Длинный опрос: сервер держит запрос до 20 секунд; сбой сети — пауза 10 секунд. */
export const PULL_WAIT_SEC = 20;
export const PULL_BACKOFF_MS = 10_000;

const calls = new Map();   // uuid → живой звонок
let lastDemandAt = 0;
let cursor = '';           // номер последнего забранного события публичного сервера
let unknownLogged = 0;

/** Для стендов: забыть всё, как после перезапуска сервера. */
export function resetLive() { calls.clear(); lastDemandAt = 0; cursor = ''; unknownLogged = 0; }

export function demandLive(now = Date.now()) { lastDemandAt = now; }
export function liveDemanded(now = Date.now()) { return lastDemandAt > 0 && now - lastDemandAt < DEMAND_TTL_MS; }
/** Курсор опроса — для стендов и диагностики. */
export function liveCursor() { return cursor; }

function enrich(db, number) {
  let patient = null;
  let lead = null;
  try {
    const p = findPatientsByPhone(db, number, 1)[0];
    if (p) patient = { id: p.id, full_name: p.full_name || '', mrn: p.mrn || '' };
  } catch { patient = null; }
  try {
    const l = leadsForPhone(db, number, { open: true })[0];
    if (l) lead = { id: l.id, full_name: l.full_name || '', status: l.status || '' };
  } catch { lead = null; }
  return { patient, lead };
}

function prune(now) {
  for (const [k, c] of calls) {
    const age = now - c.updated;
    if (c.state === 'ended' ? age > ENDED_KEEP_MS : c.state === 'answered' ? age > ANSWERED_MAX_MS : age > RINGING_MAX_MS) calls.delete(k);
  }
}

/**
 * Событие станции → живое состояние. Возвращает запись звонка или null (нечего
 * показывать: непонятное событие, конец звонка, начала которого мы не видели).
 */
export function noteEvent(db, ev, now = Date.now()) {
  if (!ev) return null;
  if (ev.unknown) {
    // Имена полей — без значений: по ним уточняется схема станции, номера пациентов в журнал не попадают.
    if (unknownLogged < 3) { unknownLogged++; console.warn('[ring] непонятное событие станции; поля: ' + (ev.keys || []).join(', ')); }
    return null;
  }
  prune(now);
  let c = calls.get(ev.uuid);
  if (!c) {
    // Конец звонка, начала которого не видели (спрос появился посреди разговора):
    // показывать нечего — строка приедет в журнал обычным путём.
    if (ev.event === END) return null;
    const number = ev.direction === 'out' ? ev.callee : ev.caller;   // номер пациента
    c = { uuid: ev.uuid, direction: ev.direction, caller: ev.caller, callee: ev.callee, number,
      state: 'ringing', was_answered: false, since: ev.at, answered_at: null, ended_at: null, updated: now, ...enrich(db, number) };
    calls.set(ev.uuid, c);
  }
  if (ev.event === ANSWER) { c.state = 'answered'; c.was_answered = true; c.answered_at = ev.at; }
  else if (ev.event === END) {
    c.state = 'ended'; c.ended_at = ev.at;
    // FIX_318_V1 (C2) — конец Binotel несёт «разговор был» сам: события «ответили» у него нет.
    if (ev.answered && !c.was_answered) { c.was_answered = true; c.answered_at = ev.at; }
  }
  else if (ev.event === RING && c.state === 'ended') { /* повтор начала после конца — не воскрешать */ }
  c.updated = now;
  return c;
}

/** Живые звонки для панели — свежие первыми. Копии: панель их не правит. */
export function liveCalls(now = Date.now()) {
  prune(now);
  return [...calls.values()].sort((a, b) => b.updated - a.updated).map((c) => ({ ...c }));
}

/**
 * Один длинный опрос публичного сервера: события после курсора, ждать до 20 с.
 * Бросает то же, что call() (SyncFail с причиной) — цикл решает, когда повторить.
 */
export async function pullOnce(ctx, { callImpl = syncCall, now = Date.now } = {}) {
  const res = await callImpl(ctx, 'GET', '/pbx-events?after=' + encodeURIComponent(cursor) + '&wait=' + PULL_WAIT_SEC);
  const items = Array.isArray(res && res.items) ? res.items : [];
  for (const it of items) {
    if (it && it.id !== undefined && it.id !== null) cursor = String(it.id);
    noteEvent(ctx.db, it, now());
  }
  return { ok: true, count: items.length };
}

/**
 * Откуда панель может узнать о звонке: 'relay' — через публичный сервер (клиника
 * включена для обмена), 'direct' — только прямой адрес (есть публичный адрес
 * клиники и токен), 'off' — ниоткуда; reason — почему не relay (как у vendorBlocker).
 */
export function liveSource(db, dataDir, { keyPath = path.join(dataDir, SYNC_KEY_FILE) } = {}) {
  let identity = null;
  try { identity = loadSyncIdentity({ keyPath, create: false }); } catch { identity = null; }
  // FIX_318_V1 (C3) — нет ключа обмена у зарегистрированной установки — не «не
  // зарегистрирована», а «ключа ещё нет» (его заводит такт обмена ради адреса станции).
  const reason = identity ? vendorBlocker(dataDir, identity) : (vendorBlocker(dataDir, null) === 'not_enrolled' ? 'not_enrolled' : 'no_sync_key');
  if (!reason) return { source: 'relay', reason: '' };
  const row = readSettingsRow(db) || {};
  if (row.ring_token && row.public_base_url) return { source: 'direct', reason };
  return { source: 'off', reason };
}

let timer = null;
let stopped = true;

/**
 * Цикл длинного опроса. Крутится, только пока есть спрос (liveDemanded): без
 * спроса — проверка раз в секунду без сети; заблокирован обмен — раз в 5 секунд;
 * сбой сети — пауза 10 секунд и одна строка в журнал не чаще раза в минуту.
 * Ничего не бросает наружу: падение телефонии не стоит работы клиники.
 */
export function scheduleLivePull(db, dataDir, opts = {}) {
  const { buildContext = buildSyncContext, callImpl = syncCall, now = Date.now, idleMs = 1000, blockedMs = 5000,
    backoffMs = PULL_BACKOFF_MS, log = console, ...ctxOpts } = opts;
  stopped = false;
  let warnedAt = 0;
  const arm = (ms) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
    if (timer.unref) timer.unref();
  };
  const tick = async () => {
    if (stopped) return;
    if (!liveDemanded(now())) return arm(idleMs);
    let ctx;
    try { ctx = buildContext(db, dataDir, { ...ctxOpts, now, createKey: false }); } catch (e) { ctx = { blocked: 'server_error' }; }
    if (!ctx || ctx.blocked) return arm(blockedMs);
    try {
      await pullOnce(ctx, { callImpl, now });
      arm(0);
    } catch (e) {
      if (now() - warnedAt > 60_000) { warnedAt = now(); log.warn('[ring] живые события станции не забрались: ' + ((e && e.reason) || (e && e.message) || e)); }
      arm(backoffMs);
    }
  };
  arm(idleMs);
  return { stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; } };
}
