// LAN_ADDRESS_V1 — ответчик имени <имя>.local.
//
// Порт 5353 ЭТОЙ машины тест не занимает никогда: настоящие сокеты — только на
// 127.0.0.1 со случайным портом и без multicast; «сеть» и ошибки сокета —
// подставленным сокетом.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { createMdnsResponder, mdnsAllowed, nextName, normalizeBase } from './mdns.js';
import { parseMessage, buildQuery, buildResponse, TYPE_A } from './mdns-packet.js';

const HERE = [{ adapter: 'Ethernet', address: '192.168.1.156', netmask: '255.255.255.0', mac: 'a4:bb:6d:12:34:56' }];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('не дождались'); await wait(5); }
}

// ---- выключатель ------------------------------------------------------------
test('выключатель: EASYMED_MDNS=0/off/false — выключено; под node --test — выключено, пока тест не включит', () => {
  assert.deepEqual(mdnsAllowed({}), { ok: true, reason: '' });
  for (const v of ['0', 'off', 'false', 'OFF', 'no']) assert.deepEqual(mdnsAllowed({ EASYMED_MDNS: v }), { ok: false, reason: 'env_off' });
  assert.deepEqual(mdnsAllowed({ NODE_TEST_CONTEXT: 'child-v8' }), { ok: false, reason: 'test' });
  assert.deepEqual(mdnsAllowed({ NODE_TEST_CONTEXT: 'child-v8', EASYMED_MDNS: '1' }), { ok: true, reason: '' });
  assert.deepEqual(mdnsAllowed({ NODE_TEST_CONTEXT: 'child-v8' }, { allowUnderTest: true }), { ok: true, reason: '' });
  assert.deepEqual(mdnsAllowed({ NODE_TEST_CONTEXT: 'child-v8', EASYMED_MDNS: '0' }, { allowUnderTest: true }), { ok: false, reason: 'env_off' });
  // Этот файл сам идёт под node --test — значит, настоящий запуск сервера из теста не займёт 5353.
  assert.equal(mdnsAllowed(process.env).ok, process.env.EASYMED_MDNS === '1');
});

test('имя: основа из «имени в адресе», иначе easymed; при конфликте — easymed-2 … easymed-9', () => {
  assert.equal(normalizeBase('MedLife'), 'medlife');
  assert.equal(normalizeBase(''), 'easymed');
  assert.equal(normalizeBase('клиника'), 'easymed');
  assert.equal(normalizeBase('-x-'), 'easymed');
  assert.equal(nextName('medlife', 0), 'medlife');
  assert.equal(nextName('medlife', 1), 'medlife-2');
  assert.equal(nextName('medlife', 8), 'medlife-9');
  assert.equal(nextName('medlife', 9), null);
});

// ---- настоящий UDP на 127.0.0.1 ---------------------------------------------
function udp(t) {
  const s = dgram.createSocket('udp4');
  t.after(() => { try { s.close(); } catch { /* уже закрыт */ } });
  return new Promise((r) => s.bind(0, '127.0.0.1', () => r(s)));
}
function ask(sock, port, name, { timeout = 400, id = 0x4242 } = {}) {
  return new Promise((resolve) => {
    const done = (v) => { sock.off('message', on); clearTimeout(tm); resolve(v); };
    const on = (msg) => { const m = parseMessage(msg); if (m && m.qr) done(m); };
    const tm = setTimeout(() => done(null), timeout);
    sock.on('message', on);
    sock.send(buildQuery(name, { type: TYPE_A, id }), port, '127.0.0.1');
  });
}
async function realResponder(t, sink, extra = {}) {
  const r = createMdnsResponder({
    baseName: 'easymed', port: 0, bindAddress: '127.0.0.1', joinMulticast: false,
    announceTo: { address: '127.0.0.1', port: sink.address().port },
    getInterfaces: () => HERE, probeIntervalMs: 15, log: () => {}, ...extra,
  });
  t.after(() => r.stop());
  await r.start();
  return r;
}

