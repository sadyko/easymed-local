import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './control/checkin.js';
import {
  currentDiskSpace, dbBytes, copyNeedBytes, noSpaceError, noteGuard, COPIES_SHARE_MAX, FREE_SHARE_MIN,
  LOW_FREE_BYTES, RESERVE_BYTES,
} from './disk-guard.js';   // DISK_GUARD_V1

// SYSTEM_SETTINGS_V1 (docs/plans/2026-08-23-system-settings.md) — the clinic's
// own backup system: the daily/manual copies, the restore path and the factory
// reset. db/backup.js stays the migration-rollback specialist (pre- copies for
// updates); this module owns everything the settings screen drives.
//
// Two rules inherited from db/backup.js and from the retired apply-update.ps1
// (deleted 2026-08-24 — these two rules are the part of it worth keeping, and
// this is now where they live), restated because every function below leans
// on them:
//   1. Copies are taken with db.backup(), never fs.copyFileSync — the database
//      runs in WAL mode, so the .db file alone is NOT the whole database.
//   2. The live database is MOVED aside on restore, never deleted. Disk space
//      is recoverable; a clinic's patient records are not. (DISK_GUARD_V1 —
//      the move-asides are kept two per kind, see KEEP_BY_KIND.)

// The only filename shape a backup may have. Anything else in backups/ —
// a sidecar, a subdirectory, a name with a separator smuggled in — is invisible
// to the listing, which is what keeps the listing (and therefore the restore
// RPC, which validates against it) from ever becoming a traversal primitive.
const NAME_RE = /^[A-Za-z0-9._-]+\.db$/;

// The kinds this module may CREATE. 'pre' is deliberately absent: update
// rollback points are db/backup.js's job, created only by the update path.
const CREATABLE_KINDS = new Set(['daily', 'manual', 'safety', 'final']);

// Per-kind retention. One shared counter (the old pruneBackups(dir, 3) at
// boot) let fourteen daily copies silently evict the update rollback point —
// and one update evict every daily copy. Each kind ages against itself only.
// DISK_GUARD_V1 — и копии, отложенные восстановлением (replaced-*, applyRestore)
// и откатом (rollback-*, install/rollback.mjs): по две последние каждого вида.
// Раньше они не удалялись никогда и на экране не были видны.
const KEEP_BY_KIND = { daily: 14, manual: 10, safety: 5, final: 5, pre: 3, replaced: 2, rollback: 2 };
// DISK_GUARD_V1 — видны в списке, но с экрана не восстанавливаются (см. listBackups).
const SET_ASIDE_KINDS = new Set(['replaced', 'rollback']);

const MARKER_NAME = 'pending-action.json';

// PATIENT_FILE_ATTACH_V1 — ФАЙЛЫ ТОЖЕ ЕСТЬ ДАННЫЕ КЛИНИКИ.
//
// До этой работы копия содержала ТОЛЬКО базу. Сканы, фотографии направлений и
// вложения переписки лежат не в базе, а в <dataDir>/storage — то есть каждая
// «резервная копия» обещала сохранность того, чего не сохраняла. Проверить это
// клиника могла ровно одним способом: восстановиться и обнаружить, что в карте
// каждого пациента остались строки документов, которые ничего не открывают.
// (И это при том, что «Сброс к заводским настройкам» storage/ уже удалял —
// продукт умел стирать файлы и не умел их спасать.)
//
// СНИМОК ДЕЛАЕТСЯ ЖЁСТКИМИ ССЫЛКАМИ, а не копированием. Файлы в storage
// НЕИЗМЕНЯЕМЫ: имя на диске — уникальный ключ, второй раз в него никто не
// пишет (upsert:false), а удаление документа заменено отзывом. Значит ссылка
// на тот же inode — полноценный снимок момента, занимающий ноль места:
// четырнадцать ежедневных копий хранилища на 5 ГБ не превращаются в 70 ГБ на
// диске регистратуры. Там, где ссылку сделать нельзя (другой том, файловая
// система без hardlink), молча копируем — дороже, но так же верно.
const STORAGE_DIR = 'storage';
const sidecarFor = (dbFileName) => dbFileName.replace(/\.db$/, '') + '.files';

function copyTreeLinked(from, to) {
  let entries;
  try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return 0; }
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of entries) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) { n += copyTreeLinked(src, dst); continue; }
    if (!e.isFile()) continue;
    try {
      fs.linkSync(src, dst);
      n++;
    } catch (err) {
      if (err.code === 'EEXIST') { n++; continue; }
      // EXDEV (другой том), EPERM (файловая система без жёстких ссылок) —
      // копия делает то же самое, просто дороже.
      try { fs.copyFileSync(src, dst); n++; }
      catch (e2) { console.warn('[backup] файл не попал в копию:', src, e2 && e2.message); }
    }
  }
  return n;
}

// Восстановление СЛИВАЕТ файлы, а не заменяет их. Хранилище только растёт:
// откат базы на вчера не делает сегодняшний скан ошибкой, а перезапись папки
// целиком уничтожила бы всё, что появилось после снятой копии. Существующий
// файл никогда не трогается — имена уникальны, и совпадение означает тот же
// самый файл.
function mergeTree(from, to) {
  let entries;
  try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return 0; }
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of entries) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) { n += mergeTree(src, dst); continue; }
    if (!e.isFile() || fs.existsSync(dst)) continue;
    try { fs.copyFileSync(src, dst); n++; }
    catch (err) { console.warn('[backup] файл не восстановился:', src, err && err.message); }
  }
  return n;
}

