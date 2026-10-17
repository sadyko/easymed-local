// LAN_ADDRESS_V1 — перепроверка (2026-10-17): память адреса, ложные «адрес изменился», журнал,
// состояние имени для экрана. Повторы разборщика перенесены как есть: каждый утверждает
// БЕЗОПАСНОЕ поведение.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createMdnsResponder } from './mdns.js';
import { buildResponse, parseMessage } from './mdns-packet.js';
import { startLanAddress, stopLanAddress, lanStatus } from './index.js';

const v4 = (address, mac = 'a4:bb:6d:12:34:56', netmask = '255.255.255.0') => ({ address, netmask, family: 'IPv4', mac, internal: false });
function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'em-lan-review-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

test('экран в состоянии conflict не показывает «http://null.local» — даже если ответчик вернул такое имя', async (t) => {
  const dir = tmp(t);
  const fake = () => ({ start: async () => {}, stop() {}, setBaseName() {}, refresh() {},
    status: () => ({ base: 'easymed', name: 'null.local', state: 'conflict', reason: '', suffixed: true }) });
  await startLanAddress(null, dir, { getInterfaces: () => ({ 'Ethernet': [v4('192.168.1.156')] }), tickMs: 0, port: 8000, log: () => {},
    env: {}, allowUnderTest: true, createResponder: fake });
  t.after(() => stopLanAddress());
  const s = lanStatus(null, dir);
  assert.equal(s.name.url, null);
  assert.equal(s.name.current, null);
  assert.equal(s.name.state, 'conflict');
});

class FS2 extends EventEmitter {
  constructor() { super(); this.hostile = true; }
  bind(o, cb) { setImmediate(cb); } address() { return { port: 5353 }; }
  send(b, p, a, cb) {
    const m = parseMessage(b);
    if (this.hostile && m && !m.qr && m.questions[0]) setImmediate(() => this.emit('message', buildResponse({ name: m.questions[0].name, addresses: ['192.168.1.20'] }), { address: '192.168.1.20', port: 5353 }));
    if (cb) cb(null);
  }
  addMembership() {} dropMembership() {} setMulticastTTL() {} setMulticastLoopback() {} setMulticastInterface() {} close() {}
}
test('настоящий ответчик, все имена заняты соседом — lan_address_status: имя null, ссылки нет (не «http://null.local:8000»)', async (t) => {
  const dir = tmp(t);
  const sock = new FS2();
  let R;
  await startLanAddress(null, dir, { getInterfaces: () => ({ 'Ethernet': [v4('192.168.1.156')] }), tickMs: 0, port: 8000, log: () => {},
    env: {}, allowUnderTest: true, createResponder: (o) => (R = createMdnsResponder({ ...o, probeIntervalMs: 2, createSocket: () => sock })) });
  t.after(() => stopLanAddress());
  for (let i = 0; i < 400 && R.status().state !== 'conflict'; i++) await new Promise((x) => setTimeout(x, 5));
  const s = lanStatus(null, dir);
  assert.equal(s.name.state, 'conflict');
  assert.equal(s.name.url, null, JSON.stringify(s.name));
});
