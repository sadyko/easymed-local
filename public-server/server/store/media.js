// PUBLIC_SERVER_V1 — ФАЙЛЫ СНИМКА: логотипы клиники и фото показанных врачей.
//
// Клиника шлёт только то, чего у сервера нет (POST /media/check), файлом по
// отпечатку (PUT /media/<sha256>.<ext>). Байты — на диске <data>/media/<sha256>
// (одинаковый файл двух клиник лежит один раз), строка media — «этот файл
// прислала эта клиника». Партнёр получает файл по ссылке без ключа (картинку
// на сайте браузер грузит без заголовков), но только файл, на который
// ссылается ТЕКУЩИЙ снимок клиники.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isoOf } from '../lib/time.js';

export const MEDIA_MAX_BYTES = 2 * 1024 * 1024;   // как snapshot.js клиники
export const MEDIA_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' });
const SHA_RE = /^[0-9a-f]{64}$/;
const KEEP_UNREFERENCED_MS = 86400000;

const mediaDir = (dataDir) => path.join(dataDir, 'media');

/** Байты похожи на объявленный вид (не HTML под видом картинки). */
export function looksLike(ext, buf) {
  if (ext === 'png') return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === 'jpg' || ext === 'jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === 'webp') return buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

/** POST /media/check — каких из присланных отпечатков у этой клиники нет. */
export function missingMedia(db, clinicId, hashes) {
  const list = Array.isArray(hashes) ? [...new Set(hashes.map((h) => String(h).toLowerCase()).filter((h) => SHA_RE.test(h)))].slice(0, 500) : [];
  const has = db.prepare('SELECT 1 FROM media WHERE clinic_id = ? AND sha256 = ?');
  return list.filter((h) => !has.get(clinicId, h));
}

/** PUT /media/<sha256>.<ext>. → {ok} | {error:'bad_request'|'too_large'} */
export function putMedia(db, dataDir, clinicId, sha, ext, buf, now) {
  if (!SHA_RE.test(sha) || !MEDIA_TYPES[ext] || !Buffer.isBuffer(buf) || !buf.length) return { error: 'bad_request' };
  if (buf.length > MEDIA_MAX_BYTES) return { error: 'too_large' };
  if (crypto.createHash('sha256').update(buf).digest('hex') !== sha || !looksLike(ext, buf)) return { error: 'bad_request' };
  const dir = mediaDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sha);
  if (!fs.existsSync(file)) {
    const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  db.prepare('INSERT OR REPLACE INTO media (clinic_id, sha256, ext, bytes, stored_at) VALUES (?, ?, ?, ?, ?)')
    .run(clinicId, sha, ext, buf.length, isoOf(now));
  return { ok: true };
}

/** Файл для партнёра: прислан этой клиникой и есть в её текущем снимке. → {file, type} | null */
export function mediaFile(db, dataDir, clinic, sha, ext) {
  if (!clinic || !SHA_RE.test(sha) || !MEDIA_TYPES[ext]) return null;
  const row = db.prepare('SELECT ext FROM media WHERE clinic_id = ? AND sha256 = ?').get(clinic.clinic_id, sha);
  if (!row || row.ext !== ext) return null;
  if (!String(clinic.snapshot || '').includes('"media/' + sha + '.' + ext + '"')) return null;
  const file = path.join(mediaDir(dataDir), sha);
  return fs.existsSync(file) ? { file, type: MEDIA_TYPES[ext] } : null;
}

/** Уборка: строки, на которые снимок не ссылается дольше суток, и файлы без строк. */
export function gcMedia(db, dataDir, now) {
  const old = isoOf(now - KEEP_UNREFERENCED_MS);
  const rows = db.prepare('SELECT m.clinic_id, m.sha256, m.ext, c.snapshot FROM media m JOIN clinics c ON c.clinic_id = m.clinic_id WHERE m.stored_at < ?').all(old);
  const del = db.prepare('DELETE FROM media WHERE clinic_id = ? AND sha256 = ?');
  let rowsGone = 0;
  for (const r of rows) {
    if (!String(r.snapshot || '').includes('"media/' + r.sha256 + '.' + r.ext + '"')) { del.run(r.clinic_id, r.sha256); rowsGone += 1; }
  }
  let filesGone = 0;
  const dir = mediaDir(dataDir);
  if (fs.existsSync(dir)) {
    const still = db.prepare('SELECT 1 FROM media WHERE sha256 = ? LIMIT 1');
    for (const f of fs.readdirSync(dir)) {
      if (SHA_RE.test(f) && !still.get(f)) { fs.rmSync(path.join(dir, f), { force: true }); filesGone += 1; }
    }
  }
  return { rows: rowsGone, files: filesGone };
}
