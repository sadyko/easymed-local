// PERF_SLOWLOG_V1 — медленный запрос обязан оставить след, быстрый — нет.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { slowLog } from './slow-log.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

// srv.unref() — иначе ПАДАЮЩАЯ проверка вешает весь прогон вместо того, чтобы
// честно упасть: assert бросает, до srv.close() в конце теста дело не доходит,
// слушающий сокет держит цикл событий, а у node --test нет тайм-аута по
// умолчанию. Один такой файл 29.08.2026 остановил всю сборку на полчаса —
// снаружи это выглядело как «тесты идут», хотя не шло уже ничего. unref()
// делает провал провалом: процесс завершается и рантайм печатает причину.
async function serve(app) {
  const srv = await listen(app);
  srv.unref();
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

// Порог для проверок «быстрый запрос НЕ логируется». Настоящих 5 секунд ни
// один из здешних маршрутов не занимает, а 50 мс — занимает: под полной
// нагрузкой прогона обычный запрос к express измерялся в 300-400 мс, и
// проверка падала не потому, что middleware сломан, а потому что машина была
// занята. Порог здесь не про «сколько это миллисекунд», а про то, что запрос
// заведомо ниже порога — 5000 делает это правдой на любой машине.
const NEVER_SLOW_MS = 5000;

// finish/close fire asynchronously after the response is sent — recordEvent
// runs in that handler, so a poll gives it a moment to land before asserting.
async function waitFor(fn, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

test('быстрый запрос лог не засоряет', async () => {
  const lines = [];
  const app = express();
  app.use(slowLog(freshDb(), { thresholdMs: NEVER_SLOW_MS, log: (l) => lines.push(l) }));
  app.get('/fast', (req, res) => res.json({ ok: true }));
  const { srv, base } = await serve(app);

  await (await fetch(base + '/fast')).json();
  assert.equal(lines.length, 0, 'быстрый запрос лог не засоряет');
  srv.close();
});

test('запрос дольше порога пишется в лог', async () => {
  const lines = [];
  const app = express();
  app.use(slowLog(freshDb(), { thresholdMs: 50, log: (l) => lines.push(l) }));
  app.get('/slow', (req, res) => setTimeout(() => res.json({ ok: true }), 120));
  const { srv, base } = await serve(app);

  await (await fetch(base + '/slow')).json();
  assert.equal(lines.length, 1, 'медленный записан');
  assert.match(lines[0], /^\[slow\] \d+ms  GET \/slow  status=200/);
  srv.close();
});

test('для RPC в строке видно имя вызова, а не просто /api/rpc', async () => {
  const lines = [];
  const app = express();
  app.use(slowLog(freshDb(), { thresholdMs: 1, log: (l) => lines.push(l) }));
  app.post('/api/rpc/:name', (req, res) => setTimeout(() => res.json({ data: 1 }), 20));
  const { srv, base } = await serve(app);
  await (await fetch(base + '/api/rpc/run_report', { method: 'POST' })).json();
  assert.match(lines[0], /rpc run_report/, 'иначе виновника не найти: ' + lines[0]);
  srv.close();
});

test('порог 0 полностью отключает логирование', async () => {
  const lines = [];
  const app = express();
  app.use(slowLog(freshDb(), { thresholdMs: 0, log: (l) => lines.push(l) }));
  app.get('/x', (req, res) => setTimeout(() => res.json({ ok: true }), 60));
  const { srv, base } = await serve(app);
  await (await fetch(base + '/x')).json();
  assert.equal(lines.length, 0);
  srv.close();
});

// --- OPS_EVENTS_V1 -----------------------------------------------------------

test('a slow request past the threshold records a slow_request ops_event with the route template', async () => {
  const db = freshDb();
  const app = express();
  app.use(slowLog(db, { thresholdMs: 50, log: () => {} }));
  app.get('/patients/:id', (req, res) => setTimeout(() => res.json({ ok: true }), 120));
  const { srv, base } = await serve(app);

  await (await fetch(base + '/patients/42')).json();
  const row = await waitFor(() => db.prepare('SELECT * FROM ops_events').get());
  assert.equal(row.kind, 'slow_request');
  assert.equal(row.route, '/patients/:id', 'the route TEMPLATE, never the literal id 42');
  srv.close();
});

test('a fast request records no ops_event at all', async () => {
  const db = freshDb();
  const app = express();
  app.use(slowLog(db, { thresholdMs: NEVER_SLOW_MS, log: () => {} }));
  app.get('/fast', (req, res) => res.json({ ok: true }));
  const { srv, base } = await serve(app);

  await (await fetch(base + '/fast')).json();
  await new Promise((r) => setTimeout(r, 30)); // give a false positive a chance to land
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ops_events').get().n, 0);
  srv.close();
});

test('a slow request on an unmatched route (no req.route) records the event with a null route, not a throw', async () => {
  const db = freshDb();
  const app = express();
  app.use(slowLog(db, { thresholdMs: 10, log: () => {} }));
  app.use((req, res) => setTimeout(() => res.status(404).json({}), 40)); // plain middleware, not a Router route: req.route stays undefined
  const { srv, base } = await serve(app);

  await (await fetch(base + '/anything')).json();
  const row = await waitFor(() => db.prepare('SELECT * FROM ops_events').get());
  assert.equal(row.kind, 'slow_request');
  assert.equal(row.route, null);
  srv.close();
});

// --- LOCAL_SPEED_V1 ------------------------------------------------------------
// К finish express уже срезал путь монтирования: /api/db писался как «POST /», а
// /api/rpc/x — как «POST /x», и по фото консоли нельзя было понять, какая таблица
// или какой RPC тяжёлые. Теперь имя — из req.originalUrl (только путь, без строки
// запроса), RPC — по имени, /api/db — по таблице и операции из тела.

async function mountedApp(lines) {
  const app = express();
  app.use(slowLog(freshDb(), { thresholdMs: 1, log: (l) => lines.push(l) }));
  const rpc = express.Router();
  rpc.post('/:name', (req, res) => setTimeout(() => res.json({ data: 1 }), 15));
  const db = express.Router();
  db.post('/', (req, res) => setTimeout(() => res.json({ data: [] }), 15));
  const storage = express.Router();
  storage.get('/:bucket/*rest', (req, res) => setTimeout(() => res.status(404).json({}), 15));
  app.use('/api/rpc', express.json(), rpc);
  app.use('/api/db', express.json(), db);
  app.use('/api/storage', storage);
  app.get('/plain/:id', (req, res) => setTimeout(() => res.json({}), 15));
  return serve(app);
}
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('LOCAL_SPEED_V1: RPC за монтированием — «rpc <имя>», а не «POST /<имя>» (и в верхнем регистре пути)', async () => {
  const lines = [];
  const { srv, base } = await mountedApp(lines);
  await (await postJson(base + '/api/rpc/run_report', {})).json();
  await (await postJson(base + '/API/RPC/queue_board', {})).json();
  srv.close();
  assert.match(lines[0], /^\[slow\] \d+ms  POST rpc run_report  status=200$/, lines[0]);
  assert.match(lines[1], /  POST rpc queue_board  /, lines[1]);
});

test('LOCAL_SPEED_V1: /api/db — «db <таблица> <операция>», из тела больше ничего', async () => {
  const lines = [];
  const { srv, base } = await mountedApp(lines);
  await (await postJson(base + '/api/db', { table: 'patients', op: 'insert', values: { full_name: 'Тест Тестович', phone: '+998900000000' } })).json();
  await (await postJson(base + '/api/db', { table: 'visits', op: 'select' })).json();
  await (await postJson(base + '/api/db', { table: 'visits' })).json();
  await (await postJson(base + '/api/db', { table: 'Тест Тестович', op: 'drop everything' })).json();
  srv.close();
  assert.match(lines[0], /  POST db patients insert  status=200$/, lines[0]);
  assert.match(lines[1], /  POST db visits select  /, lines[1]);
  assert.match(lines[2], /  POST db visits  /, 'без операции — только таблица: ' + lines[2]);
  assert.match(lines[3], /  POST db \?  /, 'неизвестная таблица и операция — «?»: ' + lines[3]);
  for (const l of lines) assert.doesNotMatch(l, /Тест|998900|full_name|drop/, 'ничего из тела, кроме таблицы и операции: ' + l);
});

test('LOCAL_SPEED_V1: строка запроса в журнал не попадает никогда', async () => {
  const lines = [];
  const { srv, base } = await mountedApp(lines);
  await (await postJson(base + '/api/rpc/run_report?patient=Testov&phone=998900000000', {})).json();
  await (await postJson(base + '/api/db?table=patients&q=Testov', { table: 'patients', op: 'select' })).json();
  await (await fetch(base + '/plain/7?name=Testov')).json();
  srv.close();
  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.doesNotMatch(l, /\?|Testov|998900|phone=|name=|q=/, 'строка запроса не печатается: ' + l);
  }
  assert.match(lines[0], /POST rpc run_report  /);
  assert.match(lines[1], /POST db patients select  /);
  assert.match(lines[2], /GET \/plain\/7  /, 'другие пути — полностью, как есть: ' + lines[2]);
});

test('LOCAL_SPEED_V1: файл хранилища — только корзина, без пути файла (в имени бывает фамилия)', async () => {
  const lines = [];
  const { srv, base } = await mountedApp(lines);
  await (await fetch(base + '/api/storage/clinic-docs/patients/5/docs/Testov-analiz.pdf')).json();
  srv.close();
  assert.match(lines[0], /  GET \/api\/storage\/clinic-docs  status=404$/, lines[0]);
  assert.doesNotMatch(lines[0], /Testov|patients\/5/);
});
