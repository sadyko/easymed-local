// PUBLIC_SERVER_V1 — ОТПРАВКА ОДНОГО УВЕДОМЛЕНИЯ ПАРТНЁРУ.
//
// Тело и подпись (X-EasyMed-Signature: sha256=…) — готовые от клиники: сервер
// их не меняет и подделать не может (дизайн §4). Здесь — только доставка:
//   • адрес проверяется ЕЩЁ РАЗ перед каждой отправкой (тем же правилом, что
//     экран шага 7: https, доменное имя в интернете — webhookUrlProblem);
//   • соединение — только на публичный адрес, проверенный в самом подключении
//     (net-guard.js guardedLookup — SSRF и DNS rebinding);
//   • 10 секунд на всё, перенаправления не выполняются, ответ не читается
//     (нужен только код), тело ответа нигде не сохраняется.
import https from 'node:https';
import { webhookUrlProblem } from '../../../public/js/shared/api-connections.js';
import { guardedLookup, blockedList } from './net-guard.js';

export const WEBHOOK_TIMEOUT_MS = 10000;
export const USER_AGENT = 'EasyMed-Webhooks/1';

/** '' — адрес годится; иначе код. Пустой адрес для экрана — «без уведомлений», для отправки — негодный. */
export function checkWebhookUrl(url) {
  const s = String(url || '').trim();
  return !s || webhookUrlProblem(s) ? 'bad_url' : '';
}

const SSRF_CODES = new Set(['blocked_address', 'no_address', 'dns_failed']);
function errorCode(e) {
  const c = String((e && e.code) || '');
  if (SSRF_CODES.has(c)) return c;
  if (/CERT|TLS|SSL|SELF_SIGNED|ERR_SSL/i.test(c)) return 'tls';
  return 'connect';
}

/**
 * POST одного уведомления. Никогда не бросает.
 * @returns {Promise<{status:number, error?:string}>} status 0 — ответа не было (error — почему)
 */
export function httpsSend({ url, headers = {}, body = '', timeoutMs = WEBHOOK_TIMEOUT_MS, lookup, request = https.request }) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { finish({ status: 0, error: 'timeout' }); if (req) req.destroy(); }, timeoutMs);
    if (timer.unref) timer.unref();
    if (checkWebhookUrl(url)) { finish({ status: 0, error: 'bad_url' }); return; }
    const u = new URL(url);
    const payload = Buffer.from(String(body), 'utf8');
    try {
      req = request({
        protocol: 'https:', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', servername: u.hostname,
        headers: { 'User-Agent': USER_AGENT, ...headers, 'Content-Length': payload.length }, lookup, agent: false, timeout: timeoutMs,
      });
    } catch { finish({ status: 0, error: 'connect' }); return; }
    req.on('response', (res) => { finish({ status: Number(res.statusCode) || 0 }); res.resume(); res.destroy(); });
    req.on('timeout', () => { finish({ status: 0, error: 'timeout' }); req.destroy(); });
    req.on('error', (e) => finish({ status: 0, error: errorCode(e) }));
    req.end(payload);
  });
}

/**
 * Настоящая отправка для фона доставки: охрана адресов с адресами этой машины
 * (PUBLIC_SELF_IPS) в запрещённом списке.
 */
export function makeSender({ selfIps = [], timeoutMs = WEBHOOK_TIMEOUT_MS, resolve = undefined } = {}) {
  const lookup = guardedLookup({ list: blockedList(selfIps), ...(resolve ? { resolve } : {}) });
  return (msg) => httpsSend({ ...msg, timeoutMs, lookup });
}
