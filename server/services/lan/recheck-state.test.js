// LAN_ADDRESS_V1 — повторная перепроверка (2026-10-17), повторы разборщика перенесены как есть: per-MAC memory, non-admin RPC shape, parser caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordAddresses, readLanState, visibleChange } from './state.js';
import { parseMessage } from './mdns-packet.js';
import { setDataDir } from '../control/config.js';
import { lanAddressStatus, lanAddressDismiss } from '../rpc/lan-address.js';
import { startLanAddress, stopLanAddress } from './index.js';

const v4 = (address, mac, netmask = '255.255.255.0') => ({ address, netmask, family: 'IPv4', mac, internal: false });
function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-lanr-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const day = (n) => new Date(Date.UTC(2026, 9, n, 8));


function lab(n) { return Buffer.concat([Buffer.from([n]), Buffer.alloc(n, 0x61)]); }
const name255 = () => Buffer.concat([lab(63), lab(63), lab(63), lab(62), Buffer.from([0])]);


test('USB: same USB adapter replugged into another port (new name "Ethernet 3", same MAC) with a new IP -> change', (t) => {
  const dir = tmp(t);
  recordAddresses(dir, { interfaces: { 'Ethernet 2': [v4('192.168.1.147', '00:e0:4c:68:01:02')] }, now: day(1) });
  const r = recordAddresses(dir, { interfaces: { 'Ethernet 3': [v4('192.168.1.150', '00:e0:4c:68:01:02')] }, now: day(2) });
  assert.equal(r.changed, true);
});

test('VPN still no false change; old address back clears the warning', (t) => {
  const dir = tmp(t);
  const lan = { 'Ethernet': [v4('192.168.1.156', 'a4:bb:6d:12:34:56')] };
  recordAddresses(dir, { interfaces: lan, now: day(1) });
  assert.equal(recordAddresses(dir, { interfaces: { ...lan, 'clinic-hq': [v4('10.8.0.2', '00:00:00:00:00:00')] }, now: day(2) }).changed, false);
  assert.equal(recordAddresses(dir, { interfaces: lan, now: day(3) }).changed, false);
  recordAddresses(dir, { interfaces: { 'Ethernet': [v4('192.168.1.160', 'a4:bb:6d:12:34:56')] }, now: day(4) });
  assert.ok(visibleChange(readLanState(dir)));
  recordAddresses(dir, { interfaces: lan, now: day(5) });
  assert.equal(visibleChange(readLanState(dir)), null);
});

test('RPC non-admin shape: no MAC, card name, netmask, router hint, remembered list — in any field', async (t) => {
  const dir = tmp(t);
  setDataDir(dir);
  t.after(() => { stopLanAddress(); setDataDir(null); });
  const NET = { 'Realtek-PCIe-SECRETNAME': [v4('192.168.1.156', 'a4:bb:6d:12:34:56')], 'Wi-Fi': [v4('10.20.30.40', 'd8:5e:d3:01:02:03', '255.255.0.0')] };
  await startLanAddress(null, dir, { getInterfaces: () => NET, tickMs: 0, port: 8000, log: () => {}, env: { EASYMED_MDNS: '0' } });
  recordAddresses(dir, { interfaces: { 'Realtek-PCIe-SECRETNAME': [v4('192.168.1.150', 'a4:bb:6d:12:34:56')] }, now: day(1) });
  recordAddresses(dir, { interfaces: NET, now: day(2) });
  for (const user of [{ id: 2, role: 'registrar' }, { id: 3, role: 'doctor', extra_roles: ['nurse'] }, { id: 4, role: 'cashier', is_super_admin: false }]) {
    const s = lanAddressStatus(null, {}, user);
    const j = JSON.stringify(s);
    console.log('# non-admin keys', Object.keys(s).join(','), '| name keys', Object.keys(s.name).join(','));
    assert.ok(!/a4:bb|A4-BB|d8:5e|D8-5E/i.test(j), 'MAC leak ' + j);
    assert.ok(!/SECRETNAME|Wi-Fi/.test(j), 'card name leak ' + j);
    assert.ok(!/255\.255/.test(j), 'netmask leak ' + j);
    assert.ok(!('router_hint' in s) && !('remembered' in s), 'extra fields ' + Object.keys(s));
    assert.throws(() => lanAddressDismiss(null, { at: 'x' }, user), (e) => e.status === 403 && !/a4|SECRET/i.test(e.message));
  }
  const adm = lanAddressStatus(null, {}, { id: 1, role: 'admin' });
  assert.ok(JSON.stringify(adm).includes('A4-BB-6D-12-34-56'));
});

