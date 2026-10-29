// DISK_GUARD_V1 (docs/specs/2026-10-29-3181-cabinet-print-disk-design.md,
// раздел 3) — место на диске клиники: сколько свободно, сколько нужно копии
// базы и обновлению, и что было отказано из-за нехватки места.
//
// Владелец (2026-10-29): «после обновлений диск компьютера клиники не должен
// заполняться». Опасны полные копии базы: при базе 2 ГБ их могло лечь до
// ~74 ГБ, а копия, оборвавшаяся на полном диске, занимала остаток места.
//
// Без зависимостей, кроме fs и path: модуль зовут копии базы
// (services/backup.js, db/backup.js), обновление (control/updater.js) и связь
// с Easy-Med (control/checkin.js), и ни один из них не должен тянуть за собой
// чужую цепочку импортов.
import fs from 'node:fs';
import path from 'node:path';

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

// Запас сверх нужного: на этот же диск пишут SQLite, журнал программы и Windows.
export const RESERVE_BYTES = 1 * GB;
// Копия не больше самой базы с журналом; 20 % сверху — на рост во время копии.
export const COPY_FACTOR = 1.2;
// Предел копий по объёму (п. 5): копии занимают не больше 30 % диска, свободно
// не меньше 10 %.
export const COPIES_SHARE_MAX = 0.30;
export const FREE_SHARE_MIN = 0.10;
// Красное предупреждение на «Данных клиники» (п. 8): меньше 10 % или меньше 5 ГБ.
export const LOW_FREE_BYTES = 5 * GB;

// Ключ словаря public/js/admin/i18n-strings.js: экран переводит фразу целиком
// по шаблону (server-message.js), а не показывает её по-русски.
export const COPY_REFUSED_TEMPLATE = 'Недостаточно места на диске: нужно {need} ГБ, свободно {free} ГБ. Копия не сделана.';

const STATE_NAME = 'disk-guard.json';

/** Свободно и всего на томе, где лежит dir; null — платформа не ответила или папки нет. */
export function diskSpace(dir) {
  try {
    const s = fs.statfsSync(dir);
    const bsize = Number(s.bsize);
    const free = Number(s.bavail) * bsize;
    const total = Number(s.blocks) * bsize;
    if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return null;
    return { free, total };
  } catch {
    return null;
  }
}

let _testDiskSpace = null;
/**
 * Тесты подменяют ответ диска на весь файл: настоящий диск машины
 * разработчика — не данные теста (на 2026-10-29 там 0,9 % свободно, и
 * правило «меньше 10 %» стирало бы копии посреди чужих тестов). null —
 * вернуть настоящий диск. В рабочей программе не вызывается никогда.
 */
export function __setDiskSpaceForTests(fn) { _testDiskSpace = typeof fn === 'function' ? fn : null; }

/** Ответ, которым пользуется весь код: подмена теста, если есть, иначе настоящий диск. */
export function currentDiskSpace(dir) {
  return _testDiskSpace ? _testDiskSpace(dir) : diskSpace(dir);
}

/** Размер базы вместе с журналом (-wal); нет файла — 0. */
export function dbBytes(dbFile) {
  let n = 0;
  for (const f of [dbFile, dbFile + '-wal']) {
    try { n += fs.statSync(f).size; } catch { /* нет файла — нет и байт */ }
  }
  return n;
}

/** Сколько нужно свободного места на копию (п. 2): база × 1,2 + 1 ГБ. */
export const copyNeedBytes = (db) => Math.ceil(db * COPY_FACTOR) + RESERVE_BYTES;

/**
 * Гигабайты с одним знаком после запятой — числом. «Нужно» округляется
 * вверх, «свободно» — вниз: фраза «нужно 1,0 ГБ, свободно 1,0 ГБ» о
 * несделанной копии читалась бы как ошибка программы. Та же формула — у
 * экрана (public/js/admin/updates-logic.js gbValue).
 */
export function gbValue(bytes, { up = false } = {}) {
  const v = Math.max(0, Number(bytes) || 0) / GB;
  return (up ? Math.ceil(v * 10) : Math.floor(v * 10)) / 10;
}

/** То же — для русской фразы (журнал, русский экран): «2,1». */
export function gbText(bytes, opts) {
  return gbValue(bytes, opts).toFixed(1).replace('.', ',');
}

/**
 * Ошибка «нет места» — с шаблоном и значениями (server-message.js), чтобы экран
 * перевёл фразу целиком. message — готовая русская фраза (журнал, русский
 * экран); в params числа — ЧИСЛАМИ: десятичный знак ставит экран по своему
 * языку (public/js/admin/i18n.js — ru и uz запятая, en точка). Строка «2,1»
 * осталась бы с запятой и на английском экране.
 */
