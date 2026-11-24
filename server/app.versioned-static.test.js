// LOCAL_SPEED_V1 (2026-11-24) — код хранится в браузере до следующего обновления.
//
// Адрес /v/<номер сборки>/… отдаётся «навсегда» (immutable), а страницы
// (admin.html, index.html, users.html) ссылаются на свой код именно так. Номер —
// отпечаток содержимого public/ (services/build-id.js): обновление меняет номер,
// страница (no-cache, ETag) приходит новой — и с ней новые адреса.
//
// Здесь — поведение сервера: что и с какими заголовками отдаётся по /v/, как
// переписана страница, что старые адреса /js/… живы, и страж: ни один модуль
// клиента не грузит код по абсолютному /js/… или /css/… (такой адрес минует
// /v/<номер>/ — а два адреса одного модуля это два его экземпляра).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { computeBuild, buildOf } from './services/build-id.js';
import { rewritePage } from './middleware/versioned-static.js';
import { licensedDataDir } from './services/control/licensed-fixture.js';
import { listen } from '../control-plane/server/test-helpers/listen.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(REPO, 'public');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const GZ = { 'Accept-Encoding': 'gzip' };

const CSS = '/* стиль */\n' + '.row { display: flex; gap: 8px; }\n'.repeat(80);   // больше килобайта — сжимается
const PAGE = (extra = '') => `<!doctype html>
<html lang="ru"><head>
<link rel="icon" type="image/svg+xml" href="favicon.svg?v=blue1">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon-192.png?v=blue1">
<link rel="stylesheet" href="css/app.css?v=topnav1">
<link rel="stylesheet" href="https://example.invalid/css/app.css?v=1">
</head><body>
<a href="users.html">Сотрудники</a> <a href="#top">Наверх</a>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">
<script type="module" src="js/app.js?v=topnav1"></script>
<script type="module" src="./js/admin/view.js"></script>
<script type="module" src="/js/abs.js?v=3"></script>
<script type="module" src="js/no-such.js?v=1"></script>
${extra}<!-- ${'страница больше килобайта — сжимается. '.repeat(30)} -->
</body></html>
`;

function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-public-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

const FILES = () => ({
  'index.html': PAGE(), 'admin.html': PAGE('<div id="app"></div>'), 'users.html': PAGE('<div id="users"></div>'),
  'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'manifest.json': '{}', 'icon-192.png': 'png',
  'js/app.js': "import './admin/view.js';\nexport const a = 1;\n",
  'js/abs.js': 'export const abs = 1;\n',
  'js/admin/view.js': 'export const b = 2;\n',
  'js/admin/view.test.js': '// тест — в поставку не едет\n',
  'css/app.css': CSS,
  'fonts/f.woff2': 'font-bytes',
  'secret.txt': 'вне отпечатка',
});

async function stand(t, { publicDir, env } = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env || {})) { saved[k] = process.env[k]; process.env[k] = v; }
  const db = openDb(':memory:');
  migrate(db);
  let server;
  try {
    server = await listen(createApp(db, { dataDir: licensedDataDir(), live: { enabled: false }, ...(publicDir ? { publicDir } : {}) }));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  server.unref();
  t.after(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
    db.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, db };
}

