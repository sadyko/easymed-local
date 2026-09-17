// ONLINEPBX_V1 (2026-09-14) — клиент HTTP API onlinePBX.
//
// Владелец: «we will add another (onlinePBX) … flow should be exactly like
// that [as Binotel]». Контракт взят из машиночитаемого описания API самого
// провайдера (https://api2.onlinepbx.ru/documentation/json, «onlinePBX HTTP
// API 2.10.1»), а не пересказан по памяти:
//
//   • сервер — https://api2.onlinepbx.ru, у клиента свой домен вида
//     example.onpbx.ru, и он стоит в ПУТИ каждого запроса: /{domain}/…;
//   • ключ доступа получают ОДИН раз: POST /{domain}/auth.json с auth_key из
//     панели → {key_id, key}. Дальше каждый запрос несёт заголовок
//     x-pbx-authentication: "key_id:key". Ключ живёт три дня с последнего
//     обращения; ответ {isNotAuth: true} значит «получи ключ заново» — и
//     ТОЛЬКО он: запрашивать ключ на каждый вызов нельзя, провайдер
//     предупреждает, что частая авторизация ломает сессии;
//   • история звонков — POST /{domain}/mongo_history/search.json,
//     start_stamp_from (unix), accountcode inbound|outbound|local|missed;
//     звонок доступен по API с задержкой до минуты, окно запроса — неделя;
//   • позвонить — POST /{domain}/call/now.json {from, to}; не чаще пяти
//     запросов в секунду.
//
// Тело запросов — application/x-www-form-urlencoded, ответ — JSON со
// status "1" (успех) или "0" + comment. Всё это здесь и только здесь: опрос,
// проверка подключения и «позвонить» зовут одну функцию.
import { readBounded } from '../control/checkin.js';

export const ONLINEPBX_API_BASE = 'https://api2.onlinepbx.ru';
const TIMEOUT_MS = 15_000;
// Measured live (2026-09-14): six days of one clinic's history is 2.1 MB —
// every call carries its events array. A tick normally re-reads only the
// two-minute overlap, but a poller that was switched off for a week must
// still be able to catch up in one answer.
const MAX_BYTES = 16_000_000;

/** Домен без схемы, пути и пробелов: «clinic.onpbx.ru». */
export function normalizeDomain(v) {
  return String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function form(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k + '[]', String(x)));
    else p.append(k, String(v));
  }
  return p.toString();
}

