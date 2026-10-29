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
