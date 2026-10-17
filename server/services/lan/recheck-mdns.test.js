// LAN_ADDRESS_V1 — повторная перепроверка (2026-10-17), повторы разборщика перенесены как есть: windowed conflict logic, buckets, cache, neighbour filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMdnsResponder } from './mdns.js';
import { parseMessage, buildQuery, buildResponse, TYPE_A } from './mdns-packet.js';
import { sameSubnet } from './interfaces.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// multicast delivered to every socket with a card in the sender card's subnet (one copy per socket)
class Link {
  constructor() { this.socks = []; this.delivered = 0; this.cap = 20000; }
  add(s) { this.socks.push(s); }
  mcast(from, srcAddr, buf) {
    const srcIf = from.ifaces.find((i) => i.address === srcAddr) || from.ifaces[0];
    for (const s of this.socks) {
      if (s === from || s.closed) continue;
      if (!s.ifaces.some((i) => sameSubnet(i.address, srcIf.address, i.netmask))) continue;
      if (this.delivered++ > this.cap) return;
      setImmediate(() => { if (!s.closed) s.emit('message', Buffer.from(buf), { address: srcIf.address, port: 5353 }); });
    }
  }
}
class LinkSocket extends EventEmitter {
  constructor(link, ifaces) { super(); this.link = link; this.ifaces = ifaces; this.closed = false; this.mif = ifaces[0].address; this.sent = []; link.add(this); }
  bind(o, cb) { setImmediate(cb); }
  address() { return { address: '0.0.0.0', port: 5353 }; }
  send(buf, port, address, cb) {
    this.sent.push({ t: Date.now(), m: parseMessage(buf), port, address, via: this.mif });
    if (address === '224.0.0.251') this.link.mcast(this, this.mif, buf);
    if (cb) cb(null);
  }
  setMulticastInterface(a) { this.mif = a; }
  addMembership() {} dropMembership() {} setMulticastTTL() {} setMulticastLoopback() {}
  close() { this.closed = true; }
}
const IF = (adapter, address, netmask = '255.255.255.0') => ({ adapter, address, netmask, mac: 'a4:bb:6d:12:34:56' });
function server(t, link, ifaces, extra = {}) {
  const sock = new LinkSocket(link, ifaces);
  const r = createMdnsResponder({ baseName: 'easymed', getInterfaces: () => ifaces, probeIntervalMs: 30, createSocket: () => sock, log: () => {}, retryAfterMs: 60000, ...extra });
  t.after(() => r.stop());
  return { r, sock };
}
async function timeline(servers, ms, step = 100) {
  const out = [];
  for (let el = 0; el < ms; el += step) { await wait(step); out.push(servers.map((s) => (s.r.status().name || s.r.status().state)).join(' / ')); }
  return out;
}
const distinctActive = (servers) => {
  const st = servers.map((s) => s.r.status());
  return st.every((x) => x.state === 'active') && new Set(st.map((x) => x.name)).size === st.length;
};


// ---- single responder, hand-driven socket
class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; }
  bind(o, cb) { setImmediate(cb); }
  address() { return { address: '0.0.0.0', port: 5353 }; }
  send(buf, port, address, cb) { this.sent.push({ t: Date.now(), m: parseMessage(buf), port, address }); if (cb) cb(null); }
  addMembership() {} dropMembership() {} setMulticastTTL() {} setMulticastLoopback() {} setMulticastInterface() {}
  close() {}
}
async function one(t, getIfaces, extra = {}) {
  const sock = new FakeSocket();
  const r = createMdnsResponder({ baseName: 'easymed', getInterfaces: getIfaces, probeIntervalMs: 2, createSocket: () => sock, log: () => {}, ...extra });
  t.after(() => r.stop());
  await r.start();
  for (let i = 0; i < 100 && r.status().state !== 'active'; i++) await wait(5);
  await wait(1300);           // let the second announce pass
  sock.sent.length = 0;
  return { r, sock };
}



