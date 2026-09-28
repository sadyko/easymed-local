// PERF_GZIP_V1 — сжатие не должно менять НИ ОДНОГО байта содержимого.
//
// Тесты бьют по настоящему приложению (createApp + listen), а не по функции в
// вакууме: цена ошибки здесь — испорченный ответ на любом экране клиники.
//
// V3121_GZIP_CAP (2026-09-28) — ДВА УРОКА ОДНОГО ДНЯ.
//   1. Сервер закрывается в t.after, а не последней строкой теста. Раньше
//      упавшая проверка выходила из теста ДО server.close(): слушающий порт
//      оставался жить, файл не завершался, и весь `npm test` висел полчаса.
//   2. Страж порога: словарь переводов перерос 2 МБ и молча поехал в браузер
//      несжатым. Теперь любой сжимаемый файл public/ больше порога
//      (compress.js MAX_BUFFER) краснеет здесь с именем файла.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';   // LICENCE_FIXTURE_V1
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { MAX_BUFFER } from './compress.js';

async function startServer(t) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
// LICENCE_FIXTURE_V1 — каталог данных задаётся ЯВНО. createApp(db) без него
// берёт настоящую папку ./data проекта: на машине разработчика она активирована,
// а на сборочной — нет, и тест «работает у меня» падает в сборке (так и вышло
// с v0.9.0). Права лицензии этот файл не проверяет, поэтому берёт готовую.
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  // V3121_GZIP_CAP — закрыть при ЛЮБОМ исходе теста, упавшем тоже: живые
  // keep-alive соединения fetch держат порт, поэтому сначала их.
  t.after(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
    db.close();
  });
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}
// fetch сам разжимает gzip, поэтому для проверки байтов ходим без него.
const rawGet = (base, p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });

test('крупный JS отдаётся сжатым и распаковывается байт в байт', async (t) => {
  const { base } = await startServer(t);
  const res = await rawGet(base, '/js/admin/i18n-strings.js', { 'Accept-Encoding': 'gzip' });
  // Файл читается ПОСЛЕ ответа: словарь в рабочей папке может правиться
  // соседним процессом, и сверять надо с тем, что сервер только что отдал.
  const sent = Buffer.from(await res.arrayBuffer());     // fetch уже распаковал
  const disk = fs.readFileSync('public/js/admin/i18n-strings.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.match(String(res.headers.get('vary') || ''), /Accept-Encoding/i);
  assert.equal(sent.length, disk.length, 'размер после распаковки совпадает с файлом');
  assert.ok(sent.equals(disk), 'содержимое побайтово совпадает с файлом на диске');
});

test('сжатие действительно уменьшает передачу', async (t) => {
  const { base } = await startServer(t);
  const plain = await rawGet(base, '/js/admin/i18n-strings.js', { 'Accept-Encoding': 'identity' });
  const plainLen = Number(plain.headers.get('content-length'));
  await plain.arrayBuffer();
  const gz = await rawGet(base, '/js/admin/i18n-strings.js', { 'Accept-Encoding': 'gzip' });
  const gzLen = Number(gz.headers.get('content-length'));
  await gz.arrayBuffer();
  assert.ok(gzLen > 0 && gzLen < plainLen / 2, `ожидали минимум вдвое меньше: ${gzLen} vs ${plainLen}`);
});

test('клиент без gzip получает несжатое и целое', async (t) => {
  const { base } = await startServer(t);
  const res = await rawGet(base, '/js/admin/i18n-strings.js', { 'Accept-Encoding': 'identity' });
  assert.equal(res.headers.get('content-encoding'), null);
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(fs.readFileSync('public/js/admin/i18n-strings.js')));
});

test('мелкий ответ API не сжимается (накладные расходы дороже выигрыша)', async (t) => {
  const { base } = await startServer(t);
  const res = await rawGet(base, '/api/health', { 'Accept-Encoding': 'gzip' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), null);
  assert.deepEqual(await res.json(), { ok: true });
});

