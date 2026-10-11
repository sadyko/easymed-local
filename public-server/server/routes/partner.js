// PUBLIC_SERVER_V1 — АДРЕСА ПАРТНЁРОВ https://api.easymed.uz/<клиника>/v1/…
// (решение владельца 7). Порядок слоёв — routes/partner-auth.js; чтение —
// partner-read.js; заявки и запись — partner-write.js.
//
// Файлы снимка (/media/<sha256>.<ext>) — без ключа: картинку на сайте партнёра
// браузер грузит без заголовков. Отдаётся только файл из текущего снимка
// клиники (store/media.js), с запретом угадывать вид и исполнять что-либо.
import express from 'express';
import { clinicGate, preflight, requireKey } from './partner-auth.js';
import { readRoutes } from './partner-read.js';
import { writeRoutes } from './partner-write.js';
import { mediaFile } from '../store/media.js';
import { sendError } from '../lib/errors.js';

export const PARTNER_BODY_LIMIT = '32kb';

/**
 * @param {{db, dataDir:string, now:()=>number, offsetMin:number, baseUrl:string, requireHttps?:boolean,
 *   limiter?:{hit:(key:string, limit:number, now:number)=>{ok:boolean, retryAfterSec?:number}}}} ctx
 */
export function partnerRouter(ctx) {
  const r = express.Router({ mergeParams: true });
  r.use(clinicGate(ctx));
  r.use(preflight(ctx));
  r.get('/media/:file', (req, res) => {
    const m = /^([0-9a-f]{64})\.([a-z]{3,4})$/.exec(String(req.params.file || ''));
    const f = m ? mediaFile(ctx.db, ctx.dataDir, req.clinic, m[1], m[2]) : null;
    if (!f) return sendError(req, res, 'not_found');
    res.set('Content-Type', f.type);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'");
    return res.sendFile(f.file);
  });
  r.use(express.json({ limit: PARTNER_BODY_LIMIT }));
  r.use(requireKey(ctx));
  readRoutes(r, ctx);
  writeRoutes(r, ctx);
  r.use((req, res) => sendError(req, res, 'not_found'));
  return r;
}
