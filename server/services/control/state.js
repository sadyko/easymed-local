import fs from 'node:fs';
import path from 'node:path';
import { verifyLicence } from './licence.js';
import { effectiveNow, clockAnomaly } from './clock.js';
import { ladderState } from './ladder.js';
import { extensionUntil } from './unlock.js';

// LICENCE_CORE_V1 — the single question the rest of the app asks: "what am I
// allowed to do right now?"
//
// Everything below is wrapped so that it CANNOT throw. This module is consulted
// on the hot path of every write and on every page load; a clinic must never be
// unable to register a patient because a file was half-written during a power
// cut. Anything unexpected means "locked", which is safe, visible, and
// recoverable by telephone.

let _testPublicKey = null;
/** Tests inject their own throwaway key. Never called in production. */
export function __setPublicKeyForTests(key) { _testPublicKey = key; invalidateControlCache(); }   // LOCAL_SPEED_V1 — другой ключ — другой ответ проверки

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// LOCAL_SPEED_V1 (2026-11-24) — ФАЙЛОВАЯ ЧАСТЬ В ПАМЯТИ.
//
// controlState спрашивают на каждом запросе API, а control.json и licence.dat
// меняются раз в час (check-in) или при активации. Чтение обоих + разбор +
// проверка подписи Ed25519 стоили ≈1,15 мс единственного потока на запрос (на
// ПК клиники с антивирусом — больше: он смотрит каждое открытие файла). Теперь
// это хранится по (mtimeMs, size) ОБОИХ файлов (нет файла — свой ключ); часть с
// базой (effectiveNow, clockAnomaly, extensionUntil) — на каждом вызове.
//
// Свежий файл НЕ хранится: если файл изменён меньше RACY_MS назад, ответ берётся
// с диска на каждом вызове, пока файл не «остынет». Время изменения у Windows
// идёт шагами (до ~16 мс, у FAT — 2 с), и перезапись того же размера в тот же шаг
// иначе осталась бы незамеченной (тот же приём, что «racy clean» у git). Поэтому
// тест, пишущий файлы и сразу спрашивающий, видит ровно то же, что до кэша.
// Писатели (enroll.js, checkin.js) после записи ещё и сбрасывают память сами.
//
// Содержимое файлов здесь никогда не печатается — в них секреты клиники.
const FILE_CACHE = new Map();   // dataDir → { sig, facts }   LOCAL_SPEED_V1
const FILE_CACHE_MAX = 16;   // LOCAL_SPEED_V1 — у сервера одна папка данных; тесты — много мелких
const RACY_MS = 2000;   // LOCAL_SPEED_V1

/** LOCAL_SPEED_V1 — забыть всё прочитанное: следующий controlState читает файлы заново. */
export function invalidateControlCache() { FILE_CACHE.clear(); }

// LOCAL_SPEED_V1 — отпечаток файла: { key, mtimeMs }; нет файла — 'none';
// stat не удался по другой причине — null (тогда не храним вовсе, читаем как прежде).
function fileSig(file) {
  let st;
  try { st = fs.statSync(file, { throwIfNoEntry: false }); } catch { return null; }
  if (!st) return { key: 'none', mtimeMs: null };
  return { key: st.mtimeMs + ':' + st.size, mtimeMs: st.mtimeMs };
}

// LOCAL_SPEED_V1 — то, что раньше controlState читал с диска на каждом вызове, в
// том же порядке: control.json; если он бессмыслица — licence.dat не нужен.
function readFacts(idFile, licFile) {
  const identity = readJson(idFile);

  // clinic_id must be a string: verifyLicence compares it with `!==` against
  // payload.clinic_id (always a string, part of the signed document), so a
  // JSON control.json containing a number, an array, or clinic_id:null would
  // otherwise sail past this check and simply fail wrong_clinic below — locked
  // either way, but for a misleading reason. Failing here as not_enrolled keeps
  // "identity file is nonsense" and "licence doesn't match this clinic"
  // distinct.
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      typeof identity.clinic_id !== 'string' || !identity.clinic_id) {
    return { identity: null, verified: null };
  }
  const verified = verifyLicence(readText(licFile), {
    publicKey: _testPublicKey,
    clinicId: identity.clinic_id,
  });
  return { identity, verified };
}

function fileFacts(dataDir) {   // LOCAL_SPEED_V1
  const idFile = path.join(dataDir, 'control.json');
  const licFile = path.join(dataDir, 'licence.dat');
  const readAt = Date.now();
  const a = fileSig(idFile);
  const b = fileSig(licFile);
  const sig = a && b ? a.key + '|' + b.key : null;
  const hit = sig ? FILE_CACHE.get(dataDir) : null;
  if (hit && hit.sig === sig) return hit.facts;

  const facts = readFacts(idFile, licFile);
  // Храним, только если оба файла «остыли»: изменены раньше, чем RACY_MS до чтения.
  // Часы, ушедшие назад (время файла «в будущем»), — тоже не храним: читаем как прежде.
  const cold = (s) => s.mtimeMs == null || s.mtimeMs + RACY_MS < readAt;
  FILE_CACHE.delete(dataDir);
  if (sig && cold(a) && cold(b)) {
    if (FILE_CACHE.size >= FILE_CACHE_MAX) FILE_CACHE.delete(FILE_CACHE.keys().next().value);
    FILE_CACHE.set(dataDir, { sig, facts });
  }
  return facts;
}

