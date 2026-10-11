// PUBLIC_SERVER_V1 — адреса: «Разрешённые IP» (адрес и подсеть, IPv4 и IPv6,
// неверная запись — никого); уведомления — только на публичные адреса, и
// проверка — в самом подключении (DNS rebinding).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ipAllowed, clientIp, isPublicAddress, blockedList, guardedLookup, SsrfError } from './net-guard.js';

test('«Разрешённые IP»: пусто — все; адрес и подсеть; IPv6; запись с ошибкой — никого', () => {
  assert.equal(ipAllowed([], '198.51.100.1'), true);
  assert.equal(ipAllowed(['203.0.113.7'], '203.0.113.7'), true);
  assert.equal(ipAllowed(['203.0.113.7'], '::ffff:203.0.113.7'), true, 'IPv4 в записи IPv6');
  assert.equal(ipAllowed(['203.0.113.7'], '203.0.113.8'), false);
  assert.equal(ipAllowed(['203.0.113.0/24'], '203.0.113.200'), true);
  assert.equal(ipAllowed(['2001:db8::/32'], '2001:db8::5'), true);
  assert.equal(ipAllowed(['2001:db8::/32'], '2001:db9::5'), false);
  assert.equal(ipAllowed(['203.0.113.7', 'мусор'], '203.0.113.7'), false, 'неверная запись не расширяет доступ');
  assert.equal(ipAllowed(['203.0.113.0/33'], '203.0.113.7'), false);
  assert.equal(ipAllowed(['203.0.113.7'], ''), false);
  assert.equal(clientIp('::ffff:10.1.2.3'), '10.1.2.3');
});

test('публичный адрес: частные, петлевые, локальные, метаданные облака, служебные — нет; адрес самой машины — нет', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1', 'не ip',
    '::ffff:7f00:1', '::7f00:1', '::127.0.0.1', '::a9fe:a9fe', '::ffff:0:7f00:1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '45.77.242.169', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(isPublicAddress('45.77.242.169', blockedList(['45.77.242.169'])), false, 'сам себе — нет');
});

const lookupOf = (addrs) => guardedLookup({ resolve: async () => addrs });
const call = (fn, opts) => new Promise((resolve) => fn('hook.partner.uz', opts, (err, a, f) => resolve({ err, a, f })));

test('lookup подключения: публичное — отдаёт; хоть один частный — отказ; пусто — отказ; ошибка DNS — отказ', async () => {
  const ok = await call(lookupOf([{ address: '8.8.8.8', family: 4 }]), {});
  assert.deepEqual([ok.err, ok.a, ok.f], [null, '8.8.8.8', 4]);
  const all = await call(lookupOf([{ address: '8.8.8.8', family: 4 }, { address: '2a00:1450:4001:80b::200e', family: 6 }]), { all: true });
  assert.equal(all.a.length, 2);
  const mixed = await call(lookupOf([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), {});
  assert.ok(mixed.err instanceof SsrfError);
  assert.equal(mixed.err.code, 'blocked_address');
  assert.equal((await call(lookupOf([]), {})).err.code, 'no_address');
  const broken = guardedLookup({ resolve: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal((await call(broken, {})).err.code, 'dns_failed');
});
