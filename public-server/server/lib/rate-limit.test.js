// PUBLIC_SERVER_V1 — лимит в минуту: до лимита — да, сверх — отказ с
// Retry-After; окно скользит; ключи независимы; корзины не растут без конца.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from './rate-limit.js';

const T0 = Date.parse('2030-03-11T04:00:00Z');   // ровно начало минуты

test('до лимита — да, сверх — отказ с Retry-After до конца минуты', () => {
  const l = createLimiter();
  for (let i = 0; i < 60; i += 1) assert.equal(l.hit('k', 60, T0 + i * 100).ok, true, 'запрос ' + (i + 1));
  const no = l.hit('k', 60, T0 + 10000);
  assert.deepEqual(no, { ok: false, retryAfterSec: 50 });
  assert.equal(l.hit('другой', 60, T0 + 10000).ok, true, 'ключи независимы');
});

test('окно скользит: в начале следующей минуты прошлая ещё весит, потом отпускает', () => {
  const l = createLimiter();
  for (let i = 0; i < 60; i += 1) l.hit('k', 60, T0 + 59000);
  const early = l.hit('k', 60, T0 + 60000 + 500);
  assert.equal(early.ok, false, 'через полсекунды после смены минуты прошлые 60 ещё почти все в окне');
  assert.ok(early.retryAfterSec >= 1 && early.retryAfterSec <= 60);
  assert.equal(l.hit('k', 60, T0 + 60000 + 500 + early.retryAfterSec * 1000).ok, true, 'через Retry-After — можно');
  assert.equal(l.hit('k', 60, T0 + 180000).ok, true, 'через две минуты — с чистого листа');
});

test('корзины не растут без конца', () => {
  const l = createLimiter({ maxBuckets: 100 });
  for (let i = 0; i < 1000; i += 1) l.hit('ip' + i, 10, T0);
  assert.ok(l.size() <= 100);
  l.sweep(T0 + 3 * 60000);
  assert.equal(l.size(), 0);
});