test('интеграция: запрос на тестовый порт — ответ с адресом этого ПК (тот же ID, legacy unicast)', async (t) => {
  const sink = await udp(t), client = await udp(t);
  const r = await realResponder(t, sink);
  await until(() => r.status().state === 'active');
  const m = await ask(client, r.port(), 'easymed.local');
  assert.ok(m, 'ответ пришёл');
  assert.equal(m.id, 0x4242);
  assert.deepEqual(m.answers.map((a) => [a.name, a.address, a.ttl]), [['easymed.local', '192.168.1.156', 10]]);
  assert.deepEqual(r.status(), { base: 'easymed', name: 'easymed.local', state: 'active', reason: '', suffixed: false });
  // Регистр имени не важен (Windows спрашивает как набрали), чужое имя — молчание.
  assert.ok(await ask(client, r.port(), 'EasyMed.LOCAL'));
  assert.equal(await ask(client, r.port(), 'other.local', { timeout: 120 }), null);
});

test('интеграция: на пробу ответил другой сервер Easy-Med — этот берёт easymed-2, на easymed молчит', async (t) => {
  const sink = await udp(t), client = await udp(t);
  // «Главное здание» уже называется easymed: отвечает на пробу своим адресом.
  sink.on('message', (msg, rinfo) => {
    const m = parseMessage(msg);
    if (m && !m.qr && m.questions.some((q) => q.name === 'easymed.local')) {
      sink.send(buildResponse({ name: 'easymed.local', addresses: ['192.168.1.20'] }), rinfo.port, rinfo.address);
    }
  });
  const r = await realResponder(t, sink);
  await until(() => r.status().state === 'active');
  assert.deepEqual(r.status(), { base: 'easymed', name: 'easymed-2.local', state: 'active', reason: '', suffixed: true });
  assert.equal(await ask(client, r.port(), 'easymed.local', { timeout: 120 }), null);
  const m = await ask(client, r.port(), 'easymed-2.local');
  assert.deepEqual(m.answers.map((a) => a.address), ['192.168.1.156']);
});

// ---- подставленный сокет -----------------------------------------------------
class FakeSocket extends EventEmitter {
  constructor(opts = {}) { super(); this.sent = []; this.opts = opts; this.closed = false; this.joined = []; }
  bind(o, cb) {
    if (this.opts.bindError) { setImmediate(() => { this.emit('error', Object.assign(new Error('bind'), { code: this.opts.bindError })); this.emit('error', Object.assign(new Error('bind'), { code: this.opts.bindError })); }); return; }
    setImmediate(cb);
  }
  address() { return { address: '0.0.0.0', port: 5353 }; }
  send(buf, port, address, cb) { this.sent.push({ m: parseMessage(buf), port, address }); if (cb) cb(null); }
  addMembership(g, a) { if (this.opts.noMulticast) throw Object.assign(new Error('join'), { code: 'EADDRNOTAVAIL' }); this.joined.push(a); }
  setMulticastTTL() {} setMulticastLoopback() {} setMulticastInterface() {}
  close() { this.closed = true; }
}
async function fakeResponder(t, opts = {}, extra = {}) {
  const sock = new FakeSocket(opts);
  const logs = [];
  const r = createMdnsResponder({ baseName: 'easymed', getInterfaces: () => HERE, probeIntervalMs: 5,
    createSocket: () => sock, log: (m) => logs.push(m), ...extra });
  t.after(() => r.stop());
  await r.start();
  return { r, sock, logs };
}
const fromLan = (address, port = 5353) => ({ address, port, family: 'IPv4', size: 0 });

test('порт 5353 занят / нет прав — состояние failed, одна строка в журнал, без исключения', async (t) => {
  const { r, logs } = await fakeResponder(t, { bindError: 'EADDRINUSE' });
  await until(() => r.status().state === 'failed');
  assert.equal(r.status().reason, 'port_busy');
  assert.equal(logs.length, 1, 'дважды пришедшая ошибка пишется один раз');
  const b = await fakeResponder(t, { bindError: 'EACCES' });
  await until(() => b.r.status().state === 'failed');
  assert.equal(b.r.status().reason, 'access');
});

test('multicast запрещён — работает дальше (обычный DNS-клиент получит ответ), одна строка в журнал', async (t) => {
  const { r, sock, logs } = await fakeResponder(t, { noMulticast: true });
  await until(() => r.status().state === 'active');
  assert.equal(logs.length, 1);
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 7 }), fromLan('192.168.1.30', 50000));
  const last = sock.sent.at(-1);
  assert.equal(last.address, '192.168.1.30');
  assert.equal(last.port, 50000);
  assert.deepEqual(last.m.answers.map((a) => a.address), ['192.168.1.156']);
});

