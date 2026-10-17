// LAN_ADDRESS_V1 — ПАМЯТЬ АДРЕСА МЕЖДУ ЗАПУСКАМИ: data/lan-address.json.
//
// Файл в папке данных, а не строка в базе, — намеренно. Адрес — свойство ЭТОГО
// компьютера, а не данных клиники: восстановление резервной копии базы (или
// копия, принесённая с другого ПК) не должно «вспоминать» чужой адрес, а связь
// зданий (branch-sync) не должна его возить. Тот же приём, что data/lisproxy.json.
//
//   { v: 1, addresses: ['192.168.1.156'],            — адреса карт, которые есть сейчас
//     cards: [{ key: 'a4:bb:…', adapter, addresses }], — все запомненные карты (по MAC)
//     seen_at, change: { from, to, at } | null, dismissed_at, mdns_enabled }
//
// Смена — когда ТА ЖЕ карта получила другой адрес (перепроверка 2026-10-17:
// подключение и отключение VPN, хот-спота, Wi-Fi позже кабеля давали ложное
// «адрес изменился») ИЛИ когда ни одного из адресов прошлой записи больше нет
// (повторная перепроверка, R3: Wi-Fi со случайным MAC получает новый MAC и новый
// адрес каждый день; сервер переставили с Wi-Fi .147 на кабель .160 — компьютеры
// клиники знали только .147). Карта, которой сейчас нет, помнится 30 дней: вернётся
// с другим адресом — это смена; карта со случайным («локально назначенным») MAC не
// помнится вовсе — тем же MAC она не вернётся. Прежние адреса вернулись —
// предупреждение снимается само.
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
import { realLanInterfaces, lanCards, detectChange } from './interfaces.js';

export const LAN_FILE = 'lan-address.json';
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const FORGET_AFTER_MS = 30 * DAY_MS;
// Второй бит первого октета MAC — «локально назначенный»: так выглядят случайные
// аппаратные адреса Windows (x2, x6, xA, xE), а не адрес самой карты.
export const isRandomMac = (key) => /^[0-9a-f][26ae]:/i.test(String(key || ''));

const ips = (v) => (Array.isArray(v) ? v.filter((a) => typeof a === 'string' && IPV4_RE.test(a)) : null);
const iso = (v) => (typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? v : null);

function normChange(c) {
  if (!c || typeof c !== 'object') return null;
  const from = ips(c.from), to = ips(c.to), at = iso(c.at);
  return from && to && at ? { from, to, at } : null;
}

function normCards(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const c of v) {
    if (!c || typeof c !== 'object' || typeof c.key !== 'string' || !c.key) continue;
    const addresses = ips(c.addresses);
    if (!addresses || !addresses.length) continue;
    out.push({ key: c.key, adapter: typeof c.adapter === 'string' ? c.adapter : '', addresses, seen_at: iso(c.seen_at) });
  }
  return out;
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
    cards: normCards(v.cards),
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
 * Запуск (и такт раз в минуту): сравнить карты сейчас с запомненными и
 * запомнить. Пишет только когда что-то изменилось (или это первый запуск) —
 * такт не трогает диск зря. Не бросает: ошибка записи — в .error.
 * → { changed, state, error? } (changed — новая смена, о которой сказать)
 */
export function recordAddresses(dataDir, { interfaces = os.networkInterfaces(), now = new Date() } = {}) {
  const prev = readLanState(dataDir);
  let cur;
  try { cur = lanCards(realLanInterfaces(interfaces)); } catch { cur = []; }
  const d = detectChange(prev.cards, cur);
  if (d.skip) return { changed: false, state: prev };
  const present = cur.flatMap((c) => c.addresses);
  const at = now.toISOString(), t = now.getTime();
  // «Видели» у карты, которая есть сейчас, обновляется не чаще раза в сутки: такт раз
  // в минуту не должен переписывать файл ради метки.
  const seenOf = (c) => {
    const p = prev.cards.find((x) => x.key === c.key);
    const s = p && p.seen_at && t - Date.parse(p.seen_at) < DAY_MS ? p.seen_at : at;
    return { ...c, seen_at: s };
  };
  // Карты, которых сейчас нет, помнятся 30 дней (вернётся Wi-Fi с другим адресом —
  // смена); со случайным MAC — не помнятся.
  const absent = prev.cards.filter((p) => !cur.some((c) => c.key === p.key)
    && !isRandomMac(p.key) && t - Date.parse(p.seen_at || prev.seen_at || at) < FORGET_AFTER_MS);
  const cards = [...cur.map(seenOf), ...absent];
  // Ни одного адреса прошлой записи больше нет — смена, даже если сменилась сама карта.
  const lostAll = prev.addresses.length > 0 && !prev.addresses.some((x) => present.includes(x));
  if (!d.changed && lostAll) { d.changed = true; d.from = prev.addresses; d.to = present; }
  let change = prev.change, dismissed = prev.dismissed_at;
  // Старые адреса вернулись (роутер отдал прежний, Wi-Fi поднялся с тем же) — компьютеры
  // снова находят сервер: предупреждение снимается, и возврат сам сменой не считается.
  const back = change && change.from.length && change.from.every((x) => present.includes(x));
  if (back) { change = null; dismissed = null; }
  else if (d.changed) { change = { from: d.from, to: d.to, at }; dismissed = null; }
  const same = JSON.stringify(cards) === JSON.stringify(prev.cards) && JSON.stringify(present) === JSON.stringify(prev.addresses)
    && change === prev.change && prev.seen_at;
  if (same) return { changed: false, state: prev };
  const next = { ...prev, addresses: present, cards, seen_at: at, change, dismissed_at: dismissed };
  try { writeState(dataDir, next); }
  catch (e2) { return { changed: !back && d.changed, state: next, error: e2 && e2.message ? e2.message : String(e2) }; }
  return { changed: !back && d.changed, state: next };
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
