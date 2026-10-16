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

// Имена виртуальных и туннельных карт. На них «адрес сервера» искать нельзя:
// 192.168.56.1 VirtualBox или 172.27.x.x WSL другие компьютеры клиники не видят,
// а подсказать их человеку — отправить его настраивать роутер не на тот адрес.
const VIRTUAL_NAME_RE = /virtualbox|vbox|vmware|vmnet|hyper-v|vethernet|\bwsl\b|docker|\btap\b|tap-|\btun\b|wireguard|\bwg\d|openvpn|tailscale|zerotier|hamachi|radmin|vpn|bluetooth|npcap|loopback|pseudo-interface|teredo|isatap/i;
// MAC виртуальных карт, когда имя переименовано («Ethernet 3»): VMware, VirtualBox,
// Hyper-V, Docker, TAP-Windows (OpenVPN).
const VIRTUAL_MAC_PREFIXES = ['00:05:69', '00:0c:29', '00:1c:14', '00:50:56', '08:00:27', '0a:00:27', '00:15:5d', '02:42:', '00:ff:'];

const isIpv4 = (a) => typeof a === 'string' && IPV4_RE.test(a);
const isLinkLocal = (a) => a.startsWith('169.254.');   // APIPA: адрес «сам себе», роутер его не выдавал

function looksVirtual(adapter, mac) {
  if (VIRTUAL_NAME_RE.test(adapter)) return true;
  const m = String(mac || '').toLowerCase();
  return VIRTUAL_MAC_PREFIXES.some((p) => m.startsWith(p));
}

/**
 * Адреса IPv4 этого ПК, которыми его видят другие компьютеры клиники:
 * [{ adapter, address, netmask, mac }], по имени карты, затем по адресу.
 * Виртуальные/VPN-карты отброшены; если после отбора не осталось ничего (сервер
 * сам на Hyper-V с внешним коммутатором) — берутся все IPv4: подсказка «адреса
 * нет» при живой сети хуже подсказки с виртуальной картой. Никогда не бросает.
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
  const real = all.filter((x) => !looksVirtual(x.adapter, x.mac));
  const out = real.length ? real : all;
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
 * Сменился ли адрес с прошлого запуска.
 *   нет текущих адресов (кабель выдернут при запуске) → skip: не смена и не запоминать;
 *   прошлых нет (первый запуск) → не смена;
 *   хотя бы один прежний адрес пропал → смена: кто ходил на него, сервер потерял.
 *   Добавившийся рядом новый адрес — не смена: старый по-прежнему работает.
 */
export function detectChange(prev, cur) {
  const from = Array.isArray(prev) ? prev.filter(isIpv4) : [];
  const to = Array.isArray(cur) ? cur.filter(isIpv4) : [];
  if (!to.length) return { changed: false, skip: true, from, to };
  const lost = from.filter((a) => !to.includes(a));
  return { changed: lost.length > 0, skip: false, from, to };
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