test('вопрос с порта 5353 (Windows, Bonjour) — ответ multicast на 224.0.0.251:5353, cache-flush', async (t) => {
  const { r, sock } = await fakeResponder(t);
  await until(() => r.status().state === 'active');
  sock.sent.length = 0;
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A }), fromLan('192.168.1.30'));
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].address, '224.0.0.251');
  assert.equal(sock.sent[0].port, 5353);
  assert.deepEqual(sock.sent[0].m.answers.map((a) => [a.address, a.flush, a.ttl]), [['192.168.1.156', true, 120]]);
});

test('две сетевые карты: спросившему — адрес из его подсети; из чужой подсети — молчание (перепроверка: не раздавать адреса чужим сетям)', async (t) => {
  const two = [{ adapter: 'Ethernet', address: '192.168.0.20', netmask: '255.255.255.0', mac: '' }, ...HERE];
  const { r, sock } = await fakeResponder(t, {}, { getInterfaces: () => two });
  await until(() => r.status().state === 'active');
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 1 }), fromLan('192.168.0.33', 50000));
  assert.deepEqual(sock.sent.at(-1).m.answers.map((a) => a.address), ['192.168.0.20']);
  const n = sock.sent.length;
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 2 }), fromLan('10.0.0.9', 50000));
  assert.equal(sock.sent.length, n, 'вопрос не из наших подсетей — без ответа');
});

test('во время работы чужой сервер назвался тем же именем: меньший адрес остаётся (и объявляет себя — не чаще раза в секунду), больший — easymed-2', async (t) => {
  let clock = 1000000;
  const { r, sock } = await fakeResponder(t, {}, { now: () => clock });
  await until(() => r.status().state === 'active');
  clock += 5000;   // с первого объявления прошло больше секунды
  sock.sent.length = 0;
  sock.emit('message', buildResponse({ name: 'easymed.local', addresses: ['192.168.1.200'] }), fromLan('192.168.1.200'));
  await until(() => sock.sent.some((s) => s.m.qr));
  assert.equal(r.status().name, 'easymed.local', '.156 меньше .200 — имя остаётся');
  assert.ok(sock.sent.some((s) => s.m.qr && s.m.answers.some((a) => a.name === 'easymed.local' && a.address === '192.168.1.156')), 'объявил себя');
  // Ещё притязание в ту же секунду — объявления нет (ограничитель), имя то же.
  sock.sent.length = 0;
  sock.emit('message', buildResponse({ name: 'easymed.local', addresses: ['192.168.1.200'] }), fromLan('192.168.1.200'));
  await wait(30);
  assert.equal(sock.sent.filter((s) => s.m.qr).length, 0);
  sock.emit('message', buildResponse({ name: 'easymed.local', addresses: ['192.168.1.100'] }), fromLan('192.168.1.100'));
  await until(() => r.status().state === 'active' && r.status().name === 'easymed-2.local');
  assert.equal(r.status().suffixed, true);
});

test('свои же пакеты (multicast-петля) и ответ с нашим же адресом — не конфликт', async (t) => {
  const { r, sock } = await fakeResponder(t);
  await until(() => r.status().state === 'active');
  sock.emit('message', buildResponse({ name: 'easymed.local', addresses: ['192.168.1.1'] }), fromLan('192.168.1.156'));
  sock.emit('message', buildResponse({ name: 'easymed.local', addresses: ['192.168.1.156'] }), fromLan('192.168.1.10'));
  assert.equal(r.status().name, 'easymed.local');
});

test('вопрос с адреса самого сервера (браузер на этом же ПК спросил через службу Windows) — ответ есть', async (t) => {
  const { r, sock } = await fakeResponder(t);
  await until(() => r.status().state === 'active');
  sock.sent.length = 0;
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A }), fromLan('192.168.1.156'));
  assert.equal(sock.sent.length, 1);
  assert.deepEqual(sock.sent[0].m.answers.map((a) => a.address), ['192.168.1.156']);
});

test('чужие пакеты (принтеры, телефоны, Chromecast) не стоят опроса сетевых карт — только пакеты о нашем имени', async (t) => {
  let reads = 0;
  const { r, sock } = await fakeResponder(t, {}, { getInterfaces: () => { reads++; return HERE; } });
  await until(() => r.status().state === 'active');
  const before = reads;
  for (let i = 0; i < 50; i++) {
    sock.emit('message', buildQuery('printer.local', { type: TYPE_A }), fromLan('192.168.1.30'));
    sock.emit('message', buildResponse({ name: 'chromecast.local', addresses: ['192.168.1.40'] }), fromLan('192.168.1.40'));
  }
  assert.equal(reads, before);
});

