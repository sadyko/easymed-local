import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { compareVersions } from './bundle.js';
import {
  readProgress, writeProgress, clearProgress, makeProgressReporter,
  reconcileProgressAtBoot, progressForStatus, DEFAULT_MIN_INTERVAL_MS,
} from './update-progress.js';

// UPDATE_PROGRESS_V1 (2026-08-30) — the record behind «идёт загрузка».
//
// Two properties matter more than any of the formatting: it must never be
// able to fail the update it describes, and it must never keep claiming to be
// downloading after the process that WAS downloading has gone.

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}

/** A clock a test drives by hand — the throttle is a time rule and must be tested as one, not by really waiting. */
function fakeClock(startMs = Date.parse('2026-08-30T03:00:00.000Z')) {
  let t = startMs;
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

function countRows(d) {
  return d.prepare("SELECT COUNT(*) c FROM control_state WHERE key = 'update_progress'").get().c;
}

// --- storage ----------------------------------------------------------------

test('readProgress: nothing stored reads as null, never throws', () => {
  assert.equal(readProgress(db()), null);
});

test('readProgress: a corrupt or non-object row reads as "no progress", never a crash on the screen', () => {
  const d = db();
  for (const bad of ['not json', '[]', 'null', '42']) {
    d.prepare("INSERT INTO control_state (key, value, updated_at) VALUES ('update_progress', ?, '2026-08-30T03:00:00Z') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(bad);
    assert.equal(readProgress(d), null, `value=${bad}`);
  }
});

test('writeProgress: a failing database write is swallowed — bookkeeping may never fail an update', () => {
  // The whole discipline branch-sync/relay.js applies to its own LAST_PUBLISH
  // write. A closed connection is the bluntest way to prove it here.
  const d = db();
  d.close();
  assert.equal(writeProgress(d, { version: '0.4.6', phase: 'downloading' }), false, 'reports failure...');
  assert.doesNotThrow(() => writeProgress(d, { phase: 'x' }), '...but never throws it at the pipeline');
  assert.doesNotThrow(() => clearProgress(d));
  assert.equal(readProgress(d), null, 'and reading a dead connection is null, not an exception');
});

// --- the reporter -----------------------------------------------------------

test('reporter: a phase change is always written, throttle or not', () => {
  const d = db();
  const clock = fakeClock();
  const r = makeProgressReporter(d, { version: '0.4.6', now: clock.now });

  r.phase('downloading');
  assert.equal(readProgress(d).phase, 'downloading');
  // Immediately after, with no time passed at all: a phase is rare and is the
  // thing the screen most needs to be current about.
  r.phase('verifying');
  assert.equal(readProgress(d).phase, 'verifying');
});

test('reporter: byte counts are throttled — a write per chunk would hammer the clinic database', () => {
  const d = db();
  const clock = fakeClock();
  const r = makeProgressReporter(d, { version: '0.4.6', now: clock.now, minIntervalMs: 2000 });
  r.phase('downloading');

  assert.equal(r.bytes(1000, 40000), false, 'a byte report right after the phase write is swallowed');
  assert.equal(r.bytes(2000, 40000), false);
  assert.equal(readProgress(d).bytes, 0, 'nothing was persisted in between');

  clock.advance(1999);
  assert.equal(r.bytes(3000, 40000), false, 'one millisecond short of the interval');

  clock.advance(1);
  assert.equal(r.bytes(4000, 40000), true, 'the interval elapsed — now it lands');
  assert.equal(readProgress(d).bytes, 4000);
});

test('reporter: the FINAL byte count is forced past the throttle', () => {
  const d = db();
  const clock = fakeClock();
  const r = makeProgressReporter(d, { version: '0.4.6', now: clock.now, minIntervalMs: 2000 });
  r.phase('downloading');
  r.bytes(1000, 40000);                    // throttled away
  assert.equal(r.bytes(40000, 40000, { force: true }), true);
  // Without the force the record's last word on a finished download would be
  // whatever it said up to two seconds before the end.
  assert.equal(readProgress(d).bytes, 40000);
});

test('reporter: 1000 chunks in one second cost ONE write, not 1000', () => {
  const d = db();
  const clock = fakeClock();
  const r = makeProgressReporter(d, { version: '0.4.6', now: clock.now, minIntervalMs: DEFAULT_MIN_INTERVAL_MS });
  r.phase('downloading');
  let written = 0;
  for (let i = 1; i <= 1000; i += 1) {
    clock.advance(1);                       // 1 ms apart — a real fast LAN download
    if (r.bytes(i * 8192, 40 * 1024 * 1024)) written += 1;
  }
  assert.equal(written, 0, 'one second of chunks is inside a single 2s window');
  clock.advance(DEFAULT_MIN_INTERVAL_MS);
  assert.equal(r.bytes(9_000_000, 40 * 1024 * 1024), true);
});

test('reporter: an absent/zero/garbage Content-Length stores total:null — never a fake denominator', () => {
  const d = db();
  const clock = fakeClock();
  const r = makeProgressReporter(d, { version: '0.4.6', now: clock.now, minIntervalMs: 0 });
  for (const bad of [null, undefined, 0, -1, NaN, 'x']) {
    r.bytes(500, bad, { force: true });
    assert.equal(readProgress(d).total, null, `content-length=${JSON.stringify(bad)}`);
  }
  r.bytes(500, 40000, { force: true });
  assert.equal(readProgress(d).total, 40000);
});

test('reporter: `at` moves with every write — that timestamp is how a stall is ever noticed', () => {
  const d = db();
  const clock = fakeClock();
  const r = makeProgressReporter(d, { version: '0.4.6', now: clock.now, minIntervalMs: 0 });
  r.phase('downloading');
  const first = readProgress(d).at;
  clock.advance(60_000);
  r.bytes(1, null, { force: true });
  assert.notEqual(readProgress(d).at, first);
  assert.equal(readProgress(d).started_at, first, 'started_at stays put — it is when the whole thing began');
});

test('reporter: fail() is terminal and keeps the reason; clear() removes the row entirely', () => {
  const d = db();
  const r = makeProgressReporter(d, { version: '0.4.6', now: fakeClock().now });
  r.phase('downloading');
  r.fail('network');
  assert.equal(readProgress(d).phase, 'failed');
  assert.equal(readProgress(d).reason, 'network');
  r.clear();
  assert.equal(countRows(d), 0);
});

// --- the stale-record rule --------------------------------------------------

test('boot: a live record naming the version now RUNNING is deleted — the update landed, say nothing', () => {
  const d = db();
  writeProgress(d, { version: '0.4.6', phase: 'switching', bytes: 1, total: 1, at: new Date().toISOString() });
  assert.equal(reconcileProgressAtBoot(d, { runningVersion: '0.4.6', compare: compareVersions }), 'deleted');
  assert.equal(countRows(d), 0, 'a clinic must not open the screen after a good update and see «переключение…»');
});

test('boot: a live record OLDER than the running version is also gone (several updates later)', () => {
  const d = db();
  writeProgress(d, { version: '0.4.6', phase: 'downloading', bytes: 10, total: 100, at: new Date().toISOString() });
  assert.equal(reconcileProgressAtBoot(d, { runningVersion: '0.5.0', compare: compareVersions }), 'deleted');
});

test('boot: a live record for a version that never arrived becomes `interrupted`, not a frozen 40%', () => {
  const d = db();
  writeProgress(d, { version: '0.4.6', phase: 'downloading', bytes: 16, total: 40, at: '2026-08-30T03:00:00.000Z' });
  assert.equal(reconcileProgressAtBoot(d, { runningVersion: '0.4.5', compare: compareVersions }), 'interrupted');
  const rec = readProgress(d);
  assert.equal(rec.phase, 'interrupted');
  assert.equal(rec.version, '0.4.6');
  assert.equal(rec.bytes, 16, 'how far it got is kept — it is the useful half of the news');
});

test('boot: the pipeline lives in ONE process, so every live phase is dead by the time we boot', () => {
  for (const phase of ['downloading', 'verifying', 'unpacking', 'snapshot', 'switching']) {
    const d = db();
    writeProgress(d, { version: '9.9.9', phase, at: '2026-08-30T03:00:00.000Z' });
    assert.equal(reconcileProgressAtBoot(d, { runningVersion: '0.4.5', compare: compareVersions }), 'interrupted', phase);
  }
});

test('boot: a recent terminal record is kept (it explains the restart the clinic just lived through)', () => {
  const d = db();
  const clock = fakeClock();
  writeProgress(d, { version: '0.4.6', phase: 'failed', reason: 'network', at: clock.now().toISOString() });
  clock.advance(60 * 60 * 1000);
  assert.equal(reconcileProgressAtBoot(d, { runningVersion: '0.4.5', now: clock.now, compare: compareVersions }), 'kept');
  assert.equal(readProgress(d).phase, 'failed');
});

test('boot: a terminal record older than a day is dropped — it has been read by now', () => {
  const d = db();
  const clock = fakeClock();
  writeProgress(d, { version: '0.4.6', phase: 'interrupted', at: clock.now().toISOString() });
  clock.advance(25 * 60 * 60 * 1000);
  assert.equal(reconcileProgressAtBoot(d, { runningVersion: '0.4.5', now: clock.now, compare: compareVersions }), 'deleted');
  assert.equal(countRows(d), 0);
});

test('boot: nothing stored is a no-op', () => {
  assert.equal(reconcileProgressAtBoot(db(), { runningVersion: '0.4.5', compare: compareVersions }), 'none');
});

test('boot: no runningVersion known — the record is treated as interrupted, never left claiming to download', () => {
  const d = db();
  writeProgress(d, { version: '0.4.6', phase: 'downloading', at: '2026-08-30T03:00:00.000Z' });
  assert.equal(reconcileProgressAtBoot(d, { runningVersion: null, compare: compareVersions }), 'interrupted');
});

// --- what the screen is handed ----------------------------------------------

test('progressForStatus: age_ms is computed on the SERVER clock, so a wrong clinic clock cannot fake a stall', () => {
  const d = db();
  const clock = fakeClock();
  writeProgress(d, { version: '0.4.6', phase: 'downloading', bytes: 5, total: 10, at: clock.now().toISOString() });
  clock.advance(45_000);
  const p = progressForStatus(d, { now: clock.now });
  assert.equal(p.age_ms, 45_000);
  assert.equal(p.phase, 'downloading');
  assert.equal(p.bytes, 5);
});

test('progressForStatus: an unparseable `at` degrades to age_ms:null rather than NaN', () => {
  const d = db();
  writeProgress(d, { version: '0.4.6', phase: 'downloading', at: 'not a date' });
  assert.equal(progressForStatus(d).age_ms, null);
});

test('progressForStatus: null when there is nothing to report', () => {
  assert.equal(progressForStatus(db()), null);
});