test('PARSER caps: crafted packets cost within ~10x of a normal multi-record mDNS packet', () => {
  // crafted: 16 questions each pointing at a 255-byte name, then 65535 answers declared
  const h = Buffer.alloc(12); h.writeUInt16BE(16, 4); h.writeUInt16BE(65535, 6); h.writeUInt16BE(0x8400, 2);
  const parts = [h, name255(), Buffer.from([0, 1, 0, 1])];
  for (let i = 1; i < 16; i++) parts.push(Buffer.from([0xc0, 12, 0, 1, 0, 1]));
  for (let i = 0; i < 200; i++) parts.push(Buffer.from([0xc0, 12, 0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4, 1, 2, 3, 4]));
  const crafted = Buffer.concat(parts);
  // crafted 2: answers only (qd 0), 64 KB of pointer answers
  const h2 = Buffer.alloc(12); h2.writeUInt16BE(65535, 6); h2.writeUInt16BE(0x8400, 2);
  const p2 = [h2, name255(), Buffer.from([0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4, 1, 2, 3, 4])];
  let sz = 12 + 270; while (sz + 16 < 65000) { p2.push(Buffer.from([0xc0, 12, 0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4, 1, 2, 3, 4])); sz += 16; }
  const crafted2 = Buffer.concat(p2);
  // normal: a Chromecast-like response, 5 records with ~30-byte names
  const nm = (s) => Buffer.concat([...s.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const h3 = Buffer.alloc(12); h3.writeUInt16BE(5, 6); h3.writeUInt16BE(0x8400, 2);
  const rec = (n) => Buffer.concat([nm(n), Buffer.from([0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4, 192, 168, 1, 41])]);
  const normal = Buffer.concat([h3, rec('Chromecast-1234abcd._googlecast._tcp.local'), rec('Chromecast-1234abcd.local'), rec('_googlecast._tcp.local'), rec('_services._dns-sd._udp.local'), rec('1234abcd-5678.local')]);
  const bench = (b, N) => { for (let i = 0; i < 200; i++) parseMessage(b); const t0 = process.hrtime.bigint(); let r; for (let i = 0; i < N; i++) r = parseMessage(b); return { us: Number(process.hrtime.bigint() - t0) / 1e3 / N, r }; };
  const c = bench(crafted, 20000), c2 = bench(crafted2, 5000), n = bench(normal, 20000);
  console.log('# crafted %dB %s us (q=%d a=%d trunc=%s) | crafted2 %dB %s us (a=%d trunc=%s) | normal %dB %s us',
    crafted.length, c.us.toFixed(2), c.r.questions.length, c.r.answers.length, c.r.truncated,
    crafted2.length, c2.us.toFixed(2), c2.r.answers.length, c2.r.truncated, normal.length, n.us.toFixed(2));
  console.log('# CPU share at 100 Mbit/s flood: crafted %s%%, crafted2 %s%%', ((12.5e6 / crafted.length) * c.us / 1e4).toFixed(0), ((12.5e6 / crafted2.length) * c2.us / 1e4).toFixed(1));
  assert.ok(c.us < 10 * n.us && c2.us < 10 * n.us, `crafted ${c.us.toFixed(2)} / ${c2.us.toFixed(2)} us vs normal ${n.us.toFixed(2)} us`);
});
