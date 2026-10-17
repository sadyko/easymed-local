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

// ---- ложные «адрес сервера изменился» ----------------------------------------
import { recordAddresses, readLanState, visibleChange } from './state.js';
import { realLanInterfaces } from './interfaces.js';
const at = (s) => new Date('2026-10-17T0' + s + ':00:00Z');

test('VPN: туннель WireGuard/Wintun (своё имя, MAC из нулей) — не карта сети клиники; отключился — не «адрес изменился»', (t) => {
  const dir = tmp(t);
  const up = { 'Ethernet': [v4('192.168.1.156')], 'clinic-hq': [v4('10.8.0.2', '00:00:00:00:00:00', '255.255.255.0')] };
  const down = { 'Ethernet': [v4('192.168.1.156')] };
  assert.deepEqual(realLanInterfaces(up).map((i) => i.address), ['192.168.1.156']);
  recordAddresses(dir, { interfaces: down, now: at(1) });
  recordAddresses(dir, { interfaces: up, now: at(2) });
  const r = recordAddresses(dir, { interfaces: down, now: at(3) });
  assert.equal(r.changed, false, 'false "address changed": ' + JSON.stringify(readLanState(dir).change));
});

test('VPN: встроенный PPP/IKEv2 «Офис» (MAC из нулей) — то же, отключение не смена', (t) => {
  const dir = tmp(t);
  recordAddresses(dir, { interfaces: { 'Ethernet': [v4('192.168.1.156')], 'Офис': [v4('172.16.5.9', '00:00:00:00:00:00', '255.255.255.255')] }, now: at(1) });
  const r = recordAddresses(dir, { interfaces: { 'Ethernet': [v4('192.168.1.156')] }, now: at(2) });
  assert.equal(r.changed, false, JSON.stringify(readLanState(dir).change));
});

test('Мобильный хот-спот Windows (192.168.137.1) выключили — не «адрес изменился»', (t) => {
  const dir = tmp(t);
  recordAddresses(dir, { interfaces: { 'Ethernet': [v4('192.168.1.156')], 'Подключение по локальной сети* 10': [v4('192.168.137.1', '1a:2b:3c:4d:5e:6f')] }, now: at(1) });
  const r = recordAddresses(dir, { interfaces: { 'Ethernet': [v4('192.168.1.156')] }, now: at(2) });
  assert.equal(r.changed, false, JSON.stringify(readLanState(dir).change));
});

test('Hyper-V с внешним коммутатором: сеть клиники на vEthernet (External), Default Switch и WSL берут новые подсети при каждом запуске — не смена', (t) => {
  const dir = tmp(t);
  const boot = (ds, wsl) => ({ 'vEthernet (External)': [v4('192.168.1.50', '00:15:5d:01:02:03')],
    'vEthernet (Default Switch)': [v4(ds, '00:15:5d:aa:bb:cc', '255.255.240.0')], 'vEthernet (WSL)': [v4(wsl, '00:15:5d:dd:ee:ff', '255.255.240.0')] });
  recordAddresses(dir, { interfaces: boot('172.20.48.1', '172.27.0.1'), now: at(1) });
  const r = recordAddresses(dir, { interfaces: boot('172.25.112.1', '172.30.16.1'), now: at(2) });
  assert.equal(r.changed, false, 'LAN address 192.168.1.50 did not change: ' + JSON.stringify(readLanState(dir).change));
  assert.deepEqual(readLanState(dir).addresses, ['192.168.1.50']);
});

test('APIPA при загрузке (до DHCP) и выдернутый кабель — не смена, память не стирается', (t) => {
  const dir = tmp(t);
  recordAddresses(dir, { interfaces: { 'Ethernet': [v4('192.168.1.156')] }, now: at(1) });
  assert.equal(recordAddresses(dir, { interfaces: { 'Ethernet': [v4('169.254.10.20')] }, now: at(2) }).changed, false);
  assert.equal(recordAddresses(dir, { interfaces: {}, now: at(3) }).changed, false);
  assert.equal(recordAddresses(dir, { interfaces: { 'Ethernet': [v4('192.168.1.156')] }, now: at(4) }).changed, false);
  assert.deepEqual(readLanState(dir).addresses, ['192.168.1.156']);
});

test('две карты, Wi-Fi поднялся через минуту после кабеля — не смена (карта появилась/исчезла, адрес у неё прежний)', (t) => {
  const dir = tmp(t);
  const both = { 'Ethernet': [v4('192.168.1.156')], 'Wi-Fi': [v4('192.168.1.160', 'd8:5e:d3:01:02:03')] };
  recordAddresses(dir, { interfaces: both, now: at(1) });
  recordAddresses(dir, { interfaces: { 'Ethernet': [v4('192.168.1.156')] }, now: at(2) });
  recordAddresses(dir, { interfaces: both, now: at(3) });
  assert.equal(visibleChange(readLanState(dir)), null, JSON.stringify(readLanState(dir).change));
});

test('Wi-Fi вернулся с ДРУГИМ адресом — это смена (той же карты); прежние адреса вернулись — предупреждение снимается само', (t) => {
  const dir = tmp(t);
  const wifi = (a) => ({ 'Ethernet': [v4('192.168.1.156')], 'Wi-Fi': [v4(a, 'd8:5e:d3:01:02:03')] });
  recordAddresses(dir, { interfaces: wifi('192.168.1.160'), now: at(1) });
  recordAddresses(dir, { interfaces: { 'Ethernet': [v4('192.168.1.156')] }, now: at(2) });
  const r = recordAddresses(dir, { interfaces: wifi('192.168.1.171'), now: at(3) });
  assert.equal(r.changed, true);
  assert.deepEqual([visibleChange(readLanState(dir)).from, visibleChange(readLanState(dir)).to], [['192.168.1.160'], ['192.168.1.171']]);
  recordAddresses(dir, { interfaces: wifi('192.168.1.160'), now: at(4) });
  assert.equal(visibleChange(readLanState(dir)), null, 'старый адрес вернулся — компьютеры снова находят сервер');
});
