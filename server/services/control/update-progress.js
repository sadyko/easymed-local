// UPDATE_PROGRESS_V1 (2026-08-30, owner: «can we show status of the
// downloading of the last update please fix that») — the one record that says
// what an update is DOING right now.
//
// Until this file existed the screen went straight from «Доступно обновление»
// to «установлено», with nothing in between. A clinic on a slow line could
// not tell a 40 MB download from a hung socket, and the honest answer to
// "is it stuck?" was "close the window and see".
//
// THE RULE THAT OUTRANKS EVERYTHING HERE, inherited from updater.js's own
// header: nothing in this file may harm the update it is reporting on. Every
// write is best-effort and swallowed — the same discipline branch-sync/
// relay.js applies to its LAST_PUBLISH bookkeeping (`try { putState(…) }
// catch`), for the same reason: a counter nobody's life depends on must never
// be the thing that fails a release.
//
// WHY control_state AND NOT A FILE: update_status (rpc/updates.js) already
// reads its offer/consent/schedule out of control_state on the same
// connection, so the screen gets progress in the call it was already making —
// no second read path, no second thing that can be half-written. The pipeline
// runs in the same process as the server answering that RPC.
//
// WHY IT CAN GO STALE, AND WHY THAT IS SOLVED AT BOOT: the whole pipeline
// (download → verify → unpack → snapshot → switch) runs INSIDE ONE PROCESS,
// and a successful update ends that process with exit(75). So any record
// still in a live phase when a process starts up belongs to a process that no
// longer exists — it is dead by definition, never "still running". That is
// what reconcileProgressAtBoot() below acts on, and it is why a clinic can
// never come back to a frozen «загружено 40%» that will never move again.

const KEY = 'update_progress';

/** Phases in the order runPipeline goes through them. */
export const PHASES = Object.freeze(['downloading', 'verifying', 'unpacking', 'snapshot', 'switching']);
/** Phases that mean "a process is working on this right now". */
const LIVE_PHASES = new Set(PHASES);

// A byte counter written on every chunk would mean thousands of SQLite writes
// per download, on the clinic's own live database, for a number that changes
// faster than a human can read it. Two seconds is below the threshold where a
// progress bar looks frozen and far above the rate at which chunks arrive.
export const DEFAULT_MIN_INTERVAL_MS = 2000;

// How long a record may sit unchanged before the screen should stop calling it
// progress. Writes are throttled to 2s, so 90s of silence is not a slow line —
// it is a socket that has stopped delivering. This is the number that answers
// the owner's actual question: slow, or stuck?
export const STALL_MS = 90 * 1000;

// An interrupted/failed record is worth showing for a while (it explains a
// restart the clinic just lived through) but not forever — a week-old notice
// is noise. A day covers "I came in the next morning and looked".
const TERMINAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function put(db, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(KEY, String(value));
}

