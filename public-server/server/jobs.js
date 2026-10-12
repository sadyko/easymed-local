// PUBLIC_SERVER_V1 — ФОН: доставка уведомлений (каждые 5 секунд), уборка
// (каждую минуту) и — PUBLIC_LICENCE_V1 — список производителя с сервера
// лицензий (раз в PUBLIC_FEED_EVERY_SEC). Таймеры unref, такт не перекрывает себя и никогда не
// бросает наружу (по образцу опроса телефонии клиники): упавший такт пишет
// в журнал тип ошибки и стек без сообщения и ждёт следующего.
//
// Уборка — это и обязанности перед партнёрами, и минимизация данных:
//   • закрыть то, на что клиника не ответит (store/requests.js closeOverdue):
//     не забранное за сутки — решение владельца 20, срок из настройки
//     PUBLIC_UNCOLLECTED_MAX_HOURS (config.js uncollectedMaxMs);
//   • статусы старше 90 дней, журналы старше 30 дней, законченные доставки,
//     прежние имена в адресе после 30 дней, файлы без снимка;
//   • wal_checkpoint(TRUNCATE) — стёртые страницы не задерживаются в журнале WAL.
import { closeOverdue, purgeRequests, UNCOLLECTED_MAX_MS } from './store/requests.js';
import { purgeLogs } from './store/logs.js';
import { purgeDeliveries, deliverDue } from './store/deliveries.js';
import { gcMedia } from './store/media.js';
import { safeStack } from './lib/errors.js';
import { isoOf } from './lib/time.js';
import { pullFeed } from './store/feed.js';

export function runMaintenance(db, dataDir, now, limiter = null, { uncollectedMaxMs = UNCOLLECTED_MAX_MS } = {}) {
  const closed = closeOverdue(db, now, { uncollectedMaxMs });
  const purged = purgeRequests(db, now);
  const logs = purgeLogs(db, now);
  const deliveries = purgeDeliveries(db, now);
  const aliases = db.prepare('DELETE FROM slug_aliases WHERE until_at <= ?').run(isoOf(now)).changes;
  const media = gcMedia(db, dataDir, now);
  if (limiter) limiter.sweep(now);
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { ...closed, ...purged, logs, deliveries, aliases, media };
}

/**
 * @param {{db, dataDir:string, now?:()=>number, send:(msg:object)=>Promise<{status:number, error?:string}>, webhooks?:boolean,
 *   limiter?:object, uncollectedMaxMs?:number, deliverEveryMs?:number, maintainEveryMs?:number, log?:Console,
 *   feed?:{holder:object, url:string, token:string, publicKey?:object|null, fetchImpl?:typeof fetch}|null, feedEveryMs?:number}} o
 *   feed — PUBLIC_LICENCE_V1: забирать список производителя (store/feed.js); null — не забирать.
 */
export function startJobs({ db, dataDir, now = () => Date.now(), send, webhooks = true, limiter = null, uncollectedMaxMs = UNCOLLECTED_MAX_MS,
  deliverEveryMs = 5000, maintainEveryMs = 60000, log = console, feed = null, feedEveryMs = 60000 }) {
  const state = { deliveries_at: null, maintenance_at: null, feed_at: null, last_error: '', last_error_at: null };
  let delivering = false;
  let pulling = false;
  const fail = (what, e) => {
    state.last_error = what;
    state.last_error_at = isoOf(now());
    log.error('[public-server] фон:', what, (e && e.name) || 'Error', '\n' + safeStack(e));
  };
  async function deliverTick() {
    if (delivering) return null;
    delivering = true;
    try {
      const r = await deliverDue(db, { now: now(), send });
      state.deliveries_at = isoOf(now());
      return r;
    } catch (e) { fail('delivery', e); return null; } finally { delivering = false; }
  }
  function maintainTick() {
    try {
      const r = runMaintenance(db, dataDir, now(), limiter, { uncollectedMaxMs });
      state.maintenance_at = isoOf(now());
      return r;
    } catch (e) { fail('maintenance', e); return null; }
  }
  // PUBLIC_LICENCE_V1 — список производителя: такт не перекрывает себя; сбой
  // сети или подписи — причина в feed.holder.error, прежний список остаётся.
  async function feedTick() {
    if (!feed || pulling) return null;
    pulling = true;
    try {
      const r = await pullFeed(db, feed.holder, { url: feed.url, token: feed.token, publicKey: feed.publicKey || null,
        fetchImpl: feed.fetchImpl || globalThis.fetch, now: now() });
      state.feed_at = isoOf(now());
      return r;
    } catch (e) { fail('feed', e); return null; } finally { pulling = false; }
  }
  const timers = [];
  if (webhooks) timers.push(setInterval(() => { deliverTick(); }, deliverEveryMs));
  timers.push(setInterval(maintainTick, maintainEveryMs));
  if (feed) {
    timers.push(setTimeout(() => { feedTick(); }, 1000));   // первый — сразу после запуска
    timers.push(setInterval(() => { feedTick(); }, feedEveryMs));
  }
  for (const t of timers) if (t.unref) t.unref();
  return {
    deliverTick, maintainTick, feedTick,
    status: () => ({ ...state, webhooks, feed: !!feed }),
    stop() { for (const t of timers) clearInterval(t); },
  };
}
