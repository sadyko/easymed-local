// LAN_ADDRESS_V1 — перепроверка ответчика имени (состязательный разбор 2026-10-17).
//
// Повторы находок разборщика, перенесённые как есть: каждый утверждает
// БЕЗОПАСНОЕ поведение. «Сеть» — подставленная: multicast доставляется каждому
// сокету, чья карта в подсети отправителя; порт 5353 машины не занимается.
//   STORM — два сервера, у одного вторая карта: оба «меньше» → объявления без конца;
//   RATE  — ответ и объявление не чаще раза в секунду на запись и карту (RFC 6762 §6);
//   цена  — чужие пакеты и пакеты с нашим именем не опрашивают сетевые карты.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMdnsResponder } from './mdns.js';
import { parseMessage, buildQuery, buildResponse, TYPE_A } from './mdns-packet.js';
import { sameSubnet } from './interfaces.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await wait(5); } return true; }

// ---- «провод»: multicast — каждому сокету, у которого есть карта в подсети отправителя
class Link {
  constructor() { this.socks = []; this.delivered = 0; this.cap = 5000; }
  add(s) { this.socks.push(s); }
  mcast(from, srcAddr, buf) {
    const srcIf = from.ifaces.find((i) => i.address === srcAddr) || from.ifaces[0];
    for (const s of this.socks) {
      if (s === from || s.closed) continue;
      if (!s.ifaces.some((i) => sameSubnet(i.address, srcIf.address, i.netmask))) continue;
      if (this.delivered++ > this.cap) return;
      setImmediate(() => { if (!s.closed) s.emit('message', Buffer.from(buf), { address: srcIf.address, port: 5353, family: 'IPv4', size: buf.length }); });
    }
  }
}
class LinkSocket extends EventEmitter {
  constructor(link, ifaces) { super(); this.link = link; this.ifaces = ifaces; this.closed = false; this.mif = ifaces[0].address; this.sent = []; link.add(this); }
  bind(o, cb) { setImmediate(cb); }
  address() { return { address: '0.0.0.0', port: 5353 }; }
  send(buf, port, address, cb) {
    this.sent.push({ m: parseMessage(buf), port, address });
    if (address === '224.0.0.251') this.link.mcast(this, this.mif, buf);
    if (cb) cb(null);
  }
  setMulticastInterface(a) { this.mif = a; }
  addMembership() {} dropMembership() {} setMulticastTTL() {} setMulticastLoopback() {}
  close() { this.closed = true; }
}
function server(t, link, ifaces, extra = {}) {
  const sock = new LinkSocket(link, ifaces);
  const r = createMdnsResponder({ baseName: 'easymed', getInterfaces: () => ifaces, probeIntervalMs: 5, createSocket: () => sock, log: () => {}, ...extra });
  t.after(() => r.stop());
  return { r, sock };
}
const IF = (adapter, address) => ({ adapter, address, netmask: '255.255.255.0', mac: 'a4:bb:6d:12:34:56' });

test('контроль: два сервера по одному адресу, одно имя — расходятся (easymed и easymed-2) за несколько пакетов', async (t) => {
  const link = new Link();
  const A = server(t, link, [IF('Ethernet', '192.168.1.10')]);
  const B = server(t, link, [IF('Ethernet', '192.168.1.20')]);
  await Promise.all([A.r.start(), B.r.start()]);
  await wait(400);
  assert.deepEqual([A.r.status().name, B.r.status().name].sort(), ['easymed-2.local', 'easymed.local']);
  assert.ok(link.delivered < 60, 'deliveries ' + link.delivered);
});

test('STORM: у второго сервера вторая карта (10.0.0.5) — не «оба меньше», имена расходятся, пакетов мало', async (t) => {
  const link = new Link();
  const A = server(t, link, [IF('Ethernet', '192.168.1.10')]);
  const B = server(t, link, [IF('Ethernet', '192.168.1.20'), IF('Ethernet 2', '10.0.0.5')]);
  await Promise.all([A.r.start(), B.r.start()]);
  await wait(400);
  assert.deepEqual([A.r.status().name, B.r.status().name].sort(), ['easymed-2.local', 'easymed.local'], 'two servers must not keep the same name');
  assert.ok(link.delivered < 60, 'multicast packets exchanged in 400 ms: ' + link.delivered);
});

test('две общие подсети с обратным порядком адресов (A меньше в одной, B — в другой) — всё равно расходятся', async (t) => {
  const link = new Link();
  const A = server(t, link, [IF('Ethernet', '192.168.1.10'), IF('Ethernet 2', '10.0.0.9')]);
  const B = server(t, link, [IF('Ethernet', '192.168.1.20'), IF('Ethernet 2', '10.0.0.5')]);
  await Promise.all([A.r.start(), B.r.start()]);
  await until(() => {
    const n = [A.r.status(), B.r.status()];
    return n.every((s) => s.state === 'active') && n[0].name !== n[1].name;
  }, 1500);
  const names = [A.r.status().name, B.r.status().name];
  assert.notEqual(names[0], names[1], JSON.stringify(names));
  assert.ok(names.includes('easymed.local'), 'имя без номера осталось у одного: ' + JSON.stringify(names));
  assert.ok(link.delivered < 80, 'deliveries ' + link.delivered);
});