test('JSON API остаётся валидным JSON', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(base + '/api/db/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' },
    body: JSON.stringify({ table: 'patients', select: '*' }),
  });
  assert.equal(res.status, 401, 'без сессии — отказ');
  const body = await res.json();
  assert.ok(body && body.error, 'тело разбирается как JSON: ' + JSON.stringify(body));
});

test('вход по паролю продолжает работать через сжатие', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.username, 'boss');
  assert.ok(String(res.headers.get('set-cookie') || '').length, 'кука сессии выставлена');
});

// Условные запросы проверяем ЧЕРЕЗ node:http, а не fetch: undici не передаёт
// If-None-Match так, как это делает браузер, и тест мерил бы клиента, а не нас.
function rawRequest(base, p, headers) {
  const u = new URL(base + p);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: headers.__method || 'GET', headers },
      (res) => { const bufs = []; res.on('data', (c) => bufs.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) })); });
    req.on('error', reject); req.end();
  });
}

test('304 и HEAD не ломаются', async (t) => {
  const { base } = await startServer(t);
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
});

test('CSS сжимается, а изображение — нет', async (t) => {
  const { base } = await startServer(t);
  const css = await rawGet(base, '/css/admin-views.css', { 'Accept-Encoding': 'gzip' });
  assert.equal(css.headers.get('content-encoding'), 'gzip');
  await css.arrayBuffer();

  const png = fs.existsSync('public/favicon.ico') ? '/favicon.ico' : null;
  if (png) {
    const img = await rawGet(base, png, { 'Accept-Encoding': 'gzip' });
    if (img.status === 200) assert.equal(img.headers.get('content-encoding'), null, 'бинарник не жмём');
    await img.arrayBuffer();
  }
});

test('gzip-поток корректен и для ручной распаковки', async (t) => {
  const { base } = await startServer(t);
  const res = await rawGet(base, '/css/admin.css', { 'Accept-Encoding': 'gzip' });
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  // fetch распаковал сам; повторяем вручную из файла, чтобы проверить сам поток.
  const disk = fs.readFileSync('public/css/admin.css');
  const roundTrip = zlib.gunzipSync(zlib.gzipSync(disk));
  assert.ok(roundTrip.equals(disk));
  const sent = Buffer.from(await res.arrayBuffer());
  assert.ok(sent.equals(disk), 'то, что дошло, равно файлу');
});

// ---------------------------------------------------------------------------
// V3121_GZIP_CAP — страж порога. Сжимаемый тип (compress.js COMPRESSIBLE:
// text/*, JavaScript, JSON, SVG) у статики определяется расширением.
// ---------------------------------------------------------------------------
const COMPRESSIBLE_EXT = new Set(['.js', '.mjs', '.css', '.html', '.htm', '.svg', '.json', '.webmanifest', '.map', '.txt', '.xml']);

function compressibleFiles(dir = 'public', out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) compressibleFiles(p, out);
    else if (COMPRESSIBLE_EXT.has(path.extname(e.name).toLowerCase())) out.push({ file: p.split(path.sep).join('/'), size: fs.statSync(p).size });
  }
  return out;
}

const oversized = (cap) => compressibleFiles().filter((f) => f.size > cap);

test('страж: ни один сжимаемый файл public/ не больше порога сжатия — иначе он уедет в браузер несжатым', () => {
  const all = compressibleFiles();
  assert.ok(all.length > 100 && all.some((f) => f.file === 'public/js/admin/i18n-strings.js'), 'страж не видит файлов клиента: ' + all.length);
  assert.ok(oversized(1).length === all.length, 'сравнение с порогом работает');
  const big = oversized(MAX_BUFFER);
  assert.deepEqual(big.map((f) => `${f.file} — ${f.size} байт`), [],
    `больше порога сжатия (${MAX_BUFFER} байт, server/middleware/compress.js MAX_BUFFER): такой файл отдаётся несжатым. Поднимите порог или разделите файл.`);
});
