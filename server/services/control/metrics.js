// STATS_V1 — the counter catalogue and the payload builder.
//
// docs/plans/2026-08-22-statistics.md: the vendor's panel *names* which
// counters it wants; the clinic's own code decides what those names mean and
// runs the query. The panel can never send a query of its own — it can only
// pick from a fixed, compiled-in vocabulary — so a compromised control plane
// is STRUCTURALLY incapable of asking this file for anything but a number
// under a name that already exists here. That is the whole security model,
// and it is enforced by the SHAPE of buildStatsPayload, not by a promise:
// there is no code path in this file that can return a row, a string field,
// or free text.

import { isLocalToday } from '../domain/day.js';
import { outstandingWhere } from '../domain/money.js';
// One vocabulary shared with dashboard.js/reports.js — INFLOW_SQL is what
// stops "collected today" from counting a wallet spend as new money twice
// (DEPOSIT_REVENUE_V1). Re-deriving that exclusion here instead of importing
// it is exactly the drift this repo has been bitten by before (see
// domain/day.js's header and domain/no-drift.test.js).
import { INFLOW_SQL } from '../../../public/js/shared/payment-methods.js';

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

// COUNTERS — Object.assign(Object.create(null), {...}), not a `{}` literal.
//
// This map is looked up by name, and those names ultimately originate from
// the vendor's panel (Task 3 imports COUNTER_NAMES as the vocabulary a clinic
// admin picks from, but a panel newer than this install could still send a
// name this catalogue does not have, and buildStatsPayload's own guard below
// treats an unknown name as ordinary input, not a bug). A `{}` literal
// inherits `toString`, `constructor`, `__proto__` etc. from Object.prototype,
// so COUNTERS['constructor'] on a literal would return a function instead of
// undefined — the exact trap already found and fixed once in
// public/js/admin/licensed-modules.js. A null-prototype object has no such
// inherited properties, so every lookup that is not one of the keys below is
// a clean `undefined`.
export const COUNTERS = Object.assign(Object.create(null), {
  // --- from ops_events (server/services/ops-log.js, Task 1) ---------------
  //
  // `at` is stored the same way every other timestamp in this database is
  // (strftime('%Y-%m-%dT%H:%M:%SZ','now') — always UTC), so a rolling window
  // like "last 24 hours" is a plain instant-to-instant comparison; it is NOT
  // a calendar day and does not go through domain/day.js. Only the billing
  // counters below need the local-day treatment.
  errors_24h: {
    describe: 'Server errors (5xx responses) recorded in the last 24 hours.',
    run: (db) => one(db,
      "SELECT COUNT(*) n FROM ops_events WHERE kind = 'server_error' AND at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours')"
    ).n,
  },
  slow_requests_24h: {
    describe: 'Requests that crossed the slow-request threshold in the last 24 hours.',
    run: (db) => one(db,
      "SELECT COUNT(*) n FROM ops_events WHERE kind = 'slow_request' AND at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours')"
    ).n,
  },
  failed_logins_24h: {
    describe: 'Failed login attempts recorded in the last 24 hours.',
    run: (db) => one(db,
      "SELECT COUNT(*) n FROM ops_events WHERE kind = 'failed_login' AND at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours')"
    ).n,
  },
  boots_7d: {
    describe: 'Number of times the app has started in the last 7 days.',
    run: (db) => one(db,
      "SELECT COUNT(*) n FROM ops_events WHERE kind = 'boot' AND at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days')"
    ).n,
  },

  // --- from invoices/payments (server/db/migrations/004_billing.sql) ------
  //
  // "Today" here is the LOCAL clinic day (domain/day.js's isLocalToday),
  // the same expression cashier.js/dashboard.js/reports.js already use — see
  // 071_queue_local_day_backfill.sql for the 400-ticket bug this file's rule
  // exists to prevent from happening a second time. COALESCE(SUM(...), 0) on
  // every aggregate: SQLite's SUM over zero rows is NULL, not 0, and this
  // catalogue promises a number even on a brand-new, empty install.
  billed_today: {
    // A void invoice can only be reached with zero payments on it (cashier.js,
    // CASHIER_DESIGN_V2) — it was cancelled before any money moved, so it was
    // never actually billed to the patient. Everything else created today
    // (unpaid/partial/paid/debt/refunded) really was invoiced, whatever
    // happened to it afterwards.
    describe: "Sum of invoice totals (total_amount) created today (local day), excluding void invoices.",
    run: (db) => one(db,
      `SELECT COALESCE(SUM(total_amount),0) s FROM invoices WHERE status <> 'void' AND ${isLocalToday('created_at')}`
    ).s,
  },
  collected_today: {
    // Refunds are stored as negative payments rows (CASHIER_REFUND_V1,
    // billing.js refundPayment) — a refund is money leaving the till, so it
    // is included here as a negative, not filtered out. Wallet payments are
    // excluded (INFLOW_SQL): a 'wallet' payment spends an already-accepted
    // patient deposit rather than bringing in new money — counting it here
    // too would double the same cash the deposit already counted on the day
    // it was taken (DEPOSIT_REVENUE_V1, public/js/shared/payment-methods.js).
    describe: 'Sum of payments recorded today (local day); refunds count as negative amounts, wallet spends are excluded (not new money).',
    run: (db) => one(db,
      `SELECT COALESCE(SUM(amount),0) s FROM payments WHERE ${INFLOW_SQL} AND ${isLocalToday('paid_at')}`
    ).s,
  },
  collected_today_cash: {
    describe: "Sum of today's payments (local day) with method = 'cash', including cash refunds as negative amounts.",
    run: (db) => one(db,
      `SELECT COALESCE(SUM(amount),0) s FROM payments WHERE method = 'cash' AND ${isLocalToday('paid_at')}`
    ).s,
  },
  collected_today_card: {
    describe: "Sum of today's payments (local day) with method = 'card', including card refunds as negative amounts.",
    run: (db) => one(db,
      `SELECT COALESCE(SUM(amount),0) s FROM payments WHERE method = 'card' AND ${isLocalToday('paid_at')}`
    ).s,
  },
  unpaid_total: {
    // Reuses domain/money.js's outstandingWhere() rather than re-typing the
    // status list — that is the exact vocabulary-drift trap that once let
    // 'debt' invoices silently vanish from the dashboard while the till still
    // counted them (see domain/money.js's own header). It already excludes
    // 'void' and 'refunded' by construction.
    describe: 'Outstanding balance (total_amount - paid_amount) across all invoices still owed (unpaid, partial, or debt) — an all-time snapshot, not scoped to today.',
    run: (db) => one(db,
      `SELECT COALESCE(SUM(total_amount - paid_amount),0) s FROM invoices WHERE ${outstandingWhere()}`
    ).s,
  },

  // --- usage signals --------------------------------------------------------
  patients_total: {
    describe: 'Total number of patient records in this clinic.',
    run: (db) => one(db, 'SELECT COUNT(*) n FROM patients').n,
  },
  visits_today: {
    describe: 'Number of visits scheduled today (local day).',
    run: (db) => one(db, `SELECT COUNT(*) n FROM visits WHERE ${isLocalToday('visit_date')}`).n,
  },
});

