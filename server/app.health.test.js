// V3120_FIX — /api/health проверяет базу, а не только то, что процесс жив.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { licensedDataDir } from './services/control/licensed-fixture.js';
import { listen } from '../control-plane/server/test-helpers/listen.js';

test('/api/health: 200 при живой базе, 503 когда база недоступна', async (t) => {
  const db = openDb(':memory:');
  migrate(db);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  let res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  db.close();   // база «отвалилась»
  res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'db_unavailable');
});
