// WEBSITE_V1 — публичная раздача картинок сайта: GET /media/<path> отдаёт
// файлы из data/storage/website/<path> БЕЗ авторизации (в отличие от ERP
// хранилища server/routes/storage.js, которое всегда сидит за requireAuth).
// Проверка пути — зеркало safeResolve оттуда: сегмент '.', '..', содержащий
// '\' или '\0' отклоняется, итоговый абсолютный путь обязан остаться внутри
// mediaDir. Здесь нет понятия "bucket" — корнем сразу служит сам mediaDir.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LANG } from './i18n.js';
import { doctorBySlug } from './content.js';
import { photoFile } from '../services/api/snapshot.js';

// WEBSITE_V1 (Easy-Med) — фирменная 404 грузится лениво: страницы сайта
// (render/*) переносятся отдельной задачей, а раздача картинок не должна
// падать на импорте, пока их нет. Нет рендера — отдаём короткую HTML-404.
async function notFound(db, res) {
  let html = '<!doctype html><meta charset="utf-8"><title>404</title><h1>404</h1>';
  try {
    const { renderNotFound } = await import('./render/notfound.js');
    html = renderNotFound(db, DEFAULT_LANG);
  } catch { /* запасная страница выше */ }
  return res.status(404).type('html').send(html);
}

// Разрешённые для публичной отдачи расширения — всё остальное (в т.ч. .txt,
// .json, .pdf) получает обычную HTML-404 сайта, как будто файла нет вовсе.
const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function safeResolve(mediaDir, rest) {
  const raw = Array.isArray(rest) ? rest : String(rest || '').split('/');
  const segments = raw.filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((s) => s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0'))) return null;
  const baseDir = path.resolve(mediaDir);
  const abs = path.resolve(baseDir, ...segments);
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) return null;
  return abs;
}

// Возвращает Express-обработчик GET /media/*rest для смонтированного mediaDir.
export function mediaRoute(mediaDir, db, { storageDir } = {}) {
  return async (req, res) => {
    // WEBSITE_V1 (Easy-Med) — фото врача живёт в профиле (корзина doctor-photos),
    // а не в корзине сайта. Отдаём его только врачу, которого показывает сайт
    // (doctorBySlug — тот же показ, что у партнёров): скрытый врач по прямой
    // ссылке /media/doctor/<id> не находится.
    const rel = (Array.isArray(req.params.rest) ? req.params.rest : String(req.params.rest || '').split('/')).filter(Boolean).join('/');
    const m = /^doctor\/(\d{1,9})$/.exec(rel);
    if (m) {
      const d = db ? doctorBySlug(db, m[1]) : undefined;
      const url = d && d.photo_path ? db.prepare('SELECT photo_url FROM users WHERE id = ?').get(d.user_id)?.photo_url : null;
      const file = url ? photoFile(storageDir, url, d.user_id) : null;
      const type = file ? CONTENT_TYPES[path.extname(file).toLowerCase()] : null;
      // svg из профиля не отдаём: он мог бы нести скрипт, а CSP для него здесь не ставится
      if (!file || !type || type === CONTENT_TYPES['.svg'] || !fs.existsSync(file)) return notFound(db, res);
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.sendFile(path.resolve(file));
    }
    const abs = safeResolve(mediaDir, req.params.rest);
    const ext = abs ? path.extname(abs).toLowerCase() : '';
    const contentType = CONTENT_TYPES[ext];
    if (!abs || !contentType || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return notFound(db, res);
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // SVG может нести <script>; на всякий случай запрещаем ему вообще что-либо
    // загружать/исполнять собственным CSP, отдельным от общего сайта.
    if (ext === '.svg') res.setHeader('Content-Security-Policy', "default-src 'none'");
    // TOCTOU-защита: файл мог существовать на момент statSync() выше и
    // исчезнуть/оказаться заблокирован (антивирус, EBUSY) к моменту чтения.
    // Без обработчика 'error' необработанное исключение потока валит ВЕСЬ
    // процесс — а на нём же висит боевой ЕРП. headersSent решает, можно ли
    // ещё отдать чистый 404, или остаётся только оборвать соединение.
    const stream = fs.createReadStream(abs);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).end();
      else res.destroy();
    });
    stream.pipe(res);
  };
}
