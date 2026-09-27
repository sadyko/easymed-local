// V3120_PERF — utcRange()/localRangeWhere() must select EXACTLY the rows that
// inLocalRange() selects, in whatever timezone the process runs. The index-
// friendly forms exist only for speed; any disagreement would move money or
// documents between days. Run this file under several TZ values
// (TZ=UZT-5, TZ=EST5EDT, unset) — it asks SQLite for the offset, never assumes.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { inLocalRange, utcRange, utcDayRange, localRangeWhere, localDate } from './day.js';

function seeded() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, at TEXT)');
  db.exec('CREATE INDEX t_at ON t(at)');
  const ins = db.prepare('INSERT INTO t (at) VALUES (?)');
  // Every minute-ish boundary around three days, in every format the app has
  // been seen to write, plus junk.
  const base = Date.parse('2026-09-25T00:00:00Z');
  const pad = (n) => String(n).padStart(2, '0');
  for (let m = 0; m < 4 * 24 * 60; m += 7) {
    const d = new Date(base + m * 60e3);
    const iso = d.toISOString();                       // …:00.000Z
    ins.run(iso.slice(0, 19) + 'Z');                   // …:00Z (strftime)
    ins.run(iso);                                      // toISOString
    ins.run(iso.slice(0, 10) + ' ' + iso.slice(11, 19)); // datetime('now')
    ins.run(iso.slice(0, 16));                         // '…T09:30' (no seconds)
    if (m % 5 === 0) ins.run(`${iso.slice(0, 19)}+05:00`); // offset-suffixed
    if (m % 11 === 0) ins.run(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`); // date-only
  }
  // Exact local-midnight instants (all three days), with and without millis.
  for (const ymd of ['2026-09-26', '2026-09-27', '2026-09-28']) {
    const [lo] = utcDayRange(db, ymd);
    ins.run(lo + ':00Z'); ins.run(lo + ':00.500Z'); ins.run(lo);
  }
  ins.run(null); ins.run(''); ins.run('garbage');
  return db;
}

const ids = (rows) => rows.map((r) => r.id);

test('localRangeWhere selects exactly the inLocalRange rows (any format), and uses the index', () => {
  const db = seeded();
  for (const [from, to] of [['2026-09-26', '2026-09-26'], ['2026-09-26', '2026-09-27'], ['2026-09-27', '2026-09-28'], ['2026-09-20', '2026-10-05']]) {
    const want = ids(db.prepare(`SELECT id FROM t WHERE ${inLocalRange('at')} ORDER BY id`).all(from, to));
    const w = localRangeWhere('at', from, to);
    const got = ids(db.prepare(`SELECT id FROM t WHERE ${w.sql} ORDER BY id`).all(...w.params));
    assert.ok(want.length > 0, 'fixture must hit the range');
    assert.deepEqual(got, want, `range ${from}..${to}`);
  }
  // Open sides.
  const lo = localRangeWhere('at', '2026-09-27', null);
  assert.deepEqual(
    ids(db.prepare(`SELECT id FROM t WHERE ${lo.sql} ORDER BY id`).all(...lo.params)),
    ids(db.prepare(`SELECT id FROM t WHERE ${localDate('at')} >= date(?) ORDER BY id`).all('2026-09-27')));
  const hi = localRangeWhere('at', null, '2026-09-26');
  assert.deepEqual(
    ids(db.prepare(`SELECT id FROM t WHERE ${hi.sql} ORDER BY id`).all(...hi.params)),
    ids(db.prepare(`SELECT id FROM t WHERE ${localDate('at')} <= date(?) ORDER BY id`).all('2026-09-26')));
  assert.equal(localRangeWhere('at', null, null).sql, '1=1');

  const w = localRangeWhere('at', '2026-09-26', '2026-09-26');
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM t WHERE ${w.sql}`).all(...w.params).map((r) => r.detail).join('\n');
  assert.match(plan, /USING (COVERING )?INDEX t_at/);
});

test('utcRange bounds are exact for every ISO-with-T format the app writes', () => {
  const db = seeded();
  const isoT = "at LIKE '____-__-__T__:__%' AND at NOT LIKE '%+__:__'";
  for (const [from, to] of [['2026-09-26', '2026-09-26'], ['2026-09-26', '2026-09-28']]) {
    const want = ids(db.prepare(`SELECT id FROM t WHERE ${isoT} AND ${inLocalRange('at')} ORDER BY id`).all(from, to));
    const [a, b] = utcRange(db, from, to);
    const got = ids(db.prepare(`SELECT id FROM t WHERE ${isoT} AND at >= ? AND at < ? ORDER BY id`).all(a, b));
    assert.deepEqual(got, want, `range ${from}..${to}`);
  }
  // A day is 24h wide and the bounds carry minutes, no seconds, no 'Z'.
  const [a, b] = utcDayRange(db, '2026-09-27');
  assert.match(a, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(Date.parse(b + 'Z') - Date.parse(a + 'Z'), 24 * 3600e3);
  // The lower bound is local midnight: SQLite reads it back as that local date.
  assert.equal(db.prepare("SELECT date(?, 'localtime') d").get(a + 'Z').d, '2026-09-27');
  assert.equal(db.prepare("SELECT date(?, '-1 second', 'localtime') d").get(a + 'Z').d, '2026-09-26');
});
