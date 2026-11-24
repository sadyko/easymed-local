// LOCAL_SPEED_V1 (2026-11-24) — АДРЕСА С НОМЕРОМ СБОРКИ: /v/<сборка>/… и страницы,
// которые на них ссылаются.
//
// Две половины одного правила (номер сборки — services/build-id.js):
//
//   1. versionedStatic — GET /v/<сборка>/<файл> отдаёт тот же файл из public/, что
//      и /<файл>. Сборка текущая — «храни год, не переспрашивай» (immutable).
//      Любая другая (вкладка, открытая до обновления, делает ленивый import()) —
//      ТЕКУЩИЙ файл с no-cache: не 404 (вкладка должна работать, как сегодня) и
//      не «навсегда» (под чужим номером новое содержимое запоминать нельзя).
//
//   2. versionedPages — admin.html, index.html, users.html отдаются с переписанными
//      ссылками на свой код и стиль: src="js/…", href="css/…", favicon.svg →
//      /v/<сборка>/…, старый хвост ?v=… отбрасывается. Сама страница остаётся
//      no-cache с ETag: после обновления браузер переспросит её, получит новую и
//      с ней — новые адреса. Всё внутри модулей относительное и наследует
//      /v/<сборка>/ само (в том числе шрифты печати через import.meta.url).
//
// Файлы на диске не меняются — переписывается только ответ; старые адреса
// /js/…, /css/… работают как прежде (no-cache).

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isBuildFile } from '../services/build-id.js';

export const IMMUTABLE = 'public, max-age=31536000, immutable';
const HTML = /\.html?$/i;
const BUILD = Symbol('LOCAL_SPEED_V1.build');

const relOf = (root, filePath) => path.relative(root, filePath).split(path.sep).join('/');

/**
 * Обработчик для app.use('/v/:build', …).
 *   root      — папка public/;
 *   build     — () => { id, files } (считается при первом обращении);
 *   immutable — false: те же адреса, но no-cache (EASYMED_STATIC_IMMUTABLE=0);
 *   mark      — markStaticFile из compress.js: сжатый файл хранится в памяти.
 */
export function versionedStatic({ root, build, immutable = true, mark }) {
  const serve = express.static(root, {
    index: false,      // /v/<сборка>/ — не страница
    redirect: false,
    setHeaders: (res, filePath, stat) => {
      const b = build();
      // «Навсегда» — только текущей сборке и только файлу, вошедшему в её
      // отпечаток и с тех пор не тронутому; страницы — никогда.
      const forever = immutable && res[BUILD] === b.id && !HTML.test(filePath)
        && isBuildFile(b, relOf(root, filePath), stat);
      res.setHeader('Cache-Control', forever ? IMMUTABLE : 'no-cache');
      if (mark) mark(res, filePath, stat);
    },
  });
  return function versionedStaticMiddleware(req, res, next) {
    // Страницы под /v/ не нужны: их относительные ссылки (с ?v=…) дали бы тем же
    // модулям второй адрес, а два адреса — два экземпляра модуля.
    if (HTML.test(req.path)) return next();
    res[BUILD] = String(req.params.build || '');
    serve(req, res, next);
  };
}

/**
 * Переписать ссылки страницы на код и стиль: значение src/href, указывающее на
 * файл из отпечатка сборки, становится /v/<id>/<путь> без строки запроса.
 * Адреса со схемой (http:, https:, data:, blob:…), «//хост», якоря и всё, чего в
 * отпечатке нет (manifest.json, png, другие страницы), остаются как были.
 */
export function rewritePage(html, build) {
  return String(html).replace(/\b(src|href)=(["'])([^"'<>]*)\2/gi, (whole, attr, q, value) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return whole;
    let p = value.replace(/[?#].*$/, '');
    if (p.startsWith('./')) p = p.slice(2);
    else if (p.startsWith('/')) p = p.slice(1);   // страницы лежат в корне: «/js/x» и «js/x» — один файл
    // LOCAL_SPEED_V1 (ревью) — файл, не прочитанный при старте (антивирус), в
    // build.files есть (с меткой, build-id.js): его ссылка тоже уходит под
    // /v/<id>/ — иначе у общих модулей было бы два адреса и два экземпляра.
    if (!build.files.has(p)) return whole;
    return `${attr}=${q}/v/${build.id}/${p}${q}`;
  });
}

// Адрес → файл. Те же адреса, что давал express.static с extensions:['html'].
const PAGES = new Map([
  ['/', 'index.html'], ['/index', 'index.html'], ['/index.html', 'index.html'],
  ['/admin', 'admin.html'], ['/admin.html', 'admin.html'],
  ['/users', 'users.html'], ['/users.html', 'users.html'],
]);

/**
 * Три страницы с переписанными ссылками. Готовая страница хранится в памяти по
 * (время файла, размер, номер сборки); файла нет — запрос идёт дальше, к статике.
 */
export function versionedPages({ root, build, mark }) {
  const cache = new Map();   // имя файла → { key, body, etag }
  return function versionedPagesMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const name = PAGES.get(String(req.path).toLowerCase());
    if (!name) return next();
    const file = path.join(root, name);
    let stat;
    try { stat = fs.statSync(file); } catch { return next(); }
    if (!stat.isFile()) return next();
    const b = build();
    const key = stat.mtimeMs + '\0' + stat.size + '\0' + b.id;
    let page = cache.get(name);
    if (!page || page.key !== key) {
      let html;
      try { html = fs.readFileSync(file, 'utf8'); } catch { return next(); }
      const body = Buffer.from(rewritePage(html, b), 'utf8');
      // ETag — от готовых байтов: меняется и с файлом, и с номером сборки (он в ссылках).
      // Слабый: тот же ответ уходит и сжатым, и как есть.
      page = { key, body, etag: 'W/"' + createHash('sha1').update(body).digest('hex').slice(0, 20) + '"' };
      cache.set(name, page);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', page.etag);
    // Сжатая страница — тоже из памяти: «файл» здесь — страница этой сборки.
    if (mark) mark(res, file + '\0v\0' + b.id, { mtimeMs: stat.mtimeMs, size: page.body.length });
    res.send(page.body);   // 304 на If-None-Match и пустое тело на HEAD — дело res.send
  };
}
