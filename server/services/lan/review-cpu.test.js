// LAN_ADDRESS_V1 — перепроверка: цена пакетов, называющих нас, с НАСТОЯЩИМ опросом карт (os.networkInterfaces ~1 мс на Windows).
// with the PRODUCTION getInterfaces (os.networkInterfaces on Windows ~1 ms per call).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createMdnsResponder } from './mdns.js';
import { buildQuery, buildResponse, TYPE_A } from './mdns-packet.js';
import { realLanInterfaces } from './interfaces.js';

class FakeSocket extends EventEmitter {
  constructor() { super(); this.n = 0; }
  bind(o, cb) { setImmediate(cb); }
  address() { return { address: '0.0.0.0', port: 5353 }; }
  send(buf, port, address, cb) { this.n++; if (cb) cb(null); }
  addMembership() {} dropMembership() {} setMulticastTTL() {} setMulticastLoopback() {} setMulticastInterface() {}
  close() {}
}

test('1000 tiny queries for our name (≈31 KB, a quarter-second of 1 Mbit/s) must cost < 100 ms of main thread', async (t) => {
  const sock = new FakeSocket();
  const real = realLanInterfaces(os.networkInterfaces());
  assert.ok(real.length, 'needs a real adapter on this box');
  const r = createMdnsResponder({ baseName: 'easymed', probeIntervalMs: 1, createSocket: () => sock, log: () => {} }); // production getInterfaces
  t.after(() => r.stop());
  await r.start();
  for (let i = 0; i < 100 && r.status().state !== 'active'; i++) await new Promise((x) => setTimeout(x, 5));
  const from = real[0].address.replace(/\.\d+$/, '.250');
  const q = buildQuery('easymed.local', { type: TYPE_A });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) sock.emit('message', q, { address: from, port: 5353 });
  const msQ = Number(process.hrtime.bigint() - t0) / 1e6;
  // forged claims, higher address -> keep + announce every time
  const claim = buildResponse({ name: 'easymed.local', addresses: [real[0].address.replace(/\.\d+$/, '.254')] });
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) sock.emit('message', claim, { address: from, port: 5353 });
  const msC = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log('# 1000 queries: %s ms main thread; 1000 forged claims: %s ms; packets sent %d', msQ.toFixed(0), msC.toFixed(0), sock.n);
  assert.ok(msQ < 100 && msC < 100, `queries ${msQ.toFixed(0)} ms, claims ${msC.toFixed(0)} ms per 1000 packets`);
});
