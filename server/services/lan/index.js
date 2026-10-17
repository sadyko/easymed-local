// LAN_ADDRESS_V1 — «АДРЕС В СЕТИ»: запуск из server/index.js и состояние для экрана.
//
// При запуске и раз в минуту: сравнить адреса ПК с запомненными (state.js) —
// сменились, значит другие компьютеры и анализаторы могут не находить сервер,
// и администратор увидит предупреждение; поднять ответчик имени <имя>.local
// (mdns.js), если он не выключен (EASYMED_MDNS=0, кнопка на экране, node --test).
//
// Имя — «имя в адресе» из «API и подключения» (api_settings.slug), иначе easymed.
// Сменили его там — такт подхватит через минуту, перезапуск не нужен.
//
// Ничего здесь не бросает наружу: подсказка про сеть не может быть причиной,
// по которой клиника не запустилась (docs/plans/2026-10-16-lan-address.md).
import os from 'node:os';
import { readSlug } from '../api/connections.js';
import { realLanInterfaces, formatMac, routerHint } from './interfaces.js';
import { readLanState, recordAddresses, visibleChange } from './state.js';
import { createMdnsResponder, mdnsAllowed, normalizeBase, DEFAULT_BASE } from './mdns.js';

let ctx = null;
let responder = null;
let lastFailure = null;
const loggedOnce = new Set();

function baseNameOf(db) {
  try { return normalizeBase(readSlug(db)); } catch { return DEFAULT_BASE; }
}
function logOnce(key, msg) {
  if (!ctx || loggedOnce.has(key)) return;
  loggedOnce.add(key);
  try { ctx.log(msg); } catch { /* журнал не важнее сервера */ }
}
const interfacesOf = (c) => { try { return c.getInterfaces(); } catch { return {}; } };

function recordNow() {
  const r = recordAddresses(ctx.dataDir, { interfaces: interfacesOf(ctx) });
  if (r.error) logOnce('write', '[lan] не удалось запомнить адрес этого ПК: ' + r.error);
  if (r.changed && r.state.change) {
    // Не logOnce: каждая смена — своя строка в журнале окна Easy-Med.
    try {
      ctx.log(`  Адрес сервера в сети изменился: было ${r.state.change.from.join(', ')}, стало ${r.state.change.to.join(', ')}.`);
      ctx.log('  Другие компьютеры и анализаторы могут не находить сервер — закрепите адрес в роутере (Настройки → Адрес в сети).');
    } catch { /* журнал не важнее сервера */ }
  }
}

/** Поднять или погасить ответчик имени по текущим env и настройке. Не бросает. */
export async function applyMdns() {
  if (!ctx) return;
  const allowed = mdnsAllowed(ctx.env, { allowUnderTest: ctx.allowUnderTest });
  const want = allowed.ok && readLanState(ctx.dataDir).mdns_enabled;
  if (!want) {
    if (responder) { try { responder.stop(); } catch { /* уже */ } responder = null; }
    return;
  }
  if (responder) return;
  try {
    const c = ctx;
    responder = c.createResponder({
      baseName: baseNameOf(c.db),
      getInterfaces: () => realLanInterfaces(interfacesOf(c)),
      log: (m) => { try { c.log(m); } catch { /* журнал не важнее сервера */ } },
    });
    lastFailure = null;
    await responder.start();
  } catch (e) {
    responder = null;
    lastFailure = e;
    logOnce('mdns-create', '[mdns] имя в сети не запустилось: ' + (e && e.message ? e.message : e));
  }
}

/** Такт: адрес (смена посреди работы), имя из «API», новые карты — в группу mDNS. */
export function tickLanAddress() {
  if (!ctx) return;
  try { recordNow(); } catch { /* следующий такт */ }
  if (responder) {
    try { responder.setBaseName(baseNameOf(ctx.db)); responder.refresh(); } catch { /* следующий такт */ }
  }
}

/**
 * server/index.js, после listen(). opts — для тестов: getInterfaces, env,
 * allowUnderTest, createResponder, tickMs (0 — без таймера), port, log.
 */
export async function startLanAddress(db, dataDir, opts = {}) {
  stopLanAddress();
  try {
    ctx = {
      db, dataDir,
      port: Number.isInteger(opts.port) ? opts.port : Number(process.env.PORT || 8000),
      env: opts.env || process.env,
      allowUnderTest: opts.allowUnderTest === true,
      createResponder: opts.createResponder || createMdnsResponder,
      getInterfaces: opts.getInterfaces || (() => os.networkInterfaces()),
      log: opts.log || ((m) => console.log(m)),
      timer: null,
    };
    recordNow();
    await applyMdns();
    const tickMs = Number.isInteger(opts.tickMs) ? opts.tickMs : 60 * 1000;
    if (tickMs > 0) {
      ctx.timer = setInterval(() => { try { tickLanAddress(); } catch { /* следующий такт */ } }, tickMs);
      if (ctx.timer.unref) ctx.timer.unref();
    }
  } catch (e) {
    try { console.warn('[lan]', e && e.message ? e.message : e); } catch { /* */ }
  }
}

export function stopLanAddress() {
  if (ctx && ctx.timer) clearInterval(ctx.timer);
  if (responder) { try { responder.stop(); } catch { /* уже */ } }
  responder = null; ctx = null; lastFailure = null;
  loggedOnce.clear();
}

/**
 * Состояние для экрана «Адрес в сети» и баннера. Работает и без запуска
 * (RPC в тестах, обход всех RPC): тогда имя — «не запущено».
 */
export function lanStatus(db, dataDir) {
  const c = ctx || { env: process.env, allowUnderTest: false, port: Number(process.env.PORT || 8000), getInterfaces: () => os.networkInterfaces() };
  let ifs = [];
  try { ifs = realLanInterfaces(interfacesOf(c)); } catch { ifs = []; }
  const st = readLanState(dataDir);
  const allowed = mdnsAllowed(c.env, { allowUnderTest: c.allowUnderTest });
  const base = baseNameOf(db);
  let name;
  if (responder) {
    const r = responder.status();
    // Ссылку показываем только на настоящее имя: в конфликте его нет (никогда «null.local»).
    const ok = r.state !== 'conflict' && typeof r.name === 'string' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.local$/.test(r.name) && r.name !== 'null.local';
    name = { base: r.base, current: ok ? r.name : null, state: r.state, reason: r.reason || '', suffixed: !!r.suffixed };
  } else {
    const off = (state, reason) => ({ base, current: base + '.local', state, reason, suffixed: false });
    if (!allowed.ok) name = off('off', allowed.reason);
    else if (!st.mdns_enabled) name = off('off', 'setting');
    else if (lastFailure) name = off('failed', 'error');
    else name = off('off', 'not_started');
  }
  name.url = name.current ? 'http://' + name.current + ':' + c.port : null;
  const first = ifs[0] || {};
  return {
    addresses: ifs.map((i) => ({ adapter: i.adapter, address: i.address, netmask: i.netmask, mac: formatMac(i.mac) })),
    port: c.port,
    change: visibleChange(st),
    remembered: st.addresses,
    name,
    mdns_enabled: st.mdns_enabled,
    router_hint: routerHint(first.address, first.netmask),
  };
}
