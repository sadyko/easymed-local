// WEBSITE_PREVIEW_V1 — стили, скрипты, шрифты и картинки для предпросмотра сайта.
// Сам HTML отдаёт RPC website_preview; почему адрес с ключом, а не по cookie, — site/preview.js.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewCss, previewTokenOk } from '../site/preview.js';
import { mediaRoute } from '../site/media.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SITE_DIR = path.join(ROOT, 'public', 'site');

export function sitePreviewRoutes(db, dataDir) {
  const r = express.Router();
  const storageDir = path.join(dataDir, 'storage');
  r.use('/:token', (req, res, next) => {
    if (!previewTokenOk(req.params.token)) return res.status(404).end();
    // Рамка без allow-same-origin — «чужое» происхождение: шрифты браузер берёт только с CORS.
    res.set('Access-Control-Allow-Origin', '*');
    next();
  });
  r.get('/:token/assets/site.css', (req, res) => {
    res.set('Cache-Control', 'no-cache').type('css').send(previewCss(fs.readFileSync(path.join(SITE_DIR, 'site.css'), 'utf8')));
  });
  r.use('/:token/assets', express.static(SITE_DIR, { index: false, maxAge: 0 }));
  r.get('/:token/media/*rest', mediaRoute(path.join(storageDir, 'website'), db, { storageDir }));
  return r;
}
