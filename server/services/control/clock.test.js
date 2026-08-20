import { test } from 'node:test';
import assert from 'node:assert';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { effectiveNow, clockAnomaly } from './clock.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('normal time passing is reported as-is', () => {
  const db = fresh();
  assert.equal(effectiveNow(db, new Date('2026-08-20T10:00:00Z')).toISOString(), '2026-08-20T10:00:00.000Z');
  assert.equal(effectiveNow(db, new Date('2026-08-21T10:00:00Z')).toISOString(), '2026-08-21T10:00:00.000Z');
  assert.equal(clockAnomaly(db), false);
});

test('winding the clock back does not turn time back', () => {
  const db = fresh();
  effectiveNow(db, new Date('2026-09-01T00:00:00Z'));
  const back = effectiveNow(db, new Date('2026-08-01T00:00:00Z'));   // the licence-dodging move
  assert.equal(back.toISOString(), '2026-09-01T00:00:00.000Z', 'the high-water mark wins');
  assert.equal(clockAnomaly(db), true, 'and it is recorded for the vendor');
});

test('the high-water mark survives a restart', () => {
  const db = fresh();
  effectiveNow(db, new Date('2026-09-01T00:00:00Z'));
  // A new module instance reading the same database is exactly what a restart is.
  assert.equal(
    effectiveNow(db, new Date('2026-08-01T00:00:00Z')).toISOString(),
    '2026-09-01T00:00:00.000Z'
  );
});

test('small backward drift is tolerated without crying tamper', () => {
  const db = fresh();
  effectiveNow(db, new Date('2026-09-01T00:00:00Z'));
  effectiveNow(db, new Date('2026-09-01T00:00:00Z'));         // NTP nudges of a few seconds
  const drift = effectiveNow(db, new Date('2026-08-31T23:59:30Z'));
  assert.equal(drift.toISOString(), '2026-09-01T00:00:00.000Z', 'still never goes backwards');
  assert.equal(clockAnomaly(db), false, '30 seconds is NTP, not fraud');
});

// --- adversarial follow-ups, added after attacking the first implementation ---

test('an Invalid Date passed as systemNow does not crash and does not disturb the recorded mark', () => {
  const db = fresh();
  effectiveNow(db, new Date('2026-09-01T00:00:00Z'));
  // A caller bug (new Date(undefined), a bad upstream date parse) must not take
  // down a request that was only trying to check a licence. The naive version of
  // this code called systemNow.toISOString() unconditionally on this path and
  // threw RangeError: Invalid time value — reproduced against it before this
  // test was written.
  let result;
  assert.doesNotThrow(() => { result = effectiveNow(db, new Date(undefined)); });
  assert.equal(result.toISOString(), '2026-09-01T00:00:00.000Z', 'falls back to the last known-good mark');
  assert.equal(clockAnomaly(db), false, 'a caller bug is not tamper evidence');
});

test('an unchanged instant does not re-write the high-water row', () => {
  const db = fresh();
  // Trigger-based write counter: updated_at has only second resolution, so
  // comparing timestamps before/after cannot tell "wrote the same value back"
  // from "wrote nothing" when both calls land in the same second. Counting
  // rows an AFTER INSERT/UPDATE trigger appends can.
  db.exec(`
    CREATE TABLE write_probe (n INTEGER);
    CREATE TRIGGER wp_ins AFTER INSERT ON control_state BEGIN INSERT INTO write_probe (n) VALUES (1); END;
    CREATE TRIGGER wp_upd AFTER UPDATE ON control_state BEGIN INSERT INTO write_probe (n) VALUES (1); END;
  `);
  effectiveNow(db, new Date('2026-09-01T00:00:00Z'));
  const before = db.prepare('SELECT COUNT(*) c FROM write_probe').get().c;
  effectiveNow(db, new Date('2026-09-01T00:00:00Z'));   // same instant again — nothing to record
  const after = db.prepare('SELECT COUNT(*) c FROM write_probe').get().c;
  assert.equal(after, before, 'no new row for an instant that does not advance the mark');
});

test('the anomaly flag does not clear itself once raised', () => {
  const db = fresh();
  effectiveNow(db, new Date('2026-09-01T00:00:00Z'));
  effectiveNow(db, new Date('2026-08-01T00:00:00Z'));   // tamper attempt, flags it
  assert.equal(clockAnomaly(db), true);
  effectiveNow(db, new Date('2026-09-02T00:00:00Z'));   // clock behaves normally again afterwards
  // Clearing this is a vendor decision (a later task), not something this module
  // resets on its own — a self-clearing flag is one an attacker defeats just by
  // winding the clock forward again, the same action that raised it.
  assert.equal(clockAnomaly(db), true, 'a flagged install stays flagged until the vendor clears it');
});

test('a corrupt stored high-water value does not silently disable the defence', () => {
  const db = fresh();
  // Simulates a hand-edited or disk-corrupted row: new Date('not a date') is an
  // Invalid Date, and every comparison against one (<, >, ==) is false — so a
  // check that only tests truthiness of the stored value, without validating it
  // parsed, would treat this as a real mark that can never be "behind".
  db.prepare('INSERT INTO control_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('clock_high_water', 'not a date', '2026-01-01T00:00:00Z');

  const first = effectiveNow(db, new Date('2026-09-01T00:00:00Z'));
  assert.equal(first.toISOString(), '2026-09-01T00:00:00.000Z', 'recovers by treating corrupt data as no mark yet');

  const back = effectiveNow(db, new Date('2026-08-01T00:00:00Z'));
  assert.equal(back.toISOString(), '2026-09-01T00:00:00.000Z', 'the defence is live again, not switched off for good');
});

test('millisecond precision survives the ISO round trip', () => {
  const db = fresh();
  const withMillis = new Date('2026-09-01T00:00:00.123Z');
  const result = effectiveNow(db, withMillis);
  assert.equal(result.toISOString(), '2026-09-01T00:00:00.123Z');
  assert.equal(result.getTime(), withMillis.getTime());
});
