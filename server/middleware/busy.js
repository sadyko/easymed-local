// LOCAL_SPEED_V1 (2026-11-24) — КТО ЗАНЯЛ СЕРВЕР.
//
// На фото консоли клиники строки [slow] заканчивались в пределах 1–5 мс друг от
// друга (1308/1309 мс, 267–271 мс): единственный поток Node стоял, и все ждали в
// очереди. По [slow] не видно, кто его занял, а кто просто ждал; к тому же
// /api/db писался как «POST /», а /api/rpc/x — как «POST /x» (express к finish уже
// срезал путь монтирования).
//
// Здесь — имена для журнала. Только код: имя RPC, имя таблицы из реестра,
// операция из пяти известных. Ни тела запроса, ни строки запроса, ни пути файла
// (в имени файла бывает фамилия пациента).

import { tableEntry } from '../db/schema-registry.js';

const DB_OPS = new Set(['select', 'insert', 'update', 'delete', 'upsert']);
const API_RPC = /^\/api\/rpc\/([^/]*)/i;
const API_DB = /^\/api\/db(?:\/|$)/i;
const API_STORAGE = /^\/api\/storage\/([^/]*)/i;

// Сегмент пути — как код: раскодированный, только буквы/цифры/_-. и не длиннее 80.
function codeName(seg) {
  let s = String(seg == null ? '' : seg);
  try { s = decodeURIComponent(s); } catch { /* как есть */ }
  return s.replace(/[^\w.-]/g, '').slice(0, 80) || '?';
}

/** «rpc <имя>» — имя RPC как код. */
export function rpcLabel(name) {
  return 'rpc ' + codeName(name);
}

/**
 * «db <таблица> <операция>» из тела /api/db: таблица — только если она есть в
 * реестре (иначе «?»: в поле table может прийти что угодно), операция — только
 * одна из пяти известных (нет её — без операции).
 */
export function dbLabel(body) {
  const b = body && typeof body === 'object' ? body : {};
  const t = typeof b.table === 'string' ? b.table : (typeof b.from === 'string' ? b.from : '');
  const table = t && tableEntry(t) ? t : '?';
  return 'db ' + table + (typeof b.op === 'string' && DB_OPS.has(b.op) ? ' ' + b.op : '');
}

/** Путь запроса без строки запроса — по полному адресу (express не успел его срезать). */
export function requestPath(req) {
  const url = String((req && (req.originalUrl || req.url)) || '');
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

/** Имя запроса для строки [slow]: rpc <имя> / db <таблица> <операция> / путь. */
export function requestLabel(req) {
  const p = requestPath(req);
  const rpc = API_RPC.exec(p);
  if (rpc) return rpcLabel(rpc[1]);
  if (API_DB.test(p)) return dbLabel(req.body);
  const storage = API_STORAGE.exec(p);
  if (storage) return '/api/storage/' + codeName(storage[1]);
  return p;
}
