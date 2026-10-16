// LAN_ADDRESS_V1 — ОТВЕТЧИК ИМЕНИ <имя>.local (mDNS, RFC 6762).
//
// Зачем. Роутер клиники после перезапуска выдаёт серверу новый адрес, и
// компьютеры, открывавшие http://192.168.1.147:8000, теряют его. Windows 10/11
// (и телефоны, и macOS) сами спрашивают имена *.local по multicast DNS —
// 224.0.0.251, порт 5353. Если сервер отвечает на «medlife.local» своим ТЕКУЩИМ
// адресом, ссылка http://medlife.local:8000 переживает любую смену номера.
// Анализаторам это не поможет (адрес LIS у них — число), поэтому настоящее
// лечение — резервирование в роутере; экран «Адрес в сети» говорит это прямо.
//
// Своя реализация на node:dgram, без пакетов: обновление клиники не обязано
// ставить новые зависимости, а нужно ровно одно — отвечать A-записью.
//
// НИКОГДА НЕ РОНЯЕТ СЕРВЕР. Порт занят, multicast запрещён, брандмауэр — одна
// строка в журнал (logOnce) и состояние для экрана; регистратура и касса важнее
// имени в сети. Выключатель и запрет под тестами — mdnsAllowed() ниже, решает
// вызывающий (lan/index.js).
//
// КОНФЛИКТ ИМЁН. Два сервера Easy-Med в одной сети (главное здание и филиал,
// branch-sync) не должны назваться одинаково:
//   * перед тем как назваться — 3 пробы «чьё это имя?»; кто-то ответил своим
//     адресом → берём имя-2, имя-3 … имя-9 (дальше — состояние conflict);
//   * во время работы чужой ответ с нашим именем и другим адресом: меньший
//     IPv4 оставляет имя и сразу объявляет себя, больший переходит на
//     следующее. Правило одно для обоих, поэтому они не меняются именами по
//     кругу.
// Пробы — вопросом QM, не QU (вопреки совету RFC): на Windows порт 5353 делят
// служба DNS-клиента и мы, и ответ «лично» (unicast на 5353) может достаться
// ей, а multicast получают все.
import dgram from 'node:dgram';
import os from 'node:os';
import { parseMessage, buildResponse, buildQuery, TYPE_A, TYPE_ANY } from './mdns-packet.js';
import { realLanInterfaces, ipNum, sameSubnet } from './interfaces.js';

export const MDNS_GROUP = '224.0.0.251';
export const MDNS_PORT = 5353;
export const DEFAULT_BASE = 'easymed';
const MAX_ATTEMPT = 8;   // easymed, easymed-2 … easymed-9

/**
 * Можно ли поднимать ответчик. EASYMED_MDNS=0|off|false|no — выключено всегда.
 * Под node --test (NODE_TEST_CONTEXT) — выключено, пока тест явно не включил
 * (EASYMED_MDNS=1 или allowUnderTest): тест, запустивший server/index.js или
 * обошедший все RPC, не должен занять 5353 и назваться в сети разработчика.
 */
export function mdnsAllowed(env = process.env, { allowUnderTest = false } = {}) {
  const v = String((env && env.EASYMED_MDNS) || '').trim().toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(v)) return { ok: false, reason: 'env_off' };
  if (env && env.NODE_TEST_CONTEXT && v !== '1' && !allowUnderTest) return { ok: false, reason: 'test' };
  return { ok: true, reason: '' };
}

/** Основа имени: «имя в адресе» клиники (уже [a-z0-9-]), иначе easymed. */
export function normalizeBase(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,50}[a-z0-9])?$/.test(s) ? s : DEFAULT_BASE;
}

/** attempt 0 → основа, 1 → основа-2 … 8 → основа-9, дальше — null. */
export function nextName(base, attempt) {
  if (attempt > MAX_ATTEMPT) return null;
  return attempt === 0 ? base : base + '-' + (attempt + 1);
}

const reasonOf = (e) => {
  const c = e && e.code;
  if (c === 'EADDRINUSE') return 'port_busy';
  if (c === 'EACCES' || c === 'EPERM') return 'access';
  return 'error';
};

