// LOCAL_SPEED_V1 (2026-11-24) — НОМЕР СБОРКИ КЛИЕНТА: отпечаток содержимого public/.
//
// Экран — 381 ES-модуль и 3 css, и все они no-cache (NO_STALE_CODE_V1): каждое
// открытие страницы переспрашивает главный компьютер клиники про 385 файлов.
// Чтобы браузер держал код у себя до следующего обновления, страницы ссылаются
// на код по адресу /v/<номер сборки>/…, а такой адрес отдаётся «навсегда»
// (immutable). Обновление меняет хоть один файл — меняется номер — меняются
// адреса — браузер качает новое. Забыть «поднять версию» нельзя: её никто не
// поднимает руками.
//
// Номер — sha1 (10 hex) от СОДЕРЖИМОГО, а не от времени и размера: обновление,
// сохранившее и то и другое, обязано сменить номер. В отпечаток входят файлы,
// которые сервер отдаёт как код и стиль: js/, css/, fonts/ целиком и *.js, *.css,
// *.svg из корня public/. Тесты (*.test.js, *.test.mjs, __tests__) не входят: в
// поставку клинике они не едут (BUNDLE_EXCLUDES в scripts/build-bundle.mjs), и
// номер должен считаться одинаково на дереве разработчика и у клиники.
//
// Вместе с номером запоминаются время и размер каждого учтённого файла: адрес
// /v/<номер>/… получает «навсегда» только пока файл на диске — тот самый, что
// вошёл в отпечаток. Файл подменили при работающем сервере (правка разработчика,
// распаковка обновления до перезапуска) — он отдаётся с no-cache, и под старым
// номером новое содержимое в браузере не застрянет.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DIRS = ['js', 'css', 'fonts'];
const TOP_LEVEL = /\.(?:js|css|svg)$/i;
const TEST_FILE = /\.test\.m?js$/i;
const TEST_DIR = '__tests__';

/** Обход папки в порядке имён; только обычные файлы и папки (ссылки и стыки — мимо). */
function walk(root, rel, out) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const child = rel + '/' + e.name;
    if (e.isDirectory()) { if (e.name !== TEST_DIR) walk(root, child, out); }
    else if (e.isFile() && !TEST_FILE.test(e.name)) out.push(child);
  }
}

/** Пути (через «/», от корня public/) файлов, входящих в отпечаток, в порядке кодов символов. */
export function buildFiles(root) {
  const out = [];
  for (const dir of DIRS) walk(root, dir, out);
  let top = [];
  try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { /* папки нет — пустая сборка */ }
  for (const e of top) if (e.isFile() && TOP_LEVEL.test(e.name) && !TEST_FILE.test(e.name)) out.push(e.name);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Посчитать сборку папки: { id, files }.
 * id — 10 hex; files — Map «путь → { mtimeMs, size }» на момент подсчёта.
 */
export function computeBuild(root) {
  const hash = createHash('sha1');
  const files = new Map();
  for (const rel of buildFiles(root)) {
    const abs = path.join(root, rel);
    let body, stat;
    try { body = fs.readFileSync(abs); stat = fs.statSync(abs); } catch { continue; }
    // Путь, длина и содержимое — раздельно: два файла не склеятся в один и тот же поток байтов.
    hash.update(rel + '\0' + body.length + '\0');
    hash.update(body);
    files.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size });
  }
  return { id: hash.digest('hex').slice(0, 10), files };
}

// Один подсчёт на папку за жизнь процесса: ≈15 МБ читаются один раз при старте
// (обновление всегда перезапускает сервер).
const memo = new Map();

/** Сборка папки — посчитанная один раз на процесс. */
export function buildOf(root) {
  const key = path.resolve(root);
  let b = memo.get(key);
  if (!b) { b = computeBuild(key); memo.set(key, b); }
  return b;
}

/** Файл на диске — тот самый, что вошёл в отпечаток (по времени и размеру)? */
export function isBuildFile(build, rel, stat) {
  const f = build && build.files.get(rel);
  return !!(f && stat && f.size === stat.size && f.mtimeMs === stat.mtimeMs);
}

/** «Навсегда» включено? EASYMED_STATIC_IMMUTABLE=0 — те же адреса /v/, но no-cache (разработка). */
export function staticImmutable(env) {
  return String((env && env.EASYMED_STATIC_IMMUTABLE) ?? '').trim() !== '0';
}
