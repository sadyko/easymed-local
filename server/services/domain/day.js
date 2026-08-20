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
