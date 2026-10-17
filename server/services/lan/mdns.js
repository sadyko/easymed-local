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
//   * во время работы чужой ответ с нашим именем и другим адресом из нашей
//     подсети: притязания собираются коротким окном (объявления идут по каждой
//     карте подряд), и решает САМАЯ МЛАДШАЯ общая подсеть — в ней меньший IPv4
//     оставляет имя, больший переходит на следующее. Оба сервера видят одни и
//     те же общие подсети, поэтому решение у них зеркальное, даже когда у
//     одного вторая карта или порядок адресов в двух подсетях обратный
//     (перепроверка 2026-10-17: сравнение «мой наименьший адрес с его адресом»
//     давало обоим «я меньше» и бесконечный обмен объявлениями).
// ЦЕНА. Ответ и объявление — не чаще раза в секунду на запись и карту (RFC 6762
// §6), обычному DNS-клиенту — не больше 20 ответов в секунду. Список сетевых
// карт хранится в памяти: его перечитывают запуск и такт раз в минуту
// (refresh), а не каждый пакет — os.networkInterfaces() на Windows ~1 мс.
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
const RATE_MS = 1000;    // RFC 6762 §6: одна и та же запись в одну сеть — не чаще раза в секунду
const LEGACY_PER_SEC = 20;

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
  conflictWindowMs = probeIntervalMs,   // сколько ждать притязаний с других карт того же сервера
  retryAfterMs = 60 * 1000,             // все имена заняты — через сколько пробовать снова (RFC 6762 §8.1)
  now = () => Date.now(),
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
  let cache = null;                  // список карт: запуск и refresh(), не каждый пакет
  const lastMc = new Map();          // запись|карта → когда отправлена multicast
  let legacyAt = 0, legacyN = 0;     // окно «обычных» ответов
  let pending = null;                // притязания на наше имя в текущем окне

  const fqdn = () => nextName(base, attempt) + '.local';
  const logOnce = (key, msg) => { if (logged.has(key)) return; logged.add(key); try { log('[mdns] ' + msg); } catch { /* журнал не важнее сервера */ } };
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    if (t.unref) t.unref();
    timers.add(t);
  };
  const readIfaces = () => { try { const l = getInterfaces(); return Array.isArray(l) ? l : []; } catch { return []; } };
  const reload = () => { cache = readIfaces(); return cache; };
  const ifaces = () => cache || reload();
  // Не чаще раза в секунду на запись (имя) и карту — отдельно для объявлений
  // ('ann') и ответов на вопросы ('ans'): вопрос через 20 мс после объявления
  // (Windows не помнит объявлений, о которых не спрашивала) всё равно получит ответ.
  function allowMc(kind, name, via) {
    const key = kind + '|' + name.toLowerCase() + '|' + via;
    const t = now(), last = lastMc.get(key);
    if (last !== undefined && t - last < RATE_MS) return false;
    lastMc.set(key, t);
    return true;
  }
  function allowLegacy() {
    const t = now();
    if (t - legacyAt >= 1000) { legacyAt = t; legacyN = 0; }
    return ++legacyN <= LEGACY_PER_SEC;
  }

  function rawSend(buf, p, address) {
    if (!sock || !bound) return;
    try {
      sock.send(buf, p, address, (err) => { if (err) logOnce('send', 'не удалось отправить ответ: ' + (err.code || err.message)); });
    } catch (e) { logOnce('send', 'не удалось отправить ответ: ' + (e.code || e.message)); }
  }
  const target = () => announceTo || { address: group, port };

  // multicast: по каждой карте отдельно, со своим адресом — спрашивающий в
  // подсети Wi-Fi должен получить адрес Wi-Fi, а не кабеля.
  // rateName — ответ/объявление (запись имени): не чаще раза в секунду на карту;
  // пробы (вопросы) идут без него — их и так три за запуск имени.
  function multicast(build, list = ifaces(), rateName = null) {   // rateName — только объявления
    const t = target();
    if (joinMulticast && list.length) {
      for (const it of list) {
        if (rateName && !allowMc('ann', rateName, it.address)) continue;
        try { sock.setMulticastInterface(it.address); } catch { /* карта ушла — шлём как есть */ }
        rawSend(build([it.address]), t.port, t.address);
      }
    } else {
      if (rateName && !allowMc('ann', rateName, '*')) return;
      rawSend(build(list.map((i) => i.address)), t.port, t.address);
    }
  }

  function announce() {
    const list = ifaces();
    if (!list.length) return;
    announcedKey = list.map((i) => i.address).join(',');
    const name = fqdn();
    multicast((addrs) => buildResponse({ name, addresses: addrs }), list, name);
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
      // Второе объявление — через секунду с запасом (RFC 6762 §8.3; ограничитель — 1 с).
      later(() => { if (my === gen && state === 'active') announce(); }, RATE_MS + 100);
    };
    tick();
  }

  // Все имена заняты — не сдаваться навсегда (перепроверка 2026-10-17: девять
  // поддельных пакетов выключали имя до перезапуска): отступить и через
  // retryAfterMs (и на каждом такте refresh) пробовать имя с начала.
  function rename() {
    attempt++;
    if (!nextName(base, attempt)) {
      const my = ++gen;
      state = 'conflict';
      logOnce('conflict:' + base, `все имена ${base}.local … ${nextName(base, MAX_ATTEMPT)}.local заняты другими компьютерами — имя в сети пока не работает, попробую позже`);
      later(() => { if (my === gen && state === 'conflict' && !stopped) { attempt = 0; beginProbe(); } }, retryAfterMs);
      return;
    }
    beginProbe();
  }

  // Притязание на наше имя с адресом their из подсети нашей карты mineIf.
  // Во время пробы имя уже чьё-то — следующее. Во время работы — окно: сервер
  // объявляет себя по каждой карте подряд, и решение принимается по самой
  // младшей общей подсети (одинаковой для обоих серверов).
  function onConflict(their, mineIf) {
    if (state === 'probing') { rename(); return; }
    if (state !== 'active') return;
    const net = (ipNum(mineIf.address) & ipNum(mineIf.netmask)) >>> 0;
    if (!pending) {
      const p = pending = { gen, claims: new Map() };
      later(() => decide(p), conflictWindowMs);
    }
    const prev = pending.claims.get(net);
    if (!prev || ipNum(their) < ipNum(prev.their)) pending.claims.set(net, { ours: mineIf.address, their });
  }
  function decide(p) {
    if (pending === p) pending = null;
    if (p.gen !== gen || state !== 'active' || stopped) return;
    const [, c] = [...p.claims.entries()].sort((x, y) => x[0] - y[0])[0];
    if (ipNum(c.ours) < ipNum(c.their)) { announce(); return; }   // имя наше; объявление — по ограничителю
    rename();
  }

  // Порядок проверок — ради цены: в сети клиники mDNS-пакетов много (принтеры,
  // телефоны, Chromecast), а опрос сетевых карт (os.networkInterfaces) на Windows
  // не бесплатен. Карты читаются только для пакета, где есть НАШЕ имя.
  function onMessage(msg, rinfo) {
    if (stopped || !rinfo || state === 'conflict') return;
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
      const list = ifaces();
      const mine = list.map((i) => i.address);
      if (mine.includes(rinfo.address)) return;
      if (!neighbourIfaces(list, rinfo.address)) return;   // притязание не из нашей сети — не наше дело
      for (const c of claims) {
        if (mine.includes(c.address)) continue;
        // Притязание считается, только если адрес — из подсети нашей карты: только
        // там наши компьютеры могли бы получить чужой адрес вместо нашего.
        const mineIf = list.find((i) => sameSubnet(i.address, c.address, i.netmask));
        if (mineIf) onConflict(c.address, mineIf);
      }
      return;
    }
    if (state !== 'active') return;
    const q = m.questions.find((x) => x.name.toLowerCase() === name && (x.type === TYPE_A || x.type === TYPE_ANY) && (x.qclass === 1 || x.qclass === 255));
    if (!q) return;
    // Только соседям и только их подсетью: вопрос не из наших подсетей (8.8.8.8 через
    // проброс порта, VPN) остаётся без ответа, и адресов другой сети никто не получает
    // (перепроверка 2026-10-17: «обычный» вопрос с 8.8.8.8 получал оба адреса сервера).
    const use = neighbourIfaces(ifaces(), rinfo.address);
    if (!use || !use.length) return;
    const addresses = use.map((i) => i.address);
    if (rinfo.port !== boundPort) {
      // Обычный DNS-клиент (nslookup, программа) спросил со своего порта — RFC 6762 §6.7.
      if (!allowLegacy()) return;
      rawSend(buildResponse({ id: m.id, name: fqdn(), addresses, legacy: true, question: q }), rinfo.port, rinfo.address);
      return;
    }
    const t = target();
    const own = fqdn();
    if (!allowMc('ans', own, joinMulticast ? use[0].address : '*')) return;   // этот ответ в эту сеть уже ушёл меньше секунды назад
    if (joinMulticast) { try { sock.setMulticastInterface(use[0].address); } catch { /* как есть */ } }
    rawSend(buildResponse({ name: own, addresses }), t.port, t.address);
  }

  // Карты, через которые отправитель — наш сосед: его подсеть; свой же адрес — эта
  // карта (служба DNS-клиента Windows на этом ПК); петля 127/8 — все карты (это сам
  // ПК; снаружи пакет с 127/8 Windows не пропускает). Иначе null — не сосед.
  function neighbourIfaces(list, src) {
    const s = String(src || '');
    if (/^127\./.test(s)) return list;
    const local = list.filter((i) => i.address === s || sameSubnet(i.address, s, i.netmask));
    return local.length ? local : null;
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
            reload();
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
      const key = reload().map((i) => i.address).join(',');
      joinAll();
      if (state === 'conflict') { attempt = 0; beginProbe(); return; }
      if (state === 'active' && key && key !== announcedKey) announce();
    },
    port: () => boundPort,
    // В конфликте имени нет: null, а не «null.local».
    status: () => ({ base, name: state === 'conflict' ? null : fqdn(), state, reason, suffixed: attempt > 0 }),
  };
}
