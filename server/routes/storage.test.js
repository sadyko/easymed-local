import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storageRoutes } from './storage.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

async function start(storageDir) {
  const app = express();
  app.use('/api/storage', storageRoutes(storageDir));   // mounted without auth for the unit test
  const srv = await listen(app);
  return { srv, port: srv.address().port };
}

test('storage: upload -> serve -> delete round-trip, with bucket + traversal + empty guards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emstore-'));
  const { srv, port } = await start(dir);
  const base = `http://127.0.0.1:${port}/api/storage`;
  try {
    // upload
    let res = await fetch(`${base}/clinic-docs/photos/p1.txt`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('hello world') });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.path, 'photos/p1.txt');
    assert.ok(fs.existsSync(path.join(dir, 'clinic-docs', 'photos', 'p1.txt')));

    // serve it back with the right content type
    res = await fetch(`${base}/clinic-docs/photos/p1.txt`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/plain/);
    assert.equal(await res.text(), 'hello world');

    // unknown bucket -> 400, nothing written
    res = await fetch(`${base}/evil/x.txt`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('x') });
    assert.equal(res.status, 400);

    // path traversal (encoded ../../) -> 400, nothing escapes the bucket dir
    res = await fetch(`${base}/clinic-docs/%2e%2e%2f%2e%2e%2fescape.txt`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('x') });
    assert.equal(res.status, 400);
    assert.ok(!fs.existsSync(path.join(dir, 'escape.txt')));

    // empty upload -> 400
    res = await fetch(`${base}/clinic-docs/empty.txt`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '' });
    assert.equal(res.status, 400);

    // delete, then it 404s
    res = await fetch(`${base}/clinic-docs/photos/p1.txt`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    res = await fetch(`${base}/clinic-docs/photos/p1.txt`);
    assert.equal(res.status, 404);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