// A locked, reasoned answer with no modules and no identity — the shape every
// early-exit path returns, so a corrupt file never produces a different
// (partially-filled, harder to reason about) result than a missing one.
function lockedResult(reason) {
  return shape({ state: 'locked', locked: true, daysLeft: 0, reason }, [], null, null, false);
}

/**
 * @param {Database} db
 * @param {string}   dataDir  where control.json and licence.dat live
 * @param {Date}     [systemNow]
 * @returns {{
 *   locked:boolean, state:string, reason:string, daysLeft:number,
 *   modules:string[], clinicId:string|null, clinicName:string|null,
 *   clockAnomaly:boolean, has:(key:string)=>boolean
 * }}
 */
export function controlState(db, dataDir, systemNow = new Date()) {
  // dataDir is a path built from config elsewhere; path.join(null|undefined, x)
  // throws TypeError before readJson ever gets a chance to fail closed. This is
  // the one input readJson's try/catch cannot reach because the throw happens
  // constructing the ARGUMENT to readJson, not inside it.
  if (typeof dataDir !== 'string') return lockedResult('not_enrolled');

  // LOCAL_SPEED_V1 — файлы, их разбор и проверка подписи — из памяти, пока
  // файлы не изменились (fileFacts выше); проверка формы control.json — там же.
  const { identity, verified: result } = fileFacts(dataDir);
  if (!identity) return lockedResult('not_enrolled');

  // effectiveNow/clockAnomaly write to control_state (INSERT..ON CONFLICT).
  // Everything else in this module reads a file; these are the only calls that
  // touch the disk-backed database, and the one place a full disk or a
  // read-only mount (both real clinic-PC failure modes) turns into a thrown
  // exception instead of a returned {ok:false}. The sibling modules do not
  // guard this themselves (clock.js's own docs assume a working table), so the
  // guard belongs here, at the one caller that promises never to throw.
  let now, anomaly;
  try {
    now = effectiveNow(db, systemNow);
    anomaly = clockAnomaly(db);
  } catch {
    return lockedResult('clock_unavailable');
  }

  // LOCAL_SPEED_V1 — `result` (verifyLicence licence.dat для этой клиники) уже
  // получен выше из fileFacts: проверка подписи от времени не зависит.
  const licence = result.ok ? result.licence : null;

  // A telephone unlock cannot rewrite the signed licence, so it is recorded
  // separately and simply wins when it reaches further into the future.
  // extensionUntil() only ever reads control_state (see unlock.js) so it is not
  // wrapped here the way the write path above is — but a corrupt stored value
  // ("not a date") must not poison the max() below, hence the isNaN filter.
  let ext = null;
  try { ext = extensionUntil(db); } catch { ext = null; }

  const dates = [licence?.valid_until, ext].filter(Boolean).map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()));
  const until = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString() : null;

  const ladder = ladderState({ validUntil: until, now, subscription: identity.subscription || 'active' });

  // Modules are granted only while unlocked. A lapsed clinic has none, which is
  // what makes the whole app fall back to the activation screen. Non-string
  // entries (a corrupted or hand-edited licence payload: [1, 2, {}]) are
  // dropped rather than passed through — has() keys a Set off these values, and
  // an app route calling has(moduleKey) with a real module string must never
  // match by accident against an object or number that happened to be present.
  const modules = !ladder.locked && licence && Array.isArray(licence.modules)
    ? licence.modules.filter((m) => typeof m === 'string')
    : [];

  return shape(ladder, modules, identity.clinic_id, licence?.clinic_name ?? null, anomaly, until);
}

function shape(ladder, modules, clinicId, clinicName, clockAnomalyFlag, validUntil = null) {
  const set = new Set(modules);
  return {
    state:    ladder.state,
    locked:   ladder.locked,
    reason:   ladder.reason,
    daysLeft: ladder.daysLeft,
    modules,
    clinicId,
    clinicName,
    clockAnomaly: clockAnomalyFlag,
    // SYSTEM_SETTINGS_V1 — the EFFECTIVE expiry (`until` above: licence vs.
    // phone extension, whichever reaches further), not the raw licence field.
    // It is the date daysLeft counts down to, and the settings screen shows
    // the two side by side — a date that disagreed with its own countdown
    // would read as a bug to the clinic.
    validUntil,
    has: (key) => set.has(key),
  };
}
