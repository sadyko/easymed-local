// CLINIC_DAY_V1 — the one definition of "when did this happen, in clinic time".
//
// Every timestamp in this database is stored as UTC
// (strftime('%Y-%m-%dT%H:%M:%SZ','now')). A clinic, though, works in LOCAL
// days: the cash shift, the reception desk and the owner's "today" all mean the
// local calendar day, and the day rolls at local midnight.
//
// Before this module three modules disagreed. cashier.js converted properly
// with 'localtime'; dashboard.js and reports.js compared raw UTC. At UTC+5 that
// put everything taken between 00:00 and 05:00 local on the PREVIOUS day in the
// dashboard and the reports, but on the CURRENT day at the till — so a clinic
// working evenings could never reconcile the two, and the discrepancy moved
// around depending on the hour the report was run.
//
// Rule: no module writes date('now') or date(col) for itself. It calls in here.
// A grep for "date('now')" outside this file should return nothing.

// The clinic's current calendar date as 'YYYY-MM-DD'.
export function today(db) {
  return db.prepare("SELECT date('now','localtime') d").get().d;
}

// SQL fragment: the LOCAL calendar date of a stored UTC column.
// Use for both filtering and display, so a row is shown on the same day it is
// counted on.
export function localDate(col) {
  return `date(${col}, 'localtime')`;
}

// SQL fragment: the LOCAL 'YYYY-MM' month of a stored UTC column.
export function localMonth(col) {
  return `strftime('%Y-%m', ${col}, 'localtime')`;
}

// SQL fragment: "this column's local date falls in the requested range",
// consuming exactly two bound parameters (from, to). The bounds are already
// plain local 'YYYY-MM-DD' dates supplied by the caller, so only the COLUMN
// needs converting — date(?) merely normalises the bound.
export function inLocalRange(col) {
  return `${localDate(col)} BETWEEN date(?) AND date(?)`;
}

// V3120_PERF — the SAME local-day window, but as bounds an index can use.
//
// `date(col,'localtime') BETWEEN …` is exact but wraps the column in a function,
// so SQLite cannot use an index on it: every report over «today» read the whole
// table (visit_services 1M rows, 1.7 s on a three-year clinic). The bounds here
// are the UTC instants of local midnight, computed BY SQLITE with its 'utc'
// modifier — the exact inverse of the 'localtime' used by localDate(), so the
// two agree under whatever timezone the server process has. Computing them in
// JS instead would NOT agree: with TZ=UZT-5 (the tests' setting) Node reports
// offset 0 while SQLite applies +5.
//
// Bounds are 'YYYY-MM-DDTHH:MM' (no seconds, no 'Z') on purpose: they are a
// PREFIX of every ISO form the app writes — '…:00Z' (strftime), '…:00.000Z'
// (toISOString), '…T09:30' — so a string comparison lands on the right side of
// local midnight for all of them. With a '…:00Z' bound, a value '…:00.500Z' at
// the exact midnight instant would sort BELOW it and fall on the previous day.
// They are NOT safe for 'YYYY-MM-DD HH:MM:SS' (space) values — ' ' sorts below
// 'T' — nor for offset-suffixed ones; for those use localRangeWhere() below.

// [fromUtc, toUtcExclusive) for local calendar days fromYmd..toYmd inclusive.
export function utcRange(db, fromYmd, toYmd) {
  const r = db.prepare(
    `SELECT strftime('%Y-%m-%dT%H:%M', date(?), 'utc') lo,
            strftime('%Y-%m-%dT%H:%M', date(?), '+1 day', 'utc') hi`,
  ).get(fromYmd, toYmd);
  return [r.lo, r.hi];
}

// [fromUtc, toUtcExclusive) for one local calendar day.
export function utcDayRange(db, ymd) {
  return utcRange(db, ymd, ymd);
}

// SQL fragment + params: "this column's local date is in [from, to]", driven by
// an index on the column and EXACT for any stored format. Prefer this over bare
// utcRange() bounds whenever the column's format is not guaranteed ISO-with-'T'.
//
// Two layers:
//   1. a coarse index range on the raw string, one calendar day wider on each
//      side than any timezone can shift a date — plain 'YYYY-MM-DD' bounds, so
//      it holds for '…T…Z', '… …' (datetime('now')), date-only and
//      offset-suffixed values alike;
//   2. the exact localDate() comparison on the few rows that survive.
// The row set is by construction the same as inLocalRange(col) alone.
// Either bound may be null (open side); both null → '1=1'.
export function localRangeWhere(col, fromYmd, toYmd) {
  const sql = [];
  const params = [];
  if (fromYmd != null) {
    sql.push(`${col} >= date(?, '-1 day')`, `${localDate(col)} >= date(?)`);
    params.push(fromYmd, fromYmd);
  }
  if (toYmd != null) {
    sql.push(`${col} < date(?, '+2 days')`, `${localDate(col)} <= date(?)`);
    params.push(toYmd, toYmd);
  }
  return { sql: sql.length ? sql.join(' AND ') : '1=1', params };
}

// localRangeWhere() with the two dates written INTO the SQL as literals — for
// sub-selects nested deep inside a statement (V3120_PERF, reports.js), where
// threading positional parameters through every join would be fragile. Only
// strict 'YYYY-MM-DD' is accepted, so the literal can never carry anything
// else; a bad value throws rather than widening the range.
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
export function localRangeSql(col, fromYmd, toYmd) {
  for (const v of [fromYmd, toYmd]) {
    if (v != null && !YMD_RE.test(String(v))) throw new Error('localRangeSql: not a YYYY-MM-DD date: ' + v);
  }
  const w = localRangeWhere(col, fromYmd, toYmd);
  let k = 0;
  return w.sql.replace(/\?/g, () => `'${w.params[k++]}'`);
}

// SQL fragment: "this column's local date is today".
export function isLocalToday(col) {
  return `${localDate(col)} = date('now','localtime')`;
}

// CALLCENTER_REPORT_V1 — the LOCAL hour of a stored UTC column, as 'HH'.
//
// «Самые загруженные часы» колл-центра считаются по времени создания заявки.
// Two digits, not one, so the value groups AND sorts as a string: '09' sorts
// before '10', '9' does not.
export function localHour(col) {
  return `strftime('%H', ${col}, 'localtime')`;
}

// SQL fragment: the LOCAL day of week, '0'..'6' with 0 = Sunday (SQLite's %w).
// Local, for the same reason the date is: a Monday-morning call taken at 02:00
// UTC+5 is Monday's work, and grouping it under Sunday would misreport which
// day the desk is busiest.
export function localWeekday(col) {
  return `strftime('%w', ${col}, 'localtime')`;
}
