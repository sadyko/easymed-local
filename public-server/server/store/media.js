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
import { SNAPSHOT_LIMITS } from './clinics.js';

export const MEDIA_MAX_BYTES = 2 * 1024 * 1024;   // как snapshot.js клиники
// Потолок файлов одной клиники (ревью 8b, C7): диск машины общий (Symptex, n8n —
// решение 16), а не связанные со снимком файлы живут сутки. Логотипы и фото
// сотен врачей укладываются с запасом; сверх — 409 media_quota (клиника 8a
// пропускает файл, пишет код в журнал и шлёт снимок дальше — 8d покажет код).
// Проверка исправлений 8b, G: по числу — два комплекта (фото всех врачей снимка
// и два логотипа): клиника, переснявшая всех врачей, шлёт новые фото раньше
// снимка, пока старые ещё в нём; диск держит потолок байтов.
export const MEDIA_QUOTA_FILES = 2 * (SNAPSHOT_LIMITS.doctors + 2);
export const MEDIA_QUOTA_BYTES = 200 * 1024 * 1024;
// Проверка исправлений 8b, G: сверх потолка сначала убираются файлы этой клиники,
// на которые нынешний снимок не ссылается и которые старше MEDIA_PRUNE_AFTER_MS
// (только что присланные ждут своего снимка — он уходит после файлов). Байты на
// диске убирает уборка (gcMedia) в течение минуты.
export const MEDIA_PRUNE_AFTER_MS = 10 * 60000;
const REFERENCED = `EXISTS (SELECT 1 FROM clinics c WHERE c.clinic_id = media.clinic_id
                     AND instr(c.snapshot, '"media/' || media.sha256 || '.' || media.ext || '"') > 0)`;
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

/** PUT /media/<sha256>.<ext>. → {ok} | {error:'bad_request'|'too_large'|'media_quota'} */
export function putMedia(db, dataDir, clinicId, sha, ext, buf, now, { quotaFiles = MEDIA_QUOTA_FILES, quotaBytes = MEDIA_QUOTA_BYTES } = {}) {
  if (!SHA_RE.test(sha) || !MEDIA_TYPES[ext] || !Buffer.isBuffer(buf) || !buf.length) return { error: 'bad_request' };
  if (buf.length > MEDIA_MAX_BYTES) return { error: 'too_large' };
  if (crypto.createHash('sha256').update(buf).digest('hex') !== sha || !looksLike(ext, buf)) return { error: 'bad_request' };
  const heldOf = () => db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM media WHERE clinic_id = ? AND sha256 <> ?').get(clinicId, sha);
  const over = (h) => h.n + 1 > quotaFiles || h.b + buf.length > quotaBytes;
  if (over(heldOf())) {
    db.prepare(`DELETE FROM media WHERE clinic_id = ? AND sha256 <> ? AND stored_at < ? AND NOT ${REFERENCED}`)
      .run(clinicId, sha, isoOf(now - MEDIA_PRUNE_AFTER_MS));
    if (over(heldOf())) return { error: 'media_quota' };
  }
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

/**
 * Уборка: строки, на которые снимок не ссылается дольше суток, и файлы без строк.
 *
 * Ревью 8b, C4: снимок в память процесса не попадает — ссылку проверяет сама
 * SQLite (instr), а файл, на который снимок ссылается, отмечается свежим
 * (stored_at) и следующие сутки уборкой не проверяется. Прежде каждая строка
 * тянула в JS весь снимок своей клиники каждую минуту: 12 клиник × 40 фото при
 * снимке ~200 КБ роняли процесс по памяти (160 МБ) раз в минуту.
 */
export function gcMedia(db, dataDir, now) {
  const old = isoOf(now - KEEP_UNREFERENCED_MS);
  let rowsGone = 0;
  db.transaction(() => {
    db.prepare(`UPDATE media SET stored_at = ? WHERE stored_at < ? AND ${REFERENCED}`).run(isoOf(now), old);
    rowsGone = db.prepare('DELETE FROM media WHERE stored_at < ?').run(old).changes;
  })();
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
