// LAN_ADDRESS_V1 — ПАКЕТЫ mDNS: разбор и сборка, без сокетов.
//
// Ровно то, что нужно ответчику имени (mdns.js): прочитать вопросы (и чужие
// ответы — для поиска конфликта имени) и собрать ответ с A-записями. Формат —
// RFC 1035 §4.1, поверх него RFC 6762: верхний бит класса вопроса — QU («ответьте
// мне лично»), верхний бит класса записи — cache-flush («это имя только моё»).
// Своих пакетов зависимостей не добавляем: обновление клиники не обязано ставить
// новые npm-пакеты, а нужен здесь десяток строк.
//
// Разбор никогда не бросает: в сеть клиники может прийти что угодно, и плохой
// пакет — это null, а не упавший сервер.

export const TYPE_A = 1;
export const TYPE_ANY = 255;
const CLASS_IN = 1;
const FLAG_QR = 0x8000;
const RESPONSE_FLAGS = 0x8400;   // QR + AA: ответ владельца имени
const TTL_MULTICAST = 120;       // RFC 6762 §10: записи с именем хоста — 120 с
const TTL_LEGACY = 10;           // RFC 6762 §6.7: обычному DNS-клиенту — не больше 10 с
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

class Bad extends Error {}

function readName(buf, start) {
  const labels = [];
  let off = start, next = -1, jumps = 0, total = 0;
  for (;;) {
    if (off >= buf.length) throw new Bad('name');
    const len = buf[off];
    if (len === 0) { off += 1; break; }
    if ((len & 0xc0) === 0xc0) {                       // указатель (сжатие имён)
      if (off + 1 >= buf.length || ++jumps > 16) throw new Bad('pointer');
      const to = ((len & 0x3f) << 8) | buf[off + 1];
      if (next < 0) next = off + 2;
      if (to >= off) throw new Bad('pointer forward');  // только назад: петля невозможна
      off = to;
      continue;
    }
    if (len & 0xc0) throw new Bad('label type');        // 64..191 — не метка
    if (off + 1 + len > buf.length) throw new Bad('label');
    labels.push(buf.toString('latin1', off + 1, off + 1 + len));
    total += len + 1;
    if (total > 255) throw new Bad('name long');
    off += 1 + len;
  }
  return { name: labels.join('.'), next: next >= 0 ? next : off };
}

const u16 = (buf, off) => { if (off + 2 > buf.length) throw new Bad('u16'); return buf.readUInt16BE(off); };
const u32 = (buf, off) => { if (off + 4 > buf.length) throw new Bad('u32'); return buf.readUInt32BE(off); };

/**
 * → { id, flags, qr, questions: [{ name, type, qclass, qu }],
 *     answers: [{ name, type, rclass, flush, ttl, address? }] } | null
 * Записи authority/additional не разбираются: ответчику они не нужны.
 */
export function parseMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  try {
    const id = u16(buf, 0), flags = u16(buf, 2);
    const qd = u16(buf, 4), an = u16(buf, 6);
    let off = 12;
    const questions = [];
    for (let i = 0; i < qd; i++) {
      const n = readName(buf, off);
      const type = u16(buf, n.next), cls = u16(buf, n.next + 2);
      questions.push({ name: n.name, type, qclass: cls & 0x7fff, qu: (cls & 0x8000) !== 0 });
      off = n.next + 4;
    }
    const answers = [];
    for (let i = 0; i < an; i++) {
      const n = readName(buf, off);
      const type = u16(buf, n.next), cls = u16(buf, n.next + 2), ttl = u32(buf, n.next + 4);
      const rdlen = u16(buf, n.next + 8), rd = n.next + 10;
      if (rd + rdlen > buf.length) throw new Bad('rdata');
      const rec = { name: n.name, type, rclass: cls & 0x7fff, flush: (cls & 0x8000) !== 0, ttl };
      if (type === TYPE_A && rdlen === 4) rec.address = `${buf[rd]}.${buf[rd + 1]}.${buf[rd + 2]}.${buf[rd + 3]}`;
      answers.push(rec);
      off = rd + rdlen;
    }
    return { id, flags, qr: (flags & FLAG_QR) !== 0, questions, answers };
  } catch {
    return null;   // Bad (наши проверки) или RangeError буфера — пакет просто не наш
  }
}

function encodeName(name) {
  const parts = String(name || '').split('.').filter(Boolean);
  // Ошибки сборки — для программиста (ответчик строит имя сам), экрану не уходят.
  if (!parts.length) throw new RangeError('mdns: пустое имя: ' + JSON.stringify(name));
  const out = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'latin1');
    if (b.length > 63) throw new RangeError('mdns: метка длиннее 63: ' + p);
    out.push(Buffer.from([b.length]), b);
  }
  out.push(Buffer.from([0]));
  const buf = Buffer.concat(out);
  if (buf.length > 255) throw new RangeError('mdns: имя длиннее 255: ' + name);
  return buf;
}

function header(id, flags, qd, an) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id & 0xffff, 0); h.writeUInt16BE(flags, 2);
  h.writeUInt16BE(qd, 4); h.writeUInt16BE(an, 6);
  return h;
}

function aRecord(nameBuf, address, legacy) {
  if (!IPV4_RE.test(String(address))) throw new RangeError('mdns: не IPv4: ' + address);
  const r = Buffer.alloc(14);
  r.writeUInt16BE(TYPE_A, 0);
  r.writeUInt16BE(legacy ? CLASS_IN : (0x8000 | CLASS_IN), 2);   // cache-flush — только в multicast
  r.writeUInt32BE(legacy ? TTL_LEGACY : TTL_MULTICAST, 4);
  r.writeUInt16BE(4, 8);
  String(address).split('.').forEach((o, i) => { r[10 + i] = Number(o); });
  return Buffer.concat([nameBuf, r]);
}

/**
 * Ответ с A-записями нашего имени.
 *   multicast (по умолчанию): ID 0, без вопроса, cache-flush, TTL 120;
 *   legacy (спросили не с порта mDNS — обычный DNS-клиент, RFC 6762 §6.7):
 *   ID запроса, вопрос повторён, без cache-flush, TTL 10.
 */
export function buildResponse({ id = 0, name, addresses, legacy = false, question = null }) {
  const nameBuf = encodeName(name);
  const list = Array.isArray(addresses) ? addresses : [];
  const parts = [header(legacy ? id : 0, RESPONSE_FLAGS, legacy && question ? 1 : 0, list.length)];
  if (legacy && question) {
    const q = Buffer.alloc(4);
    q.writeUInt16BE(question.type & 0xffff, 0); q.writeUInt16BE((question.qclass || CLASS_IN) & 0x7fff, 2);
    parts.push(encodeName(question.name), q);
  }
  for (const a of list) parts.push(aRecord(nameBuf, a, legacy));
  return Buffer.concat(parts);
}

/** Вопрос «чьё это имя?» (проба перед тем, как назваться): ANY, QM — ответ придёт multicast. */
export function buildQuery(name, { type = TYPE_ANY, qu = false, id = 0 } = {}) {
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0); q.writeUInt16BE((qu ? 0x8000 : 0) | CLASS_IN, 2);
  return Buffer.concat([header(id, 0, 1, 0), encodeName(name), q]);
}