export function noSpaceError(need, free) {
  const params = { need: gbValue(need, { up: true }), free: gbValue(free) };
  const e = new Error(COPY_REFUSED_TEMPLATE.replace('{need}', gbText(need, { up: true })).replace('{free}', gbText(free)));
  e.code = 'no_space';
  e.need_bytes = need;
  e.free_bytes = free;
  e.template = COPY_REFUSED_TEMPLATE;
  e.params = params;
  return e;
}

/** Отметки об отказах из-за места (<dataDir>/disk-guard.json); нет файла или он испорчен — {}. */
export function readGuard(dataDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_NAME), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * Обновить отметки: значение null снимает отметку. Пишется через временный
 * файл и переименование; без перемен не пишется вовсе. Никогда не бросает: на
 * полном диске и эта запись может не пройти — тогда остаётся строка в журнале
 * программы, а копия или обновление от этого не ломаются.
 */
export function noteGuard(dataDir, patch) {
  const file = path.join(dataDir, STATE_NAME);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    const cur = readGuard(dataDir);
    let changed = false;
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null || v === undefined) {
        if (k in cur) { delete cur[k]; changed = true; }
      } else {
        cur[k] = v;
        changed = true;
      }
    }
    if (!changed) return;
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* временного файла могло и не быть */ }
    console.warn('[disk-guard] отметка о месте не записалась:', e && e.message);
  }
}

// Обновление (п. 3): скачанный пакет не больше 100 МБ (updater.js
// MAX_BUNDLE_BYTES), распакованная версия ~55 МБ, плюс копия базы перед
// обновлением и тот же запас 1 ГБ.
export const UPDATE_DOWNLOAD_BYTES = 100 * MB;
export const UPDATE_UNPACK_BYTES = 60 * MB;
export const updateNeedBytes = (db) => UPDATE_DOWNLOAD_BYTES + UPDATE_UNPACK_BYTES + copyNeedBytes(db);

/**
 * Хватит ли места на обновление: 100 МБ + 60 МБ + база × 1,2 + 1 ГБ.
 * Платформа не сказала, сколько свободно, — обновление идёт, как раньше.
 * @returns {{ok:boolean, need:number|null, free:number|null}}
 */
export function checkUpdateSpace(dataDir, { diskSpaceImpl = currentDiskSpace, dbFile = path.join(dataDir, 'easymed.db') } = {}) {
  const space = diskSpaceImpl(dataDir);
  if (!space) return { ok: true, need: null, free: null };
  const need = updateNeedBytes(dbBytes(dbFile));
  return { ok: space.free >= need, need, free: space.free };
}

// ---------------------------------------------------------------------------
// «Место на диске» (раздел 3, п. 8) — карточка на «Данных клиники» и колокол
// администратора (server/services/rpc/backup.js diskUsage).
//
// Обход папок ограничен (ревью C5): хранилище сканов за годы — десятки тысяч
// файлов, а сервер клиники один на всех. Поэтому обход асинхронный и пачками
// (сервер не замирает), не больше TREE_MAX_ENTRIES записей на папку (дальше
// счёт останавливается, и число уходит как «не меньше» — поле в partial), а
// итог держится TREE_CACHE_MS: повторные открытия экрана и два администратора
// разом делят один обход. Колокол ({quick:true}) папки не обходит вовсе.
// ---------------------------------------------------------------------------

export const TREE_MAX_ENTRIES = 100_000;
export const TREE_CACHE_MS = 60_000;
const STAT_BATCH = 64;

// soleOnly — считать только файлы с одной ссылкой (nlink 1): файл с жёсткой
// ссылкой занимает место один раз, и это место уже сосчитано там, где лежит
// вторая ссылка (storage).
async function sumSizes(files, soleOnly = false) {
  let n = 0;
  for (let i = 0; i < files.length; i += STAT_BATCH) {
    const sizes = await Promise.all(files.slice(i, i + STAT_BATCH)
      .map((p) => fs.promises.stat(p).then((s) => (soleOnly && s.nlink > 1 ? 0 : s.size), () => 0)));   // исчез между чтением и замером — 0
    for (const s of sizes) n += s;
  }
  return n;
}

/**
 * Сумма размеров файлов в папке со всеми вложенными; нет папки — 0. Ссылки
 * (junction, symlink) не обходятся: Dirent ссылки — не папка и не файл.
 * soleOnlyDirs(имя) — вложенные папки, где считаются только файлы с одной
 * ссылкой (снимки файлов .files: жёсткие ссылки на storage места не
 * занимают, а единственная копия файла — занимает). Больше maxEntries
 * записей — счёт останавливается: complete false, bytes — «не меньше».
 * @returns {Promise<{bytes:number, complete:boolean}>}
 */
