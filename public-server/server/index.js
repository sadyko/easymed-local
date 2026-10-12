// PUBLIC_SERVER_V1 — ЗАПУСК ПУБЛИЧНОГО СЕРВЕРА (systemd-служба
// easymed-public, DEPLOY.md). Настройки — из окружения (config.js); неверная —
// отказ запуска. Слушает только 127.0.0.1 за nginx (TLS — у nginx).
//
// Против зависаний (память symptex-gateway-fragility): у сервера свои сроки на
// заголовки и тело запроса, у фона — свои 10 секунд на уведомление; запрос
// партнёра никогда не ждёт ни клинику, ни сеть — только свою базу.
import fs from 'node:fs';
import path from 'node:path';
import { readConfig, SERVICE_ROOT } from './config.js';
import { resolveLicenceKey } from './licence-key.js';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createPublicServer } from './app.js';
import { startJobs } from './jobs.js';
import { makeSender } from './lib/webhook-send.js';

let cfg;
try { cfg = readConfig(); } catch (e) {
  console.error('Публичный сервер не запущен: ' + e.message);
  process.exit(1);
}
const version = JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, 'package.json'), 'utf8')).version;
fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });

// PUBLIC_LICENCE_V1 — ключ лицензий: вшитый ключ производителя, чужой — только
// на стенде с PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1 (licence-key.js).
let licence;
try { licence = resolveLicenceKey({ path: cfg.licenceKeyPath, allowForeign: cfg.allowForeignLicenceKey }); } catch (e) {
  console.error('Публичный сервер не запущен: ' + e.message);
  process.exit(1);
}
const licencePublicKey = licence.key;

const db = openDb(path.join(cfg.dataDir, 'public.db'));
migrate(db);
const { app, ctx } = createPublicServer({
  db, dataDir: cfg.dataDir, licencePublicKey, offsetMin: cfg.offsetMin, baseUrl: cfg.baseUrl, requireHttps: cfg.requireHttps,
  trustProxy: cfg.trustProxy, skewMs: cfg.syncSkewMs, metricsToken: cfg.metricsToken, version, uncollectedMaxMs: cfg.uncollectedMaxMs,
  licenceKeySource: licence.source,
});
// PUBLIC_LICENCE_V1 — список производителя: без токена не забирается (и это
// видно в журнале и в /_metrics: feed_issued_at пуст).
const feed = cfg.feedToken ? { holder: ctx.feed, url: cfg.feedUrl, token: cfg.feedToken, publicKey: licencePublicKey } : null;
if (!feed) console.warn('WARNING: PUBLIC_FEED_TOKEN is not set — unpaid clinics and revoked keys reach this server only through clinic licences.');
const jobs = startJobs({ db, dataDir: cfg.dataDir, send: makeSender({ selfIps: cfg.selfIps }), webhooks: cfg.webhooks, limiter: ctx.limiter,
  uncollectedMaxMs: cfg.uncollectedMaxMs, feed, feedEveryMs: cfg.feedEveryMs });
ctx.jobs = jobs;

const server = app.listen(cfg.port, cfg.bind, () => {
  console.log('Easy-Med public server ' + version + ' is running on ' + cfg.bind + ':' + cfg.port + ' (data: ' + cfg.dataDir + ')');
  if (licence.source === 'compiled') console.log('Licence key: the production vendor key compiled into the app (' + licence.fingerprint + ').');
  else console.warn('WARNING: licence key ' + licence.fingerprint + ' is NOT the production vendor key — a test stand only (PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1).');
});
server.requestTimeout = 20000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('Публичный сервер не запущен: порт ' + cfg.port + ' занят — возможно, служба уже работает.');
    process.exit(1);
  }
  throw err;
});

function shutdown() {
  jobs.stop();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
