// V3120_FIX — «установлено» говорится только после того, как новая версия
// ДЕЙСТВИТЕЛЬНО поднялась.
//
// ЧТО БЫЛО. applyUpdate() переставлял `current`, писал update-result.json с
// ok:true и выходил с кодом 75 — всё это СТАРЫЙ процесс, до того как новая
// версия сделала хоть один шаг. Версия, падающая при запуске (миграция, битый
// импорт), отчитывалась поставщику успехом; двухотказный автостоп поставщика
// её не видел; клиника оставалась без программы до ручного recover.cmd
// (так было 07.09.2026 с 1.1.0).
//
// КАК ТЕПЕРЬ.
//   1. applyUpdate() пишет data\update-pending.json {version, from, backup, …}
//      вместо ok:true.
//   2. Новая версия при запуске (scheduleUpdater → armBootConfirmation), уже
//      после migrate и listen, спрашивает свой же /api/health (он трогает
//      базу). Ответ 200 — и только тогда пишется ok:true, а pending удаляется.
//   3. Версия, которая упала, не дойдя до шага 2, оставляет pending лежать.
//      EasyMed.exe видит падение при непогашенном pending и возвращает прежнюю
//      версию и базу (install/rollback.mjs auto); recover.cmd делает то же по
//      просьбе человека. Оба пишут ok:false и update-rolled-back.json.
//   4. Прежняя версия при запуске (reconcileUpdateAtBoot) видит pending на
//      ЧУЖУЮ версию или отметку отката: пишет ok:false, если его ещё никто не
//      написал, и снимает согласие администратора на эту версию — иначе в
//      следующем окне обновление поставилось бы снова и снова упало.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeAtomic } from './checkin.js';

export const PENDING_NAME = 'update-pending.json';
export const ROLLED_BACK_NAME = 'update-rolled-back.json';
export const RESULT_NAME = 'update-result.json';

/**
 * The outcome file — the clinic's only record of what its own update did, and
 * the only thing the vendor's two-failure auto-halt can ever count. Shape:
 * {version, from, ok, db, at, detail} — read by checkin.js, rpc/updates.js
 * and the updates screen. (Moved here from updater.js unchanged.)
 */
export function writeOutcome(dataDir, outcome) {
  // Printed FIRST, one grep-able line: if the file write below fails, the
  // outcome must still exist SOMEWHERE.
  console.log('UPDATE_RESULT ' + JSON.stringify(outcome));
  try {
    writeAtomic(path.join(dataDir, RESULT_NAME), JSON.stringify(outcome, null, 2) + '\n');
  } catch (e) {
    console.warn('[updater] could not write update-result.json (the UPDATE_RESULT line above is the record):', e && e.message);
  }
}

export function readPending(dataDir) {
  return readJsonFile(path.join(dataDir, PENDING_NAME));
}

/** Record «switched, not yet proven». Throws on a write failure — the caller decides. */
export function writePending(dataDir, record) {
  writeAtomic(path.join(dataDir, PENDING_NAME), JSON.stringify(record, null, 2) + '\n');
}