export async function treeBytes(dir, { soleOnlyDirs = null, maxEntries = TREE_MAX_ENTRIES } = {}) {
  let bytes = 0;
  let left = maxEntries;
  const stack = [{ d: dir, soleOnly: false }];
  while (stack.length) {
    const { d, soleOnly } = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
    const files = [];
    for (const e of entries) {
      if (left <= 0) return { bytes: bytes + await sumSizes(files, soleOnly), complete: false };
      left--;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push({ d: p, soleOnly: soleOnly || !!(soleOnlyDirs && soleOnlyDirs(e.name)) });
      } else if (e.isFile()) {
        files.push(p);
      }
    }
    bytes += await sumSizes(files, soleOnly);
  }
  return { bytes, complete: true };
}

// Подсчёты папок: ключ (папка данных, папка версий, предел) → {at, promise}.
// at — когда обход ЗАКОНЧИЛСЯ (null — ещё идёт): минута считается от готового
// числа, а идущий обход делят все, сколько бы он ни шёл, — второй полный
// обход рядом с первым не запускается.
const sizeCache = new Map();

function folderSizes(dataDir, versionsDir, { maxEntries, cacheMs, now }) {
  const t = now();
  for (const [k, v] of sizeCache) {
    if (v.at !== null && t - v.at >= Math.max(cacheMs, TREE_CACHE_MS)) sizeCache.delete(k);
  }
  const key = JSON.stringify([path.resolve(dataDir), versionsDir ? path.resolve(versionsDir) : null, maxEntries]);
  const hit = sizeCache.get(key);
  if (hit && (hit.at === null || t - hit.at < cacheMs)) return hit.promise;
  const entry = { at: null, promise: null };
  entry.promise = (async () => {
    const partial = [];
    const measure = async (field, dir, opts = {}) => {
      const r = await treeBytes(dir, { ...opts, maxEntries });
      if (!r.complete) partial.push(field);
      return r.bytes;
    };
    // Копии — вся папка backups/: и отложенные восстановлением и откатом с их
    // журналами, и неубранные обрывки (.broken) — это настоящее место. В
    // снимках файлов .files — только файлы с одной ссылкой: жёсткая ссылка на
    // файл storage места не занимает, а файл, которого в storage уже нет
    // («Удалить все данные» без копий) или который скопирован (ссылку сделать
    // не удалось), — занимает.
    const backups_bytes = await measure('backups_bytes', path.join(dataDir, 'backups'), { soleOnlyDirs: (n) => n.endsWith('.files') });
    const storage_bytes = await measure('storage_bytes', path.join(dataDir, 'storage'));
    const versions_bytes = versionsDir ? await measure('versions_bytes', versionsDir) : null;
    return { backups_bytes, storage_bytes, versions_bytes, partial };
  })();
  sizeCache.set(key, entry);
  entry.promise.then(() => { entry.at = now(); }, () => { if (sizeCache.get(key) === entry) sizeCache.delete(key); });
  return entry.promise;
}

/**
 * «Место на диске» (раздел 3, п. 8): что сколько занимает, сколько свободно,
 * «мало места» (свободно меньше 10 % диска или меньше 5 ГБ) и отметки об
 * отказах (disk-guard.json). quick — без обхода папок: колокол администратора
 * спрашивает каждую минуту. versionsDir — папка versions/ установки (null из
 * исходников). Числа — числами: десятичный знак ставит экран по своему языку.
 * Платформа не сказала, сколько свободно, — free/total null, low false.
 */
export async function diskUsageReport(dataDir, {
  quick = false, versionsDir = null, diskSpaceImpl = currentDiskSpace,
  maxEntries = TREE_MAX_ENTRIES, cacheMs = TREE_CACHE_MS, now = Date.now,
} = {}) {
  const space = diskSpaceImpl(dataDir);
  const guard = readGuard(dataDir);
  const db = dbBytes(path.join(dataDir, 'easymed.db'));
  const out = {
    free_bytes: space ? space.free : null,
    total_bytes: space ? space.total : null,
    low: !!space && (space.free < FREE_SHARE_MIN * space.total || space.free < LOW_FREE_BYTES),
    // Ежедневная копия делается раз в день: место освободили днём — до завтра
    // её не будет, и «Копия не сделана» висела бы на экране, хотя место есть.
    // Пока места на копию хватает, отказ не показывается; в disk-guard.json он
    // остаётся (журнал) и снимается первой же сделанной копией.
    copy_refused: (guard.copy_refused && !(space && space.free >= copyNeedBytes(db))) ? guard.copy_refused : null,
    update_refused: guard.update_refused || null,
    kept_over_cap: guard.kept_over_cap || null,
  };
  if (quick) return out;
  const sizes = await folderSizes(dataDir, versionsDir, { maxEntries, cacheMs, now });
  return { ...out, db_bytes: db, ...sizes, partial: [...sizes.partial] };
}
