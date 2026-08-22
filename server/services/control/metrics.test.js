// STATS_V1 — the counter catalogue and the payload builder.
//
// This file exists to enforce the two rules that outrank every feature in the
// statistics plan (docs/plans/2026-08-22-statistics.md): the panel can never
// send a query, and the payload it gets back can never carry a row, a string
// field, or free text — only numbers under catalogue keys. Everything below
// is either a build-gate for that guarantee (the marker test, the finite-number
// loop) or a check on one deliberate business-logic decision the plan asked us
// to verify against the real schema rather than guess at.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { COUNTERS, COUNTER_NAMES, buildStatsPayload } from './metrics.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// The exact starting set from the plan/task — pinned so an accidental rename
// or omission fails loudly here rather than silently in Task 3's vocabulary
// import.
const EXPECTED_NAMES = [
  'errors_24h', 'slow_requests_24h', 'failed_logins_24h', 'boots_7d',
  'billed_today', 'collected_today', 'collected_today_cash', 'collected_today_card', 'unpaid_total',
  'patients_total', 'visits_today',
];

const MARKER = 'ZZTESTPATIENT_UNIQUE_9Q4';

// One row for every table a counter reads from, so every counter in the
// catalogue has something real to count. `patientName`/`phone`/`labValue`
// are parameters so the marker test can reuse this exact seed with the
// tell-tale string substituted in, rather than hand-rolling a second fixture
// that could drift from the one the finite-number test exercises.
function seedClinicData(db, { patientName = 'Иванов Иван', phone = '+998901112233', labValue = '5.2' } = {}) {
  for (const kind of ['server_error', 'slow_request', 'failed_login', 'boot']) {
    db.prepare('INSERT INTO ops_events (kind) VALUES (?)').run(kind);
  }
  const pid = db.prepare('INSERT INTO patients (full_name, phone) VALUES (?,?)').run(patientName, phone).lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const vsid = db.prepare('INSERT INTO visit_services (visit_id, quantity, unit_price, total) VALUES (?,1,1000,1000)').run(vid).lastInsertRowid;
  db.prepare('INSERT INTO lab_results (visit_service_id, value) VALUES (?,?)').run(vsid, labValue);
  const inv = db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,1000,800,'partial')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?,1000,'cash')").run(inv);
  db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?,-200,'cash')").run(inv); // CASHIER_REFUND_V1 — a refund is a negative row, same as billing.js writes it.
  return { pid, vid, inv };
}

// Same trick day.test.js uses (domain/day.test.js): ask SQLite for its own
// local offset rather than hard-coding one, so the fixture straddles the
// UTC/local boundary on whatever machine or CI runs it, and skips cleanly
// on a box that happens to run at UTC (where there is no boundary to cross).
function localOffsetSeconds(db) {
  return db.prepare(
    "SELECT CAST(strftime('%s','now','localtime') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) AS s"
  ).get().s;
}
function boundaryLocalTime(db) {
  const off = localOffsetSeconds(db);
  if (off > 0) return '00:30';
  if (off < 0) return '23:30';
  return null;
}
function storedUtcForLocalTime(db, hhmm) {
  const off = localOffsetSeconds(db);
  const localDay = db.prepare("SELECT date('now','localtime') d").get().d;
  const shift = -off;
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', datetime(?, ?)) x")
    .get(`${localDay}T${hhmm}:00`, `${shift >= 0 ? '+' : ''}${shift} seconds`).x;
}

// --- catalogue shape -------------------------------------------------------

test('COUNTERS has a null prototype — no inherited __proto__/constructor trap', () => {
  assert.equal(Object.getPrototypeOf(COUNTERS), null);
});

test('COUNTER_NAMES is a plain array and matches the catalogue keys', () => {
  assert.ok(Array.isArray(COUNTER_NAMES));
  assert.deepEqual(COUNTER_NAMES.slice().sort(), Object.keys(COUNTERS).sort());
});

test('the starting catalogue is exactly the plan\'s named counters', () => {
  assert.deepEqual(COUNTER_NAMES.slice().sort(), EXPECTED_NAMES.slice().sort());
});

test('every counter has a run function and a non-empty describe string', () => {
  for (const name of COUNTER_NAMES) {
    const c = COUNTERS[name];
    assert.equal(typeof c.run, 'function', `${name}.run missing`);
    assert.equal(typeof c.describe, 'string', `${name}.describe missing`);
    assert.ok(c.describe.length > 0, `${name}.describe is empty`);
  }
});

// --- build-gate test 1: every counter is a finite number --------------------

