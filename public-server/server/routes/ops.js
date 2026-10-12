// PUBLIC_SERVER_V1 — НАБЛЮДЕНИЕ: /_health для проверки снаружи (8c: проверка
// каждую минуту и сообщение при сбое) и /_metrics для команды Easy-Med.
//
// /_health — без ключа и без подробностей: жив ли процесс и отвечает ли база.
// /_metrics — только с PUBLIC_METRICS_TOKEN (нет токена — адреса нет): числа,
// без единого имени, номера заявки или адреса партнёра.
import crypto from 'node:crypto';
import express from 'express';
import { sendError } from '../lib/errors.js';
import { isoOf } from '../lib/time.js';

const sameToken = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Числа для наблюдения. extra — счётчики процесса (ревью 8b, C6 и C8):
 * пропущенные уведомления (очередь клиники полна) и не записанные в журнал запросы.
 */
export function metrics(db, now, jobs = null, { counters = null, accessJournal = null } = {}) {
  const skipped = accessJournal ? accessJournal.stats() : {};
  const n = (sql, ...args) => db.prepare(sql).get(...args).n;
  const day = isoOf(now - 86400000);
  return {
    at: isoOf(now),
    clinics: n('SELECT COUNT(*) AS n FROM clinics'),
    clinics_live_5m: n('SELECT COUNT(*) AS n FROM clinics WHERE last_seen_at >= ?', isoOf(now - 5 * 60000)),
    inbox_waiting: n('SELECT COUNT(*) AS n FROM inbox'),
    inbox_oldest_at: db.prepare('SELECT MIN(received_at) AS t FROM inbox').get().t,
    requests_24h: n('SELECT COUNT(*) AS n FROM requests WHERE created_at >= ?', day),
    closed_24h: n("SELECT COUNT(*) AS n FROM requests WHERE status = 'closed' AND updated_at >= ?", day),
    deliveries_pending: n("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'pending'"),
    deliveries_failed_24h: n("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'failed' AND updated_at >= ?", day),
    access_24h: n('SELECT COUNT(*) AS n FROM access_log WHERE at >= ?', day),
    errors_5xx_24h: n('SELECT COUNT(*) AS n FROM access_log WHERE at >= ? AND status >= 500', day),
    rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    deliveries_queue_full: (counters && counters.queue_full) || 0,
    access_skipped_rate_limited: skipped.rate_limited || 0,
    access_skipped_keyless: skipped.keyless || 0,
    access_skipped_over_key_day: skipped.over_key_day || 0,
    access_skipped_over_total: skipped.over_total || 0,
    jobs: jobs ? jobs.status() : null,
  };
}

/** @param ctx {{db, now:()=>number, version:string, metricsToken?:string, jobs?:{status:()=>object}}} */
export function opsRouter(ctx) {
  const r = express.Router();
  r.get('/_health', (req, res) => {
    try { ctx.db.prepare('SELECT 1').get(); } catch { return res.status(503).json({ status: 'db_error' }); }
    return res.json({ status: 'ok', version: ctx.version, uptime_s: Math.round(process.uptime()) });
  });
  r.get('/_metrics', (req, res) => {
    if (!ctx.metricsToken) return sendError(req, res, 'not_found');
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || ''));
    if (!m || !sameToken(m[1], ctx.metricsToken)) return sendError(req, res, 'invalid_key');
    return res.json(metrics(ctx.db, ctx.now(), ctx.jobs || null, { counters: ctx.counters || null, accessJournal: ctx.accessJournal || null }));
  });
  return r;
}