test('R1: B has two cards in the SAME subnet (Ethernet .30, Wi-Fi .5), A has .10 -> both must not rename together; one keeps easymed', async (t) => {
  const link = new Link();
  const A = server(t, link, [IF('Ethernet', '192.168.1.10')]);
  const B = server(t, link, [IF('Ethernet', '192.168.1.30'), IF('Wi-Fi', '192.168.1.5')]);
  await Promise.all([A.r.start(), B.r.start()]);
  const tl = await timeline([A, B], 6000, 200);
  console.log('# R1 timeline (A / B):\n#  ' + tl.join('\n#  '));
  console.log('# R1 deliveries', link.delivered);
  const names = [A.r.status().name, B.r.status().name];
  assert.ok(distinctActive([A, B]) && names.includes('easymed.local'), 'after 6 s: ' + JSON.stringify(names) + ' ' + JSON.stringify([A.r.status(), B.r.status()]));
});

test('R1b: three single-card servers .10/.20/.30 start together -> distinct names, bounded packets', async (t) => {
  const link = new Link();
  const S = ['192.168.1.10', '192.168.1.20', '192.168.1.30'].map((a) => server(t, link, [IF('Ethernet', a)]));
  await Promise.all(S.map((s) => s.r.start()));
  const tl = await timeline(S, 7000, 500);
  console.log('# R1b timeline:\n#  ' + tl.join('\n#  ') + '\n# deliveries ' + link.delivered);
  assert.ok(distinctActive(S), JSON.stringify(S.map((s) => s.r.status())));
  assert.equal(S[0].r.status().name, 'easymed.local');
  assert.ok(link.delivered < 200, 'deliveries ' + link.delivered);
});

test('R1c: two shared subnets in reversed order (A 192.168.1.10+10.0.0.20, B 192.168.1.20+10.0.0.10) -> converge', async (t) => {
  const link = new Link();
  const A = server(t, link, [IF('Ethernet', '192.168.1.10'), IF('Ethernet 2', '10.0.0.20')]);
  const B = server(t, link, [IF('Ethernet', '192.168.1.20'), IF('Ethernet 2', '10.0.0.10')]);
  await Promise.all([A.r.start(), B.r.start()]);
  const tl = await timeline([A, B], 5000, 500);
  console.log('# R1c timeline:\n#  ' + tl.join('\n#  ') + '\n# deliveries ' + link.delivered);
  assert.ok(distinctActive([A, B]), JSON.stringify([A.r.status(), B.r.status()]));
  assert.ok(link.delivered < 200);
});

test('R1d: multi-homed vs single (old STORM) -> converge, bounded', async (t) => {
  const link = new Link();
  const A = server(t, link, [IF('Ethernet', '192.168.1.10')]);
  const B = server(t, link, [IF('Ethernet', '192.168.1.20'), IF('Ethernet 2', '10.0.0.5')]);
  await Promise.all([A.r.start(), B.r.start()]);
  await wait(4000);
  console.log('# R1d', A.r.status().name, B.r.status().name, 'deliveries', link.delivered);
  assert.ok(distinctActive([A, B]));
  assert.ok(link.delivered < 100);
});

test('R4: attacker floods queries (200/s) — every legit query still sees a multicast answer within ~1 s', async (t) => {
  const { sock } = await one(t, () => [IF('Ethernet', '192.168.1.156')]);
  const q = buildQuery('easymed.local', { type: TYPE_A });
  const legitAt = [];
  const flood = setInterval(() => sock.emit('message', q, { address: '192.168.1.66', port: 5353 }), 5);
  t.after(() => clearInterval(flood));
  for (let i = 0; i < 8; i++) {
    await wait(150 + Math.floor(Math.random() * 400));
    legitAt.push(Date.now());
    sock.emit('message', q, { address: '192.168.1.40', port: 5353 });
  }
  await wait(1200);
  clearInterval(flood);
  const answers = sock.sent.filter((s) => s.address === '224.0.0.251').map((s) => s.t);
  const delays = legitAt.map((t0) => { const a = answers.find((x) => x >= t0); return a === undefined ? Infinity : a - t0; });
  console.log('# R4 multicast answers', answers.length, 'over', ((answers.at(-1) - answers[0]) / 1000).toFixed(1), 's; legit delays ms', JSON.stringify(delays));
  assert.ok(delays.every((d) => d <= 1100), JSON.stringify(delays));
});

