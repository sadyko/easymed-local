// LIS_PROXY_V1 — настройка приёма LIS Proxy: включён ли и ключ
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 1, Р1, Р2).
//
// Файл data/lisproxy.json, а не таблица: миграции этой работы — только ADD
// COLUMN, таблицы настроек у лаборатории нет, а секрет пары филиалов уже живёт
// так же (branch-sync/pairing.js) — у здания свой, в /api/db и в синхронизацию
// зданий не попадает. Чтение НИКОГДА не бросает (прокси получит 404, а не 500).
//
// LIS_PROXY_V1 (ревью) — запись с fsync и копия lisproxy.json.bak с ТЕМ ЖЕ
// содержимым. Испорченный файл раньше читался как «выключено»: 404 у каждого
// лабораторного ПК, значения теряются (повтора у прокси нет), а «Включить» снова
// — новый ключ на всех ПК. Теперь испорчен или пропал основной — читается
// копия. Копия — нынешний ключ, а не прежний: прежний дал бы те же 404.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SETTINGS_FILE = 'lisproxy.json';
const OFF = Object.freeze({ enabled: false, key: null, changed_at: null, changed_by: null });

export function settingsPath(dataDir) { return path.join(dataDir, SETTINGS_FILE); }
/** Копия настройки (то же содержимое, пишется следом за основным файлом). */
export function backupPath(dataDir) { return settingsPath(dataDir) + '.bak'; }

/** Файл → объект настройки или null (нет файла, не JSON, не объект). Не бросает. */
function readFileSettings(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let v;
  try { v = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch { return null; }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/** { enabled, key, changed_at, changed_by }; включён — только с ключом. Основной файл не читается — копия .bak. */
export function readProxySettings(dataDir) {
  const v = readFileSettings(settingsPath(dataDir)) || readFileSettings(backupPath(dataDir));
  if (!v) return { ...OFF };
  const key = typeof v.key === 'string' && v.key.trim() ? v.key.trim() : null;
  return {
    enabled: v.enabled === true && !!key,
    key,
    changed_at: typeof v.changed_at === 'string' ? v.changed_at : null,
    changed_by: Number.isInteger(v.changed_by) ? v.changed_by : null,
  };
}

/**
 * Записать файл так, чтобы после сбоя питания он был либо прежним, либо новым:
 * временный файл → fsync → rename; каталог — fsync по возможности (на Windows
 * каталог как файл не открывается).
 */
function writeDurable(file, content) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* уже нет */ }
    throw e;
  }
  try {
    const d = fs.openSync(dir, 'r');
    try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  } catch { /* Windows: каталог не синхронизируется — rename уже на диске журнала NTFS */ }
}

/** Записать настройку целиком (основной файл, затем копия .bak) и вернуть её прочитанной. */
export function writeProxySettings(dataDir, { enabled = false, key = null, changed_by = null } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const rec = { enabled: enabled === true, key: key || null, changed_at: new Date().toISOString(), changed_by: Number.isInteger(changed_by) ? changed_by : null };
  const text = JSON.stringify(rec, null, 2);
  writeDurable(settingsPath(dataDir), text);
  writeDurable(backupPath(dataDir), text);
  return readProxySettings(dataDir);
}

/** Ключ: 32 случайных байта, base64url — 43 знака без + / = (безопасен в кавычках cmd и в TOML). */
export function newProxyKey() { return randomBytes(32).toString('base64url'); }

/**
 * Ключ из адреса совпал с сохранённым. Сравниваются SHA-256 обеих строк через
 * timingSafeEqual: время не зависит ни от длины, ни от того, сколько знаков
 * совпало (обычное === выходит на первом несовпавшем знаке).
 */
export function keyMatches(given, stored) {
  if (typeof given !== 'string' || typeof stored !== 'string' || !given || !stored) return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(stored, 'utf8').digest();
  return timingSafeEqual(a, b);
}