/**
 * Снимок <dataDir>/storage рядом с копией базы: backups/<имя копии>.files/.
 * Возвращает число файлов в снимке. Никогда не бросает — копия базы к этому
 * моменту уже сделана, и потерять её из-за беды с файлами было бы хуже, чем
 * предупредить в журнал.
 *
 * Имя папки не оканчивается на .db, поэтому listBackups её не видит и
 * restore-RPC на неё указать не может — ровно то свойство «сайдкара», которое
 * NAME_RE объявляет выше.
 */
export function snapshotStorage(dataDir, dbFileName) {
  const from = path.join(dataDir, STORAGE_DIR);
  if (!fs.existsSync(from)) return 0;
  try {
    return copyTreeLinked(from, path.join(dataDir, 'backups', sidecarFor(dbFileName)));
  } catch (e) {
    console.warn('[backup] снимок файлов не удался:', e && e.message);
    return 0;
  }
}

/** Вернуть файлы из снимка копии `dbFileName` в <dataDir>/storage. */
export function restoreStorage(dataDir, dbFileName) {
  const from = path.join(dataDir, 'backups', sidecarFor(dbFileName));
  if (!fs.existsSync(from)) return 0;
  try { return mergeTree(from, path.join(dataDir, STORAGE_DIR)); }
  catch (e) { console.warn('[backup] файлы не восстановились:', e && e.message); return 0; }
}

/**
 * DISK_GUARD_V1 — убрать копию, оборвавшуюся посередине: сам файл, -journal /
 * -wal / -shm, если SQLite успел их завести, и папку снимка файлов (.files).
 * Никогда не бросает: ошибка уборки не должна заслонить настоящую причину
 * сбоя, ради которой копия и оборвалась. Зовут оба места записи копий — эта
 * функция и db/backup.js backupBeforeMigrate.
 */
export function discardPartial(file) {
  // Windows: антивирус может держать файл (EBUSY/EPERM) — maxRetries работает
  // только вместе с recursive, поэтому он указан и для одиночных файлов.
  const rm = (p) => {
    try { fs.rmSync(p, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 }); return true; }
    catch (e) { console.warn('[backup] обрывок копии не удалён:', p, e && e.code); return false; }
  };
  let mainGone = true;
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const ok = rm(file + suffix);
    if (suffix === '' && !ok) mainGone = false;
  }
  rm(path.join(path.dirname(file), sidecarFor(path.basename(file))));
  // Не удалось убрать сам файл: чистка по числу копий его не тронет, поэтому
  // ставим метку <файл>.broken — listBackups такие копии не показывает, а
  // runDailyBackup не считает их копией дня.
  if (!mainGone) {
    try { fs.writeFileSync(file + '.broken', 'partial'); } catch { /* метку не поставить — ничего больше не сделать */ }
  }
}

/**
 * DISK_GUARD_V1 — повторить удаление обрывков с меткой .broken (их не видят ни
 * список, ни чистка по числу копий). Метка уходит, когда копия убрана.
 */
export function sweepBroken(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.broken')); } catch { return; }
  for (const marker of names) {
    const file = path.join(dir, marker.slice(0, -'.broken'.length));
    discardPartial(file);
    if (!fs.existsSync(file)) {
      try { fs.rmSync(path.join(dir, marker), { force: true }); } catch { /* повторим в следующий раз */ }
    }
  }
}

