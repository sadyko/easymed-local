// PUBLIC_SERVER_V1 — местное время клиники для партнёров (UTC+5) и обратно.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localParts, addDays, minutesOf, hhmmOf, localMsOf, partnerTime, msOf, isoOf, msOfPartner } from './time.js';

const T = Date.parse('2030-03-12T05:00:00Z');   // 10:00 в Ташкенте

test('мгновение → местные дата и время Ташкента', () => {
  assert.deepEqual(localParts(T, 300), { date: '2030-03-12', hhmm: '10:00', minutes: 600, seconds: 0 });
  assert.deepEqual(localParts(Date.parse('2030-03-11T20:30:00Z'), 300).date, '2030-03-12', 'после 19:00 UTC — уже завтра');
  assert.equal(partnerTime('2030-03-12T05:00:00Z', 300), '2030-03-12T10:00:00+05:00');
  assert.equal(partnerTime('', 300), null);
});

test('местные дата и время → мгновение (обратно)', () => {
  assert.equal(localMsOf('2030-03-12', '10:00', 300), T);
  assert.equal(isoOf(localMsOf('2030-03-12', '10:00', 0)), '2030-03-12T10:00:00Z');
});

test('время партнёра: со смещением — как есть; без смещения — Ташкент, не пояс сервера; мусор — null', () => {
  assert.equal(msOfPartner('2030-03-12T10:00:00+05:00', 300), T);
  assert.equal(msOfPartner('2030-03-12T05:00:00Z', 300), T);
  assert.equal(msOfPartner('2030-03-12T10:00', 300), T);
  assert.equal(msOfPartner('2030-03-12T10:00:00', 300), T);
  for (const bad of ['2030-03-12', '2030-02-30T10:00', '2030-03-12T25:00', 'завтра', '', null, '1700000000000']) {
    assert.equal(msOfPartner(bad, 300), null, String(bad));
  }
});

test('дни и минуты', () => {
  assert.equal(addDays('2030-02-27', 2), '2030-03-01');
  assert.equal(addDays('2030-12-31', 1), '2031-01-01');
  assert.equal(minutesOf('08:15'), 495);
  assert.equal(minutesOf('24:00'), null);
  assert.equal(minutesOf('8:15'), null);
  assert.equal(hhmmOf(495), '08:15');
  assert.equal(msOf('нет'), null);
});
