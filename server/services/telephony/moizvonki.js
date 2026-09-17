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
//   • история — action "calls.get_calls"; при supervised=1 в ответе есть
//     user_account и user_id, то есть чей это звонок;
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

/** Домен без схемы, пути и пробелов: «clinic.moizvonki.ru». */
export function normalizeMzDomain(v) {
  return String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
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
  return mzCall(domain, 'calls.get_calls', { start_time: from, supervised: 1 }, opts);
}
