// PUBLIC_SERVER_V1 — ФОН: доставка уведомлений (каждые 5 секунд) и уборка
// (каждую минуту). Таймеры unref, такт не перекрывает себя и никогда не
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
 *   limiter?:object, uncollectedMaxMs?:number, deliverEveryMs?:number, maintainEveryMs?:number, log?:Console}} o
 */
export function startJobs({ db, dataDir, now = () => Date.now(), send, webhooks = true, limiter = null, uncollectedMaxMs = UNCOLLECTED_MAX_MS,
  deliverEveryMs = 5000, maintainEveryMs = 60000, log = console }) {
  const state = { deliveries_at: null, maintenance_at: null, last_error: '', last_error_at: null };
  let delivering = false;
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
  const timers = [];
  if (webhooks) timers.push(setInterval(() => { deliverTick(); }, deliverEveryMs));
  timers.push(setInterval(maintainTick, maintainEveryMs));
  for (const t of timers) if (t.unref) t.unref();
  return {
    deliverTick, maintainTick,
    status: () => ({ ...state, webhooks }),
    stop() { for (const t of timers) clearInterval(t); },
  };
}
