// LOCAL_SPEED_V1 (2026-11-24) — сжатый файл статики хранится в памяти.
//
// После обновления каждый ПК клиники качает весь код (≈15 МБ, 4 МБ в gzip), и
// compress() сжимал одни и те же файлы заново для каждого ПК и каждого
// открытия. Теперь gzip файла хранится по (путь, mtimeMs, size): один файл —
// одно сжатие, пока файл не изменился. Ответы API в память не попадают.
//
// Здесь — что из памяти уходят ровно те же заголовки и те же байты, что и при
// честном сжатии; файл изменился — сжимается заново; клиенту без gzip — как
// было; 304, HEAD и Range — как было.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { compress, markStaticFile } from './compress.js';
import { tmpDir } from '../test-helpers/tmpdir.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';

// Текст, который хорошо жмётся и больше порога сжатия (1 КБ).
const text = (word, n = 400) => Array.from({ length: n }, (_, i) => `export const ${word}${i} = ${i};`).join('\n') + '\n';

async function stand(t, { staticCacheBytes } = {}) {
  const dir = tmpDir('em-gzc-');
  const calls = [];
  const app = express();
  app.use(compress({
    gzip: (buf, cb) => { calls.push(buf.length); zlib.gzip(buf, cb); },
    ...(staticCacheBytes != null ? { staticCacheBytes } : {}),
  }));
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
  app.post('/api/echo', (req, res) => res.json({ text: text('api') }));
  app.use(express.static(dir, {
    setHeaders: (res, filePath, stat) => {
      res.setHeader('Cache-Control', 'no-cache');
      markStaticFile(res, filePath, stat);
    },
  }));
  const server = await listen(app);
  server.unref();
  t.after(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  });
  return { dir, calls, base: `http://127.0.0.1:${server.address().port}` };
}

function get(base, p, headers = {}, method = 'GET') {
  const u = new URL(base + p);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        const body = Buffer.concat(bufs);
        const plain = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(body) : body;
        resolve({ status: res.statusCode, headers: res.headers, body, plain });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const GZ = { 'Accept-Encoding': 'gzip' };
const withoutDate = (h) => { const o = { ...h }; delete o.date; return o; };

function write(dir, name, content, when) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  if (when) fs.utimesSync(file, when, when);
  return file;
}

test('тот же файл второй раз — без сжатия, те же байты и те же заголовки', async (t) => {
  const { dir, calls, base } = await stand(t);
  const content = text('a');
  write(dir, 'a.js', content);
  const first = await get(base, '/a.js', GZ);
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-encoding'], 'gzip');
  assert.equal(calls.length, 1, 'первый раз — сжали');
  const second = await get(base, '/a.js', GZ);
  assert.equal(calls.length, 1, 'второй раз — из памяти, zlib не звали');
  assert.equal(second.plain.toString(), content);
  assert.ok(second.body.equals(first.body), 'сжатое тело то же');
  assert.deepEqual(withoutDate(second.headers), withoutDate(first.headers), 'заголовки — те же, что при сжатии');
  assert.equal(second.headers['content-length'], String(second.body.length));
  assert.match(String(second.headers.vary), /Accept-Encoding/i);
  assert.ok(second.headers.etag, 'ETag на месте');
  assert.equal(second.headers['cache-control'], 'no-cache');
  assert.equal(second.headers['x-content-type-options'], 'nosniff');
});

test('файл изменился (другой размер, или тот же размер и другое время) — сжимается заново', async (t) => {
  const { dir, calls, base } = await stand(t);
  write(dir, 'b.css', text('one'), new Date(Date.now() - 7200 * 1000));
  assert.equal((await get(base, '/b.css', GZ)).plain.toString(), text('one'));
  assert.equal(calls.length, 1);

  write(dir, 'b.css', text('two', 500));
  const bigger = await get(base, '/b.css', GZ);
  assert.equal(bigger.plain.toString(), text('two', 500), 'новый размер — новое содержимое');
  assert.equal(calls.length, 2);

  const same = text('xyz', 500);
  assert.equal(same.length, text('two', 500).length, 'та же длина');
  write(dir, 'b.css', same, new Date(Date.now() - 3600 * 1000));
  const touched = await get(base, '/b.css', GZ);
  assert.equal(touched.plain.toString(), same, 'тот же размер, другое время — новое содержимое');
  assert.equal(calls.length, 3);
  await get(base, '/b.css', GZ);
  assert.equal(calls.length, 3, 'и новое снова из памяти');
});