const p2 = (n) => String(n).padStart(2, '0');
// LOCAL time on purpose, matching what the clinic's own clock says: "the
// backup from the 23rd" must mean the 23rd as the receptionist lived it, and
// the one-per-day rule below keys off the same local date.
const dayStamp = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
const timeStamp = (d) => `${dayStamp(d)}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

// DISK_GUARD_V1 (ревью C3) — отложенные копии узнаются только по имени, которое
// ставят сами восстановление (applyRestore) и откат (install/rollback.mjs):
// вид-ГГГГММДД-ччммсс.db, время местное. Файл, названный руками
// (rollback-before-fix.db), — чужой: его не удаляют, не считают, не показывают.
const SET_ASIDE_RE = /^(replaced|rollback)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;

function kindOf(name) {
  const m = /^(pre|daily|manual|safety|final)-/.exec(name);
  if (m) return m[1];
  const s = SET_ASIDE_RE.exec(name);
  return s ? s[1] : null;
}

// DISK_GUARD_V1 (ревью C3) — момент, когда базу отложили, из имени; не
// отложенная копия — NaN.
function setAsideTimeMs(name) {
  const s = SET_ASIDE_RE.exec(name);
  if (!s) return NaN;
  const [y, mo, d, h, mi, se] = s.slice(2).map(Number);
  return new Date(y, mo - 1, d, h, mi, se).getTime();
}

// DISK_GUARD_V1 (ревью C3) — время копии для «самых новых» и для списка.
// Отложенная база хранит дату файла ЖИВОЙ базы, а не момента, когда её
// отложили (а восстановленная на Windows база — дату копии, из которой
// пришла): по дате файла свежая отложенная копия ушла бы первой, а в списке
// стояла бы чужая дата. Поэтому у отложенных время — из имени.
function entryTimeMs(name, st) {
  const t = setAsideTimeMs(name);
  return Number.isFinite(t) ? t : st.mtimeMs;
}

// DISK_GUARD_V1 — копии, которые удаляются по объёму (п. 5). Ручные и
// финальные — решение человека, автоматически они не удаляются никогда.
// Отложенные восстановлением и откатом (SET_ASIDE_KINDS) сюда тоже не входят:
// п. 5 называет автоматическими только эти три вида, а у отложенных своё
// правило — две последние (п. 6); «до отката» к тому же единственная копия
// базы на момент отката (из неё поддержка переносит внесённое после
// обновления). В долю копий (30 %) они тоже не входят (ревью C3): иначе
// большие отложенные копии при каждой новой копии стирали бы ежедневные до
// одной, и на экране об этом не было бы ни слова. Свободное место они
// уменьшают сами собой, а панель «Место на диске» показывает всю папку копий.
const AUTO_KINDS = new Set(['daily', 'pre', 'safety']);

// DISK_GUARD_V1 — место копии со всеми её частями: .db и (у отложенных
// восстановлением и откатом) -wal/-shm рядом. Снимок файлов .files не
// считается: это жёсткие ссылки, места они не занимают.
function entryBytes(dir, name) {
  let n = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { n += fs.statSync(path.join(dir, name + suffix)).size; } catch { /* нет части — нет и байт */ }
  }
  return n;
}

// DISK_GUARD_V1 — все копии известных видов с размером и временем. Обрывок с
// меткой .broken — не копия (как и в listBackups): его убирает sweepBroken.
function backupEntries(dir) {
  let all;
  try { all = new Set(fs.readdirSync(dir)); } catch { return []; }
  const out = [];
  for (const f of all) {
    if (!NAME_RE.test(f) || all.has(f + '.broken')) continue;
    const kind = kindOf(f);
    if (!kind) continue;
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ name: f, kind, mtimeMs: entryTimeMs(f, st), bytes: entryBytes(dir, f) });
  }
  return out;
}

// DISK_GUARD_V1 — удалить копию целиком: .db, -wal/-shm и снимок файлов.
// true — копии больше нет (занятый файл на Windows — обычное дело, тогда false).
function removeEntry(dir, name) {
  try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* занятый файл — не повод падать */ }
  // DISK_GUARD_V1 (ревью C3) — .db не удалился (антивирус, его открыла
  // поддержка): копия остаётся, а с ней её -wal/-shm и снимок файлов. Без
  // журнала оставшийся .db потерял бы последние записи. Следующая чистка
  // попробует снова.
  if (fs.existsSync(path.join(dir, name))) return false;
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(path.join(dir, name + suffix), { force: true }); } catch { /* у отложенных копий его уберёт sweepSetAsideOrphans */ }
  }
  // PATIENT_FILE_ATTACH_V1 — снимок файлов уходит ВМЕСТЕ со своей копией базы:
  // оставшийся сайдкар держал бы жёсткие ссылки на файлы, удалённые из storage.
  try { fs.rmSync(path.join(dir, sidecarFor(name)), { recursive: true, force: true }); } catch { /* то же */ }
  return true;
}

/**
 * DISK_GUARD_V1 (ревью C3) — журналы -wal/-shm отложенной копии, чей .db уже
 * удалён (журнал не удалился вместе с ним, или .db убрали руками). Журнал без
 * базы ничего не восстанавливает и только занимает место. Убирается, когда у
 * его вида есть KEEP_BY_KIND копий новее, — то есть вышел за «две последние».
 * Журнал новее них остаётся: это может быть половина отложенной базы, перенос
 * которой оборвался (applyRestore при повторе переносит оставшийся -wal под
 * новым временем), и тогда он нужен поддержке вместе с той базой.
 */
function sweepSetAsideOrphans(dir, keep) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const present = new Set(names);
  const times = new Map();   // вид → время каждой его копии (.db) на диске
  for (const f of names) {
    const s = SET_ASIDE_RE.exec(f);
    if (!s) continue;
    if (!times.has(s[1])) times.set(s[1], []);
    times.get(s[1]).push(setAsideTimeMs(f));
  }
  for (const f of names) {
    const m = /^(.+\.db)-(?:wal|shm)$/.exec(f);
    if (!m || present.has(m[1]) || keep.has(m[1])) continue;
    const s = SET_ASIDE_RE.exec(m[1]);
    if (!s) continue;
    const t = setAsideTimeMs(m[1]);
    const newer = (times.get(s[1]) || []).filter((x) => x > t).length;
    if (newer < KEEP_BY_KIND[s[1]]) continue;
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* повторим при следующей чистке */ }
  }
}

const newestOf = (entries, kind) => entries
  .filter((e) => e.kind === kind)
  .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;

// DISK_GUARD_V1 (ревью C2) — копии, которые сейчас восстанавливают (полный
// путь → сколько запросов держат). Беречь их обязана ЛЮБАЯ копия этого
// процесса, а не только страховочная самого восстановления: страховочная
// синхронизации филиалов (branch-sync/relay.js), ежедневная или ручная,
// сделанная в ту же минуту, иначе удалила бы цель своей чисткой — намерение
// записалось бы, а при запуске восстанавливать было бы нечего.
const RESTORING = new Map();

/**
 * Имена в папке копий dir, которые не удаляются ни уступкой места, ни
 * чисткой: цели идущих сейчас восстановлений и цель уже записанного намерения
 * (pending-action.json) — до перезапуска она тоже нужна.
 */
function restoreTargets(dir) {
  const out = new Set();
  const here = path.resolve(dir);
  for (const p of RESTORING.keys()) if (path.dirname(p) === here) out.add(path.basename(p));
  if (path.basename(here) === 'backups') {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(path.dirname(here), MARKER_NAME), 'utf8'));
      if (m && m.action === 'restore' && typeof m.backup === 'string') out.add(m.backup);
    } catch { /* намерения нет или оно испорчено — беречь нечего */ }
  }
  return out;
}

// DISK_GUARD_V1 (ревью C2) — копии делаются по одной на процесс. Место
// проверяется перед каждой копией, но копия идёт долго: две копии, начатые
// разом, обе прошли бы проверку и вместе съели бы запас в 1 ГБ. Очередь общая
// для createBackup и db/backup.js backupBeforeMigrate. Сбой одной копии
// очередь не держит.
let copyQueue = Promise.resolve();
export function withCopyLock(fn) {
  const run = copyQueue.then(fn, fn);
  copyQueue = run.then(() => {}, () => {});
  return run;
}

/**
 * DISK_GUARD_V1 — хватит ли места на новую копию (раздел 3, п. 2): размер базы
 * (с журналом) × 1,2 + 1 ГБ. Не хватает — уступают старые автоматические
 * копии: сначала самые старые ежедневные, потом лишние «перед обновлением»
 * (последняя — точка отката текущей версии — остаётся), потом страховочные.
 * Удаляются они, ТОЛЬКО если этого хватает: стереть копии и всё равно не
 * сделать новую — худший из исходов. Не хватит и так — бросает 'no_space'
 * (ничего не удалив), пишет строку в журнал программы и отметку copy_refused
 * для «Данных клиники» и колокола администратора.
 *
 * protect — имена, которые не уступают никогда; к ним всегда добавляются цели
 * восстановления (restoreTargets). Платформа не сказала, сколько свободно, —
 * копия делается, как раньше.
 */
export function ensureCopySpace(dataDir, {
  kind = 'manual', protect = [], dbFile = path.join(dataDir, 'easymed.db'),
  diskSpaceImpl = currentDiskSpace, now = new Date(),
} = {}) {
  const dir = path.join(dataDir, 'backups');
  const space = diskSpaceImpl(dir);
  if (!space) return { freed: [] };
  const need = copyNeedBytes(dbBytes(dbFile));
  if (space.free >= need) return { freed: [] };

  const keep = new Set([...protect, ...restoreTargets(dir)]);
  const entries = backupEntries(dir);
  const newestPre = newestOf(entries, 'pre');
  const byAge = (k) => entries
    .filter((e) => e.kind === k && !keep.has(e.name) && !(k === 'pre' && newestPre && e.name === newestPre.name))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  const plan = [];
  let free = space.free;
  for (const e of [...byAge('daily'), ...byAge('pre'), ...byAge('safety')]) {
    if (free >= need) break;
    plan.push(e);
    free += e.bytes;
  }
  if (free < need) {
    console.warn(`[backup] копия «${kind}» не сделана: нужно ${need} Б, свободно ${space.free} Б, а старых автоматических копий, которые можно удалить, не хватает`);
    noteGuard(dataDir, { copy_refused: { at: now.toISOString(), kind, need_bytes: need, free_bytes: space.free } });
    throw noSpaceError(need, space.free);
  }
  const freed = plan.filter((e) => removeEntry(dir, e.name)).map((e) => e.name);
  console.warn(`[backup] мало места на диске — для новой копии удалены старые: ${freed.join(', ')}`);
  return { freed };
}

/**
 * DISK_GUARD_V1 — предел по объёму (раздел 3, п. 5): автоматические копии
 * (ежедневные, перед обновлением, страховочные) удаляются от старых к новым,
 * пока копии занимают больше 30 % диска или свободно меньше 10 %. Правило
 * «меньше 10 %» действует, только пока свободно ещё и меньше max(5 ГБ, место
 * на следующую копию) (ревью C2): диск 1 ТБ с 60 ГБ свободных — это 6 %, но
 * стирать ради этого историю копий незачем. Не
 * трогаются: protect (только что сделанная копия, копия, которую сейчас
 * восстанавливают), САМАЯ НОВАЯ копия каждого автоматического вида (поправка
 * 1 плана 3.18.1: диск, занятый другими файлами, не должен оставлять клинику
 * совсем без ежедневной копии, точки отката и страховочной), ручные,
 * финальные, отложенные восстановлением и откатом (их и в доле копий нет: их
 * держит своё правило — см. AUTO_KINDS). Не уложились и так — строка
 * «Мало места на диске» в журнал программы (на «Данных клиники» то же видно
 * по самому месту). Если ручные и финальные одни больше 30 % — отметка
 * kept_over_cap (только о них: так и говорит её текст): предупреждение на
 * «Данных клиники». Отметка пишется только рядом с настоящей папкой backups/
 * данных клиники — вызов на произвольной папке не пишет в её родителя.
 */
function pruneBySize(dir, { protect, diskSpaceImpl, dbBytesImpl = dbBytes, now }) {
  const space = diskSpaceImpl(dir);
  if (!space || !(space.total > 0)) return [];
  // DISK_GUARD_V1 (ревью C3) — отложенные копии в долю копий не входят (AUTO_KINDS).
  const entries = backupEntries(dir).filter((e) => !SET_ASIDE_KINDS.has(e.kind));
  let copies = entries.reduce((s, e) => s + e.bytes, 0);
  let free = space.free;
  // Место на следующую копию — по базе данных клиники рядом с backups/;
  // у произвольной папки базы нет: только запас. dbBytesImpl — только для
  // тестов: базы в 10 ГБ на диске теста нет.
  const nextNeed = path.basename(dir) === 'backups'
    ? copyNeedBytes(dbBytesImpl(path.join(path.dirname(dir), 'easymed.db')))
    : RESERVE_BYTES;
  const freeFloor = Math.max(LOW_FREE_BYTES, nextNeed);
  const over = () => copies > COPIES_SHARE_MAX * space.total
    || (free < FREE_SHARE_MIN * space.total && free < freeFloor);
  const newest = new Set([...AUTO_KINDS].map((k) => newestOf(entries, k)).filter(Boolean).map((e) => e.name));
  const auto = entries
    .filter((e) => AUTO_KINDS.has(e.kind) && !protect.has(e.name) && !newest.has(e.name))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const removed = [];
  for (const e of auto) {
    if (!over()) break;
    if (!removeEntry(dir, e.name)) continue;
    removed.push(e.name);
    copies -= e.bytes;
    free += e.bytes;
  }
  if (removed.length) console.warn(`[backup] копии заняли больше, чем положено, — удалены старые: ${removed.join(', ')}`);
  if (over()) {
    console.warn(`[backup] Мало места на диске: свободно ${free} Б из ${space.total} Б, копии занимают ${copies} Б. `
      + 'Самые новые копии каждого вида, ручные и финальные оставлены — освободите место на диске.');
  }
  if (path.basename(dir) === 'backups') {
    const kept = entries.filter((e) => e.kind === 'manual' || e.kind === 'final').reduce((s, e) => s + e.bytes, 0);
    const cap = Math.floor(COPIES_SHARE_MAX * space.total);
    noteGuard(path.dirname(dir), {
      kept_over_cap: kept > cap ? { at: now.toISOString(), bytes: kept, cap_bytes: cap } : null,
    });
  }
  return removed;
}

/**
 * Every backup in <dataDir>/backups, newest first.
 *
 * DISK_GUARD_V1 — в списке и копии, отложенные восстановлением (replaced-*) и
 * откатом (rollback-*, recover.cmd): это настоящие данные и настоящее место
 * на диске, и клиника должна видеть, что занимает её диск. Но restorable у них
 * false и с экрана их не вернуть: у такого .db журнал -wal лежит РЯДОМ
 * отдельным файлом, и вернуть один .db значило бы потерять записи журнала.
 * Восстанавливаемая копия того же момента — страховочная (requestRestore
 * снимает её первой); вернуть «до отката» — работа поддержки Easy-Med.
 * Размер — вместе с -wal/-shm рядом; время — из имени (entryTimeMs).
 *
 * @returns {{name:string, kind:string, size:number, mtimeMs:number, restorable:boolean}[]}
 */
export function listBackups(dataDir) {
  const dir = path.join(dataDir, 'backups');
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files
    .filter((f) => NAME_RE.test(f) && kindOf(f) && !files.includes(f + '.broken'))   // DISK_GUARD_V1 — неудалённый обрывок
    .map((f) => {
      // Guarded per-file for the same reason pruneBackups documents: a file
      // vanishing between readdir and stat (a concurrent prune, a manual
      // delete) is normal life, not an error.
      try {
        const st = fs.statSync(path.join(dir, f));
        if (!st.isFile()) return null;
        const kind = kindOf(f);
        return { name: f, kind, size: entryBytes(dir, f), mtimeMs: entryTimeMs(f, st), restorable: !SET_ASIDE_KINDS.has(kind) };
      } catch { return null; }
    })
    .filter((e) => e !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * WAL-safe copy of the live database into backups/, named <kind>-<local ts>.db.
 *
 * @param {Database} db
 * @param {string} dataDir
 * @param {'daily'|'manual'|'safety'|'final'} kind
 * @param {Date} [now]  injectable so tests can pin the local date
 * @param {{protect?: string[], diskSpaceImpl?: Function}} [opts]  DISK_GUARD_V1 —
 *   имена, которые не удаляются ни уступкой места, ни чисткой; ответ диска (тесты)
 * @returns {Promise<{name:string, kind:string, size:number, mtimeMs:number}>}
 */
export async function createBackup(db, dataDir, kind, now = new Date(), opts = {}) {
  // The kind becomes part of a filename, so it is a fixed vocabulary, never
  // caller-shaped text — same reasoning as NAME_RE above.
  if (!CREATABLE_KINDS.has(kind)) throw new Error(`Unknown backup kind: ${kind}`);
  // DISK_GUARD_V1 (ревью C2) — по одной копии за раз (withCopyLock).
  return withCopyLock(() => createBackupNow(db, dataDir, kind, now, opts));
}

async function createBackupNow(db, dataDir, kind, now, { protect = [], diskSpaceImpl = currentDiskSpace } = {}) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  sweepBroken(dir);   // DISK_GUARD_V1

  // DISK_GUARD_V1 — место проверяется ДО того, как занято имя: копия, на
  // которую места нет, не начинается вовсе (раздел 3, п. 2). Не хватает и
  // после уступок старых — ошибка 'no_space' уходит вызвавшему.
  ensureCopySpace(dataDir, { kind, protect, diskSpaceImpl, now });

  // Same exclusive-create claim as backupBeforeMigrate, same race: two
  // requests landing in the same second (a double-clicked button, or the
  // hourly tick coinciding with a manual copy) must let the OS — not a
  // timing accident — decide which gets which name.
  const base = `${kind}-${timeStamp(now)}`;
  let n = 0;
  let out = path.join(dir, `${base}.db`);
  for (;;) {
    try {
      fs.closeSync(fs.openSync(out, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      out = path.join(dir, `${base}.${++n}.db`);
    }
  }

  // Awaited for the same reason backupBeforeMigrate documents: returning
  // before the copy is complete would let the caller act on a half-written
  // backup — for requestRestore below, that would mean writing a restore
  // marker whose safety copy does not actually exist yet.
  //
  // DISK_GUARD_V1 — копия, оборвавшаяся посередине (полный диск, сбой записи),
  // удаляется здесь же, вместе со снимком файлов. Имя занято заранее через
  // 'wx', поэтому better-sqlite3 считает файл чужим и сам его НЕ удаляет
  // (backup.cpp: unlink только для файла, которого до копии не было). Без этой
  // уборки обрывок занимал остаток диска, закрывал день как «сделанный»
  // (runDailyBackup ищет копию дня по имени) и стоял в списке как годная копия.
  try {
    await db.backup(out);
  } catch (e) {
    discardPartial(out);
    throw e;
  }
  // PATIENT_FILE_ATTACH_V1 — файлы снимаются ПОСЛЕ базы. Порядок важен: строка
  // документа без файла — «файл не открывается», файл без строки — просто
  // лишние байты на диске. Из двух неполных копий правильно иметь вторую.
  const files = snapshotStorage(dataDir, path.basename(out));
  const st = fs.statSync(out);
  // DISK_GUARD_V1 — копия есть: прежний отказ «Копия не сделана» больше не правда.
  noteGuard(dataDir, { copy_refused: null });
  // DISK_GUARD_V1 — чистка сразу после КАЖДОЙ копии (п. 7), а не только после
  // ежедневной: «Создать копию сейчас» раньше ждала ночи. Новая копия и та,
  // которую сейчас восстанавливают, не удаляются. Сбой чистки — не сбой копии:
  // она уже на диске.
  try {
    pruneBackupsByKind(dir, { protect: [path.basename(out), ...protect], diskSpaceImpl, now });
  } catch (e) {
    console.warn('[backup] старые копии не почищены (новая копия цела):', e && e.message);
  }
  return { name: path.basename(out), kind, size: st.size, mtimeMs: st.mtimeMs, files };
}

/**
 * Kind-aware retention. Replaces the boot-time pruneBackups(dir, 3) call —
 * see KEEP_BY_KIND for why one shared counter was wrong. Unknown prefixes
 * (hand-copied files) are never touched: this function deletes only what this
 * module, db/backup.js or install/rollback.mjs provably created (DISK_GUARD_V1 —
 * replaced-* and rollback-* are known kinds now, two of each are kept).
 *
 * DISK_GUARD_V1 — после счёта — предел по объёму (pruneBySize). protect —
 * имена, которые не удаляются ни счётом, ни объёмом: только что сделанная
 * копия и копия, которую сейчас восстанавливают. Сбой предела — строка в
 * журнал, не исключение: чистка не бывает причиной несделанной копии.
 * diskSpaceImpl и dbBytesImpl — ответы диска и размер базы для тестов.
 */
export function pruneBackupsByKind(dir, {
  protect = [], diskSpaceImpl = currentDiskSpace, dbBytesImpl = dbBytes, now = new Date(),
} = {}) {
  // DISK_GUARD_V1 (ревью C2) — и цели восстановления: идущего и записанного.
  const keep = new Set([...protect, ...restoreTargets(dir)]);
  sweepBroken(dir);   // DISK_GUARD_V1
  let files;
  try { files = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)); } catch { return; }
  const byKind = new Map();
  for (const f of files) {
    const kind = kindOf(f);
    if (!kind) continue;
    let t;
    // Same per-file stat guard as pruneBackups, same hazard: a vanished file
    // must not abort pruning of the ones still there.
    // DISK_GUARD_V1 (ревью C3) — у отложенных копий время из имени (entryTimeMs).
    try { t = entryTimeMs(f, fs.statSync(path.join(dir, f))); } catch { continue; }
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push({ f, t });
  }
  for (const [kind, entries] of byKind) {
    entries.sort((a, b) => b.t - a.t);
    for (const { f } of entries.slice(KEEP_BY_KIND[kind])) {
      if (keep.has(f)) continue;
      // removeEntry уносит и снимок файлов (PATIENT_FILE_ATTACH_V1), и -wal/-shm.
      removeEntry(dir, f);
    }
  }
  sweepSetAsideOrphans(dir, keep);   // DISK_GUARD_V1 (ревью C3)
  try {
    pruneBySize(dir, { protect: keep, diskSpaceImpl, dbBytesImpl, now });
  } catch (e) {
    console.warn('[backup] предел копий по объёму не проверен:', e && e.message);
  }
}

/**
 * One tick of the daily schedule: if today (LOCAL date) has no daily- backup
 * yet, take one and prune. Exported separately from the timer wiring so the
 * decision is testable without waiting on real clocks.
 *
 * @returns {Promise<object|null>} the new entry, or null if today was covered
 */
export async function runDailyBackup(db, dataDir, now = new Date(), opts = {}) {
  const today = dayStamp(now);
  const covered = listBackups(dataDir).some((b) => b.kind === 'daily' && b.name.startsWith(`daily-${today}-`));
  if (covered) return null;
  // DISK_GUARD_V1 — чистка теперь внутри createBackup (после каждой копии).
  // Нет места — 'no_space' уходит в scheduleDailyBackups: строка в журнал и
  // повтор через час; день не отмечен, потому что копии дня на диске нет.
  return createBackup(db, dataDir, 'daily', now, opts);
}

// First tick ~5 minutes after boot, so a clinic PC powered on in the morning
// gets its daily backup even if it is shut down before the first full hour.
// Hourly after that: the tick is a cheap no-op once today is covered, and an
// hourly cadence means a PC that was busy at 08:05 still gets covered at 09:05.
const DAILY_INITIAL_DELAY_MS = 5 * 60_000;
const DAILY_INTERVAL_MS = 60 * 60_000;

/**
 * Wires the daily backup into the running process. Mirrors scheduleCheckin:
 * both timers unref()'d so a clinic shutting down never waits on housekeeping,
 * every tick wrapped so a failure can only ever cost one attempt — the next
 * hour retries.
 */
export function scheduleDailyBackups(db, dataDir, {
  initialDelayMs = DAILY_INITIAL_DELAY_MS,
  intervalMs = DAILY_INTERVAL_MS,
  now = () => new Date(),
} = {}) {
  const tick = () => {
    runDailyBackup(db, dataDir, now())
      .catch((e) => console.warn('[backup] daily backup failed, will retry in an hour:', e && e.message));
  };
  const initial = setTimeout(tick, initialDelayMs);
  initial.unref();
  const interval = setInterval(tick, intervalMs);
  interval.unref();
  return { initial, interval };
}

/**
 * Record the intent to restore `name` on the next boot.
 *
 * The safety- copy is taken BEFORE the marker is written: once the marker
 * exists a crash means the restore WILL run on the next boot, so the state it
 * is about to discard must already be captured by then — the other order has
 * a window where newer data is gone and no copy of it exists.
 *
 * @returns {Promise<{ok:true}|{ok:false, reason:'unknown_backup'|'backup_gone'}>}
 */
export async function requestRestore(db, dataDir, name) {
  // Validated against the real listing, not just the regex: the RPC layer
  // passes caller-shaped text, and "a name we did not list" and "a path" get
  // the same refusal — there is nothing a traversal probe can learn here.
  if (typeof name !== 'string' || !NAME_RE.test(name)
      || !listBackups(dataDir).some((b) => b.name === name && b.restorable)) {   // DISK_GUARD_V1 — replaced-*/rollback-* не возвращаются
    return { ok: false, reason: 'unknown_backup' };
  }
  // DISK_GUARD_V1 — копия, которую сейчас восстанавливают, не уступает место
  // страховочной и не уходит ни при её чистке, ни при чистке ЛЮБОЙ другой
  // копии этого процесса (RESTORING, ревью C2): иначе восстанавливать было бы
  // нечего. Метка держится до записи намерения — дальше цель бережёт сам
  // pending-action.json (restoreTargets).
  const target = path.resolve(dataDir, 'backups', name);
  RESTORING.set(target, (RESTORING.get(target) || 0) + 1);
  try {
    await createBackup(db, dataDir, 'safety', new Date(), { protect: [name] });
    // Пока делалась страховочная копия, цель могли удалить мимо программы
    // (Проводник, антивирус). Намерение без цели при запуске молча
    // пропускается, а администратор ждал восстановления — значит, отказ сейчас.
    if (!listBackups(dataDir).some((b) => b.name === name)) {
      console.warn(`[backup] восстановление не запрошено: копия ${name} исчезла, пока делалась страховочная копия`);
      return { ok: false, reason: 'backup_gone' };
    }
    writeAtomic(path.join(dataDir, MARKER_NAME), JSON.stringify({ action: 'restore', backup: name }));
    return { ok: true };
  } finally {
    const n = (RESTORING.get(target) || 1) - 1;
    if (n > 0) RESTORING.set(target, n); else RESTORING.delete(target);
  }
}

/**
 * Record the intent to factory-reset on the next boot. The final- copy is
 * taken even though the admin is deleting on purpose — fat fingers exist, and
 * keeping it is the recoverable half of the danger zone (wipe_backups is the
 * explicit clean-disk choice that removes even this).
 *
 * DISK_GUARD_V1 (ревью C2) — с wipe_backups финальная копия всё равно
 * удаляется при запуске вместе со всеми копиями, поэтому её отказ по месту
 * удаление не останавливает: на полном диске это и есть способ его освободить.
 * Копия делается, если место есть, — до перезапуска она ещё страхует.
 */
export async function requestFactoryReset(db, dataDir, { wipeBackups = false } = {}) {
  try {
    await createBackup(db, dataDir, 'final');
  } catch (e) {
    if (!(wipeBackups && e && e.code === 'no_space')) throw e;
    console.warn('[backup] финальная копия не сделана — нет места; удаление продолжается: все копии удаляются по выбору администратора');
    // Отказ здесь не новость для «Данных клиники»: копии удаляются по выбору.
    noteGuard(dataDir, { copy_refused: null });
  }
  writeAtomic(path.join(dataDir, MARKER_NAME), JSON.stringify({ action: 'factory_reset', wipe_backups: !!wipeBackups }));
  return { ok: true };
}

// A marker this code cannot act on is set ASIDE, never deleted (the intent
// stays inspectable) and never retried forever (a boot loop stuck on the same
// broken marker would keep a clinic down). Rename overwrites an older .bad on
// Windows and POSIX alike, which is fine: the newest failure is the one worth
// reading.
function quarantine(markerPath, why) {
  console.warn(`[backup] pending-action.json could not be applied (${why}) — set aside as .bad, booting normally`);
  try { fs.renameSync(markerPath, markerPath + '.bad'); }
  catch { try { fs.unlinkSync(markerPath); } catch { /* unreadable AND unmovable — booting on is still right */ } }
  return { action: null, quarantined: true };
}

/**
 * Apply a pending restore / factory reset. Runs in server/index.js BEFORE
 * openDb — the whole design depends on no handle being open on easymed.db
 * while it is renamed away (Windows refuses to move an open file).
 *
 * Never throws: whatever is wrong with the marker or the disk, the answer is
 * "quarantine and boot" — a clinic that cannot start is strictly worse than a
 * clinic that starts on its previous database.
 *
 * Both branches are idempotent and the marker is deleted LAST: a crash at any
 * point mid-action re-runs safely on the next boot, and the intent is never
 * lost silently.
 */
export function processPendingAction(dataDir) {
  const markerPath = path.join(dataDir, MARKER_NAME);
  let raw;
  try { raw = fs.readFileSync(markerPath, 'utf8'); } catch { return { action: null }; }

  let m = null;
  try { m = JSON.parse(raw); } catch { m = null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return quarantine(markerPath, 'not a JSON object');

  try {
    if (m.action === 'restore') return applyRestore(dataDir, markerPath, m);
    if (m.action === 'factory_reset') return applyFactoryReset(dataDir, markerPath, m);
    return quarantine(markerPath, `unknown action "${m.action}"`);
  } catch (e) {
    // Backstop — both branches guard their own risky steps, but an unforeseen
    // failure must still resolve to "boot normally", never to a crash loop.
    return quarantine(markerPath, e && e.message);
  }
}

function applyRestore(dataDir, markerPath, m) {
  const name = typeof m.backup === 'string' ? m.backup : '';
  // Re-validated here even though requestRestore already did: the marker is a
  // plain file anyone (or any corruption) could have edited between the RPC
  // and this boot, and this function moves databases around.
  const src = NAME_RE.test(name) ? path.join(dataDir, 'backups', name) : null;
  if (!src || !fs.existsSync(src)) return quarantine(markerPath, 'restore target missing or invalid');

  const dbPath = path.join(dataDir, 'easymed.db');
  const ts = timeStamp(new Date());
  // The moved-aside trio shares one timestamp so a human (or a support call)
  // can match a .db to ITS -wal/-shm — mixing sidecars across move-asides is
  // how a restore-of-a-restore corrupts silently.
  const moved = [];
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const from = dbPath + suffix;
      if (!fs.existsSync(from)) continue; // a prior crashed run may have moved it already — idempotency
      const to = path.join(dataDir, 'backups', `replaced-${ts}.db${suffix}`);
      fs.renameSync(from, to);
      moved.push([from, to]);
    }
    fs.copyFileSync(src, dbPath);
  } catch (e) {
    // Disk full, a straggler process still holding the db, the backup vanishing
    // mid-copy — put everything back where it was. Booting on the ORIGINAL
    // database beats booting on a fresh empty one, which is what openDb would
    // create if easymed.db stayed missing here.
    for (const [from, to] of moved.reverse()) {
      try { fs.renameSync(to, from); } catch { /* best effort — the .db rename back is the one that matters, and it happened last-in-first-out */ }
    }
    return quarantine(markerPath, `restore failed: ${e && e.message}`);
  }

  // PATIENT_FILE_ATTACH_V1 — файлы возвращаются ПОСЛЕ базы и СЛИЯНИЕМ (см.
  // mergeTree): восстановленная база снова знает про документы, снятые в тот
  // момент, а всё, что появилось позже, остаётся на диске. Сбой здесь не
  // отменяет восстановление базы — оно уже состоялось и оно главное.
  const files = restoreStorage(dataDir, name);

  try { fs.unlinkSync(markerPath); } catch { /* next boot re-runs the same restore onto the same result */ }
  return { action: 'restore', backup: name, files };
}

function applyFactoryReset(dataDir, markerPath, m) {
  const wipe = !!m.wipe_backups;
  // force:true makes every step a no-op when the target is already gone,
  // which is exactly what a re-run after a mid-reset crash needs.
  for (const f of ['easymed.db', 'easymed.db-wal', 'easymed.db-shm', 'control.json', 'licence.dat']) {
    fs.rmSync(path.join(dataDir, f), { force: true });
  }
  fs.rmSync(path.join(dataDir, 'storage'), { recursive: true, force: true });
  // backups/ goes LAST of the data, and only on the explicit clean-disk
  // choice: until this line the final- copy still exists, so a crash anywhere
  // above leaves a recoverable machine.
  if (wipe) fs.rmSync(path.join(dataDir, 'backups'), { recursive: true, force: true });
  try { fs.unlinkSync(markerPath); } catch { /* next boot re-deletes nothing and moves on */ }
  return { action: 'factory_reset', wipe_backups: wipe };
}
