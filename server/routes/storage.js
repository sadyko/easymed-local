import { Router, raw } from 'express';
import fs from 'node:fs';
import path from 'node:path';

// Local file storage — the offline stand-in for Supabase Storage. Objects live
// on disk under <storageDir>/<bucket>/<path>. Buckets are an allow-list; every
// object path is sanitised so a request can never escape its bucket directory.
// Serving is done by this same-origin authenticated endpoint (the route is
// mounted behind requireAuth), so the client's "signed URL" is simply the
// object's path here — the session cookie authorises the GET.
// TELEGRAM_BROADCAST_IMG_V1 — `telegram-media` держим ОТДЕЛЬНО от clinic-docs:
// туда уходит то, что видит пациент в боте (баннер рассылки), а не внутренние
// документы клиники. Разные корзины — разная судьба при чистке и разный ответ
// на вопрос «что здесь вообще лежит».
const BUCKETS = new Set(['clinic-docs', 'telegram-media']);

const CONTENT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
};
function contentType(abs) {
  return CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
}

// Resolve <storageDir>/<bucket>/<segments...> and PROVE the result stays inside
// the bucket dir. Returns the absolute path, or null for a bad bucket /
// traversal / empty path. Express 5's `*rest` wildcard hands us the remaining
// path as an array of already-decoded segments; each is checked individually so
// no '.', '..', or nested separator survives.
function safeResolve(storageDir, bucket, rest) {
  if (!BUCKETS.has(bucket)) return null;
  const raw = Array.isArray(rest) ? rest : String(rest || '').split('/');
  const segments = raw.filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((s) => s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0'))) return null;
  const baseDir = path.resolve(storageDir, bucket);
  const abs = path.resolve(baseDir, ...segments);
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) return null;
  return abs;
}
const relPath = (rest) => (Array.isArray(rest) ? rest : [rest]).filter(Boolean).join('/');

const badPath = (res) => res.status(400).json({ error: { code: 'bad_request', message: 'Invalid storage path.' } });

export function storageRoutes(storageDir) {
  const r = Router();

  // Upload: raw body (any content type) written verbatim to disk.
  r.post('/:bucket/*rest', raw({ type: () => true, limit: '20mb' }), (req, res) => {
    const abs = safeResolve(storageDir, req.params.bucket, req.params.rest);
    if (!abs) return badPath(res);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Empty upload.' } });
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    } catch (e) {
      console.error('[storage write]', e.message);
      return res.status(500).json({ error: { code: 'internal', message: 'Could not store file.' } });
    }
    return res.json({ data: { path: relPath(req.params.rest), size: body.length } });
  });

  // Serve an object (same-origin, session-authenticated — works for <img src>).
  r.get('/:bucket/*rest', (req, res) => {
    const abs = safeResolve(storageDir, req.params.bucket, req.params.rest);
    if (!abs) return badPath(res);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ error: { code: 'not_found', message: 'File not found.' } });
    }
    res.setHeader('Content-Type', contentType(abs));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(abs).pipe(res);
  });

  // Best-effort delete.
  r.delete('/:bucket/*rest', (req, res) => {
    const abs = safeResolve(storageDir, req.params.bucket, req.params.rest);
    if (!abs) return badPath(res);
    try { fs.unlinkSync(abs); } catch { /* already gone */ }
    return res.json({ data: {} });
  });

  return r;
}
