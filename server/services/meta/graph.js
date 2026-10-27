// META_LEADS_V1_GRAPH — тонкий клиент Graph API Meta (Facebook / Instagram).
//
// Образец — telephony/binotel.js: НИКОГДА не бросает и НИКОГДА не пишет в
// журнал (там мог бы оказаться токен). Ответ — либо { ok: true, data }, либо
// { ok: false, reason } с ОДНИМ СЛОВОМ причины из закрытого словаря ниже;
// экран переводит слово в человеческую фразу (public/js/shared/meta-reasons.js).
// Код ошибки Meta и её сообщение сохраняются для диагностики, но токен из
// сообщения вычищен: Meta иногда повторяет его в тексте ошибки.
//
// Версия API — одна константа. Meta держит версию не меньше двух лет, а по
// истечении молча переводит вызовы на следующую, так что устаревшая константа
// не роняет интеграцию, а лишь просит обновить при случае.

export const GRAPH_BASE = 'https://graph.facebook.com';
export const GRAPH_VERSION = 'v26.0';

/** Закрытый словарь причин отказа — то, что попадает в meta_settings.last_error. */
export const REASONS = Object.freeze(['offline', 'bad_token', 'no_permission', 'rate_limited', 'bad_request', 'not_found', 'server_error', 'bad_response']);

/** Токен из любого текста (адрес, сообщение Meta, сообщение исключения) — звёздочками. */
export function scrubToken(text, token) {
  const s = text == null ? '' : String(text);
  if (!token) return s;
  return s.split(String(token)).join('***');
}

/** Код ошибки Meta → слово причины. Неизвестный код — временная ошибка сервера: следующий опрос повторит. */
export function reasonFromError(err) {
  const code = Number(err && err.code);
  if (code === 190 || code === 102) return 'bad_token';                       // токен недействителен или истёк
  if (code === 10 || (code >= 200 && code <= 299)) return 'no_permission';    // нет права (leads_retrieval и т. п.)
  if (code === 4 || code === 17 || code === 32 || code === 613 || (code >= 80000 && code <= 80999)) return 'rate_limited';
  if (code === 100) return 'bad_request';                                     // неверный параметр или id
  if (code === 803 || code === 804) return 'not_found';
  return 'server_error';
}

function buildUrl(path, params, token) {
  const p = String(path || '').replace(/^\/+/, '');
  const u = new URL(`${GRAPH_BASE}/${GRAPH_VERSION}/${p}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    // Объекты и массивы — JSON-ом: так Meta принимает `filtering` и подобные.
    u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  if (token) u.searchParams.set('access_token', String(token));
  return u.toString();
}

async function fetchJson(url, { token = '', fetchImpl = globalThis.fetch, timeoutMs = 15000, maxBytes = 2_000_000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // Сеть, DNS, таймаут — всё «нет связи»: обычное состояние клиники без интернета.
    return { ok: false, reason: 'offline', message: scrubToken(e && e.message, token) };
  }
  let text = '';
  try { text = await res.text(); } catch (e) { return { ok: false, reason: 'bad_response', message: scrubToken(e && e.message, token) }; }
  if (text.length > maxBytes) return { ok: false, reason: 'bad_response', message: 'Ответ Meta слишком большой' };
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = undefined; }
  if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
    const e = body.error;
    return {
      ok: false, reason: reasonFromError(e), status: res.status,
      code: Number(e.code) || 0, subcode: Number(e.error_subcode) || 0,
      message: scrubToken(e.message, token),
    };
  }
  if (!res.ok) {
    const st = Number(res.status) || 0;
    const reason = st === 404 ? 'not_found' : (st === 401 || st === 403) ? 'no_permission' : st === 429 ? 'rate_limited' : st >= 500 ? 'server_error' : 'bad_request';
    return { ok: false, reason, status: st, message: 'HTTP ' + st };
  }
  if (body === undefined || body === null || typeof body !== 'object') return { ok: false, reason: 'bad_response', message: 'Ответ Meta не разобран' };
  return { ok: true, data: body };
}

/** Один GET: graphGet('me', { fields: 'id,name' }, { token, fetchImpl, timeoutMs }). */
export function graphGet(path, params = {}, opts = {}) {
  return fetchJson(buildUrl(path, params, opts.token), opts);
}

/**
 * GET по всем страницам ответа (paging.next), пока страницы есть или не достигнут
 * предел. Отказ на любой странице — отказ обхода с той же причиной, но уже
 * собранные строки отдаются: курсор опроса двигать по ним нельзя, а вот
 * сохранить увиденные заявки — можно, они всё равно идемпотентны по leadgen_id.
 */
export async function graphGetAll(path, params = {}, opts = {}) {
  const { maxPages = 20 } = opts;
  const out = [];
  let url = buildUrl(path, params, opts.token);
  for (let i = 0; i < maxPages; i++) {
    const r = await fetchJson(url, opts);
    if (!r.ok) return { ...r, data: out };
    const d = r.data;
    if (Array.isArray(d.data)) out.push(...d.data);
    const next = d.paging && d.paging.next;
    if (!next) return { ok: true, data: out, truncated: false };
    url = String(next);   // next уже несёт токен и курсор — адрес не пересобираем
  }
  return { ok: true, data: out, truncated: true };
}
