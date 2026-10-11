// PUBLIC_SERVER_V1 — АДРЕСА: кто пришёл (IP партнёра, «Разрешённые IP») и
// куда можно ходить (уведомления партнёрам — защита от подделки запроса
// изнутри, SSRF).
//
// УВЕДОМЛЕНИЕ уходит на адрес, который вписал администратор клиники. Если бы
// сервер слал куда угодно, адрес https://localhost:5678/… или имя, которое
// резолвится в 10.x / 127.x / 169.254.169.254 (метаданные облака), открыл бы
// наружу службы этой машины — а на 45.77.242.169 живут Symptex, n8n и старый
// шлюз (решение 16). Поэтому:
//   • все адреса, в которые резолвится имя, — публичные (ни одного частного,
//     петлевого, локального, служебного, многоадресного, документационного,
//     ни адреса самой машины — PUBLIC_SELF_IPS);
//   • проверка — В САМОМ ПОДКЛЮЧЕНИИ (guardedLookup — функция lookup сокета):
//     соединение идёт ровно на проверенный адрес, и подмена ответа DNS между
//     «проверили» и «подключились» (DNS rebinding) ничего не даёт.
import dns from 'node:dns';
import net from 'node:net';

export class SsrfError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// IPv4 внутри IPv6 (::ffff:a.b.c.d) BlockList сверяет с правилами IPv4 сам —
// отдельное правило ::ffff:0:0/96 закрыло бы и все публичные IPv4.
const V6_BLOCKED = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];

/** Список запрещённых адресов; selfIps — адреса этой машины. */
export function blockedList(selfIps = []) {
  const list = new net.BlockList();
  for (const [a, p] of V4_BLOCKED) list.addSubnet(a, p, 'ipv4');
  for (const [a, p] of V6_BLOCKED) list.addSubnet(a, p, 'ipv6');
  for (const ip of selfIps) {
    const fam = net.isIP(ip);
    if (fam) list.addAddress(ip, fam === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

/** Адрес публичный: IP и не в запрещённом списке. */
export function isPublicAddress(ip, list = blockedList()) {
  const fam = net.isIP(String(ip || ''));
  if (!fam) return false;
  return !list.check(String(ip), fam === 6 ? 'ipv6' : 'ipv4');
}

/** IP клиента: '::ffff:203.0.113.7' → '203.0.113.7'. */
export function clientIp(raw) {
  const s = String(raw || '').trim();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return m ? m[1] : s;
}

/**
 * «Разрешённые IP» подключения: пусто — с любого адреса; иначе адрес — в
 * одном из адресов или подсетей. Неверная запись в списке — ключ не пускается
 * ни с какого адреса: молча выкинуть её значило бы расширить доступ.
 */
export function ipAllowed(entries, ip) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return true;
  const who = clientIp(ip);
  const fam = net.isIP(who);
  if (!fam) return false;
  const allow = new net.BlockList();
  for (const e of list) {
    const [addr, prefix, extra] = String(e).trim().split('/');
    const f = net.isIP(addr);
    if (!f || extra !== undefined) return false;
    const type = f === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) { allow.addAddress(addr, type); continue; }
    const p = Number(prefix);
    if (!/^\d{1,3}$/.test(prefix) || p > (f === 6 ? 128 : 32)) return false;
    allow.addSubnet(addr, p, type);
  }
  return allow.check(who, fam === 6 ? 'ipv6' : 'ipv4');
}

/** Все адреса имени (A и AAAA). */
export const resolveAll = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * Функция lookup для сокета: резолвит, проверяет КАЖДЫЙ адрес и отдаёт
 * сокету только проверенные. Хоть один запрещённый — отказ целиком.
 */
export function guardedLookup({ resolve = resolveAll, list = blockedList() } = {}) {
  return (hostname, options, cb) => {
    const done = typeof options === 'function' ? options : cb;
    const opts = typeof options === 'object' && options ? options : {};
    Promise.resolve()
      .then(() => resolve(hostname))
      .then((addrs) => {
        const all = (Array.isArray(addrs) ? addrs : []).filter((a) => a && net.isIP(a.address));
        if (!all.length) throw new SsrfError('no_address');
        if (all.some((a) => !isPublicAddress(a.address, list))) throw new SsrfError('blocked_address');
        const out = all.map((a) => ({ address: a.address, family: net.isIP(a.address) }));
        if (opts.all) done(null, out);
        else done(null, out[0].address, out[0].family);
      })
      .catch((e) => done(e instanceof SsrfError ? e : new SsrfError('dns_failed')));
  };
}