export function createMdnsResponder({
  baseName = DEFAULT_BASE,
  getInterfaces = () => realLanInterfaces(os.networkInterfaces()),
  port = MDNS_PORT,
  bindAddress,
  group = MDNS_GROUP,
  joinMulticast = true,
  announceTo = null,           // { address, port } — куда multicast; тесты подставляют свой сокет
  probeIntervalMs = 250,
  probeCount = 3,
  log = (m) => console.warn(m),
  createSocket = (o) => dgram.createSocket(o),
} = {}) {
  let base = normalizeBase(baseName);
  let attempt = 0;
  let state = 'stopped', reason = '';
  let sock = null, bound = false, boundPort = null, stopped = false;
  let gen = 0;                       // поколение проб: сменили имя — старые таймеры молчат
  const timers = new Set();
  const logged = new Set();
  const joined = new Set();
  let announcedKey = '';

  const fqdn = () => nextName(base, attempt) + '.local';
  const logOnce = (key, msg) => { if (logged.has(key)) return; logged.add(key); try { log('[mdns] ' + msg); } catch { /* журнал не важнее сервера */ } };
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    if (t.unref) t.unref();
    timers.add(t);
  };
  const ifaces = () => { try { const l = getInterfaces(); return Array.isArray(l) ? l : []; } catch { return []; } };

  function rawSend(buf, p, address) {
    if (!sock || !bound) return;
    try {
      sock.send(buf, p, address, (err) => { if (err) logOnce('send', 'не удалось отправить ответ: ' + (err.code || err.message)); });
    } catch (e) { logOnce('send', 'не удалось отправить ответ: ' + (e.code || e.message)); }
  }
  const target = () => announceTo || { address: group, port };

  // multicast: по каждой карте отдельно, со своим адресом — спрашивающий в
  // подсети Wi-Fi должен получить адрес Wi-Fi, а не кабеля.
  function multicast(build, list = ifaces()) {
    const t = target();
    if (joinMulticast && list.length) {
      for (const it of list) {
        try { sock.setMulticastInterface(it.address); } catch { /* карта ушла — шлём как есть */ }
        rawSend(build([it.address]), t.port, t.address);
      }
    } else {
      rawSend(build(list.map((i) => i.address)), t.port, t.address);
    }
  }

  function announce() {
    const list = ifaces();
    if (!list.length) return;
    announcedKey = list.map((i) => i.address).join(',');
    multicast((addrs) => buildResponse({ name: fqdn(), addresses: addrs }), list);
  }

  function beginProbe() {
    const my = ++gen;
    state = 'probing';   // reason (например no_multicast) остаётся: это про сокет, не про имя
    let n = 0;
    const tick = () => {
      if (my !== gen || stopped) return;
      if (n < probeCount) {
        n++;
        multicast(() => buildQuery(fqdn()));
        later(tick, probeIntervalMs);
        return;
      }
      state = 'active';
      announce();
      later(() => { if (my === gen && state === 'active') announce(); }, 1000);
    };
    tick();
  }

  function rename() {
    attempt++;
    if (!nextName(base, attempt)) {
      gen++;
      state = 'conflict';
      logOnce('conflict:' + base, `все имена ${base}.local … ${nextName(base, MAX_ATTEMPT)}.local заняты другими компьютерами — имя в сети не работает`);
      return;
    }
    beginProbe();
  }

  function onConflict(their) {
    if (state === 'probing') { rename(); return; }
    if (state !== 'active') return;
    const ours = Math.min(...ifaces().map((i) => ipNum(i.address)).filter(Number.isFinite));
    if (Number.isFinite(ours) && ours < ipNum(their)) { announce(); return; }
    rename();
  }

  // Порядок проверок — ради цены: в сети клиники mDNS-пакетов много (принтеры,
  // телефоны, Chromecast), а опрос сетевых карт (os.networkInterfaces) на Windows
  // не бесплатен. Карты читаются только для пакета, где есть НАШЕ имя.
  function onMessage(msg, rinfo) {
    if (stopped || !rinfo) return;
    const m = parseMessage(msg);
    if (!m) return;
    const name = fqdn().toLowerCase();
    if (m.qr) {
      const claims = m.answers.filter((a) => a.type === TYPE_A && a.address && a.name.toLowerCase() === name);
      if (!claims.length) return;
      // Ответ со своего же адреса — наше объявление вернулось петлёй multicast:
      // не конфликт. ВОПРОС со своего адреса — другое дело: это служба DNS-клиента
      // Windows на этом же ПК (браузер сервера открыл <имя>.local), ему отвечаем.
      // Свои пробы сюда не попадают: пока идёт проба, на вопросы мы не отвечаем.
      const mine = ifaces().map((i) => i.address);
      if (mine.includes(rinfo.address)) return;
      const other = claims.find((a) => !mine.includes(a.address));
      if (other) onConflict(other.address);
      return;
    }
    if (state !== 'active') return;
    const q = m.questions.find((x) => x.name.toLowerCase() === name && (x.type === TYPE_A || x.type === TYPE_ANY) && (x.qclass === 1 || x.qclass === 255));
    if (!q) return;
    const list = ifaces();
    const local = list.filter((i) => sameSubnet(i.address, rinfo.address, i.netmask));
    const use = local.length ? local : list;
    if (!use.length) return;
    const addresses = use.map((i) => i.address);
    if (rinfo.port !== boundPort) {
      // Обычный DNS-клиент (nslookup, программа) спросил со своего порта — RFC 6762 §6.7.
      rawSend(buildResponse({ id: m.id, name: fqdn(), addresses, legacy: true, question: q }), rinfo.port, rinfo.address);
      return;
    }
    const t = target();
    if (joinMulticast) { try { sock.setMulticastInterface(use[0].address); } catch { /* как есть */ } }
    rawSend(buildResponse({ name: fqdn(), addresses }), t.port, t.address);
  }

  function fail(e) {
    gen++;
    state = 'failed'; reason = reasonOf(e);
    logOnce('socket', `имя в сети не работает (UDP ${port}): ${(e && (e.code || e.message)) || e}. Сервер работает дальше, адрес — числом.`);
    try { if (sock) sock.close(); } catch { /* уже закрыт */ }
    bound = false;
  }

  function joinAll() {
    if (!joinMulticast) return;
    let failed = 0;
    for (const it of ifaces()) {
      if (joined.has(it.address)) continue;
      try { sock.addMembership(group, it.address); joined.add(it.address); }
      catch (e) { failed++; logOnce('membership', `не удалось войти в группу ${group} на ${it.address}: ${e.code || e.message} — имя может не находиться другими компьютерами`); }
    }
    if (!joined.size && failed) reason = 'no_multicast';
    else if (joined.size && reason === 'no_multicast') reason = '';
  }

  return {
    start() {
      stopped = false;
      state = 'starting'; reason = '';
      return new Promise((resolve) => {
        try { sock = createSocket({ type: 'udp4', reuseAddr: true }); }
        catch (e) { fail(e); resolve(); return; }
        sock.on('error', (e) => {
          if (bound && e && e.code === 'ECONNRESET') { logOnce('connreset', 'ECONNRESET от UDP — пропущено'); return; }
          if (state !== 'failed') fail(e);
          resolve();
        });
        sock.on('message', onMessage);
        try {
          sock.bind({ port, address: bindAddress, exclusive: false }, () => {
            if (stopped) { resolve(); return; }
            bound = true;
            try { boundPort = sock.address().port; } catch { boundPort = port; }
            if (joinMulticast) {
              try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch { /* по умолчанию тоже работает */ }
              joinAll();
            }
            beginProbe();
            resolve();
          });
        } catch (e) { fail(e); resolve(); }
      });
    },
    stop() {
      stopped = true; gen++;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      try { if (sock) sock.close(); } catch { /* уже закрыт */ }
      sock = null; bound = false; state = 'stopped';
    },
    /** Новая основа имени («имя в адресе» сменили) — пробуем её с начала. */
    setBaseName(v) {
      const nb = normalizeBase(v);
      if (nb === base) return;
      base = nb; attempt = 0;
      if (bound && !stopped && (state === 'probing' || state === 'active' || state === 'conflict')) beginProbe();
    },
    /** Такт раз в минуту: новая карта/адрес — войти в группу и объявить себя заново. */
    refresh() {
      if (!bound || stopped) return;
      joinAll();
      const key = ifaces().map((i) => i.address).join(',');
      if (state === 'active' && key && key !== announcedKey) announce();
    },
    port: () => boundPort,
    status: () => ({ base, name: fqdn(), state, reason, suffixed: attempt > 0 }),
  };
}
