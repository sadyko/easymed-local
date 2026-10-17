// LAN_ADDRESS_V1 — память адреса между запусками: data/lan-address.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LAN_FILE, readLanState, recordAddresses, visibleChange, dismissChange, setMdnsEnabled } from './state.js';

const v4 = (address, mac = 'a4:bb:6d:12:34:56') => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac, internal: false });
const PC = (address) => ({ 'Ethernet': [v4(address)] });

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-lan-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const T1 = new Date('2026-10-16T08:00:00Z'), T2 = new Date('2026-10-17T08:00:00Z'), T3 = new Date('2026-10-18T08:00:00Z');

test('нет файла — пустая память, имя в сети включено по умолчанию', (t) => {
  const s = readLanState(tmpDir(t));
  assert.deepEqual(s, { addresses: [], cards: [], seen_at: null, change: null, dismissed_at: null, mdns_enabled: true });
});

test('первый запуск: запоминает адрес, смены нет', (t) => {
  const dir = tmpDir(t);
  const r = recordAddresses(dir, { interfaces: PC('192.168.1.147'), now: T1 });
  assert.equal(r.changed, false);
  assert.deepEqual(readLanState(dir), { addresses: ['192.168.1.147'], cards: [{ key: 'a4:bb:6d:12:34:56', adapter: 'Ethernet', addresses: ['192.168.1.147'], seen_at: T1.toISOString() }], seen_at: T1.toISOString(), change: null, dismissed_at: null, mdns_enabled: true });
  assert.ok(fs.existsSync(path.join(dir, LAN_FILE)));
});

test('перезапуск с новым адресом: смена «было → стало» видна; повтор без смены её хранит', (t) => {
  const dir = tmpDir(t);
  recordAddresses(dir, { interfaces: PC('192.168.1.147'), now: T1 });
  const r = recordAddresses(dir, { interfaces: PC('192.168.1.156'), now: T2 });
  assert.equal(r.changed, true);
  const change = { from: ['192.168.1.147'], to: ['192.168.1.156'], at: T2.toISOString() };
  assert.deepEqual(visibleChange(readLanState(dir)), change);
  // Администратор не входил между перезапусками — предупреждение не должно пропасть.
  recordAddresses(dir, { interfaces: PC('192.168.1.156'), now: T3 });
  assert.deepEqual(visibleChange(readLanState(dir)), change);
  assert.deepEqual(readLanState(dir).addresses, ['192.168.1.156']);
});

test('«Скрыть» — до следующей смены: скрытая не видна, следующая смена — снова видна', (t) => {
  const dir = tmpDir(t);
  recordAddresses(dir, { interfaces: PC('192.168.1.147'), now: T1 });
  recordAddresses(dir, { interfaces: PC('192.168.1.156'), now: T2 });
  dismissChange(dir, T2.toISOString());
  assert.equal(visibleChange(readLanState(dir)), null);
  recordAddresses(dir, { interfaces: PC('192.168.1.156'), now: T3 });
  assert.equal(visibleChange(readLanState(dir)), null, 'тот же адрес после перезапуска — скрытое остаётся скрытым');
  recordAddresses(dir, { interfaces: PC('192.168.1.145'), now: T3 });
  assert.deepEqual(visibleChange(readLanState(dir)), { from: ['192.168.1.156'], to: ['192.168.1.145'], at: T3.toISOString() });
});

test('«Скрыть» прежнюю смену не скрывает новую, пришедшую, пока экран был открыт', (t) => {
  const dir = tmpDir(t);
  recordAddresses(dir, { interfaces: PC('192.168.1.147'), now: T1 });
  recordAddresses(dir, { interfaces: PC('192.168.1.156'), now: T2 });
  recordAddresses(dir, { interfaces: PC('192.168.1.145'), now: T3 });
  dismissChange(dir, T2.toISOString());
  assert.equal(visibleChange(readLanState(dir)).at, T3.toISOString());
});

test('кабель выдернут при запуске: ничего не пишет — прежний адрес помнится', (t) => {
  const dir = tmpDir(t);
  recordAddresses(dir, { interfaces: PC('192.168.1.147'), now: T1 });
  const r = recordAddresses(dir, { interfaces: {}, now: T2 });
  assert.equal(r.changed, false);
  assert.deepEqual(readLanState(dir).addresses, ['192.168.1.147']);
  assert.equal(readLanState(dir).seen_at, T1.toISOString());
});

