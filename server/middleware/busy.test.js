// LOCAL_SPEED_V1 (2026-11-24) — [busy] и [stall]: кто занял единственный поток.
//
// [busy] — синхронная часть обработчика /api/db или RPC дольше EASYMED_BUSY_MS
// (150 мс; 0 — выключено): это тот, кто держал сервер. [stall] — цикл событий
// стоял дольше секунды (таймер опоздал), с именем самого долгого отмеренного
// обработчика с прошлого тика, если он был.

import test from 'node:test';
import assert from 'node:assert/strict';
import { busyLimitMs, busyTimer, startStallWatch, stopStallWatch, isStallWatchRunning, rpcLabel, dbLabel } from './busy.js';

const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* держим поток */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('порог: по умолчанию 150 мс; 0, пусто-не-число и отрицательное — выключено', () => {
  assert.equal(busyLimitMs({}), 150);
  assert.equal(busyLimitMs({ EASYMED_BUSY_MS: '' }), 150);
  assert.equal(busyLimitMs({ EASYMED_BUSY_MS: '40' }), 40);
  assert.equal(busyLimitMs({ EASYMED_BUSY_MS: '0' }), 0);
  assert.equal(busyLimitMs({ EASYMED_BUSY_MS: '-5' }), 0);
  assert.equal(busyLimitMs({ EASYMED_BUSY_MS: 'abc' }), 0);
});

test('[busy] — для долгого обработчика, и только для него', () => {
  const lines = [];
  const time = busyTimer({ env: { EASYMED_BUSY_MS: '30' }, log: (l) => lines.push(l) });
  assert.equal(time(rpcLabel('run_report'), () => { spin(60); return 42; }), 42, 'значение обработчика — как есть');
  assert.equal(time(dbLabel({ table: 'patients', op: 'select' }), () => 'fast'), 'fast');
  assert.equal(lines.length, 1, lines.join(' | '));
  assert.match(lines[0], /^\[busy\] \d+ms rpc run_report$/);
  assert.ok(Number(/(\d+)ms/.exec(lines[0])[1]) >= 55, lines[0]);
});

test('[busy] — исключение обработчика уходит дальше, время всё равно отмерено', () => {
  const lines = [];
  const time = busyTimer({ env: { EASYMED_BUSY_MS: '20' }, log: (l) => lines.push(l) });
  assert.throws(() => time(dbLabel({ table: 'visits', op: 'update' }), () => { spin(40); throw new Error('boom'); }), /boom/);
  assert.match(lines[0], /^\[busy\] \d+ms db visits update$/);
});

test('[busy] выключен порогом 0', () => {
  const lines = [];
  const time = busyTimer({ env: { EASYMED_BUSY_MS: '0' }, log: (l) => lines.push(l) });
  time('rpc x', () => spin(30));
  assert.equal(lines.length, 0);
});

// Порог остановки в тестах — 400 мс, а «остановки» — по 800 мс: под полной
// нагрузкой прогона таймер может опоздать сам по себе, но не на столько.
const big = (lines) => lines.filter((l) => /^\[stall\] \d+ms/.test(l) && Number(/(\d+)ms/.exec(l)[1]) >= 600);

test('[stall] — после остановки цикла, с именем того, кто её устроил', async (t) => {
  stopStallWatch();
  const lines = [];
  startStallWatch({ log: (l) => lines.push(l), everyMs: 20, stallMs: 400 });
  t.after(stopStallWatch);
  assert.equal(isStallWatchRunning(), true);
  await sleep(60);   // пара спокойных тиков
  const time = busyTimer({ env: { EASYMED_BUSY_MS: '0' }, log: () => {} });
  time(dbLabel({ table: 'patients', op: 'select' }), () => 1);   // быстрый — не виновник
  time(rpcLabel('run_report'), () => spin(800));
  await sleep(80);
  const stall = big(lines);
  assert.equal(stall.length, 1, lines.join(' | '));
  assert.match(stall[0], /^\[stall\] \d+ms after: rpc run_report$/);

  spin(800);   // остановка без отмеренного обработчика — без «after:»
  await sleep(80);
  const second = big(lines)[1];
  assert.match(String(second), /^\[stall\] \d+ms$/, lines.join(' | '));
});

test('[stall]: детектор один на процесс; остановленный — молчит', async () => {
  stopStallWatch();
  const lines = [];
  startStallWatch({ log: (l) => lines.push(l), everyMs: 20, stallMs: 400 });
  startStallWatch({ log: (l) => lines.push('second ' + l), everyMs: 20, stallMs: 400 });
  spin(800);
  await sleep(60);
  assert.equal(big(lines).length, 1, 'одна строка — один детектор: ' + lines.join(' | '));
  assert.equal(lines.filter((l) => l.startsWith('second')).length, 0);
  stopStallWatch();
  assert.equal(isStallWatchRunning(), false);
  const before = lines.length;
  spin(800);
  await sleep(60);
  assert.equal(lines.length, before, 'после остановки — тишина');
});
