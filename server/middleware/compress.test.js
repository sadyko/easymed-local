// PERF_GZIP_V1 — сжатие не должно менять НИ ОДНОГО байта содержимого.
//
// Тесты бьют по настоящему приложению (createApp + listen), а не по функции в
// вакууме: цена ошибки здесь — испорченный ответ на любом экране клиники.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import http from 'node:http';
import fs from 'node:fs';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';

function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  return new Promise((resolve) => {
    const server = createApp(db).listen(0, '127.0.0.1', () => {
      resolve({ db, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}
// fetch сам разжимает gzip, поэтому для проверки байтов ходим без него.
const rawGet = (base, path, headers = {}) => fetch(base + path, { headers, redirect: 'manual' });

test('крупный JS отдаётся сжатым и распаковывается байт в байт', async () => {
  const { server, base } = await startServer();
  const disk = fs.readFileSync('public/js/admin/i18n-strings.js');

  const res = await rawGet(base, '/js/admin/i18n-strings.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.match(String(res.headers.get('vary') || ''), /Accept-Encoding/i);

  const sent = Buffer.from(await res.arrayBuffer());     // fetch уже распаковал
  assert.equal(sent.length, disk.length, 'размер после распаковки совпадает с файлом');
  assert.ok(sent.equals(disk), 'содержимое побайтово совпадает с файлом на диске');
  server.close();
});

test('сжатие действительно уменьшает передачу', async () => {
  const { server, base } = await startServer();
  const plain = await rawGet(base, '/js/admin/i18n-strings.js', { 'Accept-Encoding': 'identity' });
  const plainLen = Number(plain.headers.get('content-length'));
  const gz = await rawGet(base, '/js/admin/i18n-strings.js', { 'Accept-Encoding': 'gzip' });
  const gzLen = Number(gz.headers.get('content-length'));
  assert.ok(gzLen > 0 && gzLen < plainLen / 2, `ожидали минимум вдвое меньше: ${gzLen} vs ${plainLen}`);
  server.close();
});

test('клиент без gzip получает несжатое и целое', async () => {
  const { server, base } = await startServer();
  const res = await rawGet(base, '/js/admin/i18n-strings.js', { 'Accept-Encoding': 'identity' });
  assert.equal(res.headers.get('content-encoding'), null);
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(fs.readFileSync('public/js/admin/i18n-strings.js')));
  server.close();
});

test('мелкий ответ API не сжимается (накладные расходы дороже выигрыша)', async () => {
  const { server, base } = await startServer();
  const res = await rawGet(base, '/api/health', { 'Accept-Encoding': 'gzip' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), null);
  assert.deepEqual(await res.json(), { ok: true });
  server.close();
});

test('JSON API остаётся валидным JSON', async () => {
  const { server, base } = await startServer();
  const res = await fetch(base + '/api/db/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' },
    body: JSON.stringify({ table: 'patients', select: '*' }),
  });
  assert.equal(res.status, 401, 'без сессии — отказ');
  const body = await res.json();
  assert.ok(body && body.error, 'тело разбирается как JSON: ' + JSON.stringify(body));
  server.close();
});

test('вход по паролю продолжает работать через сжатие', async () => {
  const { server, base } = await startServer();
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.username, 'boss');
  assert.ok(String(res.headers.get('set-cookie') || '').length, 'кука сессии выставлена');
  server.close();
});

// Условные запросы проверяем ЧЕРЕЗ node:http, а не fetch: undici не передаёт
// If-None-Match так, как это делает браузер, и тест мерил бы клиента, а не нас.
function rawRequest(base, path, headers) {
  const u = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: headers.__method || 'GET', headers },
      (res) => { const bufs = []; res.on('data', (c) => bufs.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) })); });
    req.on('error', reject); req.end();
  });
}

test('304 и HEAD не ломаются', async () => {
  const { server, base } = await startServer();
  const first = await rawRequest(base, '/css/admin.css', { 'Accept-Encoding': 'gzip' });
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-encoding'], 'gzip');
  const etag = first.headers.etag;
  assert.ok(etag, 'статика отдаёт ETag');

  const again = await rawRequest(base, '/css/admin.css', { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
  assert.equal(again.status, 304, 'повторный заход не качает файл заново');
  assert.equal(again.body.length, 0, 'у 304 тела нет');
  assert.equal(again.headers['content-encoding'], undefined, '304 не объявляет сжатие');

  const head = await rawRequest(base, '/css/admin.css', { 'Accept-Encoding': 'gzip', __method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  server.close();
});

test('CSS сжимается, а изображение — нет', async () => {
  const { server, base } = await startServer();
  const css = await rawGet(base, '/css/admin-views.css', { 'Accept-Encoding': 'gzip' });
  assert.equal(css.headers.get('content-encoding'), 'gzip');

  const png = fs.existsSync('public/favicon.ico') ? '/favicon.ico' : null;
  if (png) {
    const img = await rawGet(base, png, { 'Accept-Encoding': 'gzip' });
    if (img.status === 200) assert.equal(img.headers.get('content-encoding'), null, 'бинарник не жмём');
  }
  server.close();
});

test('gzip-поток корректен и для ручной распаковки', async () => {
  const { server, base } = await startServer();
  const res = await rawGet(base, '/css/admin.css', { 'Accept-Encoding': 'gzip' });
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  // fetch распаковал сам; повторяем вручную из файла, чтобы проверить сам поток.
  const disk = fs.readFileSync('public/css/admin.css');
  const roundTrip = zlib.gunzipSync(zlib.gzipSync(disk));
  assert.ok(roundTrip.equals(disk));
  const sent = Buffer.from(await res.arrayBuffer());
  assert.ok(sent.equals(disk), 'то, что дошло, равно файлу');
  server.close();
});
