// V3120_FIX — возврат к предыдущей версии Easy-Med ВМЕСТЕ С БАЗОЙ.
//
// ЗАЧЕМ. recover.cmd раньше только переставлял ссылку `current`. Пока версии
// различались одним кодом, этого хватало. Но 3.11 добавила в базу защитные
// триггеры (160_patient_deposits_guard.sql и соседние): база сама отказывает
// в записях, которые делает только старый код. Вернуть программу 3.10 на базу
// после 3.11 — значит получить кассу, которая на каждую оплату отвечает
// ошибкой. Откат программы через миграции обязан откатывать и базу — на копию,
// снятую ПЕРЕД обновлением (backups\pre-<версия>.db).
//
// ЧТО ДЕЛАЕТ.
//   recover — зовёт recover.cmd, спрашивает человека:
//     1. понимает, меняла ли новая версия устройство базы (сравнивает списки
//        миграций versions\<сейчас> и versions\<куда>);
//     2. находит копию базы, которая подходит версии «куда» (по списку
//        применённых миграций внутри самой копии, если Node умеет читать
//        SQLite; иначе — по имени pre-<версия>.db);
//     3. говорит ЧТО будет с данными, внесёнными после копии, и спрашивает;
//     4. текущую базу НЕ удаляет — переносит в backups\rollback-<время>.db;
//     5. переставляет `current`, отмечает откат для поставщика.
//   auto — зовёт EasyMed.exe, когда только что установленная версия упала при
//     запуске, так и не ответив на проверку здоровья (data\update-pending.json
//     всё ещё лежит). Тогда в новой версии никто ничего не вносил — копия,
//     снятая перед переключением, и есть последнее состояние базы, — поэтому
//     возврат делается без вопросов.
//
// БЕЗ ЗАВИСИМОСТЕЙ. Только встроенные модули Node: файл запускается из любой
// папки versions\<v>\install, в том числе из версии, которая сама не может
// стартовать, и не должен зависеть от её node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PENDING_NAME = 'update-pending.json';
export const ROLLED_BACK_NAME = 'update-rolled-back.json';
export const RESULT_NAME = 'update-result.json';
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PRE_RE = /^pre-(\d+\.\d+\.\d+)(?:\.(\d+))?\.db$/;
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const p2 = (n) => String(n).padStart(2, '0');
export const stamp = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const human = (d) => `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

/** Имя версии, на которую сейчас указывает `current`, или null. */
export function currentVersion(root) {
  try { return path.basename(fs.realpathSync(path.join(root, 'current'))); } catch { return null; }
}

export function versionInstalled(root, version) {
  return fs.existsSync(path.join(root, 'versions', version, 'server', 'index.js'));
}

/** Список .sql миграций версии, или null, если папки нет. */
export function versionMigrations(root, version) {
  try {
    return fs.readdirSync(path.join(root, 'versions', version, 'server', 'db', 'migrations'))
      .filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return null;
  }
}

// node:sqlite — встроен в Node 22.5+; в бандле клиники Node 24. Если его нет,
// копия выбирается по имени, а не по содержимому (см. findMatchingBackup).
let DatabaseSync = null;
try {
  const require = createRequire(import.meta.url);
  ({ DatabaseSync } = require('node:sqlite'));
} catch { /* старый Node — работаем без чтения копий */ }

/**
 * Какие миграции записаны внутри копии базы. null — прочитать нельзя.
 * immutable=1: копия открывается строго на чтение и рядом с ней не появляются
 * -wal/-shm (иначе они копились бы в backups\).
 */
export function appliedIn(dbFile, { sqlite = DatabaseSync } = {}) {
  if (!sqlite) return null;
  let db;
  try {
    db = new sqlite(pathToFileURL(path.resolve(dbFile)).href + '?immutable=1', { readOnly: true });
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (!has) return new Set();
    return new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  } catch {
    return null;
  } finally {
    try { db && db.close(); } catch { /* ignore */ }
  }
}

/**
 * Копия базы, подходящая версии `to`, при откате с версии `from`.
 *
 * Кандидаты: pre-<v>*.db, где to < v <= from (копия снимается ПЕРЕД переходом
 * на v, значит в ней устройство базы версии, с которой уходили), плюс копия,
 * записанная в update-pending.json. Подходящая — та, где нет ни одной
 * миграции, которой не знает версия `to`. Из подходящих — самая свежая: чем
 * позже копия, тем меньше данных уйдёт из рабочей базы.
 *
 * Без чтения SQLite (старый Node) — первая по правилу: копия из pending, иначе
 * самая свежая из pre-<ближайшая версия после to>.
 */
export function findMatchingBackup({ dataDir, root, from, to, pending = null, sqlite = DatabaseSync }) {
  const dir = path.join(dataDir, 'backups');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* нет копий */ }
  const cands = [];
  for (const name of names) {
    const m = PRE_RE.exec(name);
    if (!m) continue;
    const v = m[1];
    if (compareVersions(v, to) <= 0 || compareVersions(v, from) > 0) continue;
    let st;
    try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
    if (!st.isFile() || st.size === 0) continue;
    cands.push({ file: path.join(dir, name), name, version: v, mtime: st.mtime });
  }
  if (pending && pending.backup && pending.version === from) {
    const file = path.resolve(pending.backup);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size > 0 && !cands.some((c) => path.resolve(c.file) === file)) {
        cands.push({ file, name: path.basename(file), version: from, mtime: st.mtime, fromPending: true });
      } else {
        const c = cands.find((x) => path.resolve(x.file) === file);
        if (c) c.fromPending = true;
      }
    } catch { /* копия из pending пропала — остальные кандидаты */ }
  }
  if (!cands.length) return null;

  const known = versionMigrations(root, to);
  const canRead = !!sqlite && known !== null;
  if (canRead) {
    const knownSet = new Set(known);
    const ok = cands
      .map((c) => ({ ...c, applied: appliedIn(c.file, { sqlite }) }))
      .filter((c) => c.applied && [...c.applied].every((n) => knownSet.has(n)));
    if (ok.length) {
      ok.sort((a, b) => b.mtime - a.mtime);
      const { applied, ...best } = ok[0];
      return { ...best, checked: true };
    }
    // Ни одна не прочиталась как подходящая. Если читать не удалось НИ ОДНУ —
    // падаем на правило по имени; если прочитались, но не подходят — копии нет.
    const readable = cands.some((c) => appliedIn(c.file, { sqlite }) !== null);
    if (readable) return null;
  }
  const pend = cands.find((c) => c.fromPending);
  if (pend) return { ...pend, checked: false };
  const minV = cands.reduce((m, c) => (compareVersions(c.version, m) < 0 ? c.version : m), cands[0].version);
  const same = cands.filter((c) => c.version === minV).sort((a, b) => b.mtime - a.mtime);
  return { ...same[0], checked: false };
}

/**
 * План отката с текущей версии на `to`: что изменилось в базе и какая копия
 * её вернёт. Ничего не меняет.
 */
export function planRollback({ root, dataDir = path.join(root, 'data'), to, sqlite = DatabaseSync }) {
  const from = currentVersion(root);
  const pending = readJson(path.join(dataDir, PENDING_NAME));
  const fromList = from ? versionMigrations(root, from) : null;
  const toList = versionMigrations(root, to);
  let newMigrations = null;
  if (fromList && toList) {
    const toSet = new Set(toList);
    newMigrations = fromList.filter((f) => !toSet.has(f));
  }
  const backup = from && VERSION_RE.test(from) && VERSION_RE.test(to)
    ? findMatchingBackup({ dataDir, root, from, to, pending, sqlite })
    : null;
  return { from, to, dataDir, pending, newMigrations, backup };
}

/**
 * Проверка «сервер остановлен»: пока Easy-Med работает, его база открыта, и
 * Windows не даёт её переименовать. Пробное переименование туда и обратно.
 */
export function dbInUse(dataDir, { renameSync = fs.renameSync } = {}) {
  const db = path.join(dataDir, 'easymed.db');
  if (!fs.existsSync(db)) return false;
  const probe = db + '.rollback-probe';
  try {
    renameSync(db, probe);
  } catch {
    return true;
  }
  renameSync(probe, db);
  return false;
}

/**
 * Вернуть базу из копии. Текущая база (с -wal/-shm, одним временем в имени)
 * ПЕРЕНОСИТСЯ в backups\rollback-<время>.db — не удаляется никогда. Любая
 * ошибка — всё возвращается как было.
 */
export function restoreDb({ dataDir, backupFile, now = new Date(), renameSync = fs.renameSync, copyFileSync = fs.copyFileSync }) {
  const dbPath = path.join(dataDir, 'easymed.db');
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const ts = stamp(now);
  const moved = [];
  const putBack = () => {
    for (const [from, to] of moved.reverse()) {
      try { renameSync(to, from); } catch { /* лучшее, что можно */ }
    }
  };
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const from = dbPath + suffix;
      if (!fs.existsSync(from)) continue;
      const to = path.join(dir, `rollback-${ts}.db${suffix}`);
      renameSync(from, to);
      moved.push([from, to]);
    }
    copyFileSync(backupFile, dbPath);
  } catch (e) {
    try { if (moved.length && fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch { /* ignore */ }
    putBack();
    const err = new Error('restore failed: ' + (e && e.message));
    err.code = e && (e.code === 'EBUSY' || e.code === 'EPERM') ? 'LOCKED' : 'RESTORE_FAILED';
    throw err;
  }
  return { savedAs: moved.length ? path.join(dir, `rollback-${ts}.db`) : null };
}

/** Переставить `current` на versions\<to>. Снимается ТОЛЬКО ссылка. */
export function repointCurrent(root, to) {
  const link = path.join(root, 'current');
  const target = path.join(root, 'versions', to);
  let st = null;
  try { st = fs.lstatSync(link); } catch { /* ссылки нет — создадим */ }
  if (st && !st.isSymbolicLink()) {
    throw new Error(`'${link}' — настоящая папка, а не ссылка; трогать её опасно`);
  }
  if (st) fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link, LINK_TYPE);
  if (path.resolve(fs.realpathSync(link)) !== path.resolve(target)) {
    throw new Error(`'current' указывает не туда после переключения`);
  }
}

/**
 * Отметить откат: для поставщика — update-result.json ok:false, если новая
 * версия ещё не была подтверждена (pending) или её ok:true ещё не отправлен
 * (иначе старая версия отправила бы «успех» того, от чего клиника ушла); для
 * самого сервера — update-rolled-back.json, по которому он при запуске снимет
 * согласие на эту версию, чтобы она не поставилась снова этой же ночью.
 */
export function recordRollback({ dataDir, from, to, by, dbRestored, backupName = null, savedAs = null, now = new Date(), reason = '' }) {
  const pendingPath = path.join(dataDir, PENDING_NAME);
  const resultPath = path.join(dataDir, RESULT_NAME);
  const pending = readJson(pendingPath);
  const unsent = readJson(resultPath);
  const pendingForFrom = pending && pending.version === from;
  const staleOk = unsent && unsent.ok === true && unsent.version === from;
  if (pendingForFrom || staleOk) {
    const prevFrom = (pendingForFrom && pending.from) || (staleOk && unsent.from) || to;
    const parts = [
      `Rolled back from ${from} to ${to} by ${by}${reason ? ' (' + reason + ')' : ''}.`,
      dbRestored ? `Database restored from ${backupName}; the replaced database was kept as ${savedAs}.` : 'Database not restored.',
    ];
    writeJsonAtomic(resultPath, {
      version: from, from: prevFrom, ok: false, db: dbRestored ? 'restored' : 'current',
      at: now.toISOString(), detail: parts.join(' '),
    });
  }
  if (pending) {
    try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
  }
  writeJsonAtomic(path.join(dataDir, ROLLED_BACK_NAME), {
    version: from, to, by, db_restored: !!dbRestored, at: now.toISOString(),
  });
}

// ─── Сценарии ──────────────────────────────────────────────────────────────

const YES = new Set(['', 'д', 'да', 'y', 'yes', 'l']);   // 'l' — «д» на английской раскладке

/**
 * Интерактивный возврат (recover.cmd). ask(question) → строка ответа.
 * Возвращает код выхода: 0 — сделано, 1 — ошибка, 2 — отменено человеком.
 */
export function runRecover({ root, to, ask, log = console.log, now = new Date(), sqlite = DatabaseSync, forceDb = null }) {
  const dataDir = path.join(root, 'data');
  if (!VERSION_RE.test(String(to)) || !versionInstalled(root, to)) {
    log(`  Версия "${to}" на этом компьютере не установлена. Ничего не изменено.`);
    return 1;
  }
  if (dbInUse(dataDir)) {
    log('');
    log('  Easy-Med сейчас ЗАПУЩЕН — его база открыта.');
    log('  Закройте чёрное окно Easy-Med (или остановите службу Easy-Med)');
    log('  и запустите recover.cmd ещё раз. Ничего не изменено.');
    return 1;
  }
  const plan = planRollback({ root, dataDir, to, sqlite });
  const from = plan.from;
  if (from === to) {
    log(`  Версия ${to} и так работает сейчас. Ничего не изменено.`);
    return 2;
  }

  let restore = false;
  log('');
  if (plan.newMigrations && plan.newMigrations.length === 0) {
    log(`  Версии ${from} и ${to} используют одно и то же устройство базы —`);
    log('  базу трогать не нужно, данные остаются как есть.');
  } else {
    if (plan.newMigrations) {
      log(`  Версия ${from} изменила устройство базы (${plan.newMigrations.length} изм.).`);
    } else {
      log(`  Не удалось сравнить устройство базы версий ${from || '?'} и ${to}.`);
    }
    log(`  Программа ${to} с такой базой работать не сможет: например, касса`);
    log('  будет отказывать в записи оплат.');
    log('');
    if (plan.backup) {
      const when = human(plan.backup.mtime);
      log(`  Есть копия базы, снятая ПЕРЕД обновлением: ${plan.backup.name}`);
      log(`  (от ${when}).`);
      log('');
      log('  ЕСЛИ ВОССТАНОВИТЬ ЕЁ:');
      log(`    - всё, что внесено в программу ПОСЛЕ ${when} (новые пациенты,`);
      log('      визиты, оплаты, анализы, склад), исчезнет из рабочей базы;');
      log('    - текущая база НЕ удаляется: она целиком сохраняется в');
      log(`      data\\backups\\rollback-${stamp(now)}.db — поставщик сможет`);
      log('      перенести из неё то, что было внесено после обновления.');
      log('');
      const a = forceDb !== null ? (forceDb ? 'д' : 'н')
        : String(ask(`  Восстановить базу из копии и вернуть версию ${to}? [Д/н, о - отмена]: `) || '').trim().toLowerCase();
      if (a === 'о' || a === 'j' || a === 'q' || a === 'отмена') { log('  Отменено. Ничего не изменено.'); return 2; }
      if (YES.has(a)) restore = true;
      else {
        const b = String(ask('  Вернуть ТОЛЬКО программу, без базы? Касса может перестать работать. [д/Н]: ') || '').trim().toLowerCase();
        if (!(b === 'д' || b === 'да' || b === 'y' || b === 'l')) { log('  Отменено. Ничего не изменено.'); return 2; }
      }
    } else {
      log(`  Копии базы, подходящей для версии ${to}, в data\\backups\\ НЕ найдено.`);
      const b = String(ask('  Вернуть ТОЛЬКО программу, без базы? Касса может перестать работать. [д/Н]: ') || '').trim().toLowerCase();
      if (!(b === 'д' || b === 'да' || b === 'y' || b === 'l')) { log('  Отменено. Ничего не изменено. Обратитесь к поставщику.'); return 2; }
    }
  }

  let savedAs = null;
  if (restore) {
    try {
      ({ savedAs } = restoreDb({ dataDir, backupFile: plan.backup.file, now }));
    } catch (e) {
      log('');
      log(e.code === 'LOCKED'
        ? '  База занята — Easy-Med, похоже, запущен. Закройте его окно и повторите.'
        : '  Не удалось восстановить базу: ' + e.message);
      log('  Ничего не изменено.');
      return 1;
    }
    log(`  База восстановлена из ${plan.backup.name}.`);
    if (savedAs) log(`  Прежняя база сохранена: ${savedAs}`);
  }

  try {
    repointCurrent(root, to);
  } catch (e) {
    log('');
    log('  Не удалось переключить версию: ' + e.message);
    if (restore) log('  База уже восстановлена; при запуске новая версия снова обновит её сама.');
    log('  Запустите EasyMed.exe — он восстановит ссылку на самую свежую версию.');
    return 1;
  }
  recordRollback({ dataDir, from, to, by: 'recover.cmd', dbRestored: restore, backupName: plan.backup && plan.backup.name, savedAs, now });

  log('');
  log(`  Готово. Easy-Med снова будет работать на версии ${to}.`);
  log(restore
    ? '  База — на момент перед обновлением (прежняя сохранена, см. выше).'
    : '  Данные клиники (папка data) не затронуты.');
  log('  Поставщик получит отметку об откате при следующей связи, и эта');
  log('  версия не установится снова, пока администратор не одобрит её заново.');
  return 0;
}

/**
 * Автоматический возврат (EasyMed.exe): только что установленная версия упала
 * при запуске, не пройдя проверку здоровья. Коды: 0 — откат сделан,
 * 3 — откатывать нечего (нет незавершённого обновления), 1 — не удалось.
 */
export function runAuto({ root, log = console.log, now = new Date(), sqlite = DatabaseSync }) {
  const dataDir = path.join(root, 'data');
  const pending = readJson(path.join(dataDir, PENDING_NAME));
  const cur = currentVersion(root);
  if (!pending || !pending.version || pending.version !== cur) return 3;
  const to = pending.from;
  if (!to || !VERSION_RE.test(String(to)) || !versionInstalled(root, to)) {
    log(`  Предыдущей версии (${to || '?'}) на этом компьютере нет — вернуться не к чему.`);
    return 1;
  }
  const plan = planRollback({ root, dataDir, to, sqlite });
  const needDb = plan.newMigrations === null || plan.newMigrations.length > 0;
  let restore = false;
  let savedAs = null;
  if (needDb && plan.backup) {
    try {
      ({ savedAs } = restoreDb({ dataDir, backupFile: plan.backup.file, now }));
      restore = true;
    } catch (e) {
      log('  Не удалось восстановить базу (' + e.message + ') — возвращаю только программу.');
    }
  } else if (needDb) {
    log('  Копии базы перед обновлением не найдено — возвращаю только программу.');
  }
  try {
    repointCurrent(root, to);
  } catch (e) {
    log('  Не удалось вернуть предыдущую версию: ' + e.message);
    return 1;
  }
  recordRollback({
    dataDir, from: cur, to, by: 'EasyMed.exe', dbRestored: restore,
    backupName: plan.backup && plan.backup.name, savedAs, now,
    reason: 'the new version crashed at start before answering /api/health',
  });
  log(`  Версия ${cur} не запустилась. Возвращена версия ${to}.`);
  if (restore) log(`  База возвращена на момент перед обновлением; прежняя сохранена: ${savedAs}`);
  return 0;
}

// ─── Командная строка ──────────────────────────────────────────────────────

function argValue(argv, name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function askSync(question) {
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  let s = '';
  for (;;) {
    let n = 0;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch (e) {
      if (e.code === 'EAGAIN') continue;
      return s;
    }
    if (n <= 0) return s;
    s += buf.toString('utf8', 0, n);
    if (s.includes('\n')) return s.split(/\r?\n/)[0];
  }
}

function main(argv) {
  const cmd = argv[0];
  const root = argValue(argv, 'root');
  if (!root) { console.log('  usage: rollback.mjs recover|auto --root <папка Easy-Med> [--to <версия>]'); return 1; }
  if (cmd === 'recover') {
    const forceDb = argv.includes('--yes') ? true : (argv.includes('--code-only') ? false : null);
    return runRecover({ root: path.resolve(root), to: argValue(argv, 'to'), ask: askSync, forceDb });
  }
  if (cmd === 'auto') return runAuto({ root: path.resolve(root) });
  console.log('  неизвестная команда: ' + cmd);
  return 1;
}

const isMain = process.argv[1] && (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
