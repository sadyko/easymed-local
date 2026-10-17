// LAN_ADDRESS_V1 — перепроверка разборщика пакетов (2026-10-17): случайные и испорченные пакеты, петли указателей, худший пакет 64 КБ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseMessage, buildQuery, buildResponse, TYPE_A } from './mdns-packet.js';
import { createMdnsResponder } from './mdns.js';

function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

test('fuzz: random buffers never throw, always null or object', () => {
  const r = rng(12345);
  for (let i = 0; i < 20000; i++) {
    const len = Math.floor(r() * 600);
    const b = Buffer.alloc(len);
    for (let j = 0; j < len; j++) b[j] = Math.floor(r() * 256);
    const m = parseMessage(b);
    assert.ok(m === null || typeof m === 'object');
  }
});

test('fuzz: mutated valid packets never throw', () => {
  const r = rng(999);
  const seeds = [buildQuery('easymed.local', { type: TYPE_A, id: 7 }),
    buildResponse({ name: 'easymed.local', addresses: ['192.168.1.5', '10.0.0.1'] }),
    buildResponse({ id: 3, name: 'easymed.local', addresses: ['192.168.1.5'], legacy: true, question: { name: 'easymed.local', type: 1, qclass: 1 } })];
  for (let i = 0; i < 30000; i++) {
    const b = Buffer.from(seeds[i % seeds.length]);
    const n = 1 + Math.floor(r() * 6);
    for (let k = 0; k < n; k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
    const cut = r() < 0.3 ? b.subarray(0, Math.floor(r() * b.length)) : b;
    const m = parseMessage(cut);
    assert.ok(m === null || typeof m === 'object');
  }
});

test('crafted: pointer loop / self pointer / forward pointer / >16 jumps / label overflow / 64..191 label type -> null, fast', () => {
  const hdr = (qd, an = 0, flags = 0) => { const h = Buffer.alloc(12); h.writeUInt16BE(flags, 2); h.writeUInt16BE(qd, 4); h.writeUInt16BE(an, 6); return h; };
  const cases = {
    selfPointer: Buffer.concat([hdr(1), Buffer.from([0xc0, 12, 0, 1, 0, 1])]),
    forward: Buffer.concat([hdr(1), Buffer.from([0xc0, 20, 0, 1, 0, 1, 0, 0, 0, 0])]),
    // label then pointer back to label: bounded by jumps/total, not a hang
    backLoop: Buffer.concat([hdr(1), Buffer.from([1, 0x61, 0xc0, 12, 0, 1, 0, 1])]),
    labelOverflow: Buffer.concat([hdr(1), Buffer.from([63, 1, 2, 3])]),
    labelType: Buffer.concat([hdr(1), Buffer.from([0x40, 1, 0, 0, 1, 0, 1])]),
    truncatedHeader: Buffer.from([0, 0, 0]),
    qdHuge: hdr(65535),
    anHuge: hdr(0, 65535, 0x8400),
    rdlenHuge: Buffer.concat([hdr(0, 1, 0x8400), Buffer.from([0, 0, 1, 0, 1, 0, 0, 0, 120, 0xff, 0xff, 1, 2, 3, 4])]),
  };
  for (const [k, b] of Object.entries(cases)) {
    const t0 = process.hrtime.bigint();
    const m = parseMessage(b);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 20, k + ' took ' + ms);
    if (k !== 'qdHuge' && k !== 'anHuge') assert.equal(m, null, k);
    else assert.equal(m, null, k + ' (counts larger than buffer)');
  }
});

test('non-UTF8 / dot-inside-label names parse without throwing', () => {
  const h = Buffer.alloc(12); h.writeUInt16BE(1, 4);
  const b = Buffer.concat([h, Buffer.from([4, 0xff, 0xfe, 0x00, 0x80, 0]), Buffer.from([0, 1, 0, 1])]);
  const m = parseMessage(b);
  assert.ok(m && m.questions.length === 1);
  // one 13-byte label "easymed.local" joins to the same string as two labels
  const one = Buffer.concat([h, Buffer.from([13]), Buffer.from('easymed.local', 'latin1'), Buffer.from([0, 0, 1, 0, 1])]);
  assert.equal(parseMessage(one).questions[0].name, 'easymed.local');
});

// The worst packet a LAN device can send to UDP 5353: ~64 KB, qd = 65535, one
// 255-byte name at offset 12 and every further question a 2-byte pointer to it.
function worstPacket() {
  const h = Buffer.alloc(12); h.writeUInt16BE(65535, 4);
  const lab = (n) => Buffer.concat([Buffer.from([n]), Buffer.alloc(n, 0x61)]);
  const first = Buffer.concat([lab(63), lab(63), lab(63), lab(62), Buffer.from([0]), Buffer.from([0, 1, 0, 1])]);
  const parts = [h, first];
  let size = 12 + first.length;
  while (size + 6 <= 65507) { parts.push(Buffer.from([0xc0, 12, 0, 1, 0, 1])); size += 6; }
  return Buffer.concat(parts);
}

test('CPU: one worst-case 64 KB packet must be cheap (< 2 ms) — every LAN device can send hundreds per second', () => {
  const b = worstPacket();
  parseMessage(b); // warm
  const N = 50;
  const t0 = process.hrtime.bigint();
  let q = 0;
  for (let i = 0; i < N; i++) { const m = parseMessage(b); q = m ? m.questions.length : -1; }
  const per = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log('# worst packet bytes=%d questions parsed=%d ms/packet=%s', b.length, q, per.toFixed(2));
  assert.ok(per < 2, 'parse cost per worst packet ' + per.toFixed(2) + ' ms (questions parsed: ' + q + ')');
});

// The handler as the socket calls it: never throws for any input in any state.
class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; }
  bind(o, cb) { setImmediate(cb); }
  address() { return { address: '0.0.0.0', port: 5353 }; }
  send(buf, port, address, cb) { this.sent.push({ buf, port, address }); if (cb) cb(null); }
  addMembership() {} dropMembership() {} setMulticastTTL() {} setMulticastLoopback() {} setMulticastInterface() {}
  close() {}
}
test('handler: fuzzed packets through the real onMessage never throw (active state)', async (t) => {
  const sock = new FakeSocket();
  const r = createMdnsResponder({ baseName: 'easymed', probeIntervalMs: 1, createSocket: () => sock, log: () => {},
    getInterfaces: () => [{ adapter: 'Ethernet', address: '192.168.1.156', netmask: '255.255.255.0', mac: 'a4:bb:6d:12:34:56' }] });
  t.after(() => r.stop());
  await r.start();
  for (let i = 0; i < 50 && r.status().state !== 'active'; i++) await new Promise((res) => setTimeout(res, 5));
  assert.equal(r.status().state, 'active');
  const rand = rng(4242);
  const q = buildQuery('easymed.local', { type: TYPE_A, id: 9 });
  const resp = buildResponse({ name: 'easymed.local', addresses: ['192.168.1.9'] });
  for (let i = 0; i < 20000; i++) {
    const b = Buffer.from(i % 2 ? q : resp);
    for (let k = 0; k < 3; k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
    sock.emit('message', b, { address: '192.168.1.' + (1 + (i % 250)), port: i % 3 ? 5353 : 40000 + (i % 1000) });
  }
  sock.emit('message', worstPacket(), { address: '192.168.1.77', port: 5353 });
  sock.emit('message', Buffer.alloc(0), { address: '192.168.1.77', port: 5353 });
  sock.emit('message', 'not a buffer', { address: '192.168.1.77', port: 5353 });
});