// node:http, а не fetch: путь уходит как написан (fetch сам свернул бы «..»), и
// условные заголовки шлются как у браузера.
function get(base, p, headers = {}, method = 'GET') {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: p, method, headers }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(bufs);
        const plain = res.headers['content-encoding'] === 'gzip' && raw.length ? zlib.gunzipSync(raw) : raw;
        resolve({ status: res.statusCode, headers: res.headers, raw, plain, text: plain.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const SECURITY = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy'];
const security = (headers) => Object.fromEntries(SECURITY.map((h) => [h, headers[h]]));

// ---------------------------------------------------------------------------
// /v/<сборка>/…
// ---------------------------------------------------------------------------

test('текущая сборка: /v/<номер>/… — immutable, с ETag и теми же байтами, что /…', async (t) => {
  const root = tree(t, FILES());
  const { id } = computeBuild(root);
  const { base } = await stand(t, { publicDir: root });
  for (const p of ['js/app.js', 'js/admin/view.js', 'css/app.css', 'fonts/f.woff2', 'favicon.svg']) {
    const v = await get(base, `/v/${id}/${p}`);
    const old = await get(base, '/' + p);
    assert.equal(v.status, 200, p);
    assert.equal(v.headers['cache-control'], IMMUTABLE, p);
    assert.ok(v.headers.etag, p + ': ETag');
    assert.equal(v.headers.etag, old.headers.etag, p + ': тот же ETag, что у старого адреса');
    assert.equal(v.headers['content-type'], old.headers['content-type'], p);
    assert.ok(v.raw.equals(old.raw) && v.raw.equals(fs.readFileSync(path.join(root, p))), p + ': те же байты');
    assert.deepEqual(security(v.headers), security(old.headers), p + ': заголовки безопасности те же');
    assert.ok(v.headers['content-security-policy'], 'CSP на месте');
    assert.equal(v.headers['x-content-type-options'], 'nosniff');
    assert.equal(v.headers['x-frame-options'], 'SAMEORIGIN');
  }
});

test('старые адреса /js/…, /css/… работают как прежде: no-cache, шрифт — 30 дней', async (t) => {
  const root = tree(t, FILES());
  const { base } = await stand(t, { publicDir: root });
  for (const p of ['/js/app.js', '/js/app.js?v=topnav1', '/css/app.css']) {
    const res = await get(base, p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers['cache-control'], 'no-cache', p);
  }
  assert.equal((await get(base, '/fonts/f.woff2')).headers['cache-control'], 'public, max-age=2592000');
});

test('другая сборка: текущий файл с no-cache — не 404 и не immutable', async (t) => {
  const root = tree(t, FILES());
  const { base } = await stand(t, { publicDir: root });
  for (const build of ['0000000000', 'old', 'ABCDEF1234']) {
    for (const p of ['js/app.js', 'css/app.css', 'fonts/f.woff2']) {
      const res = await get(base, `/v/${build}/${p}`);
      assert.equal(res.status, 200, build + ' ' + p);
      assert.equal(res.headers['cache-control'], 'no-cache', build + ' ' + p);
      assert.ok(res.raw.equals(fs.readFileSync(path.join(root, p))), build + ' ' + p + ': текущие байты');
    }
  }
});

test('условный запрос по /v/ отвечает 304 с тем же Cache-Control', async (t) => {
  const root = tree(t, FILES());
  const { id } = computeBuild(root);
  const { base } = await stand(t, { publicDir: root });
  const first = await get(base, `/v/${id}/js/app.js`);
  const again = await get(base, `/v/${id}/js/app.js`, { 'If-None-Match': first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.headers['cache-control'], IMMUTABLE);
});

test('нет файла — 404; выход из public/ невозможен; страницы и папки под /v/ не отдаются', async (t) => {
  const root = tree(t, FILES());
  fs.writeFileSync(path.join(path.dirname(root), path.basename(root) + '-outside.txt'), 'снаружи');
  t.after(() => fs.rmSync(path.join(path.dirname(root), path.basename(root) + '-outside.txt'), { force: true }));
  const { id } = computeBuild(root);
  const { base } = await stand(t, { publicDir: root });
  const outside = path.basename(root) + '-outside.txt';
  const paths = [
    `/v/${id}/js/no-such-file.js`,
    `/v/${id}/../${outside}`,
    `/v/${id}/%2e%2e/${outside}`,
    `/v/${id}/..%2f${outside}`,
    `/v/${id}/js/..%5c..%5c${outside}`,
    `/v/${id}/js/%2e%2e/%2e%2e/${outside}`,
    `/v/${id}/admin.html`, `/v/${id}/index.html`, `/v/${id}/admin`, `/v/${id}/`, `/v/${id}`, `/v/${id}/js`, `/v/${id}/js/`,
    '/v/', '/v',
  ];
  for (const p of paths) {
    const res = await get(base, p);
    assert.ok(res.status === 404 || res.status === 403 || res.status === 400, p + ' → ' + res.status);
    assert.equal(res.text.includes('снаружи'), false, p);
    assert.notEqual(res.headers['cache-control'], IMMUTABLE, p);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await get(base, `/v/${id}/js/app.js`, {}, method)).status, 404, method);
  }
});

test('«навсегда» получает только файл из отпечатка сборки, не тронутый с её подсчёта', async (t) => {
  const root = tree(t, FILES());
  const { base } = await stand(t, { publicDir: root });
  const { id } = buildOf(root);
  // Не код и не стиль (в отпечатке нет) и тест — отдаются, но не «навсегда».
  for (const p of ['secret.txt', 'manifest.json', 'icon-192.png', 'js/admin/view.test.js']) {
    const res = await get(base, `/v/${id}/${p}`);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers['cache-control'], 'no-cache', p);
  }
  // Файл подменили при работающем сервере (номер сборки ещё прежний).
  assert.equal((await get(base, `/v/${id}/js/abs.js`)).headers['cache-control'], IMMUTABLE);
  fs.writeFileSync(path.join(root, 'js', 'abs.js'), 'export const abs = 2; // новое содержимое\n');
  const changed = await get(base, `/v/${id}/js/abs.js`);
  assert.equal(changed.status, 200);
  assert.equal(changed.headers['cache-control'], 'no-cache', 'новое содержимое под старым номером не запоминается');
  assert.match(changed.text, /новое содержимое/);
});

