// LIS_PROXY_V1 — вход LIS Proxy: POST /api/lisproxy?key=…
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, разделы 1–2).
//
// Стоит в app.js рядом с вебхуками телефонии — ДО requirePasswordChanged и без
// requireAuth: у программы на лабораторном ПК нет сессии. Свой гейт — ключ в
// строке запроса (прокси сохраняет её в api_url), проверка ДО разбора тела.
// Выключено, нет ключа, не тот, не POST, лишний путь — тот же 404, что у
// неизвестного адреса API (образец — services/telephony/webhooks.js): ничего не
// пишется, прибор не заводится. Лицензия не проверяется (решение владельца 5).
//
// Прокси шлёт каждый запрос ОДИН раз и не повторяет: строка журнала — первой,
// ответ — 200 на любой исход; 500 — только если не записался сам журнал.
import express, { Router } from 'express';
import { readProxySettings, keyMatches } from '../lis/lisproxy-settings.js';
import { journalProxyRequest, handleProxyRequest, failJournal, fallbackReply, methodOf } from '../lis/lisproxy.js';

// Байт в байт как ответ app.js на неизвестный адрес API — отказ не должен
// выдавать, что приёмник здесь есть.
export const NOT_FOUND = Object.freeze({ error: Object.freeze({ code: 'not_found', message: 'Неизвестный адрес API.' }) });
const INTERNAL = Object.freeze({ error: Object.freeze({ code: 'internal', message: 'Ошибка сервера. Повторите позже.' }) });

// Свой разборщик формы: ключи в скобках, как в PHP (lisResult[R][res]) → объект;
// verify сохраняет тело как пришло — для журнала (source_body). 100 КБ — одно
// значение или один номер пробирки, никогда не набор данных.
const parseForm = express.urlencoded({ extended: true, limit: '100kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } });

/** Адрес отправителя — сокет, никогда не X-Forwarded-For (его пишет сам отправитель). */
export function peerOf(req) {
  const s = String((req.socket && req.socket.remoteAddress) || '');
  return s.startsWith('::ffff:') ? s.slice(7) : s;
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
  // Тело, которое не разобралось, — тоже запрос с ключом: строка журнала и 200 (Р25).
  const parse = (req, res, next) => parseForm(req, res, (err) => {
    if (err) { req.lisProxyParseError = err; req.body = {}; }
    next();
  });

  r.post('/', gate, parse, (req, res) => {
    const peer = peerOf(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const method = methodOf(body);
    const pe = req.lisProxyParseError;
    let id;
    try {
      id = journalProxyRequest(db, { peer, body: req.rawBody ?? '', method,
        note: pe ? 'LIS Proxy: тело запроса не разобрано — ' + (pe.type || pe.message) : '' });
    } catch (e) {
      // Тело в журнал консоли не попадает никогда — только причина.
      console.warn('[lisproxy] журнал не записан:', e && e.message);
      return res.status(500).json(INTERNAL);
    }
    let out = fallbackReply(method);
    if (!pe) {
      try { out = handle(db, { id, peer, body }) || out; }
      catch (e) { failJournal(db, id, e); }
    }
    send(res, out);
  });

  r.use((req, res) => res.status(404).json(NOT_FOUND));
  return r;
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