// ---- один ответчик с ручным сокетом
class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.closed = false; }
  bind(o, cb) { setImmediate(cb); }
  address() { return { address: '0.0.0.0', port: 5353 }; }
  send(buf, port, address, cb) { this.sent.push({ m: parseMessage(buf), port, address }); if (cb) cb(null); }
  addMembership() {} dropMembership() {} setMulticastTTL() {} setMulticastLoopback() {} setMulticastInterface() {}
  close() { this.closed = true; }
}
async function one(t, ifaces = [IF('Ethernet', '192.168.1.156')]) {
  const sock = new FakeSocket();
  let calls = 0;
  const r = createMdnsResponder({ baseName: 'easymed', getInterfaces: () => { calls++; return ifaces; }, probeIntervalMs: 2, createSocket: () => sock, log: () => {} });
  t.after(() => r.stop());
  await r.start();
  await until(() => r.status().state === 'active');
  await wait(20);
  sock.sent.length = 0;
  return { r, sock, ifCalls: () => calls };
}

test('RATE: 1000 вопросов о нашем имени подряд — не 1000 multicast-ответов (RFC 6762 §6: раз в секунду на запись и карту)', async (t) => {
  const { sock } = await one(t);
  const q = buildQuery('easymed.local', { type: TYPE_A });
  for (let i = 0; i < 1000; i++) sock.emit('message', q, { address: '192.168.1.50', port: 5353 });
  const mc = sock.sent.filter((s) => s.address === '224.0.0.251').length;
  assert.ok(mc <= 5, 'multicast answers: ' + mc);
});

test('RATE: 1000 поддельных притязаний с бо́льшим адресом — не 1000 объявлений', async (t) => {
  const { r, sock } = await one(t);
  const name = r.status().name;
  for (let i = 0; i < 1000; i++) sock.emit('message', buildResponse({ name, addresses: ['192.168.1.250'] }), { address: '192.168.1.250', port: 5353 });
  await wait(30);
  const mc = sock.sent.filter((s) => s.address === '224.0.0.251').length;
  assert.ok(mc <= 5, 'announces: ' + mc);
  assert.equal(r.status().name, 'easymed.local');
});

test('цена: пакеты с нашим именем не опрашивают сетевые карты на каждый пакет (список карт — из памяти, обновляет такт)', async (t) => {
  const { r, sock, ifCalls } = await one(t);
  const before = ifCalls();
  const q = buildQuery('easymed.local', { type: TYPE_A });
  for (let i = 0; i < 500; i++) {
    sock.emit('message', q, { address: '192.168.1.50', port: 5353 });
    sock.emit('message', buildResponse({ name: 'easymed.local', addresses: ['192.168.1.250'] }), { address: '192.168.1.250', port: 5353 });
  }
  assert.equal(ifCalls() - before, 0);
  r.refresh();
  assert.equal(ifCalls() - before, 1, 'refresh() (такт раз в минуту) перечитывает карты');
});

test('ответ спросившему из своей подсети — только адрес этой подсети', async (t) => {
  const { sock } = await one(t, [IF('Ethernet', '192.168.1.156'), IF('Ethernet 2', '10.0.0.5')]);
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 5 }), { address: '192.168.1.40', port: 5353 });
  const a = sock.sent.flatMap((s) => (s.m ? s.m.answers.map((x) => x.address) : []));
  assert.deepEqual(a, ['192.168.1.156']);
});

test('чужие имена и типы — без ответа (лишняя метка, другой тип, PTR, AAAA, easymed-2)', async (t) => {
  const { sock } = await one(t);
  for (const [name, type] of [['easymed.local.x', 1], ['x.easymed.local', 1], ['easymed', 1], ['easymed.local', 12], ['easymed.local', 28], ['easymed-2.local', 1]]) {
    sock.emit('message', buildQuery(name, { type }), { address: '192.168.1.40', port: 5353 });
  }
  assert.equal(sock.sent.length, 0, JSON.stringify(sock.sent.map((s) => s.m && s.m.answers)));
});

test('OFF-SUBNET: «обычный» вопрос с 8.8.8.8:40000 (не наша подсеть) — без ответа (RFC 6762 §11, §6.7)', async (t) => {
  const { sock } = await one(t, [IF('Ethernet', '192.168.1.156'), IF('Ethernet 2', '10.0.0.5')]);
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 77 }), { address: '8.8.8.8', port: 40000 });
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A }), { address: '172.16.9.9', port: 5353 });
  assert.equal(sock.sent.length, 0, 'answered an off-subnet source: ' + JSON.stringify(sock.sent.map((u) => [u.address, u.m && u.m.answers.map((a) => a.address)])));
});

test('OFF-SUBNET: ответ никогда не несёт адресов чужих подсетей — спросившему из 10.0.0.x только 10.0.0.5', async (t) => {
  const { sock } = await one(t, [IF('Ethernet', '192.168.1.156'), IF('Ethernet 2', '10.0.0.5')]);
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 8 }), { address: '10.0.0.77', port: 40000 });
  assert.deepEqual(sock.sent.map((s) => [s.address, s.m.answers.map((a) => a.address)]), [['10.0.0.77', ['10.0.0.5']]]);
});

