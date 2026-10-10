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
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readIdentity } from './branch-sync/identity.js';
import { LOGO_BUCKET } from '../../public/js/shared/clinic-logo-rules.js';

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' };

export function preserveLegacyLogo(db, storageDir) {
  let row;
  try { row = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get(); } catch { return { kept: null }; }
  if (!row || !row.logo_data_url || row.logo_square_path) return { kept: null };
  try { if (readIdentity(db).role === 'secondary') return { kept: null }; } catch { /* нет строки — не филиал */ }
  const m = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(row.logo_data_url));
  if (!m) return { kept: null };
  const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!bytes.length) return { kept: null };
  const name = 'logo-' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + (EXT[m[1].toLowerCase()] || '.bin');
  const rel = 'legacy/' + name;
  const abs = path.join(storageDir, LOGO_BUCKET, 'legacy', name);
  if (fs.existsSync(abs)) return { kept: rel, already: true };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes, { flag: 'wx' });
  return { kept: rel, already: false };
}