test('every counter in the catalogue returns a finite number on a seeded database', () => {
  const db = fresh();
  seedClinicData(db);
  for (const name of COUNTER_NAMES) {
    const value = COUNTERS[name].run(db);
    assert.equal(typeof value, 'number', `${name} did not return a number: ${JSON.stringify(value)}`);
    assert.ok(Number.isFinite(value), `${name} returned a non-finite number: ${value}`);
  }
  // And through the builder too, so a name is never silently dropped when the
  // underlying value is perfectly good.
  const payload = buildStatsPayload(db, COUNTER_NAMES);
  assert.deepEqual(Object.keys(payload).sort(), COUNTER_NAMES.slice().sort());
  db.close();
});

test('every counter survives a completely EMPTY database — SUM of nothing must read as 0, not NaN', () => {
  const db = fresh(); // no seed at all: this is the "brand new install" case
  for (const name of COUNTER_NAMES) {
    const value = COUNTERS[name].run(db);
    assert.equal(typeof value, 'number', `${name} did not return a number on an empty db: ${JSON.stringify(value)}`);
    assert.ok(Number.isFinite(value), `${name} returned a non-finite number on an empty db: ${value}`);
  }
  const payload = buildStatsPayload(db, COUNTER_NAMES);
  assert.deepEqual(Object.keys(payload).sort(), COUNTER_NAMES.slice().sort());
  db.close();
});

// --- build-gate test 2: the marker never escapes ----------------------------

test('a patient name, phone and lab value containing a unique marker never reach the payload', () => {
  const db = fresh();
  seedClinicData(db, {
    patientName: `Иванов ${MARKER} Иван`,
    phone: `+998${MARKER}`,
    labValue: MARKER,
  });
  const payload = buildStatsPayload(db, COUNTER_NAMES);
  const json = JSON.stringify(payload);
  assert.ok(!json.includes(MARKER), 'the marker string leaked into the stats payload: ' + json);
  assert.ok(Object.keys(payload).length > 0, 'sanity: the payload must not be empty, or this test would pass for nothing');
  for (const [key, value] of Object.entries(payload)) {
    assert.ok(COUNTER_NAMES.includes(key), `${key} is not in the catalogue`);
    assert.equal(typeof value, 'number', `${key} is not a number: ${JSON.stringify(value)}`);
    assert.ok(Number.isFinite(value), `${key} is not finite: ${value}`);
  }
  db.close();
});

// --- buildStatsPayload robustness ------------------------------------------

test('unknown requested names are skipped silently — an older install must never error on a name it does not know', () => {
  const db = fresh();
  const payload = buildStatsPayload(db, ['patients_total', 'not_a_real_counter', 'future_counter_v9']);
  assert.deepEqual(Object.keys(payload), ['patients_total']);
});

test('__proto__ and constructor are not counters, and asking for them pollutes nothing', () => {
  const db = fresh();
  const payload = buildStatsPayload(db, ['__proto__', 'constructor', 'hasOwnProperty', 'toString']);
  assert.deepEqual(Object.keys(payload), []);
  // Sanity: the global Object.prototype itself must be untouched by the attempt.
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('requestedNames that is not an array (or is null/undefined) yields an empty payload, never a throw', () => {
  const db = fresh();
  for (const bad of [null, undefined, 'errors_24h', 42, {}, false, COUNTERS]) {
    assert.doesNotThrow(() => buildStatsPayload(db, bad), `buildStatsPayload threw for ${JSON.stringify(bad)}`);
    assert.deepEqual(Object.keys(buildStatsPayload(db, bad)), [], `expected empty payload for ${JSON.stringify(bad)}`);
  }
});

test('a throwing counter yields no entry for that name — never a crash, never a string error in the payload', () => {
  const db = fresh();
  seedClinicData(db);
  db.exec('DROP TABLE ops_events'); // every ops_events-backed counter must now throw internally
  const payload = buildStatsPayload(db, COUNTER_NAMES);
  for (const name of ['errors_24h', 'slow_requests_24h', 'failed_logins_24h', 'boots_7d']) {
    assert.ok(!(name in payload), `${name} should have been dropped, got ${JSON.stringify(payload[name])}`);
  }
  // The rest of the catalogue does not depend on ops_events and must still report.
  assert.equal(typeof payload.patients_total, 'number');
  assert.ok(Number.isFinite(payload.patients_total));
  assert.equal(typeof payload.visits_today, 'number');
  db.close();
});

// --- ops_events counters: windows, not just presence ------------------------

test('ops_events counters only count within their own window, split by kind', () => {
  const db = fresh();
  const insertAt = (kind, at) => db.prepare('INSERT INTO ops_events (kind, at) VALUES (?,?)').run(kind, at);
  const nowIso = () => db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') n").get().n;
  const hoursAgo = (h) => db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now', '-' || ? || ' hours') n").get(h).n;
  const daysAgo = (d) => db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now', '-' || ? || ' days') n").get(d).n;

  insertAt('server_error', nowIso());
  insertAt('server_error', hoursAgo(30)); // outside the 24h window
  insertAt('slow_request', nowIso());
  insertAt('failed_login', nowIso());
  insertAt('boot', nowIso());
  insertAt('boot', daysAgo(8)); // outside the 7d window

  const payload = buildStatsPayload(db, ['errors_24h', 'slow_requests_24h', 'failed_logins_24h', 'boots_7d']);
  assert.equal(payload.errors_24h, 1);
  assert.equal(payload.slow_requests_24h, 1);
  assert.equal(payload.failed_logins_24h, 1);
  assert.equal(payload.boots_7d, 1);
  db.close();
});

// --- billing counters: the real schema, the real vocabulary -----------------

test('billed_today sums invoice totals created today (local day), excluding void invoices', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('A')").run().lastInsertRowid;
  db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,1000,0,'unpaid')").run(pid);
  // A voided invoice was cancelled before any money moved — never actually billed.
  db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,5000,0,'void')").run(pid);
  const payload = buildStatsPayload(db, ['billed_today']);
  assert.equal(payload.billed_today, 1000);
  db.close();
});

