import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './control/checkin.js';

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
//      is recoverable; a clinic's patient records are not.

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
const KEEP_BY_KIND = { daily: 14, manual: 10, safety: 5, final: 5, pre: 3 };

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

const p2 = (n) => String(n).padStart(2, '0');
// LOCAL time on purpose, matching what the clinic's own clock says: "the
// backup from the 23rd" must mean the 23rd as the receptionist lived it, and
// the one-per-day rule below keys off the same local date.
const dayStamp = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
const timeStamp = (d) => `${dayStamp(d)}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

function kindOf(name) {
  const m = /^(pre|daily|manual|safety|final)-/.exec(name);
  return m ? m[1] : null;
}

/**
 * Every restorable backup in <dataDir>/backups, newest first.
 *
 * Only the five known kinds are listed. replaced-* files (the raw move-asides
 * a restore leaves behind) are real data but NOT offered back: a raw .db whose
 * -wal sits BESIDE it as a separate file would lose that WAL's writes if
 * copied back alone — the safety- copy of the same moment is the restorable
 * version, and it always exists because requestRestore creates it first.
 *
 * @returns {{name:string, kind:string, size:number, mtimeMs:number}[]}
 */
export function listBackups(dataDir) {
  const dir = path.join(dataDir, 'backups');
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files
    .filter((f) => NAME_RE.test(f) && kindOf(f))
    .map((f) => {
      // Guarded per-file for the same reason pruneBackups documents: a file
      // vanishing between readdir and stat (a concurrent prune, a manual
      // delete) is normal life, not an error.
      try {
        const st = fs.statSync(path.join(dir, f));
        return st.isFile() ? { name: f, kind: kindOf(f), size: st.size, mtimeMs: st.mtimeMs } : null;
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
 * @returns {Promise<{name:string, kind:string, size:number, mtimeMs:number}>}
 */
export async function createBackup(db, dataDir, kind, now = new Date()) {
  // The kind becomes part of a filename, so it is a fixed vocabulary, never
  // caller-shaped text — same reasoning as NAME_RE above.
  if (!CREATABLE_KINDS.has(kind)) throw new Error(`Unknown backup kind: ${kind}`);
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });

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
  await db.backup(out);
  // PATIENT_FILE_ATTACH_V1 — файлы снимаются ПОСЛЕ базы. Порядок важен: строка
  // документа без файла — «файл не открывается», файл без строки — просто
  // лишние байты на диске. Из двух неполных копий правильно иметь вторую.
  const files = snapshotStorage(dataDir, path.basename(out));
  const st = fs.statSync(out);
  return { name: path.basename(out), kind, size: st.size, mtimeMs: st.mtimeMs, files };
}

/**
 * Kind-aware retention. Replaces the boot-time pruneBackups(dir, 3) call —
 * see KEEP_BY_KIND for why one shared counter was wrong. Unknown prefixes
 * (replaced-*, hand-copied files) are never touched: this function deletes
 * only what this module or db/backup.js provably created.
 */
export function pruneBackupsByKind(dir) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)); } catch { return; }
  const byKind = new Map();
  for (const f of files) {
    const kind = kindOf(f);
    if (!kind) continue;
    let t;
    // Same per-file stat guard as pruneBackups, same hazard: a vanished file
    // must not abort pruning of the ones still there.
    try { t = fs.statSync(path.join(dir, f)).mtimeMs; } catch { continue; }
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push({ f, t });
  }
  for (const [kind, entries] of byKind) {
    entries.sort((a, b) => b.t - a.t);
    for (const { f } of entries.slice(KEEP_BY_KIND[kind])) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* a locked file is not worth failing over */ }
      // PATIENT_FILE_ATTACH_V1 — снимок файлов уходит ВМЕСТЕ со своей копией
      // базы. Оставшийся сайдкар держал бы жёсткие ссылки на файлы, удалённые
      // из storage (сброс к заводским), то есть занимал бы место, о котором
      // никто не знает и которое ничем не освободить.
      try { fs.rmSync(path.join(dir, sidecarFor(f)), { recursive: true, force: true }); } catch { /* same */ }
    }
  }
}

/**
 * One tick of the daily schedule: if today (LOCAL date) has no daily- backup
 * yet, take one and prune. Exported separately from the timer wiring so the
 * decision is testable without waiting on real clocks.
 *
 * @returns {Promise<object|null>} the new entry, or null if today was covered
 */
export async function runDailyBackup(db, dataDir, now = new Date()) {
  const today = dayStamp(now);
  const covered = listBackups(dataDir).some((b) => b.kind === 'daily' && b.name.startsWith(`daily-${today}-`));
  if (covered) return null;
  const entry = await createBackup(db, dataDir, 'daily', now);
  pruneBackupsByKind(path.join(dataDir, 'backups'));
  return entry;
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
 * @returns {Promise<{ok:true}|{ok:false, reason:'unknown_backup'}>}
 */
export async function requestRestore(db, dataDir, name) {
  // Validated against the real listing, not just the regex: the RPC layer
  // passes caller-shaped text, and "a name we did not list" and "a path" get
  // the same refusal — there is nothing a traversal probe can learn here.
  if (typeof name !== 'string' || !NAME_RE.test(name)
      || !listBackups(dataDir).some((b) => b.name === name)) {
    return { ok: false, reason: 'unknown_backup' };
  }
  await createBackup(db, dataDir, 'safety');
  writeAtomic(path.join(dataDir, MARKER_NAME), JSON.stringify({ action: 'restore', backup: name }));
  return { ok: true };
}

/**
 * Record the intent to factory-reset on the next boot. The final- copy is
 * taken even though the admin is deleting on purpose — fat fingers exist, and
 * keeping it is the recoverable half of the danger zone (wipe_backups is the
 * explicit clean-disk choice that removes even this).
 */
export async function requestFactoryReset(db, dataDir, { wipeBackups = false } = {}) {
  await createBackup(db, dataDir, 'final');
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
