// LIS_PROXY_V1 — вход LIS Proxy: POST /api/lisproxy?key=…
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, разделы 1–2).
//
// Стоит в app.js ДО общего разборщика JSON и ДО requirePasswordChanged, без
// requireAuth: у программы на лабораторном ПК нет сессии. Свой гейт — ключ в
// строке запроса (прокси сохраняет её в api_url), проверка ДО чтения тела.
// Выключено, нет ключа, не тот, не POST, лишний путь — тот же 404, что у
// неизвестного адреса API (образец — services/telephony/webhooks.js): ничего не
// пишется, прибор не заводится. Лицензия не проверяется (решение владельца 5).
//
// Прокси шлёт каждый запрос ОДИН раз и не повторяет: строка журнала — первой,
// ответ — 200 на любой исход; 500 — только если не записался сам журнал.
//
// LIS_PROXY_V1 (ревью I1) — тело читается БАЙТАМИ, раньше любого разбора, и в
// журнал идёт как пришло; разбирает его lisproxy-form.js (parseProxyForm), а не
// express.urlencoded: тот отказывал телу больше 100 КБ, больше 1000 пар, не
// формой или не в UTF-8 — и тогда ни тела в журнале, ни «Ok» в ответе, а на
// не-«Ok» прокси бросает остальные тесты пробы (LIS-API.md, §2). Ключ проверен
// раньше — потому предел тела может быть щедрым (2 МБ).
import zlib from 'node:zlib';
import { Router } from 'express';
import { readProxySettings, keyMatches } from '../lis/lisproxy-settings.js';
import { journalProxyRequest, handleProxyRequest, failJournal, fallbackReply, methodOf } from '../lis/lisproxy.js';
import { parseProxyForm, decodeProxyBody, looksLikeResult } from '../lis/lisproxy-form.js';

// Байт в байт как ответ app.js на неизвестный адрес API — отказ не должен
// выдавать, что приёмник здесь есть.
export const NOT_FOUND = Object.freeze({ error: Object.freeze({ code: 'not_found', message: 'Неизвестный адрес API.' }) });
const INTERNAL = Object.freeze({ error: Object.freeze({ code: 'internal', message: 'Ошибка сервера. Повторите позже.' }) });

/** Сколько байт тела читается и хранится (одно значение — около 300 байт). Сверх — тело обрезано и не разбирается. */
export const BODY_LIMIT = 2 * 1024 * 1024;

/** Адрес отправителя — сокет, никогда не X-Forwarded-For (его пишет сам отправитель). */
export function peerOf(req) {
  const s = String((req.socket && req.socket.remoteAddress) || '');
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

/** charset из Content-Type, если назван. */
function declaredCharset(req) {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(String(req.headers['content-type'] || ''));
  return m ? m[1] : '';
}

/**
 * Тело запроса байтами: распаковано (gzip, deflate, br), не больше limit.
 * Сверх предела — дочитывается и выбрасывается (соединение живо), truncated.
 * Никогда не отвергает: ошибка — в error, прочитанное — в buf.
 * @returns {Promise<{buf: Buffer, truncated: boolean, error: string}>}
 */
export function readRawBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let truncated = false;
    let done = false;
    let error = '';
    const finish = (e) => {
      if (done) return;
      done = true;
      if (e && !error) error = String((e && e.message) || e);
      resolve({ buf: Buffer.concat(chunks, size), truncated, error });
    };
    const enc = String(req.headers['content-encoding'] || 'identity').trim().toLowerCase();
    let stream = req;
    if (enc === 'gzip' || enc === 'x-gzip') stream = zlib.createGunzip();
    else if (enc === 'deflate') stream = zlib.createInflate();
    else if (enc === 'br') stream = zlib.createBrotliDecompress();
    else if (enc !== 'identity' && enc !== '') error = 'сжатие «' + enc + '» не поддерживается — тело сохранено как пришло';
    if (stream !== req) {
      req.on('error', (e) => finish(e));
      req.pipe(stream);
    }
    stream.on('data', (c) => {
      if (size >= limit) { truncated = true; return; }
      const piece = c.length > limit - size ? c.subarray(0, limit - size) : c;
      if (piece !== c) truncated = true;
      chunks.push(piece);
      size += piece.length;
    });
    stream.on('end', () => finish());
    stream.on('error', (e) => { finish(e); req.unpipe(stream); req.resume(); });   // распаковка сорвалась — остаток дочитать и выбросить
    req.on('aborted', () => finish('соединение оборвано'));
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} dataDir  папка данных здания (data/lisproxy.json)
 * @param {{handle?: Function}} [opts]  шов для тестов; в работе — handleProxyRequest
 */