test('SPOOF: 12 поддельных притязаний «A 0.0.0.0» — не конфликт: имя остаётся, такт его не теряет', async (t) => {
  const { r, sock } = await one(t);
  for (let n = 0; n < 12; n++) {
    const name = r.status().name;
    sock.emit('message', buildResponse({ name, addresses: ['0.0.0.0'] }), { address: '192.168.1.66', port: 5353 });
    await wait(15);
  }
  for (let i = 0; i < 3; i++) { r.refresh(); await wait(30); }
  assert.notEqual(r.status().state, 'conflict', 'stuck in conflict after 12 spoofed packets: ' + JSON.stringify(r.status()));
  assert.equal(r.status().name, 'easymed.local');
});

test('все имена заняты настоящим соседом — состояние conflict без «null.local»; сосед ушёл — такт (refresh) пробует имя заново и берёт его', async (t) => {
  const sock = new FakeSocket();
  let hostile = true;
  const orig = sock.send.bind(sock);
  sock.send = (buf, port, address, cb) => {
    orig(buf, port, address, cb);
    const m = parseMessage(buf);
    if (hostile && m && !m.qr && m.questions[0]) {
      setImmediate(() => sock.emit('message', buildResponse({ name: m.questions[0].name, addresses: ['192.168.1.20'] }), { address: '192.168.1.20', port: 5353 }));
    }
  };
  const r = createMdnsResponder({ baseName: 'easymed', getInterfaces: () => [IF('Ethernet', '192.168.1.156')], probeIntervalMs: 2,
    createSocket: () => sock, log: () => {}, retryAfterMs: 60000 });
  t.after(() => r.stop());
  await r.start();
  assert.ok(await until(() => r.status().state === 'conflict', 3000));
  assert.deepEqual(r.status(), { base: 'easymed', name: null, state: 'conflict', reason: '', suffixed: true });
  hostile = false;
  r.refresh();
  assert.ok(await until(() => r.status().state === 'active', 1000), JSON.stringify(r.status()));
  assert.equal(r.status().name, 'easymed.local');
});

test('конфликт сам повторяет пробу через retryAfterMs (RFC 6762 §8.1 — отступить и попробовать позже, а не сдаться навсегда)', async (t) => {
  const sock = new FakeSocket();
  let hostile = true;
  const orig = sock.send.bind(sock);
  sock.send = (buf, port, address, cb) => {
    orig(buf, port, address, cb);
    const m = parseMessage(buf);
    if (hostile && m && !m.qr && m.questions[0]) {
      setImmediate(() => sock.emit('message', buildResponse({ name: m.questions[0].name, addresses: ['192.168.1.20'] }), { address: '192.168.1.20', port: 5353 }));
    }
  };
  const r = createMdnsResponder({ baseName: 'easymed', getInterfaces: () => [IF('Ethernet', '192.168.1.156')], probeIntervalMs: 2,
    createSocket: () => sock, log: () => {}, retryAfterMs: 60 });
  t.after(() => r.stop());
  await r.start();
  assert.ok(await until(() => r.status().state === 'conflict', 3000));
  hostile = false;
  assert.ok(await until(() => r.status().state === 'active', 1000), JSON.stringify(r.status()));
  assert.equal(r.status().name, 'easymed.local');
});

test('start() и сразу stop() (включили и тут же выключили) — обещание start() завершается', async () => {
  const r = createMdnsResponder({ baseName: 'easymed', port: 0, bindAddress: '127.0.0.1', joinMulticast: false,
    announceTo: { address: '127.0.0.1', port: 9 }, getInterfaces: () => [], log: () => {} });
  const p = r.start();
  r.stop();
  const res = await Promise.race([p.then(() => 'settled'), new Promise((x) => setTimeout(() => x('hung'), 500))]);
  assert.equal(res, 'settled');
});

test('карта пропала — её членство в группе снимается (и вернувшаяся карта входит заново)', async (t) => {
  let list = [IF('Ethernet', '192.168.1.156'), IF('Wi-Fi', '192.168.0.20')];
  const sock = new FakeSocket();
  const joins = [], drops = [];
  sock.addMembership = (g, a) => joins.push(a);
  sock.dropMembership = (g, a) => drops.push(a);
  const r = createMdnsResponder({ baseName: 'easymed', getInterfaces: () => list, probeIntervalMs: 2, createSocket: () => sock, log: () => {} });
  t.after(() => r.stop());
  await r.start();
  assert.deepEqual(joins.sort(), ['192.168.0.20', '192.168.1.156']);
  list = [IF('Ethernet', '192.168.1.156')];
  r.refresh();
  assert.deepEqual(drops, ['192.168.0.20']);
  list = [IF('Ethernet', '192.168.1.156'), IF('Wi-Fi', '192.168.0.20')];
  r.refresh();
  assert.deepEqual(joins.filter((a) => a === '192.168.0.20').length, 2);
});
