// WEBSITE_V1 — троттлинг заявок с сайта по IP. Та же схема, что и у
// per-IP лимита логина (server/routes/auth.js:9-31): скользящее окно на
// Map, ограниченной 500 IP, чтобы один шумный сегмент LAN/интернета не
// раздул память процесса. Состояние живёт ВНУТРИ замыкания фабрики —
// каждый вызов rateLimit() (а значит, каждый createSiteApp) получает свою
// собственную карту, поэтому тесты друг другу не мешают.
const MAX_TRACKED_IPS = 500;

export function rateLimit({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, windowStart }

  return function (req, res, next) {
    const ip = req.ip || '';
    const now = Date.now();
    const e = hits.get(ip) || { count: 0, windowStart: now };
    if (now - e.windowStart > windowMs) { e.count = 0; e.windowStart = now; }
    e.count += 1;
    hits.delete(ip); // перевставить — карта остаётся отсортирована от старых к новым для вытеснения
    hits.set(ip, e);
    if (hits.size > MAX_TRACKED_IPS) {
      for (const [k, v] of hits) {
        if (hits.size <= MAX_TRACKED_IPS) break;
        if (now - v.windowStart > windowMs) hits.delete(k);
      }
    }
    if (e.count > max) {
      // Тот же конверт, что siteError() в app.js — сюда его импортировать не
      // стоит: app.js импортирует rateLimit() же, а замыкать модули друг на
      // друга ради одной JSON-обёртки — риск ради экономии четырёх строк.
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Слишком много запросов. Попробуйте позже.' } });
    }
    next();
  };
}
