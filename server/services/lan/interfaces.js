// LAN_ADDRESS_V1 — АДРЕСА ЭТОГО ПК В СЕТИ КЛИНИКИ И СМЕНА АДРЕСА.
//
// Владелец: компьютер-сервер после каждого перезапуска получает от роутера
// новый адрес (192.168.1.147 → .156 → .145), и остальные компьютеры и
// анализаторы теряют сервер. Здесь — только чистые функции над тем, что
// отдаёт os.networkInterfaces(): какие адреса «настоящие» и пропал ли
// прежний. Сокетов, файлов и часов здесь нет; память — state.js, ответчик
// имени — mdns.js (docs/plans/2026-10-16-lan-address.md).
//
// Отпечаток лицензии (control/checkin.js computeFingerprint: имя ПК + первый
// MAC) живёт своей жизнью и отсюда НЕ берётся и не меняется: отбор виртуальных
// карт ниже — для подсказки человеку, а не для опознания машины.

const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// ДВА СОРТА «НЕ ТОЙ» КАРТЫ (перепроверка 2026-10-17).
//
// НИКОГДА не сеть клиники — отбрасываются всегда: туннели и VPN (WireGuard и
// встроенный PPP/IKEv2 Windows отдают MAC из нулей и любое имя, которое дал
// человек: «clinic-hq», «Офис»; AnyConnect, FortiClient, GlobalProtect зовутся
// «Ethernet N» — узнаются по MAC), сети «внутри» ПК (VirtualBox Host-Only, VMnet1/8
// VMware, Default Switch и WSL Hyper-V — две последние получают новую подсеть при
// каждом запуске), Docker, Bluetooth, мобильный хот-спот Windows (192.168.137.x).
// Их подключение и отключение — не «адрес сервера изменился».
//
// ВОЗМОЖНО сеть клиники — берутся, только если настоящих карт нет: Hyper-V
// vEthernet с внешним коммутатором и карты гостя виртуальной машины (MAC VMware,
// VirtualBox, Hyper-V): Easy-Med, запущенный внутри ВМ, видит сеть только так.
const NEVER_NAME_RE = /virtualbox|vbox|vmware|vmnet|default switch|\bwsl\b|docker|\btap\b|tap-|\btun\b|wireguard|\bwg\d|openvpn|tailscale|zerotier|hamachi|radmin|vpn|anyconnect|fortinet|forticlient|pangp|globalprotect|bluetooth|npcap|loopback|pseudo-interface|teredo|isatap/i;
const NEVER_MAC_PREFIXES = [
  '00:00:00:00:00:00',   // туннели: WireGuard/Wintun, PPP/IKEv2
  '00:ff:',              // TAP-Windows (OpenVPN)
  '00:05:9a',            // Cisco AnyConnect
  '00:09:0f',            // FortiClient
  '02:50:41',            // GlobalProtect (PANGP)
  '02:42:',              // Docker
  '0a:00:27',            // VirtualBox Host-Only (сторона хоста)
  '00:50:56:c0:00',      // VMware VMnet1/VMnet8 (сторона хоста)
];
const MAYBE_NAME_RE = /hyper-v|vethernet/i;
const MAYBE_MAC_PREFIXES = ['00:05:69', '00:0c:29', '00:1c:14', '00:50:56', '08:00:27', '00:15:5d'];

const isIpv4 = (a) => typeof a === 'string' && IPV4_RE.test(a);
const isLinkLocal = (a) => a.startsWith('169.254.');   // APIPA: адрес «сам себе», роутер его не выдавал
const isHotspot = (a) => a.startsWith('192.168.137.');  // «Мобильный хот-спот» / общий доступ Windows (ICS)

function neverLan(adapter, mac, address) {
  const m = String(mac || '').toLowerCase();
  return NEVER_NAME_RE.test(adapter) || NEVER_MAC_PREFIXES.some((p) => m.startsWith(p)) || isHotspot(address);
}
function maybeVirtual(adapter, mac) {
  const m = String(mac || '').toLowerCase();
  return MAYBE_NAME_RE.test(adapter) || MAYBE_MAC_PREFIXES.some((p) => m.startsWith(p));
}

/**
 * Адреса IPv4 этого ПК, которыми его видят другие компьютеры клиники:
 * [{ adapter, address, netmask, mac }], по имени карты, затем по адресу.
 * Туннели, VPN, хот-спот и сети «внутри» ПК отброшены всегда; карты, которые
 * МОГУТ быть сетью клиники (vEthernet внешнего коммутатора, ВМ-гость), — только
 * когда настоящих нет. Никогда не бросает.
 */
