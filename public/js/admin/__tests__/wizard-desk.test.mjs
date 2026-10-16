// CRM_LINK_ALL_V1 (2026-10-16) — R3 (решение владельца D2): «СЕЙЧАС» У СТОЙКИ — одно
// правило мастера визита и сервера (views/wizard-desk.js isDeskNow, DESK_NOW_MINUTES).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeskNow, DESK_NOW_MINUTES } from '../views/wizard-desk.js';

const NOW = new Date(2030, 2, 12, 10, 0, 0, 0).getTime();
const TODAY = '2030-03-12';

test('CRM_LINK_ALL_V1 R3: сегодня без слота (живая очередь, услуги без времени) — «сейчас»', () => {
  assert.equal(isDeskNow({ dayIso: TODAY, todayIso: TODAY, headStartMs: null, nowMs: NOW }), true);
});

test('CRM_LINK_ALL_V1 R3: слот не позже чем через 30 минут (и уже начавшийся) — «сейчас»; позже — запись', () => {
  assert.equal(DESK_NOW_MINUTES, 30);
  assert.equal(isDeskNow({ dayIso: TODAY, todayIso: TODAY, headStartMs: NOW + 30 * 60000, nowMs: NOW }), true);
  assert.equal(isDeskNow({ dayIso: TODAY, todayIso: TODAY, headStartMs: NOW - 90 * 60000, nowMs: NOW }), true, 'записан на 08:30, пришёл в 10:00');
  assert.equal(isDeskNow({ dayIso: TODAY, todayIso: TODAY, headStartMs: NOW + 31 * 60000, nowMs: NOW }), false);
});

test('CRM_LINK_ALL_V1 R3: другой день — никогда не «сейчас»; мусор — нет', () => {
  assert.equal(isDeskNow({ dayIso: '2030-03-13', todayIso: TODAY, headStartMs: null, nowMs: NOW }), false);
  assert.equal(isDeskNow({ dayIso: '2030-03-11', todayIso: TODAY, headStartMs: null, nowMs: NOW }), false);
  assert.equal(isDeskNow({ dayIso: '', todayIso: TODAY, nowMs: NOW }), false);
  assert.equal(isDeskNow({ dayIso: TODAY, todayIso: TODAY, headStartMs: 'x', nowMs: NOW }), false);
  assert.equal(isDeskNow(), false);
});
