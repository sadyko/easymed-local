// SMS_INFORM_V1 — клиент SMS-Broker API Play Mobile.
//
// Запрос (спецификация Play Mobile «SMS-Broker API», playmobile.uz):
//   POST <адрес клиники>/broker-api/send
//   Authorization: Basic base64(login:password)
//   { "messages": [ { "recipient": "998901234567", "message-id": "...",
//                     "sms": { "originator": "3700", "content": { "text": "..." } } } ] }
// Успех — HTTP 200; отказ — HTTP 4xx/5xx с телом { "error-code", "error-description" }.
//
// Адрес у каждого клиента Play Mobile свой (его выдают вместе с логином),
// поэтому он не зашит здесь, а приходит из настроек.
//
// sendSms НЕ бросает исключений на отказ провайдера или сеть: возвращает
// { ok:false, reason, ... }, и экран говорит человеку, что не так. Бросает
// только на собственные ошибки вызова (нет адреса и т. п. проверяет RPC).

const TIMEOUT_MS = 15000;

/** Номер Узбекистана к виду 998XXXXXXXXX; иначе null. */
export function normalizeUzPhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (d.length === 9) d = '998' + d;
  return /^998\d{9}$/.test(d) ? d : null;
}

/** Адрес отправки из адреса клиента: хвост /broker-api/send дописывается, если его нет. */
export function sendUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  return /\/broker-api\/send$/.test(b) ? b : b + '/broker-api/send';
}

export function buildPayload({ phone, text, messageId, originator }) {
  return buildBatchPayload([{ phone, text, messageId }], originator);
}

// SMS_PUSH_V1 — рассылка: несколько сообщений одним запросом (массив messages).
export function buildBatchPayload(items, originator) {
  return {
    messages: items.map((m) => ({
      recipient: m.phone,
      'message-id': m.messageId,
      sms: { originator, content: { text: m.text } },
    })),
  };
}

export function basicAuth(login, password) {
  return 'Basic ' + Buffer.from(`${login}:${password}`, 'utf8').toString('base64');
}

/**
 * Одно сообщение. settings: { base_url, login, password, originator }.
 * Ответ: { ok, http_status, reason?, error? } — reason: 'http' | 'network' | 'timeout'.
 */
export function sendSms(settings, { phone, text, messageId }, deps = {}) {
  return sendBatch(settings, [{ phone, text, messageId }], deps);
}

/**
 * SMS_PUSH_V1 — пачка сообщений одним запросом. Play Mobile принимает или
 * отклоняет запрос целиком, поэтому и ответ один на всю пачку.
 */
export async function sendBatch(settings, items, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const url = sendUrl(settings.base_url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: basicAuth(settings.login, settings.password) },
      body: JSON.stringify(buildBatchPayload(items, settings.originator)),
      signal: ctrl.signal,
    });
  } catch (e) {
    const timeout = e && e.name === 'AbortError';
    return { ok: false, http_status: null, reason: timeout ? 'timeout' : 'network', error: timeout ? '' : String((e && e.message) || e).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 200) return { ok: true, http_status: 200 };
  let body = '';
  try { body = await res.text(); } catch { /* тело не прочиталось — хватит кода */ }
  let error = body.slice(0, 300);
  try {
    const j = JSON.parse(body);
    if (j && (j['error-code'] != null || j['error-description'])) error = `${j['error-code'] ?? ''} ${j['error-description'] ?? ''}`.trim();
  } catch { /* не JSON — показываем как есть */ }
  return { ok: false, http_status: res.status, reason: 'http', error };
}
