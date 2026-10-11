// PUBLIC_SERVER_V1 — ПРИЛОЖЕНИЕ ПУБЛИЧНОГО СЕРВЕРА api.easymed.uz (шаг 8b).
//
//   /_health, /_metrics     — наблюдение (routes/ops.js);
//   /_sync/v1/*             — канал клиники (routes/sync.js; дизайн §10);
//   /<клиника>/v1/*         — партнёры (routes/partner.js; макет «Документация API»).
// Имя клиники не может начинаться с «_» (shared/api-connections.js slugProblem),
// поэтому служебные адреса с ним не пересекаются.
//
// Без журнала запросов процесса: ни тел, ни заголовков, ни адресов с
// параметрами в журнал systemd не попадает (решение владельца 16). Журнал
// запросов партнёров — в базе, без тел (store/logs.js).
import express from 'express';
import { syncRouter } from './routes/sync.js';
import { partnerRouter } from './routes/partner.js';
import { opsRouter } from './routes/ops.js';
import { createLimiter } from './lib/rate-limit.js';
import { errorHandler, sendError } from './lib/errors.js';
import { DEFAULT_SKEW_MS } from './clinic-auth.js';
import { floorInboxCursor } from './store/requests.js';

/**
 * @param {{db, dataDir:string, now?:()=>number, licencePublicKey?:object|null, offsetMin?:number, baseUrl?:string,
 *   requireHttps?:boolean, trustProxy?:(string|boolean), skewMs?:number, metricsToken?:string, version?:string,
 *   limiter?:object, log?:Console}} o
 * @returns {{app:import('express').Express, ctx:object}}
 */
export function createPublicServer({ db, dataDir, now = () => Date.now(), licencePublicKey = null, offsetMin = 300,
  baseUrl = 'https://api.easymed.uz', requireHttps = true, trustProxy = 'loopback', skewMs = DEFAULT_SKEW_MS, metricsToken = '',
  version = '0.0.0', limiter = createLimiter(), log = console }) {
  const ctx = { db, dataDir, now, licencePublicKey, offsetMin, baseUrl, requireHttps, skewMs, metricsToken, version, limiter, jobs: null };
  // Курсоры очереди не идут назад после восстановления базы (ревью 8b, C3).
  floorInboxCursor(db, now());
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(opsRouter(ctx));
  app.use('/_sync/v1', syncRouter(ctx));
  app.use('/:slug/v1', partnerRouter(ctx));
  app.use((req, res) => sendError(req, res, 'not_found'));
  app.use(errorHandler(log));
  return { app, ctx };
}