/** The record as stored, or null. Never throws — a corrupt row reads as "no progress". */
export function readProgress(db) {
  try {
    const raw = db.prepare('SELECT value FROM control_state WHERE key = ?').get(KEY)?.value ?? null;
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Best-effort write. Returns true if it landed; NEVER throws — see the header. */
export function writeProgress(db, record) {
  try {
    put(db, JSON.stringify(record));
    return true;
  } catch (e) {
    console.warn('[updater] could not record update progress (the update itself is unaffected):', e && e.message);
    return false;
  }
}

/** Best-effort delete. Never throws. */
export function clearProgress(db) {
  try {
    db.prepare('DELETE FROM control_state WHERE key = ?').run(KEY);
    return true;
  } catch (e) {
    console.warn('[updater] could not clear update progress:', e && e.message);
    return false;
  }
}

/**
 * The handle runPipeline reports through.
 *
 * `phase()` always writes — a phase change is rare and is the thing the
 * screen most needs to be current about. `bytes()` is throttled, because it
 * is the one call that happens thousands of times.
 *
 * @param {Database} db
 * @param {object} opts
 * @param {string} opts.version           the version being installed
 * @param {() => Date} [opts.now]
 * @param {number} [opts.minIntervalMs]   throttle floor for bytes()
 */
export function makeProgressReporter(db, { version, now = () => new Date(), minIntervalMs = DEFAULT_MIN_INTERVAL_MS } = {}) {
  const startedAt = now().toISOString();
  let lastWriteMs = 0;
  const record = { version, phase: null, bytes: 0, total: null, started_at: startedAt, at: startedAt };

  const flush = (nowMs) => {
    record.at = new Date(nowMs).toISOString();
    lastWriteMs = nowMs;
    writeProgress(db, { ...record });
  };

  return {
    /** Move to a named phase. Always written. */
    phase(name) {
      record.phase = name;
      flush(now().getTime());
    },
    /**
     * Report download bytes. Throttled to minIntervalMs, except when `force`
     * is set — the final count at the end of a download must not be lost to
     * the throttle, or the record's last word on a finished download is
     * whatever it happened to say two seconds earlier.
     */
    bytes(received, total, { force = false } = {}) {
      record.bytes = received;
      // A Content-Length that is absent, zero or unparseable stays null: the
      // screen says "downloaded N MB" rather than inventing a percentage of
      // an unknown whole. See progressView() in the client logic.
      record.total = Number.isFinite(total) && total > 0 ? total : null;
      const nowMs = now().getTime();
      if (!force && nowMs - lastWriteMs < minIntervalMs) return false;
      flush(nowMs);
      return true;
    },
    /** A terminal failure. Kept (not deleted) so the screen can say what happened. */
    fail(reason) {
      record.phase = 'failed';
      record.reason = String(reason || 'unknown');
      flush(now().getTime());
    },
    /** Terminal success / nothing more to say. */
    clear() { clearProgress(db); },
  };
}

/**
 * Called ONCE at boot, before the minute timer is armed.
 *
 * The pipeline lives inside one process, so a live-phase record found at boot
 * is always the corpse of a previous one. Two outcomes:
 *
 *   - it names a version this process is already RUNNING (or older): the
 *     update landed and the exit(75) restart is what brought us here. Nothing
 *     to report — delete it. (This is the normal, successful path: a clinic
 *     must not open the screen after a good update and see «переключение на
 *     новую версию…» from a minute ago.)
 *   - anything else: it died mid-flight — the window was closed, the machine
 *     was switched off, the process crashed. Marked `interrupted` so the
 *     screen can say so plainly. A stale «загружено 40%» that never moves
 *     again is worse than nothing, which is precisely why this cannot be
 *     left as-is.
 *
 * Terminal records (failed/interrupted) older than a day are dropped: they
 * have been read by now, and the offer they refer to is long gone.
 *
 * @returns {'deleted'|'interrupted'|'kept'|'none'} what it did, for tests and logs
 */
export function reconcileProgressAtBoot(db, { runningVersion = null, now = () => new Date(), compare } = {}) {
  const rec = readProgress(db);
  if (!rec) return 'none';

  if (LIVE_PHASES.has(rec.phase)) {
    // compare is injected (updater.js's compareVersions) rather than imported,
    // so this module stays free of the bundle/verify import chain — it is
    // loaded by rpc/updates.js too, on every status call.
    const landed = runningVersion && rec.version
      && (typeof compare === 'function' ? compare(rec.version, runningVersion) <= 0 : rec.version === runningVersion);
    if (landed) { clearProgress(db); return 'deleted'; }
    writeProgress(db, { ...rec, phase: 'interrupted', at: now().toISOString() });
    return 'interrupted';
  }

  const at = rec.at ? Date.parse(rec.at) : NaN;
  if (Number.isFinite(at) && now().getTime() - at > TERMINAL_MAX_AGE_MS) {
    clearProgress(db);
    return 'deleted';
  }
  return 'kept';
}

/**
 * What update_status hands the screen.
 *
 * `age_ms` is computed HERE, on the server, and not left to the browser to
 * work out from `at`: a clinic PC whose clock is a few hours off would
 * otherwise call a healthy download stalled, or a stalled one healthy. The
 * client only ever compares one number against one threshold.
 */
export function progressForStatus(db, { now = () => new Date() } = {}) {
  const rec = readProgress(db);
  if (!rec) return null;
  const at = rec.at ? Date.parse(rec.at) : NaN;
  const ageMs = Number.isFinite(at) ? Math.max(0, now().getTime() - at) : null;
  return { ...rec, age_ms: ageMs };
}
