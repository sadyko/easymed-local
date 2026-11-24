// LOCAL_SPEED_V1 (2026-11-24) — [busy] из настоящих маршрутов /api/db и RPC, и
// детектор остановок [stall], который createApp включает вместе с журналом
// медленных запросов (EASYMED_SLOW_MS не 0).
//
// Порог [busy] здесь — 0,0001 мс: любой вызов «дольше порога», поэтому строка
// появляется для каждого — проверяется, ЧТО в ней написано, а не скорость машины.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { hashPassword } from './services/auth.js';
import { createApp } from './app.js';
import { licensedDataDir } from './services/control/licensed-fixture.js';
import { listen } from '../control-plane/server/test-helpers/listen.js';
import { isStallWatchRunning, stopStallWatch } from './middleware/busy.js';

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

async function stand(t, env) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Админ', 'admin');
  const app = withEnv(env, () => createApp(db, { dataDir: licensedDataDir(), live: { enabled: false } }));
  const server = await listen(app);
  server.unref();
  t.after(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    await res.arrayBuffer();
    return res.status;
  };
  return { post };
}

async function captureWarn(fn) {
  const real = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.map(String).join(' '));
  try { await fn(); } finally { console.warn = real; }
  return lines;
}

test('[busy] из /api/db — «db <таблица> <операция>», из RPC — «rpc <имя>»; тела и строки запроса нет', async (t) => {
  const { post } = await stand(t, { EASYMED_BUSY_MS: '0.0001', EASYMED_SLOW_MS: '0' });
  const lines = await captureWarn(async () => {
    await post('/api/db?q=Testov', { table: 'patients', op: 'select', filters: [{ col: 'full_name', op: 'eq', val: 'Тест Тестович' }] });
    await post('/api/rpc/crm_config_get?phone=998900000000', {});
  });
  const busy = lines.filter((l) => l.startsWith('[busy]'));
  assert.ok(busy.some((l) => /^\[busy\] \d+ms db patients select$/.test(l)), busy.join(' | '));
  assert.ok(busy.some((l) => /^\[busy\] \d+ms rpc crm_config_get$/.test(l)), busy.join(' | '));
  for (const l of busy) assert.doesNotMatch(l, /Тест|Testov|998900|\?|full_name/, l);
});

test('[busy] по умолчанию (150 мс) молчит о быстрых вызовах', async (t) => {
  const { post } = await stand(t, { EASYMED_BUSY_MS: null, EASYMED_SLOW_MS: '0' });
  const lines = await captureWarn(async () => {
    await post('/api/db', { table: 'patients', op: 'select' });
  });
  assert.deepEqual(lines.filter((l) => l.startsWith('[busy]')), []);
});

// Под node --test детектор включается только по EASYMED_STALL_WATCH=1: синхронный
// migrate() каждого теста стоит около секунды, и прогон засыпало бы строками [stall].
test('createApp включает детектор остановок вместе с журналом медленных запросов, и только с ним', async (t) => {
  stopStallWatch();
  t.after(stopStallWatch);
  await stand(t, { EASYMED_SLOW_MS: '0', EASYMED_STALL_WATCH: '1' });
  assert.equal(isStallWatchRunning(), false, 'EASYMED_SLOW_MS=0 — детектора нет');
  await stand(t, { EASYMED_SLOW_MS: null, EASYMED_STALL_WATCH: null });
  assert.equal(isStallWatchRunning(), false, 'под node --test без просьбы — детектора нет');
  await stand(t, { EASYMED_SLOW_MS: null, EASYMED_STALL_WATCH: '1' });
  assert.equal(isStallWatchRunning(), true, 'журнал включён (по умолчанию) — детектор работает');
  await stand(t, { EASYMED_SLOW_MS: null, EASYMED_STALL_WATCH: '1' });
  assert.equal(isStallWatchRunning(), true, 'второе приложение — тот же один детектор');
});

test('вне node --test детектору просьба не нужна', async () => {
  const { stallWatchAllowed } = await import('./middleware/busy.js');
  assert.equal(stallWatchAllowed({}), true, 'рабочий сервер');
  assert.equal(stallWatchAllowed({ NODE_TEST_CONTEXT: 'child-v8' }), false);
  assert.equal(stallWatchAllowed({ NODE_TEST_CONTEXT: 'child-v8', EASYMED_STALL_WATCH: '1' }), true);
});
