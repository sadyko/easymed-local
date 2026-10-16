// LAN_ADDRESS_V1 — RPC «Адрес в сети» и запуск из server/index.js.
// Ответчик имени подставлен (фабрика) — сокетов здесь нет вовсе; сеть ПК —
// подставленный os.networkInterfaces().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setDataDir } from '../control/config.js';
import { isReadOnlyRpc, isAlwaysAllowedRpc } from '../control/gate.js';
import { RPC } from './index.js';
import { lanAddressStatus, lanAddressDismiss, lanAddressMdns } from './lan-address.js';
import { startLanAddress, stopLanAddress, tickLanAddress } from '../lan/index.js';
import { recordAddresses } from '../lan/state.js';

const v4 = (address, mac = 'a4:bb:6d:12:34:56') => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac, internal: false });
let NET = { 'Ethernet': [v4('192.168.1.156')] };
const ADMIN = { id: 1, role: 'admin' };
const DOCTOR_ADMIN = { id: 3, role: 'doctor', extra_roles: ['admin'] };
const REGISTRAR = { id: 2, role: 'registrar' };

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-lan-rpc-'));
  setDataDir(dir);
  const db = openDb(':memory:'); migrate(db);
  NET = { 'Ethernet': [v4('192.168.1.156')] };
  t.after(() => { stopLanAddress(); db.close(); setDataDir(null); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, dir };
}
function fakeFactory() {
  const made = [];
  const factory = (opts) => {
    const r = { opts, base: opts.baseName, started: 0, stopped: 0, refreshed: 0,
      start: async () => { r.started++; }, stop: () => { r.stopped++; },
      setBaseName: (b) => { r.base = b; }, refresh: () => { r.refreshed++; },
      status: () => ({ base: r.base, name: r.base + '.local', state: 'active', reason: '', suffixed: false }) };
    made.push(r);
    return r;
  };
  return { factory, made };
}
const start = (db, dir, extra = {}) => startLanAddress(db, dir, { getInterfaces: () => NET, tickMs: 0, port: 8000, log: () => {}, ...extra });

test('зарегистрированы: статус — чтение (и при просроченной лицензии), скрыть/выключатель — всегда (файл ПК, не данные клиники)', () => {
  for (const n of ['lan_address_status', 'lan_address_dismiss', 'lan_address_mdns']) assert.equal(typeof RPC[n], 'function', n);
  assert.equal(isReadOnlyRpc('lan_address_status'), true);
  assert.equal(isAlwaysAllowedRpc('lan_address_dismiss'), true);
  assert.equal(isAlwaysAllowedRpc('lan_address_mdns'), true);
});

test('статус: адреса с картой и MAC как в ipconfig, порт, ссылка по имени, подсказка роутера; смены нет', async (t) => {
  const { db, dir } = world(t);
  await start(db, dir);
  const s = lanAddressStatus(db, {}, REGISTRAR);
  assert.deepEqual(s.addresses, [{ adapter: 'Ethernet', address: '192.168.1.156', netmask: '255.255.255.0', mac: 'A4-BB-6D-12-34-56' }]);
  assert.equal(s.port, 8000);
  assert.equal(s.change, null);
  assert.equal(s.router_hint, 'http://192.168.1.1');
  // Под node --test ответчик не поднимается: имя показано, состояние — «выключено (тест)».
  assert.deepEqual(s.name, { base: 'easymed', current: 'easymed.local', url: 'http://easymed.local:8000', state: 'off', reason: 'test', suffixed: false });
  assert.equal(s.mdns_enabled, true);
  assert.equal(s.can_manage, false);
  assert.equal(lanAddressStatus(db, {}, ADMIN).can_manage, true);
  assert.equal(lanAddressStatus(db, {}, DOCTOR_ADMIN).can_manage, true, 'админ с основной ролью врача — тоже админ');
});

test('без входа статус не отдаётся', (t) => {
  const { db } = world(t);
  assert.throws(() => lanAddressStatus(db, {}, null), (e) => e.status === 401);
});

