// MOIZVONKI_V1 (2026-09-17) — клиент API «Моих Звонков».
//
// Владелец: «(farhodmadadshifo.moizvonki.ru) … do not hardcode the my calls.
// leave only the fields for call and api (like in the pbx and binotel)».
// Поэтому здесь НЕТ ни домена, ни ключа: и то и другое вводится в настройках,
// как у onlinePBX, и хранится в telephony_providers (ключ — в закрытой части,
// наружу не выходит никогда).
//
// Контракт — из документации провайдера (https://www.moizvonki.ru/guide/api/):
//
//   • адрес один на все действия: POST https://{домен}/api/v1, тело — JSON,
//     заголовок Content-Type: application/json ОБЯЗАТЕЛЕН (с другим типом
//     запрос отвергается);
//   • подпись — не заголовок и не OAuth: поля user_name (почта сотрудника) и
//     api_key лежат В ТЕЛЕ каждого запроса, рядом с action;
//   • позвонить — action "calls.make_call" с полем to;
//   • история — action "calls.list" (MOIZVONKI_V2, 2026-10-17: в первой
//     версии стояло "calls.get_calls" — такого действия в действующей
//     документации нет). Курсор — from_id (db_call_id, включительно) или
//     from_date (UTC-секунды), страницы — from_offset ← results_next_offset,
//     пока results_remains > 0; при supervised=1 в ответе есть user_account и
//     user_id, то есть чей это звонок;
//   • события — action "webhook.subscribe" с картой «событие → адрес»:
//     call.start, call.answer, call.finish, sms.message.
//
// ЧЕМ ЭТА ТЕЛЕФОНИЯ ОТЛИЧАЕТСЯ ОТ ДВУХ ДРУГИХ, и почему это важно знать
// читателю: Binotel и onlinePBX — это АТС, там команда «позвони» идёт станции,
// и звонящим выступает внутренний номер сотрудника. У «Моих Звонков» станции
// нет: команда уходит на СМАРТФОН сотрудника, и звонит его сим-карта. Отсюда
// два следствия, которые не спрятать за общим разъёмом:
//   1. «кто звонит» здесь — учётная запись (почта), а не внутренний номер;
//   2. если телефон был без сети, сведения о звонке приезжают с опозданием, а
//      иногда только событием call.finish — сразу с итогом и длительностью.
//
// Как и binotel.js, этот файл НИЧЕГО НЕ ЛОГИРУЕТ: ключ едет в теле запроса, и
// единственный надёжный способ не утащить его в лог — не писать отсюда ничего.
import { readBounded } from '../control/checkin.js';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 8_000_000;

/**
 * Домен без схемы, пути и пробелов: «clinic.moizvonki.ru».
 *
 * ADMIN_ROWS_GRANTABLE_V1 (ревью безопасности I2) — ТОЛЬКО *.moizvonki.ru.
 * Ключ API уходит в теле каждого запроса на этот адрес: подставь «адрес» своего
 * сервера — и сохранённый ключ клиники уедет туда при первой же проверке
 * связи. Чужой адрес читается как пустой: запроса не будет вовсе.
 */
const MZ_HOST_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+moizvonki\.ru$/;
export function normalizeMzDomain(v) {
  const d = String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  return MZ_HOST_RE.test(d) ? d : '';
}

/**
 * Один запрос к API «Моих Звонков».
 *
 * @param {string} domain   «clinic.moizvonki.ru»
 * @param {string} action   например 'calls.make_call'
 * @param {object} params   поля действия
 * @param {object} opts     {userName, apiKey, fetchImpl, timeoutMs, maxBytes}
 * @returns {Promise<{ok:true, data:object}|{ok:false, reason:string}>}
 *          reason — то же семейство слов, что у Binotel и onlinePBX:
 *          bad_credentials | offline | server_error | bad_response | rate_limited
 */
