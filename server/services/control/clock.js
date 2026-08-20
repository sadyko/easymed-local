// LICENCE_CORE_V1 — time that only moves forwards.
//
// A licence that expires on a date is trivially defeated by setting the PC clock
// back a month, and a clinic PC's clock is not protected in any way. So the
// install remembers the latest moment it has ever observed and refuses to believe
// anything earlier.
//
// Tolerance exists because clocks legitimately step backwards: NTP corrects
// drift, and Windows resyncs after sleep. A few minutes is housekeeping. A month
// is somebody trying it on, and the vendor should hear about it.

const KEY_HIGH_WATER = 'clock_high_water';
const KEY_ANOMALY    = 'clock_anomaly';
const TOLERANCE_MS   = 5 * 60 * 1000;

function get(db, key) {
  return db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null;
}

function put(db, key, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/**
 * The current time, floored at the highest moment ever seen.
 * @param {Database} db
 * @param {Date} [systemNow] injectable for tests
 * @returns {Date}
 */
export function effectiveNow(db, systemNow = new Date()) {
  // A corrupt or hand-edited clock_high_water ("", "not a date", ...) must not
  // silently disable the defence. new Date('nonsense') is an Invalid Date, and
  // Invalid Date is still a truthy object, so a check that only does
  // `if (stored)` would treat corruption as a real, comparable high-water mark
  // — and every comparison against an Invalid Date (<, >, ==) is false, which
  // would make the "are we behind?" check silently never fire again. Treating
  // an unparseable stored value as "nothing recorded yet" makes corruption
  // equivalent to a fresh install (loses the old mark, but keeps the defence
  // live from this call forward) instead of turning the defence off forever
  // with no error and nothing to see in the logs.
  const stored = get(db, KEY_HIGH_WATER);
  const storedDate = stored ? new Date(stored) : null;
  const high = isValidDate(storedDate) ? storedDate : null;

  if (!isValidDate(systemNow)) {
    // Not a real observation — a caller bug (`new Date(undefined)`, a bad
    // upstream date parse) rather than a clock reading. toISOString() on an
    // Invalid Date throws RangeError, so passing it straight to put() below
    // would crash the request that was only trying to check a licence.
    // Handing back the last known-good mark unchanged (no write, no tamper
    // check) means a caller bug can never (a) crash the request, (b) poison
    // the recorded mark with "Invalid Date", or (c) get compared against a
    // fabricated substitute time and misreported as a clock-winding attempt —
    // which an earlier version of this code did: it fell back to `new Date()`
    // and ran the anomaly check against that, and a stored mark set further in
    // the future than the real wall clock (e.g. after a prior fast-forward)
    // then read as a fresh tamper attempt on every subsequent bad-input call.
    // Only a truly fresh install with no mark yet has nothing to fall back to,
    // so that case bootstraps from the real clock exactly as "first ever call"
    // does below.
    if (high) return high;
    systemNow = new Date();
  }

  if (high && systemNow.getTime() < high.getTime()) {
    if (high.getTime() - systemNow.getTime() > TOLERANCE_MS) put(db, KEY_ANOMALY, '1');
    return high;
  }

  // Only write when the mark actually advances (or is being established for
  // the first time / re-established after a corrupt value) — not on every
  // call. effectiveNow runs on every licence-gated request, and the common
  // case is the clock hasn't advanced past the stored mark since the last
  // check. Measured (server/services/control/clock.js, 2026-08-20) with
  // better-sqlite3 in WAL mode, 20000 calls passing the SAME instant each
  // time, file-backed (not :memory:): unconditional INSERT..ON CONFLICT
  // UPDATE every call averaged ~13.3us/call; skipping the write when the
  // value doesn't change averaged ~5.7us/call — about 2.3x, not the order of
  // magnitude that would justify more machinery than a single comparison.
  // Kept anyway because it's a one-line guard, and because it stops every
  // licence check on a quiet clinic PC from generating a WAL write.
  if (!high || systemNow.getTime() > high.getTime()) {
    put(db, KEY_HIGH_WATER, systemNow.toISOString());
  }
  return systemNow;
}

/**
 * Has this install ever seen its clock jump meaningfully backwards?
 *
 * Deliberately does not self-clear. A dead CMOS battery waking a clinic PC up
 * with its clock reset to a manufacture date is real and is not fraud, and a
 * flag that clears itself the next time the clock reports something plausible
 * would be a flag an attacker defeats just by winding the clock forward again
 * past whatever tripped it — the exact same action that raised it. Telling a
 * bad battery apart from somebody trying it on needs a human, on the vendor
 * side, looking at more than one install's history; that decision (a later
 * task) is the only thing that clears this flag. This module only ever raises
 * it.
 */
export function clockAnomaly(db) {
  return get(db, KEY_ANOMALY) === '1';
}
