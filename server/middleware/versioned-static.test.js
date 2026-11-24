// LOCAL_SPEED_V1 (ревью) — файл, который при старте не удалось прочитать.
//
// Антивирус клиники может держать файл в момент подсчёта номера сборки
// (EBUSY/EPERM). Раньше такой файл молча выпадал из сборки: страница оставляла
// его ссылку как была (src="js/admin.js?v=…"), рядом с /v/<номер>/… у остальных, и
// общие модули грузились по двум адресам — в двух экземплярах. Теперь он остаётся
// в сборке с меткой: страница переписана целиком, а сам файл под /v/<номер>/
// отдаётся с no-cache (не «навсегда» — его содержимого в номере нет).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { computeBuild } from '../services/build-id.js';
import { versionedStatic, versionedPages, rewritePage, IMMUTABLE } from './versioned-static.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const PAGE = `<!doctype html>
<html lang="ru"><head>
<link rel="icon" type="image/svg+xml" href="favicon.svg?v=blue1">
<link rel="stylesheet" href="css/app.css?v=topnav1">
</head><body>
<script type="module" src="js/admin.js?v=topnav1"></script>
<script type="module" src="js/shared.js?v=topnav1"></script>
</body></html>
`;

const FILES = {
  'admin.html': PAGE,
  'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'js/admin.js': "import './shared.js';\nexport const a = 1;\n",
  'js/shared.js': 'export const shared = {};\n',
  'css/app.css': 'body { margin: 0; }\n',
};

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-vstatic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(FILES)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

/** Сборка, при подсчёте которой js/admin.js был занят (все попытки — EBUSY). */
function buildWithBusyAdmin(root, warned = []) {
  const readFile = (abs, ...rest) => {
    if (abs.split(path.sep).join('/').endsWith('/js/admin.js')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return fs.readFileSync(abs, ...rest);
  };
  return computeBuild(root, { readFile, warn: (l) => warned.push(String(l)), pause: () => {} });
}

async function stand(t, root, build) {
  const app = express();
  app.use(versionedPages({ root, build: () => build }));
  app.use('/v/:build', versionedStatic({ root, build: () => build }));
  app.use(express.static(root));
  const server = await listen(app);
  server.unref();
  t.after(() => { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('LOCAL_SPEED_V1 (ревью): нечитаемый при старте файл — страница всё равно переписана целиком', async (t) => {
  const root = tree(t);
  const warned = [];
  const build = buildWithBusyAdmin(root, warned);
  assert.equal(warned.length, 1, 'одна строка в журнале');

  const html = rewritePage(PAGE, build);
  assert.ok(html.includes(`src="/v/${build.id}/js/admin.js"`), html);
  assert.ok(html.includes(`src="/v/${build.id}/js/shared.js"`), html);
  assert.ok(html.includes(`href="/v/${build.id}/css/app.css"`), html);
  assert.doesNotMatch(html, /(?:src|href)="(?:js|css)\//, 'ни одной ссылки на код мимо /v/<номер>/: ' + html);
  assert.doesNotMatch(html, /\?v=/, 'хвостов ?v= не осталось');

  const base = await stand(t, root, build);
  const page = await fetch(base + '/admin.html');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), html, 'сервер отдаёт именно её');
});

test('LOCAL_SPEED_V1 (ревью): такой файл под /v/<номер>/ — 200 и no-cache, остальные — «навсегда»', async (t) => {
  const root = tree(t);
  const build = buildWithBusyAdmin(root);
  const base = await stand(t, root, build);

  const busy = await fetch(`${base}/v/${build.id}/js/admin.js`);
  assert.equal(busy.status, 200);
  assert.equal(busy.headers.get('cache-control'), 'no-cache', 'его содержимого в номере нет — «навсегда» нельзя');
  assert.equal(await busy.text(), FILES['js/admin.js'], 'к запросу файл уже читается — отдаётся как есть');

  for (const rel of ['js/shared.js', 'css/app.css', 'favicon.svg']) {
    const r = await fetch(`${base}/v/${build.id}/${rel}`);
    assert.equal(r.status, 200, rel);
    assert.equal(r.headers.get('cache-control'), IMMUTABLE, rel);
    await r.arrayBuffer();
  }
});