function unlinkQuiet(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

// Снять согласие администратора, если оно дано именно на эту версию.
function dropConsentFor(db, version) {
  try {
    const row = db.prepare("SELECT value FROM control_state WHERE key = 'update_consent'").get();
    let consent = null;
    try { consent = row ? JSON.parse(row.value) : null; } catch { consent = null; }
    if (!consent || consent.version !== version) return false;
    db.prepare("DELETE FROM control_state WHERE key IN ('update_consent', 'update_scheduled_at')").run();
    return true;
  } catch (e) {
    console.warn('[updater] could not clear the consent for a rolled-back version:', e && e.message);
    return false;
  }
}

/**
 * Разобрать следы прошлого обновления при запуске. Никогда не бросает.
 * @returns {'none'|'awaiting'|'rolled_back'}
 *   awaiting    — pending на ЭТУ версию: её ещё нужно подтвердить (см. ниже);
 *   rolled_back — pending на другую версию: она не подтвердилась, мы — прежняя.
 */
export function reconcileUpdateAtBoot(db, dataDir, { runningVersion, now = () => new Date() } = {}) {
  try {
    const marker = readJsonFile(path.join(dataDir, ROLLED_BACK_NAME));
    if (marker && typeof marker.version === 'string') {
      dropConsentFor(db, marker.version);
      unlinkQuiet(path.join(dataDir, ROLLED_BACK_NAME));
    }

    const pending = readPending(dataDir);
    if (!pending || typeof pending.version !== 'string') return 'none';
    if (pending.version === runningVersion) return 'awaiting';

    // Переключение было, подтверждения не было, а работаем мы — значит, новую
    // версию вернули назад (EasyMed.exe старого образца, ручная правка ссылки).
    writeOutcome(dataDir, {
      version: pending.version,
      from: pending.from ?? null,
      ok: false,
      db: 'unknown',
      at: now().toISOString(),
      detail: `Version ${pending.version} was switched to but never confirmed healthy (it did not answer /api/health after starting); the clinic is running ${runningVersion} again. Pre-update snapshot: ${pending.backup || 'unknown'}.`,
    });
    dropConsentFor(db, pending.version);
    unlinkQuiet(path.join(dataDir, PENDING_NAME));
    return 'rolled_back';
  } catch (e) {
    console.warn('[updater] could not reconcile the previous update at boot (continuing):', e && e.message);
    return 'none';
  }
}

/**
 * Один шаг подтверждения: pending на эту версию + /api/health отвечает 200 →
 * пишется ok:true, pending удаляется. true — подтверждено.
 */
// V3120_FINAL — probe: проверка внутри процесса (см. armBootConfirmation).
// Передан — fetch не нужен вовсе.
export async function confirmBoot(dataDir, { runningVersion, healthUrl, fetchImpl = globalThis.fetch, probe = null, now = () => new Date(), timeoutMs = 5000 } = {}) {
  const pending = readPending(dataDir);
  if (!pending || pending.version !== runningVersion) return false;
  if (probe) {
    let alive = false;
    try { alive = !!(await probe()); } catch { alive = false; }
    if (!alive) return false;
  } else {
    let res;
    try {
      res = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return false;
    }
    if (!res || res.status !== 200) return false;
  }
  writeOutcome(dataDir, {
    version: pending.version,
    from: pending.from ?? null,
    ok: true,
    db: 'current',
    at: now().toISOString(),
    detail: `${pending.detail || `Switched to ${pending.version}.`} Confirmed: the new version started, ran its migrations and answered /api/health.`,
  });
  unlinkQuiet(path.join(dataDir, PENDING_NAME));
  console.log(`[updater] version ${pending.version} confirmed healthy`);
  return true;
}

/**
 * При запуске: разобрать прошлое обновление и, если эту версию надо
 * подтвердить, пробовать /api/health, пока не ответит (или пока не кончатся
 * попытки — тогда pending остаётся, и решает EasyMed.exe / recover.cmd).
 * Таймеры unref'нуты: процесс они не держат.
 */
export function armBootConfirmation(db, dataDir, {
  runningVersion,
  port = Number(process.env.PORT || 8000),
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  delayMs = 3000,
  intervalMs = 10_000,
  maxTries = 60,
  // V3120_FINAL — server (http.Server после listen): подтверждение ВНУТРИ
  // процесса — сервер слушает и база отвечает на SELECT 1 (то же, что делает
  // /api/health). Fetch к собственному порту не годится: порт клиники
  // закреплён port.txt, и порт из «плохого» списка fetch (6000, 6665–6669,
  // 10080, 5060…) не подтверждался никогда, а позже первый сбой откатывал
  // версию вместе с базой. probeDb — только для тестов (мёртвая база).
  server = null,
  probeDb = db,
} = {}) {
  const state = reconcileUpdateAtBoot(db, dataDir, { runningVersion, now });
  if (state !== 'awaiting') return { state, done: Promise.resolve(false) };
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  const probe = server
    ? () => { if (!server.listening) return false; probeDb.prepare('SELECT 1 AS ok').get(); return true; }
    : null;
  let tries = 0;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const attempt = async () => {
    tries++;
    let ok = false;
    try { ok = await confirmBoot(dataDir, { runningVersion, healthUrl, fetchImpl, probe, now }); } catch { ok = false; }
    if (ok) return resolveDone(true);
    if (tries >= maxTries) {
      console.warn(`[updater] version ${runningVersion} did not answer /api/health after ${tries} tries — left unconfirmed (update-pending.json)`);
      return resolveDone(false);
    }
    const t = setTimeout(attempt, intervalMs);
    t.unref?.();
  };
  const t = setTimeout(attempt, delayMs);
  t.unref?.();
  return { state, done };
}

/**
 * recover.cmd лежит в КОРНЕ установки и обновлением не заменяется (обновление
 * кладёт только versions\<v>). Чтобы исправленный recover.cmd дошёл до уже
 * установленных клиник, каждая запущенная версия кладёт в корень свою копию,
 * если та отличается. Только для настоящей установки versions\<v> + current.
 * @returns {boolean} был ли файл обновлён
 */
export function syncRecoverCmd(appRoot) {
  try {
    const resolved = path.resolve(appRoot);
    const versionsDir = path.dirname(resolved);
    if (path.basename(versionsDir) !== 'versions') return false;
    const root = path.dirname(versionsDir);
    if (path.resolve(fs.realpathSync(path.join(root, 'current'))) !== resolved) return false;
    const src = path.join(resolved, 'install', 'recover.cmd');
    const dst = path.join(root, 'recover.cmd');
    if (!fs.existsSync(src)) return false;
    const next = fs.readFileSync(src);
    let prev = null;
    try { prev = fs.readFileSync(dst); } catch { /* нет — положим */ }
    if (prev && prev.equals(next)) return false;
    writeAtomic(dst, next);
    return true;
  } catch (e) {
    console.warn('[updater] could not refresh recover.cmd (continuing):', e && e.message);
    return false;
  }
}