test('все имена easymed … easymed-9 заняты — состояние conflict, на запросы молчит', async (t) => {
  const { r, sock } = await fakeResponder(t);
  const origSend = sock.send.bind(sock);
  sock.send = (buf, port, address, cb) => {
    origSend(buf, port, address, cb);
    const m = parseMessage(buf);
    if (m && !m.qr && m.questions[0]) {
      const name = m.questions[0].name;
      setImmediate(() => sock.emit('message', buildResponse({ name, addresses: ['192.168.1.20'] }), fromLan('192.168.1.20')));
    }
  };
  await until(() => r.status().state === 'conflict', 4000);
  sock.sent.length = 0;
  sock.emit('message', buildQuery('easymed-9.local', { type: TYPE_A, id: 3 }), fromLan('192.168.1.30', 50000));
  assert.equal(sock.sent.length, 0);
});

test('имя в «API» сменили — ответчик пробует новое имя и отвечает на него', async (t) => {
  const { r, sock } = await fakeResponder(t);
  await until(() => r.status().state === 'active');
  r.setBaseName('MedLife');
  await until(() => r.status().state === 'active' && r.status().name === 'medlife.local');
  sock.emit('message', buildQuery('medlife.local', { type: TYPE_A, id: 4 }), fromLan('192.168.1.30', 50000));
  assert.deepEqual(sock.sent.at(-1).m.answers.map((a) => a.name), ['medlife.local']);
});

test('stop() закрывает сокет и больше не отвечает', async (t) => {
  const { r, sock } = await fakeResponder(t);
  await until(() => r.status().state === 'active');
  r.stop();
  assert.equal(sock.closed, true);
  assert.equal(r.status().state, 'stopped');
});

test('карты перечитываются пакетом с нашим именем не чаще раза в секунду, а чужие пакеты их не трогают', async (t) => {
  let clock = 5000000, reads = 0;
  const { r, sock } = await fakeResponder(t, {}, { now: () => clock, getInterfaces: () => { reads++; return HERE; } });
  await until(() => r.status().state === 'active');
  clock += 2000;   // список постарел
  const before = reads;
  for (let i = 0; i < 100; i++) {
    sock.emit('message', buildQuery('easymed.local', { type: TYPE_A }), fromLan('192.168.1.30'));
    sock.emit('message', buildQuery('printer.local', { type: TYPE_A }), fromLan('192.168.1.30'));
  }
  assert.equal(reads - before, 1);
});

test('«обычные» ответы: не больше 20 в секунду одному спросившему, остальным — как обычно', async (t) => {
  let clock = 9000000;
  const { r, sock } = await fakeResponder(t, {}, { now: () => clock });
  await until(() => r.status().state === 'active');
  sock.sent.length = 0;
  for (let i = 0; i < 30; i++) sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: i }), fromLan('192.168.1.66', 40000 + i));
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 99 }), fromLan('192.168.1.40', 51000));
  assert.equal(sock.sent.filter((s) => s.address === '192.168.1.66').length, 20);
  assert.equal(sock.sent.filter((s) => s.address === '192.168.1.40').length, 1);
  clock += 1000;
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 100 }), fromLan('192.168.1.66', 40100));
  assert.equal(sock.sent.filter((s) => s.address === '192.168.1.66').length, 21, 'через секунду — снова');
});

test('сосед — не адрес сети (.0) и не широковещательный (.255) своей подсети: ни ответа, ни притязания (и для /22)', async (t) => {
  const wide = [{ adapter: 'Ethernet', address: '10.4.1.77', netmask: '255.255.252.0', mac: 'a4:bb:6d:12:34:56' }];
  const { r, sock } = await fakeResponder(t, {}, { getInterfaces: () => wide });
  await until(() => r.status().state === 'active');
  sock.sent.length = 0;
  for (const src of ['10.4.0.0', '10.4.3.255']) {
    sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 3 }), fromLan(src, 40001));
    sock.emit('message', buildResponse({ name: 'easymed.local', addresses: ['10.4.1.5'] }), fromLan(src));
  }
  await wait(20);
  assert.equal(sock.sent.length, 0);
  assert.equal(r.status().name, 'easymed.local');
  sock.emit('message', buildQuery('easymed.local', { type: TYPE_A, id: 4 }), fromLan('10.4.2.255', 40002));   // обычный адрес внутри /22
  assert.equal(sock.sent.length, 1);
});
