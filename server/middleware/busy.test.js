// LOCAL_SPEED_V1 (2026-11-24) — [busy] и [stall]: кто занял единственный поток.
//
// [busy] — синхронная часть обработчика /api/db или RPC дольше EASYMED_BUSY_MS
// (150 мс; 0 — выключено): это тот, кто держал сервер. [stall] — цикл событий
// стоял дольше секунды (таймер опоздал), с именем самого долгого отмеренного
// обработчика с прошлого тика, если он был.

import test from 'node:test';
import assert from 'node:assert/strict';
import { busyLimitMs, busyTimer, startStallWatch, stopStallWatch, isStallWatchRunning, rpcLabel, dbLabel, requestLabel } from './busy.js';

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
  // LOCAL_SPEED_V1 (ревью) — с отмеренным временем обработчика: видно, его ли это остановка.
  assert.match(stall[0], /^\[stall\] \d+ms after: rpc run_report \(\d+ms\)$/);
  assert.ok(Number(/\((\d+)ms\)$/.exec(stall[0])[1]) >= 750, stall[0]);

  spin(800);   // остановка без отмеренного обработчика — без «after:»
  await sleep(80);
  const second = big(lines)[1];
  assert.match(String(second), /^\[stall\] \d+ms$/, lines.join(' | '));
});

test('LOCAL_SPEED_V1 (ревью): [stall] не называет невиновного — быстрый обработчик перед остановкой в строку не попадает', async (t) => {
  stopStallWatch();
  const lines = [];
  startStallWatch({ log: (l) => lines.push(l), everyMs: 20, stallMs: 400, env: { EASYMED_BUSY_MS: '150' } });
  t.after(stopStallWatch);
  await sleep(60);
  const time = busyTimer({ env: { EASYMED_BUSY_MS: '150' }, log: () => {} });
  time(dbLabel({ table: 'patients', op: 'select' }), () => 1);   // 0 мс — он ни при чём
  spin(800);                                                      // остановку устроил кто-то неотмеренный
  await sleep(80);
  const stall = big(lines);
  assert.equal(stall.length, 1, lines.join(' | '));
  assert.match(stall[0], /^\[stall\] \d+ms$/, 'без «after:»: ' + stall[0]);
});

test('LOCAL_SPEED_V1 (ревью): [stall] при выключенном [busy] меряет по обычному порогу (150 мс), а не называет любого', async (t) => {
  stopStallWatch();
  const lines = [];
  startStallWatch({ log: (l) => lines.push(l), everyMs: 20, stallMs: 400, env: { EASYMED_BUSY_MS: '0' } });
  t.after(stopStallWatch);
  await sleep(60);
  const time = busyTimer({ env: { EASYMED_BUSY_MS: '0' }, log: () => {} });
  time(rpcLabel('queue_board'), () => spin(20));   // ниже порога
  spin(800);
  await sleep(80);
  assert.match(String(big(lines)[0]), /^\[stall\] \d+ms$/, lines.join(' | '));
});

// LOCAL_SPEED_V1 (ревью) — секрет в пути. Адрес вебхука станции — /api/telephony/pbx/<секрет>:
// в строке [slow] (консоль клиники, её фото уходят в поддержку) его быть не должно.
const label = (url, body) => requestLabel({ originalUrl: url, body });

test('LOCAL_SPEED_V1 (ревью): секрет адреса вебхука onlinePBX печатается как «:token»', () => {
  assert.equal(label('/api/telephony/pbx/s3cr3tTOKENvalue0123456789'), '/api/telephony/pbx/:token');
  assert.equal(label('/api/telephony/pbx/s3cr3tTOKENvalue0123456789?event=call_start'), '/api/telephony/pbx/:token');
  assert.equal(label('/API/Telephony/PBX/s3cr3tTOKENvalue0123456789/'), '/api/telephony/pbx/:token');
  assert.equal(label('/api/telephony/pbx/s3cr3t/extra/part'), '/api/telephony/pbx/:token', 'и всё, что за ним');
  assert.equal(label('/api/telephony/pbx/%D1%81%D0%B5%D0%BA%D1%80%D0%B5%D1%82'), '/api/telephony/pbx/:token');
  assert.equal(label('/api/telephony/pbx'), '/api/telephony/pbx');
  assert.equal(label('/api/telephony/pbx/'), '/api/telephony/pbx');
});

test('LOCAL_SPEED_V1 (ревью): остальные входы без сессии — только известный адрес, хвост пути не печатается', () => {
  // Binotel: маршрут один — «/»; всё, что дописано к адресу, — не наше и может быть чем угодно.
  assert.equal(label('/api/telephony/binotel'), '/api/telephony/binotel');
  assert.equal(label('/api/telephony/binotel/'), '/api/telephony/binotel');
  assert.equal(label('/api/telephony/binotel/abc123secret'), '/api/telephony/binotel');
  // LIS Proxy: ключ — в строке запроса (она не печатается), маршрут один — «/».
  assert.equal(label('/api/lisproxy?key=abc123secret'), '/api/lisproxy');
  assert.equal(label('/api/lisproxy/abc123secret?key=abc123secret'), '/api/lisproxy');
  // Справочник филиалу: подпись — в заголовках; известный маршрут один.
  assert.equal(label('/api/branch-sync/catalogue'), '/api/branch-sync/catalogue');
  assert.equal(label('/API/Branch-Sync/Catalogue?x=1'), '/api/branch-sync/catalogue');
  assert.equal(label('/api/branch-sync/abc123secret'), '/api/branch-sync');
  assert.equal(label('/api/branch-sync/catalogue/abc123secret'), '/api/branch-sync/catalogue');
  // Соседние адреса не задеты.
  assert.equal(label('/api/telephony/pbxx/abc'), '/api/telephony/pbxx/abc');
  assert.equal(label('/api/users/7'), '/api/users/7');
  assert.equal(label('/api/rpc/run_report'), 'rpc run_report');
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
