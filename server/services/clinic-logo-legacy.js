// CLINIC_PROFILE_V1 — ПРЕЖНИЙ ЛОГОТИП НЕ ТЕРЯЕТСЯ.
//
// До шага 3 логотип «Компании» жил одной строкой data URL в
// doc_settings.logo_data_url. Теперь эта колонка — печатная копия
// квадратного логотипа: первая же загрузка квадратного её перепишет. Чтобы
// прежний логотип пережил замену, при каждом запуске (после миграций) он
// ложится файлом clinic-logos/legacy/logo-<sha256:16>.<расширение>.
//
// Строка базы не меняется. Имя — по содержимому, поэтому повтор ничего не
// пишет, а другой прежний логотип (восстановили копию) получит свой файл.
// Копирует только главное здание (или установка без филиалов): у филиала
// logo_data_url — копия главного, и оригинал лежит там. Пока квадратный
// загружен, logo_data_url — его копия, копировать нечего. Копии хранилища
// резервное копирование уже включает (services/backup.js).
//
// CLINIC_PROFILE_V1 (ревью M3) — data URL бывает разным, и каждый вариант
// раньше молча пропускался: SVG текстом (utf8 или %-кодированный), base64 в
// URL-безопасном алфавите, параметры (;charset=, ;name=). Теперь тело
// разбирается так, как его разбирает браузер: сначала %-коды, потом base64 —
// с обоими алфавитами. Тело, которое base64 не является, сохраняется как
// есть (.txt): лучше файл, который читается глазами, чем потерянный логотип.
// Тот же разбор зовёт /api/db (routes/db.js) перед тем, как затереть прежний
// логотип: копия не легла — правка отклоняется, логотип остаётся на бланках.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readIdentity } from './branch-sync/identity.js';
import { LOGO_BUCKET } from '../../public/js/shared/clinic-logo-rules.js';

const EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/pjpeg': '.jpg', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/bmp': '.bmp', 'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico', 'image/avif': '.avif',
};

const isHex = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
// %XX → байт; всё остальное — байтами UTF-8 как есть. Без исключений: битая
// последовательность («%E0%A4%A», «%ZZ») остаётся текстом, а не роняет копию.
function percentDecodeBytes(str) {
  const src = Buffer.from(str, 'utf8');
  if (!src.includes(0x25)) return src;
  const out = Buffer.alloc(src.length);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x25 && i + 2 < src.length && isHex(src[i + 1]) && isHex(src[i + 2])) {
      out[n++] = parseInt(String.fromCharCode(src[i + 1], src[i + 2]), 16);
      i += 2;
    } else out[n++] = src[i];
  }
  return out.subarray(0, n);
}

/** data URL → { bytes, ext } (байты прежнего логотипа); не data URL — null. */
export function legacyLogoBytes(value) {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(String(value || ''));
  if (!m) return null;
  const meta = m[1].split(';').map((x) => x.trim()).filter(Boolean);
  const mime = (meta[0] && meta[0].includes('/') ? meta[0] : 'text/plain').toLowerCase();
  const isBase64 = meta.some((p) => p.toLowerCase() === 'base64');
  const body = percentDecodeBytes(m[2]);
  if (!isBase64) return { bytes: body, ext: EXT[mime] || '.bin' };
  const text = body.toString('latin1').replace(/[\t\n\f\r ]+/g, '');
  const bare = text.replace(/=+$/, '');
  // Оба алфавита (+/ и -_), «=» только в конце (не больше двух), длина без
  // «=» не даёт остатка 1 — иначе это не base64.
  if (/^[A-Za-z0-9+/_-]*$/.test(bare) && text.length - bare.length <= 2 && bare.length % 4 !== 1) {
    return { bytes: Buffer.from(bare.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), ext: EXT[mime] || '.bin' };
  }
  return { bytes: body, ext: '.txt' };   // не base64 — тело как есть
}

/**
 * Положить значение logo_data_url файлом в clinic-logos/legacy/. Без проверок
 * строки и здания — их делает вызывающий. { kept: 'legacy/…' | null, already }.
 * kept: null — сохранять нечего (не data URL или пустое тело). Сбой записи —
 * исключение: молча «не сохранили» здесь значило бы «потеряли».
 */
export function keepLegacyLogo(value, storageDir) {
  const parsed = legacyLogoBytes(value);
  if (!parsed || !parsed.bytes.length) return { kept: null };
  const name = 'logo-' + createHash('sha256').update(parsed.bytes).digest('hex').slice(0, 16) + parsed.ext;
  const rel = 'legacy/' + name;
  const abs = path.join(storageDir, LOGO_BUCKET, 'legacy', name);
  if (fs.existsSync(abs)) return { kept: rel, already: true };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try { fs.writeFileSync(abs, parsed.bytes, { flag: 'wx' }); }
  catch (e) { if (e && e.code === 'EEXIST') return { kept: rel, already: true }; throw e; }
  return { kept: rel, already: false };
}

export function preserveLegacyLogo(db, storageDir) {
  let row;
  try { row = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get(); } catch { return { kept: null }; }
  if (!row || !row.logo_data_url || row.logo_square_path) return { kept: null };
  try { if (readIdentity(db).role === 'secondary') return { kept: null }; } catch { /* нет строки — не филиал */ }
  return keepLegacyLogo(row.logo_data_url, storageDir);
}
