// LIS_PROXY_V1 — настройка приёма LIS Proxy: включён ли и ключ
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 1, Р1, Р2).
//
// Файл data/lisproxy.json, а не таблица: миграции этой работы — только ADD
// COLUMN, таблицы настроек у лаборатории нет, а секрет пары филиалов уже живёт
// так же (branch-sync/pairing.js) — у здания свой, в /api/db и в синхронизацию
// зданий не попадает. Чтение НИКОГДА не бросает: испорченный файл — «выключено»
// (прокси получит 404, а не 500).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeAtomic } from '../services/control/checkin.js';

export const SETTINGS_FILE = 'lisproxy.json';
const OFF = Object.freeze({ enabled: false, key: null, changed_at: null, changed_by: null });

export function settingsPath(dataDir) { return path.join(dataDir, SETTINGS_FILE); }

/** { enabled, key, changed_at, changed_by }; включён — только с ключом. */
export function readProxySettings(dataDir) {
  let raw;
  try { raw = fs.readFileSync(settingsPath(dataDir), 'utf8'); } catch { return { ...OFF }; }
  let v;
  try { v = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch { return { ...OFF }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...OFF };
  const key = typeof v.key === 'string' && v.key.trim() ? v.key.trim() : null;
  return {
    enabled: v.enabled === true && !!key,
    key,
    changed_at: typeof v.changed_at === 'string' ? v.changed_at : null,
    changed_by: Number.isInteger(v.changed_by) ? v.changed_by : null,
  };
}

/** Записать настройку целиком (tmp + rename) и вернуть её прочитанной. */
export function writeProxySettings(dataDir, { enabled = false, key = null, changed_by = null } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const rec = { enabled: enabled === true, key: key || null, changed_at: new Date().toISOString(), changed_by: Number.isInteger(changed_by) ? changed_by : null };
  writeAtomic(settingsPath(dataDir), JSON.stringify(rec, null, 2));
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