test('EASYMED_STATIC_IMMUTABLE=0: те же адреса /v/, но no-cache', async (t) => {
  const root = tree(t, FILES());
  const { id } = computeBuild(root);
  const { base } = await stand(t, { publicDir: root, env: { EASYMED_STATIC_IMMUTABLE: '0' } });
  const res = await get(base, `/v/${id}/js/app.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.ok(res.headers.etag);
  const page = await get(base, '/admin.html');
  assert.ok(page.text.includes(`src="/v/${id}/js/app.js"`), 'страница по-прежнему ссылается на /v/');
});

// ---------------------------------------------------------------------------
// Страницы
// ---------------------------------------------------------------------------

test('три страницы ссылаются на свой код и стиль через /v/<номер>/, без ?v=', async (t) => {
  const root = tree(t, FILES());
  const { id } = computeBuild(root);
  const { base } = await stand(t, { publicDir: root });
  const addresses = {
    'index.html': ['/', '/index.html', '/index'],
    'admin.html': ['/admin.html', '/admin', '/admin.html?from=login', '/ADMIN.html'],
    'users.html': ['/users.html', '/users'],
  };
  const plain = await get(base, '/js/app.js');
  for (const [file, list] of Object.entries(addresses)) {
    const want = rewritePage(fs.readFileSync(path.join(root, file), 'utf8'), computeBuild(root));
    for (const p of list) {
      const res = await get(base, p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', p);
      assert.equal(res.headers['cache-control'], 'no-cache', p);
      assert.ok(res.headers.etag, p + ': ETag');
      assert.equal(res.text, want, p);
      assert.deepEqual(security(res.headers), security(plain.headers), p + ': заголовки безопасности — как у любого файла');
      const html = res.text;
      assert.ok(html.includes(`href="/v/${id}/favicon.svg"`), p + ': значок');
      assert.ok(html.includes(`href="/v/${id}/css/app.css"`), p + ': стиль');
      assert.ok(html.includes(`src="/v/${id}/js/app.js"`), p + ': скрипт');
      assert.ok(html.includes(`src="/v/${id}/js/admin/view.js"`), p + ': «./js/…»');
      assert.ok(html.includes(`src="/v/${id}/js/abs.js"`), p + ': «/js/…»');
      // Не свой код — как было.
      assert.ok(html.includes('href="/manifest.json"'), p + ': манифест');
      assert.ok(html.includes('href="/icon-192.png?v=blue1"'), p + ': png');
      assert.ok(html.includes('href="https://example.invalid/css/app.css?v=1"'), p + ': чужой адрес');
      assert.ok(html.includes('src="data:image/gif;base64,R0lGODlhAQABAAAAACw="'), p + ': data:');
      assert.ok(html.includes('href="users.html"') && html.includes('href="#top"'), p + ': ссылки на страницы и якоря');
      assert.ok(html.includes('src="js/no-such.js?v=1"'), p + ': файла нет — не трогаем');
      // Ни одной ссылки на свой код мимо /v/ и ни одного ?v= у переписанных.
      const own = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]).filter((u) => /\.(?:js|css|svg)(?:\?|$)/.test(u));
      for (const u of own) {
        if (u.startsWith('https://') || u.includes('no-such')) continue;
        assert.ok(u.startsWith(`/v/${id}/`), p + ': мимо /v/ — ' + u);
        assert.equal(u.includes('?'), false, p + ': хвост запроса — ' + u);
      }
    }
  }
});

test('каждая ссылка переписанной страницы отвечает 200 immutable', async (t) => {
  const root = tree(t, FILES());
  const { id } = computeBuild(root);
  const { base } = await stand(t, { publicDir: root });
  const html = (await get(base, '/admin.html')).text;
  const refs = [...html.matchAll(/\b(?:src|href)="(\/v\/[^"]*)"/g)].map((m) => m[1]);
  assert.equal(refs.length, 5);
  for (const u of refs) {
    const res = await get(base, u);
    assert.equal(res.status, 200, u);
    assert.equal(res.headers['cache-control'], IMMUTABLE, u);
    assert.ok(u.startsWith(`/v/${id}/`));
  }
});

test('страница: 304 на свой ETag, HEAD без тела, POST мимо', async (t) => {
  const root = tree(t, FILES());
  const { base } = await stand(t, { publicDir: root });
  const first = await get(base, '/admin.html');
  const again = await get(base, '/admin.html', { 'If-None-Match': first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.raw.length, 0);
  assert.equal(again.headers['cache-control'], 'no-cache');
  const head = await get(base, '/admin.html', {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.raw.length, 0);
  assert.equal(head.headers.etag, first.headers.etag);
  assert.equal((await get(base, '/admin.html', {}, 'POST')).status, 404);
  // ETag прежней отдачи (express.static: W/"размер-время") — уже не подходит: придёт новая страница.
  const stat = fs.statSync(path.join(root, 'admin.html'));
  const legacy = `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;
  const fromOld = await get(base, '/admin.html', { 'If-None-Match': legacy, 'If-Modified-Since': stat.mtime.toUTCString() });
  assert.equal(fromOld.status, 200, 'браузер со страницей до обновления получает новую');
});

test('ETag страницы меняется с номером сборки (тот же файл страницы) и с самим файлом', async (t) => {
  const a = tree(t, FILES());
  const b = tree(t, { ...FILES(), 'js/app.js': "import './admin/view.js';\nexport const a = 2;\n" });   // обновление: другой код той же длины
  const when = new Date('2026-11-01T10:00:00Z');
  for (const root of [a, b]) fs.utimesSync(path.join(root, 'admin.html'), when, when);
  assert.notEqual(computeBuild(a).id, computeBuild(b).id);
  const sa = await stand(t, { publicDir: a });
  const sb = await stand(t, { publicDir: b });
  const pa = await get(sa.base, '/admin.html');
  const pb = await get(sb.base, '/admin.html');
  assert.notEqual(pa.headers.etag, pb.headers.etag, 'страница та же, сборка другая — ETag другой');
  const revalidate = await get(sb.base, '/admin.html', { 'If-None-Match': pa.headers.etag });
  assert.equal(revalidate.status, 200, 'после обновления страница приходит заново');
  assert.ok(revalidate.text.includes(`/v/${computeBuild(b).id}/js/app.js`));

  // Сама страница изменилась (сборка та же) — новый ETag и новое содержимое.
  fs.writeFileSync(path.join(a, 'admin.html'), PAGE('<div id="app2"></div>'));
  const changed = await get(sa.base, '/admin.html', { 'If-None-Match': pa.headers.etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, pa.headers.etag);
  assert.ok(changed.text.includes('id="app2"'));
});

test('страницы нет в public/ — запрос идёт дальше (404), сервер не падает', async (t) => {
  const files = FILES();
  delete files['users.html'];
  const root = tree(t, files);
  const { base } = await stand(t, { publicDir: root });
  assert.equal((await get(base, '/users')).status, 404);
  assert.equal((await get(base, '/admin')).status, 200);
});

// ---------------------------------------------------------------------------
// Память сжатых файлов и «без сессии и лицензии»
// ---------------------------------------------------------------------------

test('сжатый файл по /v/ и сжатая страница второй раз уходят из памяти, без zlib', async (t) => {
  const root = tree(t, FILES());
  const { id } = computeBuild(root);
  const { base } = await stand(t, { publicDir: root });
  const realGzip = zlib.gzip;
  let calls = 0;
  zlib.gzip = function (...a) { calls++; return realGzip.apply(this, a); };
  try {
    for (const p of [`/v/${id}/css/app.css`, '/admin.html']) {
      calls = 0;
      const first = await get(base, p, GZ);
      assert.equal(first.status, 200, p);
      assert.equal(first.headers['content-encoding'], 'gzip', p);
      assert.equal(calls, 1, p + ': первый раз сжимается');
      const second = await get(base, p, GZ);
      assert.equal(calls, 1, p + ': второй раз — без zlib');
      assert.equal(second.headers['content-encoding'], 'gzip', p);
      assert.equal(second.headers['content-length'], first.headers['content-length'], p);
      assert.equal(second.headers.etag, first.headers.etag, p);
      assert.equal(second.headers['cache-control'], first.headers['cache-control'], p);
      assert.ok(second.plain.equals(first.plain), p + ': те же байты');
      const bare = await get(base, p);
      assert.equal(bare.headers['content-encoding'], undefined, p + ': клиенту без gzip — как есть');
      assert.ok(bare.raw.equals(first.plain), p);
    }
    // Тот же файл по старому адресу — та же запись памяти (ключ — файл на диске).
    calls = 0;
    await get(base, '/css/app.css', GZ);
    assert.equal(calls, 0, 'старый адрес берёт уже сжатое');
  } finally {
    zlib.gzip = realGzip;
  }
});

test('запрос /v/ и запрос страницы не трогают ни сессию, ни лицензию', async (t) => {
  const { base, db } = await stand(t);
  const { id } = buildOf(PUBLIC);
  const realPrepare = db.prepare.bind(db);
  let seen = [];
  db.prepare = (sql) => { seen.push(String(sql)); return realPrepare(sql); };
  const cookie = { Cookie: 'easymed_session=not-a-real-session; sid=x' };
  let etag = null;
  for (const [p, headers, status] of [
    [`/v/${id}/js/api.js`, cookie, 200],
    [`/v/${id}/js/api.js`, null, 304],
    ['/v/0000000000/js/api.js', cookie, 200],
    [`/v/${id}/js/no-such-file.js`, cookie, 404],
    ['/admin.html', cookie, 200], ['/admin', cookie, 200], ['/', cookie, 200], ['/users', cookie, 200],
  ]) {
    seen = [];
    const res = await get(base, p, headers || { ...cookie, 'If-None-Match': etag });
    assert.equal(res.status, status, p);
    if (status === 200 && !etag) etag = res.headers.etag;
    assert.equal(seen.some((s) => /\bsessions\b|\bcontrol_state\b/i.test(s)), false, p + ': ' + seen.join(' | '));
  }
});

// ---------------------------------------------------------------------------
// Настоящий клиент
// ---------------------------------------------------------------------------

test('настоящие страницы: весь свой код и стиль — через /v/<номер>/, каждая ссылка отвечает 200 immutable', async (t) => {
  const { base } = await stand(t);
  const { id } = buildOf(PUBLIC);
  for (const p of ['/admin.html', '/', '/users']) {
    const res = await get(base, p);
    assert.equal(res.status, 200, p);
    const html = res.text;
    const refs = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1]);
    const code = refs.filter((u) => /\.(?:m?js|css|svg)(?:[?#]|$)/.test(u));
    assert.ok(code.length >= 3, p + ': ссылки на код найдены');
    for (const u of code) {
      assert.ok(u.startsWith(`/v/${id}/`), p + ': мимо /v/ — ' + u);
      assert.equal(/[?#]/.test(u), false, p + ': хвост ?v= — ' + u);
      const file = await get(base, u, {}, 'HEAD');
      assert.equal(file.status, 200, u);
      assert.equal(file.headers['cache-control'], IMMUTABLE, u);
    }
    assert.equal(/\b(?:src|href)=["'](?:\.?\/)?(?:js|css)\//.test(html), false, p + ': осталась ссылка на /js/ или /css/ без номера');
  }
  const admin = (await get(base, '/admin.html')).text;
  assert.ok(admin.includes(`<script type="module" src="/v/${id}/js/admin.js"></script>`));
  assert.ok(admin.includes('href="/manifest.json"'), 'манифест — по прежнему адресу');
});

test('страж: ни один модуль клиента не грузит код по абсолютному /js/… или /css/…', () => {
  // Абсолютный адрес минует /v/<номер>/: файл не хранится в браузере, а модуль,
  // загруженный и так и так, существует в двух экземплярах (состояние расходится).
  // Строка, начинающаяся с /js/ или /css/, в коде клиента не нужна нигде: импорты
  // относительные, а окна печати берут стили строкой, не ссылкой.
  const ABSOLUTE = /(['"`])\/(?:js|css)\/[^'"`]*\1?/;
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(abs); continue; }
      if (!/\.m?js$/.test(e.name) || /\.test\.m?js$/.test(e.name)) continue;
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      if (lines.some((l) => l.length > 5000)) continue;   // собранный чужой бандл (vendor) — не наш код
      lines.forEach((line, i) => {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;   // комментарий
        if (ABSOLUTE.test(line)) offenders.push(path.relative(PUBLIC, abs).split(path.sep).join('/') + ':' + (i + 1));
      });
    }
  };
  walk(path.join(PUBLIC, 'js'));
  for (const top of fs.readdirSync(PUBLIC)) {
    if (!/\.m?js$/.test(top)) continue;
    fs.readFileSync(path.join(PUBLIC, top), 'utf8').split('\n').forEach((line, i) => {
      if (!/^\s*(?:\/\/|\*|\/\*)/.test(line) && ABSOLUTE.test(line)) offenders.push(top + ':' + (i + 1));
    });
  }
  assert.deepEqual(offenders, [], 'абсолютный адрес кода или стиля: ' + offenders.join(', '));
});