/** Every counter name the catalogue currently knows — Task 3's vocabulary. */
export const COUNTER_NAMES = Object.keys(COUNTERS);

/**
 * buildStatsPayload(db, requestedNames) -> { [name]: number }
 *
 * The return type IS the security property. Only names present in COUNTERS run
 * (a panel newer than this install may name counters we do not have — skipped
 * silently, never an error). Every result passes Number(); anything non-finite
 * is dropped. A counter that throws yields no entry — never a crash, never a
 * string error in the payload. There is no code path by which a row, a string
 * field, or free text can reach the return value.
 */
export function buildStatsPayload(db, requestedNames) {
  // Object.create(null) for the same reason COUNTERS is one: the OUTPUT is
  // built from caller-supplied names too, so a stray '__proto__'/'constructor'
  // key must land as an ordinary own property, never as a prototype write.
  const payload = Object.create(null);
  if (!Array.isArray(requestedNames)) return payload;

  for (const name of requestedNames) {
    if (typeof name !== 'string') continue;
    // hasOwnProperty via Object.prototype.call, not COUNTERS.hasOwnProperty —
    // COUNTERS has no prototype at all, so it has no .hasOwnProperty method of
    // its own to call (same idiom payment-methods.js already uses for METHOD_RU).
    if (!Object.prototype.hasOwnProperty.call(COUNTERS, name)) continue;

    let raw;
    try {
      raw = COUNTERS[name].run(db);
    } catch {
      // A corrupt/missing/locked table must cost this ONE counter, never the
      // whole check-in. See ops-log.js's recordEvent for the same reasoning.
      continue;
    }

    const value = Number(raw);
    if (!Number.isFinite(value)) continue; // NaN, +/-Infinity, objects, strings that don't parse — all dropped
    payload[name] = value;
  }

  return payload;
}
