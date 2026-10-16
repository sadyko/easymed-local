// LAN_ADDRESS_V1 — какие адреса у этого ПК «настоящие» и когда адрес сменился.
// Вход — ровно то, что отдаёт os.networkInterfaces() (подставляется), выход —
// чистые данные: тест не зависит от сетевых карт машины, на которой идёт.
import test from 'node:test';
import assert from 'node:assert/strict';
import { realLanInterfaces, lanAddressList, detectChange, formatMac, routerHint } from './interfaces.js';

const v4 = (address, mac, extra = {}) => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac, internal: false, cidr: address + '/24', ...extra });
const v6 = (address, mac) => ({ address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac, internal: false, scopeid: 0, cidr: address + '/64' });

// Типичный ПК регистратуры: Wi-Fi, VirtualBox, Hyper-V для WSL, петля, адаптер без DHCP.
const CLINIC_PC = {
  'Беспроводная сеть': [v6('fe80::1c2b:3a4d:5e6f:7081', 'a4:bb:6d:12:34:56'), v4('192.168.1.156', 'a4:bb:6d:12:34:56')],
  'VirtualBox Host-Only Network': [v4('192.168.56.1', '0a:00:27:00:00:0c')],
  'vEthernet (WSL (Hyper-V firewall))': [v4('172.27.160.1', '00:15:5d:aa:bb:cc', { netmask: '255.255.240.0' })],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
  'Ethernet': [v4('169.254.10.20', 'd8:5e:d3:01:02:03', { netmask: '255.255.0.0' })],
};

test('настоящая сеть: виртуальные карты, петля, IPv6 и 169.254 (нет DHCP) отброшены', () => {
  assert.deepEqual(realLanInterfaces(CLINIC_PC), [
    { adapter: 'Беспроводная сеть', address: '192.168.1.156', netmask: '255.255.255.0', mac: 'a4:bb:6d:12:34:56' },
  ]);
  assert.deepEqual(lanAddressList(CLINIC_PC), ['192.168.1.156']);
});

test('VPN и туннели по имени, VMware/Docker/TAP по MAC — тоже не «адрес сервера»', () => {
  const ifaces = {
    'Ethernet': [v4('10.4.1.77', 'd8:5e:d3:01:02:03')],
    'Tailscale': [v4('100.101.102.103', '7a:79:00:00:00:01')],
    'WireGuard Tunnel': [v4('10.66.0.2', '00:00:00:00:00:00')],
    'OpenVPN Data Channel Offload': [v4('10.8.0.6', '00:ff:aa:bb:cc:dd')],
    'Ethernet 3': [v4('10.9.0.6', '00:ff:11:22:33:44')],          // TAP-Windows: имя ничего не говорит, MAC 00:ff
    'Ethernet 4': [v4('192.168.233.1', '00:50:56:c0:00:08')],     // VMware Network Adapter VMnet8, переименованный
    'ZeroTier One [8056c2e21c]': [v4('10.147.17.5', '5e:91:aa:bb:cc:dd')],
    'Radmin VPN': [v4('26.1.2.3', '02:50:aa:bb:cc:dd')],
    'Bluetooth Network Connection': [v4('192.168.44.2', 'f4:4e:aa:bb:cc:dd')],
  };
  assert.deepEqual(lanAddressList(ifaces), ['10.4.1.77']);
});

test('две настоящие карты (кабель и Wi-Fi) — обе, по имени карты; порядок перечисления ОС не важен', () => {
  const a = { 'Wi-Fi': [v4('192.168.1.145', 'a4:bb:6d:12:34:56')], 'Ethernet': [v4('192.168.0.20', 'd8:5e:d3:01:02:03')] };
  const b = { 'Ethernet': a.Ethernet, 'Wi-Fi': a['Wi-Fi'] };
  assert.deepEqual(lanAddressList(a), ['192.168.0.20', '192.168.1.145']);
  assert.deepEqual(lanAddressList(b), ['192.168.0.20', '192.168.1.145']);
});

test('всё похоже на виртуальное (сервер на Hyper-V с внешним коммутатором) — берём что есть, но не пусто', () => {
  const ifaces = { 'vEthernet (External Switch)': [v4('192.168.1.150', '00:15:5d:01:02:03')], 'Loopback': [] };
  assert.deepEqual(lanAddressList(ifaces), ['192.168.1.150']);
});

test('мусор на входе не роняет: null, не-объект, карта без списка, запись без адреса', () => {
  assert.deepEqual(realLanInterfaces(null), []);
  assert.deepEqual(realLanInterfaces('x'), []);
  assert.deepEqual(realLanInterfaces({ a: null, b: [null, {}, { family: 'IPv4' }, { family: 4, address: '10.0.0.5', internal: false }] }),
    [{ adapter: 'b', address: '10.0.0.5', netmask: '', mac: '' }]);   // Node 18.0–18.3 отдавал family числом
  assert.deepEqual(realLanInterfaces({ a: [{ family: 'IPv4', address: 'не адрес', internal: false }] }), []);
});

test('смена адреса: .147 → .156 — смена, было/стало', () => {
  assert.deepEqual(detectChange(['192.168.1.147'], ['192.168.1.156']),
    { changed: true, skip: false, from: ['192.168.1.147'], to: ['192.168.1.156'] });
});

test('не смена: тот же адрес; добавился второй (старый работает); первый запуск', () => {
  assert.equal(detectChange(['192.168.1.147'], ['192.168.1.147']).changed, false);
  assert.equal(detectChange(['192.168.1.147'], ['10.0.0.5', '192.168.1.147']).changed, false);
  assert.deepEqual(detectChange([], ['192.168.1.147']), { changed: false, skip: false, from: [], to: ['192.168.1.147'] });
  assert.deepEqual(detectChange(undefined, ['192.168.1.147']), { changed: false, skip: false, from: [], to: ['192.168.1.147'] });
});

test('пропала одна из двух карт — смена (тот, кто ходил на неё, сервер потерял)', () => {
  assert.deepEqual(detectChange(['192.168.0.20', '192.168.1.145'], ['192.168.1.145']),
    { changed: true, skip: false, from: ['192.168.0.20', '192.168.1.145'], to: ['192.168.1.145'] });
});

test('сейчас адреса нет (кабель выдернут при запуске) — не смена и не запоминать', () => {
  assert.deepEqual(detectChange(['192.168.1.147'], []), { changed: false, skip: true, from: ['192.168.1.147'], to: [] });
});

test('MAC — как «Физический адрес» в ipconfig /all', () => {
  assert.equal(formatMac('a4:bb:6d:12:34:56'), 'A4-BB-6D-12-34-56');
  assert.equal(formatMac(''), '');
  assert.equal(formatMac('00:00:00:00:00:00'), '');
  assert.equal(formatMac(undefined), '');
});

test('страница роутера: x.y.z.1 своей подсети /24, иначе 192.168.1.1', () => {
  assert.equal(routerHint('192.168.0.37', '255.255.255.0'), 'http://192.168.0.1');
  assert.equal(routerHint('10.4.1.77', '255.255.255.0'), 'http://10.4.1.1');
  assert.equal(routerHint('10.4.1.77', '255.255.0.0'), 'http://192.168.1.1');
  assert.equal(routerHint('', ''), 'http://192.168.1.1');
});
