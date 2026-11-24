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

// LOCAL_SPEED_V1 (ревью) — ФАЙЛ, КОТОРЫЙ НЕ ПРОЧИТАТЬ ПРИ СТАРТЕ. Антивирус клиники
// может держать файл в момент подсчёта (EBUSY/EPERM). Молча пропустить его нельзя:
// страница оставила бы его ссылку без /v/<номер>/ (src="js/admin.js?v=…") рядом с
// /v/<номер>/… у остальных, и общие модули загрузились бы по двум адресам — в двух
// экземплярах. Поэтому: несколько попыток с короткой паузой, а если не вышло —
// файл остаётся в сборке с меткой UNREAD. Время и размер у метки невозможные, так
// что isBuildFile для него всегда «нет»: под /v/<номер>/ он отдаётся с no-cache,
// «навсегда» — никогда (его содержимого в номере нет).
const UNREAD = Object.freeze({ mtimeMs: -1, size: -1 });
const READ_TRIES = 3;
const READ_PAUSE_MS = 60;        // перед 2-й попыткой; перед 3-й — вдвое больше
const PAUSE_BUDGET_MS = 1500;    // на весь подсчёт: недоступная целиком папка не задержит старт на минуты

/** Синхронная пауза: подсчёт идёт один раз при старте, до приёма запросов. */
function pauseSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* нет паузы — просто следующая попытка */ }
}

/**
 * Посчитать сборку папки: { id, files }.
 * id — 10 hex; files — Map «путь → { mtimeMs, size }» на момент подсчёта
 * (нечитаемый файл — { mtimeMs: -1, size: -1 }, см. выше).
 * Второй аргумент — для тестов: readFile/statFile (чтение), pause (пауза между
 * попытками), warn (строка в журнал).
 */
export function computeBuild(root, {
  readFile = fs.readFileSync,
  statFile = fs.statSync,
  pause = pauseSync,
  warn = (line) => console.warn(line),
} = {}) {
  const hash = createHash('sha1');
  const files = new Map();
  let budget = PAUSE_BUDGET_MS;
  for (const rel of buildFiles(root)) {
    const abs = path.join(root, rel);
    let body = null, stat = null, gone = false;
    for (let attempt = 1; attempt <= READ_TRIES; attempt++) {
      try { body = readFile(abs); stat = statFile(abs); break; }
      catch (e) {
        body = null; stat = null;
        // Файла уже нет (удалён между обходом и чтением) — ждать нечего, в сборке его нет.
        if (e && e.code === 'ENOENT') { gone = true; break; }
        const wait = READ_PAUSE_MS * attempt;
        if (attempt < READ_TRIES && budget >= wait) { budget -= wait; pause(wait); }
        else if (attempt < READ_TRIES) continue;   // время на паузы вышло — попытки без ожидания
      }
    }
    if (gone) continue;
    if (!body || !stat) {
      // LOCAL_SPEED_V1 (ревью) — путь и метка вместо длины и содержимого: номер
      // такой сборки не совпадёт с номером целой (у целой здесь стоит число).
      hash.update(rel + '\0unread\0');
      files.set(rel, UNREAD);
      // Только относительный путь: в тексте ошибки системы — полный путь папки.
      try { warn('[build] файл не прочитан при старте, отдаётся без долгого хранения: ' + rel); } catch { /* журнал — не повод не стартовать */ }
      continue;
    }
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