async function post(domain, pathName, params, { headers = {}, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  let res;
  try {
    res = await fetchImpl(`${ONLINEPBX_API_BASE}/${encodeURIComponent(domain)}/${pathName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: form(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: 'offline' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'bad_credentials' };
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (!res.ok) return { ok: false, reason: 'server_error' };
  let text;
  try { text = await readBounded(res, maxBytes); } catch { return { ok: false, reason: 'bad_response' }; }
  if (text === null) return { ok: false, reason: 'bad_response' };
  let body;
  try { body = JSON.parse(text); } catch { return { ok: false, reason: 'bad_response' }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'bad_response' };
  if (body.isNotAuth) return { ok: false, reason: 'not_auth' };
  if (String(body.status) !== '1') {
    const msg = String(body.comment || '');
    return { ok: false, reason: /auth|key/i.test(msg) ? 'bad_credentials' : 'server_error', comment: msg };
  }
  return { ok: true, data: body.data };
}

/**
 * Получить пару key_id/key по auth_key из панели.
 * @returns {Promise<{ok:true, key_id:string, key:string}|{ok:false, reason:string}>}
 */
export async function pbxAuth(domain, authKey, opts = {}) {
  const d = normalizeDomain(domain);
  if (!d || !authKey) return { ok: false, reason: 'bad_credentials' };
  const r = await post(d, 'auth.json', { auth_key: String(authKey).trim(), new: 'true' }, opts);
  if (!r.ok) return r.reason === 'not_auth' ? { ok: false, reason: 'bad_credentials' } : r;
  const data = r.data || {};
  if (!data.key_id || !data.key) return { ok: false, reason: 'bad_response' };
  return { ok: true, key_id: String(data.key_id), key: String(data.key) };
}

/**
 * Один запрос к API с уже выданным ключом. `creds` — {key_id, key}.
 * При «ключ протух» (isNotAuth) — ровно ОДНА повторная авторизация по
 * auth_key и повтор запроса; новую пару отдаём наверх через onRenew.
 */
export async function pbxCall(domain, pathName, params, { creds, authKey, onRenew, ...opts } = {}) {
  const d = normalizeDomain(domain);
  let c = creds && creds.key_id && creds.key ? creds : null;
  if (!c) {
    if (!authKey) return { ok: false, reason: 'bad_credentials' };
    const a = await pbxAuth(d, authKey, opts);
    if (!a.ok) return a;
    c = { key_id: a.key_id, key: a.key };
    if (onRenew) await onRenew(c);
  }
  let r = await post(d, pathName, params, { ...opts, headers: { 'x-pbx-authentication': c.key_id + ':' + c.key } });
  if (!r.ok && r.reason === 'not_auth' && authKey) {
    const a = await pbxAuth(d, authKey, opts);
    if (!a.ok) return a;
    c = { key_id: a.key_id, key: a.key };
    if (onRenew) await onRenew(c);
    r = await post(d, pathName, params, { ...opts, headers: { 'x-pbx-authentication': c.key_id + ':' + c.key } });
  }
  if (!r.ok && r.reason === 'not_auth') return { ok: false, reason: 'bad_credentials' };
  return r;
}

/**
 * История звонков с момента `sinceUnix` (не старше недели — так у провайдера).
 *
 * CALL_RECORDING_V1 — download=1 ОБЯЗАТЕЛЕН, иначе записи разговоров не будет
 * вовсе. Владелец: «we dont have any audios uploaded to the system. we cannot
 * play the records» — и он прав: в сохранённых ответах станции нет ни одного
 * поля, похожего на запись (uuid, caller_id_*, start_stamp, hangup_cause,
 * events — и всё). Ссылку onlinePBX добавляет к ответу ТОЛЬКО по этому флагу;
 * без него мы честно спрашивали историю без записей и честно ничего не
 * получали.
 */
export function pbxHistory(domain, sinceUnix, o = {}) {
  const from = Math.max(Number(sinceUnix) || 0, Math.floor(Date.now() / 1000) - 7 * 86400 + 60);
  return pbxCall(domain, 'mongo_history/search.json', { start_stamp_from: from, download: 1 }, o);
}

/** Позвонить: сначала набирается `from` (внутренний номер), затем `to`. */
export function pbxCallNow(domain, from, to, o = {}) {
  return pbxCall(domain, 'call/now.json', { from: String(from), to: String(to) }, o);
}

/**
 * Звонок onlinePBX → строка `calls` в словаре Binotel (call_type 0/1,
 * disposition ANSWER/NOANSWER/CANCEL/BUSY, waitsec/billsec). Один словарь на
 * все провайдеры: журнал, маршрут «звонок → заявка» и экран читают ЕГО, а не
 * язык каждого вендора.
 *
 * Поля сверены с живой историей клиники (2026-09-14, 3250 звонков за шесть
 * дней), а не только со спецификацией:
 *   • accountcode — inbound | outbound (missed/local в этой истории не
 *     встретились, но спецификация их обещает — missed считается входящим);
 *   • у входящего caller_id_number — внешний номер, destination_number —
 *     очередь или добавочный; КТО ответил, лежит в events[type=user] с
 *     answered_stamp — это и есть internal_number;
 *   • user_talk_time > 0 — с сотрудником говорили (ANSWER); иначе исход
 *     уточняет hangup_cause: USER_BUSY → BUSY, ORIGINATOR_CANCEL (звонящий
 *     повесил трубку, пока звонило) → CANCEL, всё остальное → NOANSWER.
 */
export function normalizePbxCall(c) {
  if (!c || typeof c !== 'object' || !c.uuid) return null;
  const start = Number(c.start_stamp);
  if (!Number.isFinite(start) || start <= 0) return null;
  const code = String(c.accountcode || '').toLowerCase();
  const outbound = code === 'outbound';
  const caller = c.caller_id_number == null ? '' : String(c.caller_id_number);
  const callee = c.destination_number == null ? '' : String(c.destination_number);
  const talk = Number(c.user_talk_time) || 0;
  const duration = Number(c.duration) || 0;
  const answered = talk > 0;

  // Добавочный, снявший трубку: событие «user» с answered_stamp. Без него —
  // последний набранный добавочный (destination_number).
  const events = Array.isArray(c.events) ? c.events : [];
  const who = events.find((e) => e && e.type === 'user' && e.answered_stamp && e.number != null);
  const answeredAt = who ? Number(who.answered_stamp) : NaN;
  const internal = outbound ? caller : (who ? String(who.number) : callee);

  let disposition = 'ANSWER';
  if (!answered) {
    const cause = String(c.hangup_cause || '').toUpperCase();
    disposition = cause === 'USER_BUSY' ? 'BUSY' : cause === 'ORIGINATOR_CANCEL' ? 'CANCEL' : 'NOANSWER';
  }
  const wait = answered && Number.isFinite(answeredAt) && answeredAt >= start
    ? answeredAt - start
    : Math.max(0, duration - talk);
  return {
    general_call_id: 'onlinepbx:' + String(c.uuid),
    started_at: new Date(start * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    call_type: outbound ? 1 : 0,
    external_number: outbound ? callee : caller,
    internal_number: internal,
    waitsec: wait,
    billsec: talk,
    disposition,
    is_new_call: null,
    raw: c,
  };
}