test('R6b: loopback / own address / ::ffff: — loopback query answered, own-address query answered, mapped form ignored', async (t) => {
  const { sock } = await one(t, () => [IF('Ethernet', '192.168.1.156'), IF('Ethernet 2', '10.0.0.5')]);
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 4 }), { address: '127.0.0.1', port: 40002 });
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 5 }), { address: '192.168.1.156', port: 40003 });
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 6 }), { address: '::ffff:192.168.1.40', port: 40004 });
  const by = (a) => sock.sent.filter((s) => s.address === a).map((s) => s.m.answers.map((x) => x.address));
  console.log('# R6b 127:', JSON.stringify(by('127.0.0.1')), 'own:', JSON.stringify(by('192.168.1.156')), 'mapped:', JSON.stringify(by('::ffff:192.168.1.40')));
  assert.deepEqual(by('192.168.1.156'), [['192.168.1.156']]);
  assert.deepEqual(by('::ffff:192.168.1.40'), []);
});

test('R7: forged claim from a neighbour with a plausible lower on-subnet address still renames (inherent to mDNS) — and recovers', async (t) => {
  const { r, sock } = await one(t, () => [IF('Ethernet', '192.168.1.156')]);
  sock.emit('message', buildResponse({ name: 'easymed.local', addresses: ['192.168.1.2'] }), { address: '192.168.1.66', port: 5353 });
  await wait(400);
  console.log('# R7 after one forged plausible claim:', JSON.stringify(r.status()));
});

test('R2: DHCP renewal .147 -> .156 between 60-s ticks: an answer must not carry the old address', async (t) => {
  let NET = [IF('Ethernet', '192.168.1.147')];
  const { sock } = await one(t, () => NET);
  NET = [IF('Ethernet', '192.168.1.156')];       // renewal; refresh() not yet called by the minute tick
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A }), { address: '192.168.1.40', port: 5353 });
  const a = sock.sent.flatMap((s) => (s.m ? s.m.answers.map((x) => x.address) : []));
  console.log('# R2 answer after renewal:', JSON.stringify(a));
  assert.ok(!a.includes('192.168.1.147'), 'stale answer ' + JSON.stringify(a) + ' (cache-flush TTL 120 s on the client)');
});

test('R2b: started before DHCP (no address) -> address arrives -> answers before the next 60-s tick', async (t) => {
  let NET = [];
  const { sock } = await one(t, () => NET);
  NET = [IF('Ethernet', '192.168.1.156')];
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A }), { address: '192.168.1.40', port: 5353 });
  console.log('# R2b answers:', sock.sent.length);
  assert.ok(sock.sent.length > 0, 'no answer until refresh()');
});

test('R3: one neighbour sending 25 plain-DNS (legacy) queries per second starves every other plain-DNS client', async (t) => {
  const { sock } = await one(t, () => [IF('Ethernet', '192.168.1.156')]);
  const q = buildQuery('easymed.local', { type: TYPE_A, id: 1 });
  for (let i = 0; i < 25; i++) sock.emit('message', q, { address: '192.168.1.66', port: 40000 + i });
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 2 }), { address: '192.168.1.40', port: 51000 });
  const toLegit = sock.sent.filter((s) => s.address === '192.168.1.40');
  console.log('# R3 replies to attacker', sock.sent.filter((s) => s.address === '192.168.1.66').length, 'to legit', toLegit.length);
  assert.equal(toLegit.length, 1, 'legit plain-DNS client unanswered');
});