export function realLanInterfaces(interfaces) {
  if (!interfaces || typeof interfaces !== 'object') return [];
  const all = [];
  for (const adapter of Object.keys(interfaces)) {
    const list = interfaces[adapter];
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      if (!it || typeof it !== 'object' || it.internal) continue;
      // Node 18.0–18.3 отдавал family числом (4/6) — принимаем оба вида.
      if (it.family !== 'IPv4' && it.family !== 4) continue;
      if (!isIpv4(it.address) || isLinkLocal(it.address) || it.address.startsWith('127.')) continue;
      all.push({ adapter, address: it.address, netmask: typeof it.netmask === 'string' ? it.netmask : '',
        mac: typeof it.mac === 'string' ? it.mac : '' });
    }
  }
  const lan = all.filter((x) => !neverLan(x.adapter, x.mac, x.address));
  const real = lan.filter((x) => !maybeVirtual(x.adapter, x.mac));
  const out = real.length ? real : lan;
  return out.sort((a, b) => (a.adapter < b.adapter ? -1 : a.adapter > b.adapter ? 1 : ipNum(a.address) - ipNum(b.address)));
}

/** Только адреса, в том же порядке. */
export function lanAddressList(interfaces) {
  return realLanInterfaces(interfaces).map((x) => x.address);
}

/** IPv4 числом (для порядка и сравнения «кто меньше» в mdns.js). Не адрес — NaN. */
export function ipNum(a) {
  if (!isIpv4(a)) return NaN;
  return a.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}

/** В одной ли подсети адреса по маске (маска пустая — нет). */
export function sameSubnet(a, b, mask) {
  const x = ipNum(a), y = ipNum(b), m = ipNum(mask);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(m) || m === 0) return false;
  // >>> 0 — побитовое И в JS знаковое; без беззнакового сдвига 192.x дал бы минус.
  return ((x & m) >>> 0) === ((y & m) >>> 0);
}

/**
 * Карты: [{ key, adapter, addresses }] — ключ MAC (у карты может быть несколько
 * адресов), без MAC — имя карты. Порядок — по имени карты.
 */
export function lanCards(list) {
  const byKey = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    const mac = String(x.mac || '').toLowerCase();
    const key = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(mac) ? mac : 'name:' + x.adapter;
    const c = byKey.get(key) || { key, adapter: x.adapter, addresses: [] };
    if (!c.addresses.includes(x.address)) c.addresses.push(x.address);
    byKey.set(key, c);
  }
  return [...byKey.values()]
    .map((c) => ({ ...c, addresses: c.addresses.sort((a, b) => ipNum(a) - ipNum(b)) }))
    .sort((a, b) => (a.adapter < b.adapter ? -1 : a.adapter > b.adapter ? 1 : 0));
}

/**
 * Сменился ли адрес с прошлого запуска (prev, cur — lanCards).
 *   нет текущих карт (кабель выдернут при запуске) → skip: не смена и не запоминать;
 *   смена — когда ТА ЖЕ карта (тот же MAC) потеряла адрес, который у неё был: кто
 *   ходил на него, сервер потерял. Карта появилась или исчезла (VPN, хот-спот,
 *   Wi-Fi позже кабеля) — не смена: адреса оставшихся карт прежние
 *   (перепроверка 2026-10-17). from/to — адреса изменившихся карт.
 */
export function detectChange(prev, cur) {
  const before = Array.isArray(prev) ? prev : [];
  const now = Array.isArray(cur) ? cur : [];
  if (!now.length) return { changed: false, skip: true, from: [], to: [] };
  const from = [], to = [];
  for (const c of now) {
    const p = before.find((x) => x && x.key === c.key);
    if (!p || !Array.isArray(p.addresses)) continue;
    if (p.addresses.some((a) => !c.addresses.includes(a))) { from.push(...p.addresses); to.push(...c.addresses); }
  }
  return { changed: from.length > 0, skip: false, from, to };
}

/** MAC так, как его показывает ipconfig /all («Физический адрес»): A4-BB-6D-12-34-56. */
export function formatMac(mac) {
  const m = String(mac || '').trim();
  if (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(m) || m === '00:00:00:00:00:00') return '';
  return m.toUpperCase().replace(/:/g, '-');
}

/**
 * Где обычно страница роутера. Шлюз Node не сообщает; у домашних и офисных
 * роутеров с маской /24 это почти всегда x.y.z.1 своей подсети. Иначе — самый
 * частый адрес, а экран добавляет «адрес написан на наклейке роутера».
 */
export function routerHint(address, netmask) {
  if (isIpv4(address) && netmask === '255.255.255.0') return 'http://' + address.split('.').slice(0, 3).join('.') + '.1';
  return 'http://192.168.1.1';
}
