// PUBLIC_SERVER_V1 — ЛИМИТЫ ЗАПРОСОВ: скользящее окно в минуту (дизайн §9).
//
// Окно — два соседних отрезка по минуте с весом (оценка «сколько было за
// последние 60 секунд»): на ключ хватает трёх чисел, а не списка отметок, —
// память не растёт от потока запросов с тысячи адресов. Корзин не больше
// maxBuckets: при переполнении сначала уходят старые, потом — десятая часть
// подряд (лимит на время забывается, но процесс не падает от нехватки памяти:
// машина общая — решение 16).
//
// hit(key, limit, now) → {ok:true, remaining} | {ok:false, retryAfterSec}
// Retry-After — через сколько секунд оценка опустится ниже лимита.
export const WINDOW_MS = 60000;

export function createLimiter({ windowMs = WINDOW_MS, maxBuckets = 50000 } = {}) {
  const buckets = new Map();

  function sweep(now) {
    for (const [k, b] of buckets) if (now - b.start >= 2 * windowMs) buckets.delete(k);
    if (buckets.size >= maxBuckets) {
      let n = Math.ceil(maxBuckets / 10);
      for (const k of buckets.keys()) { buckets.delete(k); if (--n <= 0) break; }
    }
  }

  function hit(key, limit, now) {
    const winStart = Math.floor(now / windowMs) * windowMs;
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxBuckets) sweep(now);
      b = { start: winStart, curr: 0, prev: 0 };
      buckets.set(key, b);
    }
    if (b.start !== winStart) {
      b.prev = b.start === winStart - windowMs ? b.curr : 0;
      b.curr = 0;
      b.start = winStart;
    }
    const elapsed = now - winStart;
    const estimate = b.prev * (1 - elapsed / windowMs) + b.curr;
    if (estimate + 1 > limit) {
      const waitMs = b.curr + 1 > limit
        ? windowMs - elapsed
        : windowMs * (1 - (limit - 1 - b.curr) / b.prev) - elapsed;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    b.curr += 1;
    return { ok: true, remaining: Math.max(0, Math.floor(limit - estimate - 1)) };
  }

  return { hit, sweep, size: () => buckets.size };
}
