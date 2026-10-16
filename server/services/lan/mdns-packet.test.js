// LAN_ADDRESS_V1 — разбор запроса и сборка ответа mDNS байт в байт.
// Запросы собраны руками по RFC 1035 §4.1 / RFC 6762, ответы сверяются с
// байтами, а не с собственным разборщиком — иначе ошибка в обоих сошлась бы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, buildResponse, buildQuery, TYPE_A, TYPE_ANY } from './mdns-packet.js';

const NAME = [0x07, ...Buffer.from('easymed'), 0x05, ...Buffer.from('local'), 0x00];
const hdr = (id, flags, qd, an, ns = 0, ar = 0) => [id >> 8, id & 255, flags >> 8, flags & 255, 0, qd, 0, an, 0, ns, 0, ar];

// Так спрашивает Windows 10/11: ID 0, без флагов, один вопрос A IN (QM).
const WIN_QUERY = Buffer.from([...hdr(0, 0, 1, 0), ...NAME, 0x00, 0x01, 0x00, 0x01]);

test('запрос разобран: имя, тип A, класс IN, QM', () => {
  const m = parseMessage(WIN_QUERY);
  assert.equal(m.id, 0);
  assert.equal(m.qr, false);
  assert.deepEqual(m.questions, [{ name: 'easymed.local', type: TYPE_A, qclass: 1, qu: false }]);
  assert.deepEqual(m.answers, []);
});

test('QU-бит (верхний бит класса вопроса) — отдельно от класса', () => {
  const q = Buffer.from([...hdr(0, 0, 1, 0), ...NAME, 0x00, 0xff, 0x80, 0x01]);
  assert.deepEqual(parseMessage(q).questions, [{ name: 'easymed.local', type: TYPE_ANY, qclass: 1, qu: true }]);
});

test('ответ multicast: ID 0, флаги 8400, без вопроса, A с cache-flush, TTL 120 — байт в байт', () => {
  const got = buildResponse({ name: 'easymed.local', addresses: ['192.168.1.156'] });
  const want = Buffer.from([
    ...hdr(0, 0x8400, 0, 1),
    ...NAME, 0x00, 0x01, 0x80, 0x01, 0x00, 0x00, 0x00, 0x78, 0x00, 0x04, 192, 168, 1, 156,
  ]);
  assert.deepEqual(got, want);
});

test('ответ «legacy unicast» (спросили не с порта 5353): тот же ID, вопрос повторён, TTL 10, без cache-flush', () => {
  const query = Buffer.from([...hdr(0x1234, 0x0100, 1, 0), ...NAME, 0x00, 0x01, 0x00, 0x01]);
  const m = parseMessage(query);
  const got = buildResponse({ id: m.id, name: 'easymed.local', addresses: ['10.4.1.77', '192.168.0.20'], legacy: true, question: m.questions[0] });
  const want = Buffer.from([
    ...hdr(0x1234, 0x8400, 1, 2),
    ...NAME, 0x00, 0x01, 0x00, 0x01,
    ...NAME, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x04, 10, 4, 1, 77,
    ...NAME, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x04, 192, 168, 0, 20,
  ]);
  assert.deepEqual(got, want);
});

test('чужой ответ со сжатым именем (указатель на вопрос) разбирается: имя, A, адрес, cache-flush', () => {
  const resp = Buffer.from([
    ...hdr(0, 0x8400, 1, 1),
    ...NAME, 0x00, 0x01, 0x00, 0x01,
    0xc0, 0x0c, 0x00, 0x01, 0x80, 0x01, 0x00, 0x00, 0x00, 0x78, 0x00, 0x04, 192, 168, 1, 145,
  ]);
  const m = parseMessage(resp);
  assert.equal(m.qr, true);
  assert.deepEqual(m.answers, [{ name: 'easymed.local', type: TYPE_A, rclass: 1, flush: true, ttl: 120, address: '192.168.1.145' }]);
});

test('свой ответ читается своим разборщиком (замкнутый круг для ответчика)', () => {
  const m = parseMessage(buildResponse({ name: 'Clinic-2.local', addresses: ['192.168.1.156'] }));
  assert.deepEqual(m.answers.map((a) => [a.name, a.address]), [['Clinic-2.local', '192.168.1.156']]);
});

test('запрос-проба: один вопрос ANY, QM (ответ придёт multicast — Windows делит порт 5353)', () => {
  const q = buildQuery('easymed.local');
  assert.deepEqual(q, Buffer.from([...hdr(0, 0, 1, 0), ...NAME, 0x00, 0xff, 0x00, 0x01]));
});

test('плохие пакеты — null, не исключение: обрезан, петля указателей, метка > 63, пусто', () => {
  assert.equal(parseMessage(Buffer.alloc(0)), null);
  assert.equal(parseMessage(WIN_QUERY.subarray(0, 20)), null);
  const loop = Buffer.from([...hdr(0, 0, 1, 0), 0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01]);
  assert.equal(parseMessage(loop), null);
  const long = Buffer.from([...hdr(0, 0, 1, 0), 64, ...Buffer.alloc(64, 0x61), 0x00, 0x00, 0x01, 0x00, 0x01]);
  assert.equal(parseMessage(long), null);
  assert.equal(parseMessage('не буфер'), null);
});

test('сборка не принимает плохое имя и плохой адрес', () => {
  assert.throws(() => buildResponse({ name: 'a'.repeat(64) + '.local', addresses: ['10.0.0.1'] }));
  assert.throws(() => buildResponse({ name: 'easymed.local', addresses: ['999.1.1.1'] }));
});