test('адрес сменился после перезапуска: статус несёт «было → стало»; админ скрывает до следующей смены', async (t) => {
  const { db, dir } = world(t);
  recordAddresses(dir, { interfaces: { 'Ethernet': [v4('192.168.1.147')] }, now: new Date('2026-10-15T08:00:00Z') });
  await start(db, dir);   // этот запуск видит .156
  const s = lanAddressStatus(db, {}, ADMIN);
  assert.deepEqual([s.change.from, s.change.to], [['192.168.1.147'], ['192.168.1.156']]);
  assert.throws(() => lanAddressDismiss(db, { at: s.change.at }, REGISTRAR), (e) => e.status === 403);
  assert.throws(() => lanAddressDismiss(db, {}, ADMIN), (e) => e.status === 400);
  const after = lanAddressDismiss(db, { at: s.change.at }, ADMIN);
  assert.equal(after.change, null);
  assert.equal(lanAddressStatus(db, {}, REGISTRAR).change, null);
  // Адрес снова сменился, пока сервер работал (такт раз в минуту) — предупреждение вернулось.
  NET = { 'Ethernet': [v4('192.168.1.145')] };
  tickLanAddress();
  assert.deepEqual(lanAddressStatus(db, {}, ADMIN).change.to, ['192.168.1.145']);
});

test('имя — из «имени в адресе» (API), иначе easymed; смену имени подхватывает такт', async (t) => {
  const { db, dir } = world(t);
  db.prepare("UPDATE api_settings SET slug = 'medlife' WHERE id = 1").run();
  const { factory, made } = fakeFactory();
  await start(db, dir, { allowUnderTest: true, createResponder: factory });
  assert.equal(made.length, 1);
  assert.equal(made[0].opts.baseName, 'medlife');
  assert.equal(made[0].started, 1);
  const s = lanAddressStatus(db, {}, ADMIN);
  assert.equal(s.name.url, 'http://medlife.local:8000');
  assert.equal(s.name.state, 'active');
  db.prepare("UPDATE api_settings SET slug = 'medlife-plus' WHERE id = 1").run();
  tickLanAddress();
  assert.equal(made[0].base, 'medlife-plus');
  assert.equal(made[0].refreshed, 1);
});

test('выключатель: админ выключает — ответчик остановлен, настройка помнится; включает — запущен заново', async (t) => {
  const { db, dir } = world(t);
  const { factory, made } = fakeFactory();
  await start(db, dir, { allowUnderTest: true, createResponder: factory });
  assert.throws(() => lanAddressMdns(db, { enabled: false }, REGISTRAR), (e) => e.status === 403);
  assert.throws(() => lanAddressMdns(db, { enabled: 'нет' }, ADMIN), (e) => e.status === 400);
  const off = await lanAddressMdns(db, { enabled: false }, ADMIN);
  assert.equal(made[0].stopped, 1);
  assert.equal(off.mdns_enabled, false);
  assert.deepEqual([off.name.state, off.name.reason], ['off', 'setting']);
  stopLanAddress();
  await start(db, dir, { allowUnderTest: true, createResponder: factory });
  assert.equal(made.length, 1, 'выключено настройкой — и после перезапуска не поднимается');
  const on = await lanAddressMdns(db, { enabled: true }, ADMIN);
  assert.equal(made.length, 2);
  assert.equal(made[1].started, 1);
  assert.equal(on.name.state, 'active');
});

test('EASYMED_MDNS=0 — не поднимается, даже когда тест разрешил; экран говорит «выключено на этом компьютере»', async (t) => {
  const { db, dir } = world(t);
  const { factory, made } = fakeFactory();
  await start(db, dir, { allowUnderTest: true, createResponder: factory, env: { EASYMED_MDNS: '0' } });
  assert.equal(made.length, 0);
  assert.deepEqual([lanAddressStatus(db, {}, ADMIN).name.state, lanAddressStatus(db, {}, ADMIN).name.reason], ['off', 'env_off']);
});

test('ответчик бросил при создании — запуск сервера не падает, статус «не работает»', async (t) => {
  const { db, dir } = world(t);
  await start(db, dir, { allowUnderTest: true, createResponder: () => { throw new Error('boom'); } });
  assert.equal(lanAddressStatus(db, {}, ADMIN).name.state, 'failed');
});
