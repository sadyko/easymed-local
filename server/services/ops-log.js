// OPS_EVENTS_V1 — the write side of statistics.
//
// recordEvent can NEVER throw. It runs inside the error handler, inside the
// slow-request logger, inside the login path — a broken statistics write must
// never break the request that triggered it, and a statistics bug during an
// error must never mask the error. Telemetry is the least important thing in
// the process and must act like it.

// A path template, e.g. "/api/patients/:id" or "/api/rpc/run_report" — never
// a URL. Rejects query strings, spaces, and non-ASCII (a Cyrillic patient
// name in a mistakenly-passed req.url would fail this). Defence in depth:
// callers are supposed to pass req.route.path, never req.url, but this is
// what makes that a guarantee instead of a convention.
const ROUTE_RE = /^[/A-Za-z0-9_:-]{1,120}$/;

// Same-day cap per kind — a clinic with a misconfigured integration hammering
// 500s (or a flaky LAN device retrying a doomed login every second) must not
// turn one bug into unbounded writes between the 14-day prune runs below.
// 2000/kind/day is generous for a real single clinic (a handful of errors a
// day is normal; even a very bad hour of 500s tops out in the hundreds) but
// still bounds worst case to roughly 2000 * 4 kinds * 14 days ≈ 112,000 rows —
// a few MB, nothing a clinic PC's SQLite file will notice. In-memory and
// reset on restart, same tradeoff as auth.js's failedAttempts: telemetry may
// under-count after a crash-loop, which is fine, because the thing that must
// never be lost is the error itself (still console.error'd and still
// returned to the caller every single time), not the count of it.
const DAILY_CAP = 2000;
const dayCounts = new Map(); // "kind|YYYY-MM-DD" -> count

function underDailyCap(kind) {
  const day = new Date().toISOString().slice(0, 10);
  const key = kind + '|' + day;
  const n = dayCounts.get(key) || 0;
  if (n >= DAILY_CAP) return false;
  dayCounts.set(key, n + 1);
  // Bounded map: a day key is only ever added, never removed by anything
  // else, so without this a process left running for months would slowly
  // accumulate one entry per kind per day forever. 4 kinds means this only
  // ever needs to hold a handful of entries per real day.
  if (dayCounts.size > 4 * 60) {
    const oldestKey = dayCounts.keys().next().value;
    dayCounts.delete(oldestKey);
  }
  return true;
}

export function recordEvent(db, kind, route = null) {
  try {
    if (!underDailyCap(kind)) return;
    const safeRoute = (typeof route === 'string' && ROUTE_RE.test(route)) ? route : null;
    db.prepare('INSERT INTO ops_events (kind, route) VALUES (?, ?)').run(kind, safeRoute);
  } catch {
    // Swallow everything: a bad db handle, a closed connection, a
    // pre-migration database with no ops_events table yet, an unknown kind
    // tripping the CHECK constraint — none of these may propagate. See the
    // file header: recordEvent runs inside the error handler itself, so a
    // throw here would replace the real error with a statistics bug.
  }
}

export function pruneOpsEvents(db, days = 14) {
  try {
    db.prepare(
      "DELETE FROM ops_events WHERE at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-' || ? || ' days')"
    ).run(days);
  } catch {
    // Same reasoning as recordEvent — pruning is hygiene, not correctness,
    // and must never be the reason boot fails.
  }
}
