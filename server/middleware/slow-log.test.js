// PERF_SLOWLOG_V1 — медленный запрос обязан оставить след, быстрый — нет.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { slowLog } from './slow-log.js';

function serve(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('запрос дольше порога пишется в лог, быстрый — нет', async () => {
  const lines = [];
  const app = express();
  app.use(slowLog({ thresholdMs: 50, log: (l) => lines.push(l) }));
  app.get('/fast', (req, res) => res.json({ ok: true }));
  app.get('/slow', (req, res) => setTimeout(() => res.json({ ok: true }), 120));
  const { srv, base } = await serve(app);

  await (await fetch(base + '/fast')).json();
  assert.equal(lines.length, 0, 'быстрый запрос лог не засоряет');

  await (await fetch(base + '/slow')).json();
  assert.equal(lines.length, 1, 'медленный записан');
  assert.match(lines[0], /^\[slow\] \d+ms  GET \/slow  status=200/);
  srv.close();
});

test('для RPC в строке видно имя вызова, а не просто /api/rpc', async () => {
  const lines = [];
  const app = express();
  app.use(slowLog({ thresholdMs: 1, log: (l) => lines.push(l) }));
  app.post('/api/rpc/:name', (req, res) => setTimeout(() => res.json({ data: 1 }), 20));
  const { srv, base } = await serve(app);
  await (await fetch(base + '/api/rpc/run_report', { method: 'POST' })).json();
  assert.match(lines[0], /rpc run_report/, 'иначе виновника не найти: ' + lines[0]);
  srv.close();
});

test('порог 0 полностью отключает логирование', async () => {
  const lines = [];
  const app = express();
  app.use(slowLog({ thresholdMs: 0, log: (l) => lines.push(l) }));
  app.get('/x', (req, res) => setTimeout(() => res.json({ ok: true }), 60));
  const { srv, base } = await serve(app);
  await (await fetch(base + '/x')).json();
  assert.equal(lines.length, 0);
  srv.close();
});