test('collected_today sums payments today; a refund is a negative row and reduces it', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('A')").run().lastInsertRowid;
  const inv = db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,1000,800,'partial')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?,1000,'cash')").run(inv);
  db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?,-200,'cash')").run(inv);
  const payload = buildStatsPayload(db, ['collected_today', 'collected_today_cash']);
  assert.equal(payload.collected_today, 800);
  assert.equal(payload.collected_today_cash, 800);
  db.close();
});

test('collected_today splits correctly by the real method vocabulary — cash vs card', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('A')").run().lastInsertRowid;
  const inv = db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,800,800,'paid')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?,500,'cash')").run(inv);
  db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?,300,'card')").run(inv);
  const payload = buildStatsPayload(db, ['collected_today', 'collected_today_cash', 'collected_today_card']);
  assert.equal(payload.collected_today, 800);
  assert.equal(payload.collected_today_cash, 500);
  assert.equal(payload.collected_today_card, 300);
  db.close();
});

// DEPOSIT_REVENUE_V1 (public/js/shared/payment-methods.js) — a 'wallet'
// payment spends a deposit balance that was already counted as revenue the
// day the clinic took the original cash. Counting it again in collected_today
// would double-count that money, the same bug dashboardSummary/reportsOverview
// were fixed for.
test('collected_today excludes wallet payments — spending a deposit is not new money', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('A')").run().lastInsertRowid;
  const inv = db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,400,400,'paid')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?,400,'wallet')").run(inv);
  const payload = buildStatsPayload(db, ['collected_today']);
  assert.equal(payload.collected_today, 0);
  db.close();
});

test('unpaid_total sums outstanding balances (unpaid/partial/debt) and excludes void and settled invoices', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('A')").run().lastInsertRowid;
  db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,1000,0,'unpaid')").run(pid);
  db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,2000,500,'partial')").run(pid);
  db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,500,0,'debt')").run(pid);
  db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,9999,0,'void')").run(pid);
  db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,300,300,'paid')").run(pid);
  const payload = buildStatsPayload(db, ['unpaid_total']);
  assert.equal(payload.unpaid_total, 1000 + 1500 + 500);
  db.close();
});

test('visits_today counts only visits scheduled today (local day); patients_total counts every patient', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('A'),('B')").run().lastInsertRowid;
  db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid);
  db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2000-01-01T00:00:00Z')").run(pid); // long past — not today
  const payload = buildStatsPayload(db, ['visits_today', 'patients_total']);
  assert.equal(payload.visits_today, 1);
  assert.equal(payload.patients_total, 2);
  db.close();
});

// --- local-day boundary (CLINIC_DAY_V1, domain/day.js) ----------------------

test('a payment taken just across the local-midnight boundary counts on the LOCAL day, matching the till', (t) => {
  const db = fresh();
  const hhmm = boundaryLocalTime(db);
  if (hhmm === null) { db.close(); return t.skip('machine runs at UTC — no boundary to cross'); }

  const paidAt = storedUtcForLocalTime(db, hhmm);
  const localDay = db.prepare("SELECT date('now','localtime') d").get().d;
  const utcDay = paidAt.slice(0, 10);
  assert.notEqual(utcDay, localDay, 'fixture must straddle the boundary to be meaningful');

  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('A')").run().lastInsertRowid;
  const inv = db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,50000,50000,'paid')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,50000,'cash',?)").run(inv, paidAt);

  const payload = buildStatsPayload(db, ['collected_today', 'collected_today_cash']);
  assert.equal(payload.collected_today, 50000, 'a payment at local ' + hhmm + ' must count on the LOCAL day, not the raw UTC one');
  assert.equal(payload.collected_today_cash, 50000);
  db.close();
});
