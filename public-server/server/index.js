// PUBLIC_SERVER_V1 — ЗАПУСК ПУБЛИЧНОГО СЕРВЕРА (systemd-служба
// easymed-public, DEPLOY.md). Настройки — из окружения (config.js); неверная —
// отказ запуска. Слушает только 127.0.0.1 за nginx (TLS — у nginx).
//
// Против зависаний (память symptex-gateway-fragility): у сервера свои сроки на
// заголовки и тело запроса, у фона — свои 10 секунд на уведомление; запрос
// партнёра никогда не ждёт ни клинику, ни сеть — только свою базу.
import fs from 'node:fs';
import path from 'node:path';
import { createPublicKey } from 'node:crypto';
import { readConfig, SERVICE_ROOT } from './config.js';
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

let licencePublicKey = null;
if (cfg.licenceKeyPath) {
  try { licencePublicKey = createPublicKey(fs.readFileSync(cfg.licenceKeyPath, 'utf8')); } catch {
    console.error('Публичный сервер не запущен: PUBLIC_LICENCE_PUBLIC_KEY — не открытый ключ Ed25519 (' + cfg.licenceKeyPath + ')');
    process.exit(1);
  }
}

const db = openDb(path.join(cfg.dataDir, 'public.db'));
migrate(db);
const { app, ctx } = createPublicServer({
  db, dataDir: cfg.dataDir, licencePublicKey, offsetMin: cfg.offsetMin, baseUrl: cfg.baseUrl, requireHttps: cfg.requireHttps,
  trustProxy: cfg.trustProxy, skewMs: cfg.syncSkewMs, metricsToken: cfg.metricsToken, version, uncollectedMaxMs: cfg.uncollectedMaxMs,
});
const jobs = startJobs({ db, dataDir: cfg.dataDir, send: makeSender({ selfIps: cfg.selfIps }), webhooks: cfg.webhooks, limiter: ctx.limiter,
  uncollectedMaxMs: cfg.uncollectedMaxMs });
ctx.jobs = jobs;

const server = app.listen(cfg.port, cfg.bind, () => {
  console.log('Easy-Med public server ' + version + ' is running on ' + cfg.bind + ':' + cfg.port + ' (data: ' + cfg.dataDir + ')');
  if (!licencePublicKey) console.log('Licence key: the vendor key compiled into the app (server/services/control/licence.js).');
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