export function lisProxyRoutes(db, dataDir, { handle = handleProxyRequest } = {}) {
  const r = Router();

  const gate = (req, res, next) => {
    const s = readProxySettings(dataDir);
    const key = req.query ? req.query.key : undefined;
    if (!s.enabled || typeof key !== 'string' || !keyMatches(key, s.key)) return res.status(404).json(NOT_FOUND);
    next();
  };

  r.post('/', gate, async (req, res) => {
    const peer = peerOf(req);
    const got = await readRawBody(req);
    const { text, charset } = decodeProxyBody(got.buf, declaredCharset(req));
    // Что сказать в журнале, кроме исхода: тело не дочитано / обрезано — разбора
    // нет (значение могло оборваться); кодировка не UTF-8 — разбор есть, отметка.
    const stop = [];
    if (got.error) stop.push('тело запроса не дочитано — ' + got.error);
    if (got.truncated) stop.push('тело больше 2 МБ — сохранены первые 2 МБ, не разобрано');
    const notes = charset === 'utf-8' ? [] : ['тело не в UTF-8 — прочитано как ' + charset];
    let body = {};
    if (!stop.length) {
      const f = parseProxyForm(text);
      body = f.body;
      notes.push(...f.notes);
    }
    // Запрос результата — и по разобранному method, и по сырому тексту: «Ok»
    // нужно, даже если тело не разобралось (LIS-API.md, §2).
    const method = methodOf(body);
    const kindMethod = method === 'apiResultSave' || looksLikeResult(text) ? 'apiResultSave' : method;
    // Похоже на результат, а method не разобрался — значение не угадывается:
    // строка в лотке с телом, ответ «Ok».
    if (!stop.length && kindMethod !== method) stop.push('похоже на запрос результата, но method не разобран — значение не прочитано');
    let id;
    try {
      id = journalProxyRequest(db, { peer, body: text, method: kindMethod,
        note: stop.length ? 'LIS Proxy: ' + [...stop, ...notes].join('; ') : '' });
    } catch (e) {
      // Тело в журнал консоли не попадает никогда — только причина.
      console.warn('[lisproxy] журнал не записан:', e && e.message);
      return res.status(500).json(INTERNAL);
    }
    let out = fallbackReply(kindMethod);
    if (!stop.length) {
      try { out = handle(db, { id, peer, body }) || out; }
      catch (e) { failJournal(db, id, e); }
      if (notes.length) appendNote(db, id, notes);
    }
    send(res, out);
  });

  r.use((req, res) => res.status(404).json(NOT_FOUND));
  return r;
}

/** Отметка о разборе (кодировка, предел пар) — в конец журнала строки, по возможности. */
function appendNote(db, id, notes) {
  const note = 'LIS Proxy: ' + notes.join('; ');
  try {
    db.prepare("UPDATE lab_device_messages SET detail = CASE WHEN COALESCE(detail, '') = '' THEN ? ELSE detail || '; ' || ? END WHERE id = ?")
      .run(note, note, id);
  } catch { /* исход уже записан */ }
}

/**
 * Ответ прокси. Никогда не сжатый (Р5): прокси шлёт Accept-Encoding: gzip, а
 * compress.js жмёт JSON от 1 КБ — рабочий список на 8+ тестов; распакует ли
 * прокси gzip, не проверено, а испорченный JSON — анализатор без заказа.
 * compress.js ответ с Content-Encoding не трогает.
 */
function send(res, out) {
  res.status(200).set('Content-Encoding', 'identity').set('Cache-Control', 'no-store');
  if (out.type === 'text') return res.type('text/plain; charset=utf-8').send(String(out.body));
  return res.type('application/json; charset=utf-8').send(JSON.stringify(out.body));
}