test('испорченный файл — пустая память, не исключение; следующий запуск пишет заново', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, LAN_FILE), '{не json');
  assert.deepEqual(readLanState(dir).addresses, []);
  const r = recordAddresses(dir, { interfaces: PC('192.168.1.147'), now: T1 });
  assert.equal(r.changed, false);
  assert.deepEqual(readLanState(dir).addresses, ['192.168.1.147']);
  fs.writeFileSync(path.join(dir, LAN_FILE), JSON.stringify({ addresses: 'x', change: { from: 5 }, mdns_enabled: 'нет' }));
  assert.deepEqual(readLanState(dir), { addresses: [], cards: [], seen_at: null, change: null, dismissed_at: null, mdns_enabled: true });
});

test('папку данных нельзя записать — recordAddresses не бросает (запуск сервера важнее подсказки)', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'not-a-dir');
  fs.writeFileSync(file, 'x');   // «папка данных» — файл: запись внутрь невозможна
  const r = recordAddresses(file, { interfaces: PC('192.168.1.147'), now: T1 });
  assert.equal(r.changed, false);
  assert.ok(r.error);
});

test('выключатель имени в сети хранится в том же файле и не трогает память адреса', (t) => {
  const dir = tmpDir(t);
  recordAddresses(dir, { interfaces: PC('192.168.1.147'), now: T1 });
  setMdnsEnabled(dir, false);
  assert.equal(readLanState(dir).mdns_enabled, false);
  assert.deepEqual(readLanState(dir).addresses, ['192.168.1.147']);
  recordAddresses(dir, { interfaces: PC('192.168.1.156'), now: T2 });
  assert.equal(readLanState(dir).mdns_enabled, false, 'запись адреса не включает имя обратно');
  setMdnsEnabled(dir, true);
  assert.equal(readLanState(dir).mdns_enabled, true);
});

test('повторная перепроверка R3: настоящая карта, которой нет 30 дней, забывается; случайный MAC (Wi-Fi) не помнится вовсе', (t) => {
  const dir = tmpDir(t);
  const day = (n) => new Date(Date.UTC(2026, 9, 1) + n * 86400000);
  const eth = { 'Ethernet': [v4('192.168.1.156')] };
  recordAddresses(dir, { interfaces: { ...eth, 'Wi-Fi': [v4('192.168.1.160', 'd8:5e:d3:01:02:03')] }, now: day(0) });
  recordAddresses(dir, { interfaces: eth, now: day(1) });
  assert.equal(readLanState(dir).cards.length, 2, 'Wi-Fi выключен — помнится');
  recordAddresses(dir, { interfaces: eth, now: day(31) });
  assert.deepEqual(readLanState(dir).cards.map((c) => c.key), ['a4:bb:6d:12:34:56'], 'нет 30 дней — забыт');
  // Случайный («локально назначенный») MAC — пропал, значит не вернётся тем же: не помнить.
  recordAddresses(dir, { interfaces: { ...eth, 'Wi-Fi': [v4('192.168.1.170', 'a6:11:22:33:44:01')] }, now: day(32) });
  recordAddresses(dir, { interfaces: eth, now: day(33) });
  assert.deepEqual(readLanState(dir).cards.map((c) => c.key), ['a4:bb:6d:12:34:56']);
});

test('повторная перепроверка R3: такт раз в минуту не пишет файл, пока ничего не изменилось (метка «видели» — не чаще раза в сутки)', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, LAN_FILE);
  recordAddresses(dir, { interfaces: PC('192.168.1.147'), now: T1 });
  const m1 = fs.statSync(file).mtimeMs;
  fs.utimesSync(file, new Date(m1 / 1000 * 1000 - 60000), new Date(m1 - 60000));
  const m2 = fs.statSync(file).mtimeMs;
  recordAddresses(dir, { interfaces: PC('192.168.1.147'), now: new Date(T1.getTime() + 60000) });
  assert.equal(fs.statSync(file).mtimeMs, m2, 'минута спустя без изменений — файл не переписан');
});
