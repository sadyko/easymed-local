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
export function __setPublicKeyForTests(key) { _testPublicKey = key; }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
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

  const identity = readJson(path.join(dataDir, 'control.json'));

  // clinic_id must be a string: verifyLicence compares it with `!==` against
  // payload.clinic_id (always a string, part of the signed document), so a
  // JSON control.json containing a number, an array, or clinic_id:null would
  // otherwise sail past this check and simply fail wrong_clinic below — locked
  // either way, but for a misleading reason. Failing here as not_enrolled keeps
  // "identity file is nonsense" and "licence doesn't match this clinic"
  // distinct.
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      typeof identity.clinic_id !== 'string' || !identity.clinic_id) {
    return lockedResult('not_enrolled');
  }

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

  const result = verifyLicence(readText(path.join(dataDir, 'licence.dat')), {
    publicKey: _testPublicKey,
    clinicId: identity.clinic_id,
  });

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
