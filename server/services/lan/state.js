// LAN_ADDRESS_V1 — ПАМЯТЬ АДРЕСА МЕЖДУ ЗАПУСКАМИ: data/lan-address.json.
//
// Файл в папке данных, а не строка в базе, — намеренно. Адрес — свойство ЭТОГО
// компьютера, а не данных клиники: восстановление резервной копии базы (или
// копия, принесённая с другого ПК) не должно «вспоминать» чужой адрес, а связь
// зданий (branch-sync) не должна его возить. Тот же приём, что data/lisproxy.json.
//
//   { v: 1, addresses: ['192.168.1.156'], seen_at,
//     change: { from: ['192.168.1.147'], to: ['192.168.1.156'], at } | null,
//     dismissed_at, mdns_enabled }
//
// «Скрыть» (dismissed_at = change.at) действует до СЛЕДУЮЩЕЙ смены: новая смена —
// новый change.at, и предупреждение возвращается само. Без смены прежний change
// хранится: администратор мог не входить между перезапусками.
//
// Испорченный или нечитаемый файл = пустая память, не исключение: эта подсказка
// никогда не должна стать причиной, по которой клиника не запустилась.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lanAddressList, detectChange } from './interfaces.js';

export const LAN_FILE = 'lan-address.json';
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const ips = (v) => (Array.isArray(v) ? v.filter((a) => typeof a === 'string' && IPV4_RE.test(a)) : null);
const iso = (v) => (typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? v : null);

function normChange(c) {
  if (!c || typeof c !== 'object') return null;
  const from = ips(c.from), to = ips(c.to), at = iso(c.at);
  return from && to && at ? { from, to, at } : null;
}

function readRaw(dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, LAN_FILE), 'utf8');
    const v = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** Прочитанная и выправленная память. Не бросает. */
export function readLanState(dataDir) {
  const v = readRaw(dataDir);
  return {
    addresses: ips(v.addresses) || [],
    seen_at: iso(v.seen_at),
    change: normChange(v.change),
    dismissed_at: iso(v.dismissed_at),
    mdns_enabled: v.mdns_enabled !== false,
  };
}

// Временный файл → rename: оборванная запись оставляет прежний файл целым.
function writeState(dataDir, s) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, LAN_FILE);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...s }, null, 2));
  try { fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* уже нет */ } throw e; }
}

/** Смена, которую надо показать администратору, или null (её нет или её скрыли). */
export function visibleChange(state) {
  const c = state && state.change;
  if (!c) return null;
  return state.dismissed_at === c.at ? null : c;
}

/**
 * Запуск (и такт раз в минуту): сравнить адреса сейчас с запомненными и
 * запомнить. Пишет только когда набор адресов изменился (или это первый
 * запуск) — такт не трогает диск зря. Не бросает: ошибка записи — в .error.
 * → { changed, state, error? }
 */
export function recordAddresses(dataDir, { interfaces = os.networkInterfaces(), now = new Date() } = {}) {
  const prev = readLanState(dataDir);
  let cur;
  try { cur = lanAddressList(interfaces); } catch { cur = []; }
  const d = detectChange(prev.addresses, cur);
  if (d.skip) return { changed: false, state: prev };
  const same = prev.addresses.length === d.to.length && prev.addresses.every((a, i) => a === d.to[i]);
  if (same && prev.seen_at) return { changed: false, state: prev };
  const at = now.toISOString();
  const next = {
    ...prev,
    addresses: d.to,
    seen_at: at,
    ...(d.changed ? { change: { from: d.from, to: d.to, at }, dismissed_at: null } : {}),
  };
  try { writeState(dataDir, next); }
  catch (e) { return { changed: d.changed, state: next, error: e && e.message ? e.message : String(e) }; }
  return { changed: d.changed, state: next };
}

/**
 * «Скрыть до следующей смены». at — та смена, которую человек видел на экране:
 * если с тех пор пришла новая (другой at), она НЕ скрывается.
 */
export function dismissChange(dataDir, at) {
  const s = readLanState(dataDir);
  if (s.change && s.change.at === at && s.dismissed_at !== at) writeState(dataDir, { ...s, dismissed_at: at });
  return readLanState(dataDir);
}

/** Имя в сети (ответчик mDNS) — включить или выключить на этом ПК. */
export function setMdnsEnabled(dataDir, enabled) {
  const s = readLanState(dataDir);
  writeState(dataDir, { ...s, mdns_enabled: enabled === true });
  return readLanState(dataDir);
}