test('клиент без gzip получает несжатое и целое; zlib не нужен', async (t) => {
  const { dir, calls, base } = await stand(t);
  const content = text('c');
  write(dir, 'c.js', content);
  await get(base, '/c.js', GZ);
  const plain = await get(base, '/c.js', {});
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), content);
  assert.equal(plain.headers['content-length'], String(Buffer.byteLength(content)));
  assert.equal(calls.length, 1);
});

test('ответы API в память не попадают: каждый сжимается заново', async (t) => {
  const { calls, base } = await stand(t);
  const one = await get(base, '/api/echo', GZ, 'POST');
  const two = await get(base, '/api/echo', GZ, 'POST');
  assert.equal(one.headers['content-encoding'], 'gzip');
  assert.equal(two.headers['content-encoding'], 'gzip');
  assert.equal(calls.length, 2);
});

test('304, HEAD и Range — как без памяти', async (t) => {
  const { dir, calls, base } = await stand(t);
  const content = text('d');
  write(dir, 'd.js', content);
  const first = await get(base, '/d.js', GZ);
  await get(base, '/d.js', GZ);   // теперь в памяти
  const n = calls.length;

  const notModified = await get(base, '/d.js', { ...GZ, 'If-None-Match': first.headers.etag });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.body.length, 0);
  assert.equal(notModified.headers['content-encoding'], undefined);

  const head = await get(base, '/d.js', GZ, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-encoding'], undefined, 'HEAD — заголовки исходного файла, как прежде');

  const part = await get(base, '/d.js', { ...GZ, Range: 'bytes=0-1499' });
  assert.equal(part.status, 206, 'диапазон — не целый файл из памяти');
  assert.equal(part.plain.toString(), content.slice(0, 1500));
  assert.equal(calls.length, n + 1, 'кусок не взят из памяти и не положен в неё');
  const whole = await get(base, '/d.js', GZ);
  assert.equal(whole.plain.toString(), content, 'целый файл после диапазона — целый');
  assert.equal(calls.length, n + 1);
});

test('память ограничена: старое вытесняется, вытесненное сжимается снова', async (t) => {
  const { dir, calls, base } = await stand(t, { staticCacheBytes: 3000 });
  write(dir, 'e1.js', text('e1'));
  write(dir, 'e2.js', text('e2'));
  const a = await get(base, '/e1.js', GZ);
  assert.ok(a.body.length > 1500 && a.body.length < 3000, 'сжатый файл больше половины предела: ' + a.body.length);
  await get(base, '/e2.js', GZ);   // вытесняет e1
  assert.equal(calls.length, 2);
  await get(base, '/e2.js', GZ);
  assert.equal(calls.length, 2, 'e2 — в памяти');
  const again = await get(base, '/e1.js', GZ);
  assert.equal(calls.length, 3, 'e1 вытеснен — сжат снова');
  assert.equal(again.plain.toString(), text('e1'));
});

test('настоящее приложение: файл клиента второй раз — из памяти, с теми же заголовками (CSP, ETag, Cache-Control)', async (t) => {
  const db = openDb(':memory:');
  migrate(db);
  const server = await listen(createApp(db, { dataDir: licensedDataDir(), live: { enabled: false } }));
  server.unref();
  t.after(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const realGzip = zlib.gzip;
  let calls = 0;
  zlib.gzip = function (...a) { calls++; return realGzip.apply(this, a); };
  try {
    const first = await get(base, '/css/admin.css', GZ);
    assert.equal(first.status, 200);
    assert.equal(first.headers['content-encoding'], 'gzip');
    assert.equal(calls, 1);
    const second = await get(base, '/css/admin.css', GZ);
    assert.equal(calls, 1, 'второй раз — без zlib');
    assert.deepEqual(withoutDate(second.headers), withoutDate(first.headers));
    assert.ok(second.headers['content-security-policy'], 'CSP на месте');
    assert.ok(second.plain.equals(fs.readFileSync('public/css/admin.css')), 'байты — файла на диске');
  } finally {
    zlib.gzip = realGzip;
  }
});