export async function mzCall(domain, action, params = {}, {
  userName = '',
  apiKey = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
  maxBytes = MAX_BYTES,
} = {}) {
  const d = normalizeMzDomain(domain);
  if (!d || !userName || !apiKey) return { ok: false, reason: 'bad_credentials' };

  let res;
  try {
    res = await fetchImpl(`https://${d}/api/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Подпись СПЕРВА перезаписывается своей: params не должен уметь подменить
      // учётку, от имени которой уходит звонок.
      body: JSON.stringify({ ...params, action: String(action), user_name: String(userName), api_key: String(apiKey) }),
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

  // Провайдер отвечает HTTP 200 и кладёт отказ В ТЕЛО — как Binotel. Неверный
  // ключ поэтому приходит не 401, а полем error/result. Слова про ключ и
  // доступ читаются как «проверьте настройки», всё остальное — как «у них
  // что-то своё»: недообвинить администратора, а не наоборот.
  const err = body.error || body.error_message || (String(body.result || '') === 'error' ? (body.message || 'error') : '');
  if (err) {
    const msg = String(err);
    return { ok: false, reason: /key|auth|access|ключ|доступ/i.test(msg) ? 'bad_credentials' : 'server_error' };
  }
  return { ok: true, data: body };
}

/**
 * Позвонить. Звонок начинается НА ТЕЛЕФОНЕ сотрудника, чья учётка подписала
 * запрос: сначала оживает его трубка, потом набирается пациент — снаружи это
 * выглядит так же, как у АТС.
 *
 * `userName` здесь и есть «кто звонит», поэтому он у вызова свой, а не только
 * из настроек: когда у оператора заведена собственная учётная запись, звонок
 * уходит с его телефона и в разборе по операторам считается ему.
 */
export async function mzDial(domain, to, opts = {}) {
  const r = await mzCall(domain, 'calls.make_call', { to: String(to) }, opts);
  if (!r.ok) return r;
  const id = r.data && (r.data.db_call_id ?? r.data.call_id ?? r.data.id);
  return { ok: true, call_id: id == null ? '' : String(id) };
}

/**
 * Проверка подключения: самый дешёвый запрос, который ничего не меняет и
 * никому не звонит — список звонков за последнюю минуту.
 */
export async function mzHistory(domain, sinceUnix, opts = {}) {
  const from = Math.max(0, Math.floor(Number(sinceUnix) || 0));
  return mzCall(domain, 'calls.list', { from_date: from, from_offset: 0, max_results: 100, supervised: 1 }, opts);
}

// MOIZVONKI_V2 — ИСТОРИЯ ЗВОНКОВ ДЛЯ ОПРОСА.
//
// calls.list по всем страницам ответа. Курсор — либо from_id (db_call_id
// последнего известного звонка + 1: документация советует именно его для
// последовательного забора — звонок с телефона, который был без сети, приезжает
// с опозданием и по дате был бы пропущен, а db_call_id ему выдают при
// загрузке), либо from_date (первый запуск). Отказ на любой странице — отказ с
// той же причиной, но уже собранные звонки отдаются: они идемпотентны по
// general_call_id. Предел страниц — честное truncated, не бесконечный цикл.
const MZ_PAGE = 100;
export async function mzListCalls(domain, { fromId = null, fromDate = null, toDate = null, maxResults = MZ_PAGE, supervised = 1 } = {}, opts = {}) {
  const { maxPages = 20 } = opts;
  const out = [];
  if (!normalizeMzDomain(domain) || !opts.userName || !opts.apiKey) return { ok: false, reason: 'bad_credentials', data: out };
  let offset = 0;
  for (let i = 0; i < maxPages; i++) {
    const params = { from_offset: offset, max_results: maxResults, supervised };
    if (fromId != null && fromId !== '' && Number.isFinite(Number(fromId))) params.from_id = Math.floor(Number(fromId));
    else params.from_date = Math.max(0, Math.floor(Number(fromDate) || 0));
    if (toDate != null) params.to_date = Math.floor(Number(toDate));
    const r = await mzCall(domain, 'calls.list', params, opts);
    if (!r.ok) return { ok: false, reason: r.reason, data: out };
    const d = r.data || {};
    const list = Array.isArray(d.results) ? d.results : (Array.isArray(d.calls) ? d.calls : (Array.isArray(d.result) ? d.result : []));
    out.push(...list);
    const remains = Number(d.results_remains) || 0;
    const next = Number(d.results_next_offset);
    if (!list.length || remains <= 0 || !Number.isFinite(next) || next <= offset) return { ok: true, data: out, truncated: false };
    offset = next;
  }
  return { ok: true, data: out, truncated: true };
}

const isoFromUnix = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Звонок «Моих Звонков» → словарь журнала (как normalizePbxCall у onlinePBX),
 * чтобы recordCall положил его одним INSERT со всеми остальными.
 *
 *   general_call_id  'moizvonki:<db_call_id>' (без него — event_pbx_call_id);
 *   call_type        direction: 0 входящий, 1 исходящий;
 *   external_number  client_number как есть — к «+998…» приводит recordCall;
 *   internal_number  user_account (почта сотрудника — у «Моих Звонков» это и
 *                    есть «кто»), без неё — номер сим-карты;
 *   waitsec/billsec  из answer_time / end_time / duration;
 *   disposition      ANSWER или NOANSWER (пропущенный — answered: 0; причины
 *                    «занято/отменён» сервис не различает);
 *   raw              сам звонок — recordingUrlOf найдёт в нём поле recording.
 */
export function normalizeMzCall(c) {
  if (!c || typeof c !== 'object') return null;
  const start = Number(c.start_time);
  if (!Number.isFinite(start) || start <= 0) return null;
  const has = (v) => v != null && v !== '';
  const id = has(c.db_call_id) ? String(c.db_call_id) : (has(c.event_pbx_call_id) ? String(c.event_pbx_call_id) : '');
  if (!id) return null;
  const outbound = Number(c.direction) === 1;
  const answerAt = Number(c.answer_time) || 0;
  const answered = Number(c.answered) === 1 || answerAt > 0;
  const endAt = Number(c.end_time) || 0;
  const duration = Number(c.duration) || 0;
  const talk = answered ? (duration || Math.max(0, endAt - answerAt)) : 0;
  const wait = answered ? Math.max(0, (answerAt || start) - start) : Math.max(0, endAt ? endAt - start : 0);
  return {
    general_call_id: 'moizvonki:' + id,
    started_at: isoFromUnix(start),
    call_type: outbound ? 1 : 0,
    external_number: c.client_number == null ? '' : String(c.client_number),
    internal_number: String(c.user_account || c.src_number || ''),
    waitsec: wait,
    billsec: talk,
    disposition: answered ? 'ANSWER' : 'NOANSWER',
    is_new_call: null,
    internal: false,
    raw: c,
  };
}
