import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from './enrollment.js';
import { checkIn } from './checkin.js';
import { COUNTER_NAMES } from '../../../server/services/control/metrics.js';

// --- test harness ------------------------------------------------------------

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function clinicRow(db, clinicId) {
  return db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get(clinicId);
}

// Enrols a clinic the same way the real flow does (code -> redeem), with no
// signing hook — checkin.js's own tests don't need a licence to already
// exist, only an install_token to authenticate with.
function enrol(db, clinicId, name = 'Test Clinic') {
  const code = createEnrollmentCode(db, { clinicId, name });
  const result = redeemEnrollmentCode(db, { code });
  return result.install_token;
}

function grantModule(db, clinicId, moduleKey) {
  db.prepare('INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, ?)').run(clinicId, moduleKey);
}

function fakeSigner(calls = []) {
  return ({ clinicId, clinicName, modules }) => {
    calls.push({ clinicId, clinicName, modules });
    return { payload: { clinic_id: clinicId, clinic_name: clinicName, modules }, sig: 'fake-sig' };
  };
}

function isoDaysFromToday(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// UPDATE_DELIVERY_V1 — registers a release row directly (this is checkin.js's
// own test file; releases are normally created through routes/admin.js, but
// that is a different module's surface to test).
function insertRelease(db, version, { ring = 2, halted = 0, manifest = { payload: { version }, sig: 'sig' }, notes_ru = 'notes', url = `https://example/${version}.tar.gz`, sha256 = 'hash' } = {}) {
  db.prepare(
    `INSERT INTO releases (version, notes_ru, url, sha256, manifest, ring, halted) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(version, notes_ru, url, sha256, JSON.stringify(manifest), ring, halted);
}

function releaseRow(db, version) {
  return db.prepare('SELECT * FROM releases WHERE version = ?').get(version);
}

// --- rule 1: unknown / inactive / missing token — one outcome, nothing else -

test('an unknown install_token returns null — no row is written anywhere', () => {
  const db = freshDb();
  const result = checkIn(db, { installToken: 'no-such-token' }, { signLicence: fakeSigner() });
  assert.equal(result, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins').get().n, 0);
});

test('a deactivated clinic\'s token returns null too — indistinguishable from unknown', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare('UPDATE clinics SET active = 0 WHERE clinic_id = ?').run('c-1');

  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.equal(result, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins').get().n, 0, 'a deactivated clinic must not be recorded as having called in');
});

test('a missing, empty, numeric, or object install_token all return null without throwing', () => {
  const db = freshDb();
  assert.equal(checkIn(db, {}, { signLicence: fakeSigner() }), null);
  assert.equal(checkIn(db, { installToken: '' }, { signLicence: fakeSigner() }), null);
  assert.equal(checkIn(db, { installToken: 47 }, { signLicence: fakeSigner() }), null);
  assert.equal(checkIn(db, { installToken: { not: 'a string' } }, { signLicence: fakeSigner() }), null);
});

// --- rule 2: a checkins row every time, whatever else happens ---------------

test('a successful check-in always records a checkins row', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  checkIn(db, { installToken: token, version: '1.0.0', fingerprint: 'fp-1' }, { signLicence: fakeSigner() });
  const row = db.prepare('SELECT * FROM checkins WHERE clinic_id = ?').get('c-1');
  assert.ok(row, 'a checkins row must exist');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.fingerprint, 'fp-1');
});

test('a checkins row is recorded even when signLicence throws mid-request', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');

  assert.throws(() => checkIn(db, { installToken: token, version: '1.0.0' }, {
    signLicence: () => { throw new Error('signing key not configured'); },
  }), /signing key not configured/);

  // The evidence must survive the throw — this is the whole point of rule 2.
  const row = db.prepare('SELECT * FROM checkins WHERE clinic_id = ?').get('c-1');
  assert.ok(row, 'the check-in must be recorded even though signing blew up afterwards');
  assert.equal(row.version, '1.0.0');

  // And last_seen_at etc. must also have been committed — not just the row.
  const clinic = clinicRow(db, 'c-1');
  assert.ok(clinic.last_seen_at, 'last_seen_at must be updated before signing is even attempted');
});

// --- rule 3: last_seen_at / last_version / last_fingerprint -----------------

test('a check-in updates last_seen_at, last_version, last_fingerprint', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  assert.equal(clinicRow(db, 'c-1').last_seen_at, null);

  checkIn(db, { installToken: token, version: '2.3.4', fingerprint: 'fp-xyz' }, { signLicence: fakeSigner() });

  const row = clinicRow(db, 'c-1');
  assert.ok(row.last_seen_at, 'last_seen_at must be set');
  assert.equal(row.last_version, '2.3.4');
  assert.equal(row.last_fingerprint, 'fp-xyz');
});

// --- rule 4: fingerprint change is recorded and flagged, never auto-locked --

test('a changed fingerprint is recorded and flagged in the checkin payload, but never blocks the call', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  checkIn(db, { installToken: token, fingerprint: 'fp-a' }, { signLicence: fakeSigner() });

  const result = checkIn(db, { installToken: token, fingerprint: 'fp-b' }, { signLicence: fakeSigner() });
  assert.ok(result, 'a changed fingerprint must never fail the check-in');

  const rows = db.prepare('SELECT * FROM checkins WHERE clinic_id = ? ORDER BY id').all('c-1');
  assert.equal(rows.length, 2);
  const secondPayload = JSON.parse(rows[1].payload);
  assert.equal(secondPayload.fingerprint_changed, true, 'the change must be flagged on the record');

  const firstPayload = JSON.parse(rows[0].payload);
  assert.equal(firstPayload.fingerprint_changed, false, 'the very first fingerprint is a baseline, not a "change"');

  // And it must actually have taken effect — hardware swaps are legitimate.
  assert.equal(clinicRow(db, 'c-1').last_fingerprint, 'fp-b');
});

test('an unchanged fingerprint is not flagged', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  checkIn(db, { installToken: token, fingerprint: 'fp-a' }, { signLicence: fakeSigner() });
  checkIn(db, { installToken: token, fingerprint: 'fp-a' }, { signLicence: fakeSigner() });

  const rows = db.prepare('SELECT * FROM checkins WHERE clinic_id = ? ORDER BY id').all('c-1');
  assert.equal(JSON.parse(rows[1].payload).fingerprint_changed, false);
});

// --- rule 5: re-arm only if entitled ----------------------------------------

test('re-arms with a fresh licence when subscription is active and subscription_until is null', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  grantModule(db, 'c-1', 'crm');

  const calls = [];
  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner(calls) });

  assert.ok(result.licence, 'a fresh licence must come back');
  assert.equal(result.subscription, 'active');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].modules, ['crm']);
});

test('re-arms when subscription_until is comfortably in the future', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare('UPDATE clinics SET subscription_until = ? WHERE clinic_id = ?').run(isoDaysFromToday(30), 'c-1');

  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.ok(result.licence);
  assert.equal(result.subscription, 'active');
});

test('boundary: subscription_until exactly today still re-arms — paid until today means paid today', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare('UPDATE clinics SET subscription_until = ? WHERE clinic_id = ?').run(isoDaysFromToday(0), 'c-1');

  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.ok(result.licence, 'today has not yet passed — this must still re-arm');
  assert.equal(result.subscription, 'active');
});

test('does not re-arm when subscription is unpaid — no licence, and the response itself says unpaid', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = ?").run('c-1');

  const calls = [];
  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner(calls) });

  assert.equal(result.licence, null, 'no fresh licence for an unpaid clinic');
  assert.equal(result.subscription, 'unpaid');
  assert.equal(calls.length, 0, 'signLicence must never even be called when not entitled');
});

test('does not re-arm when subscription_until is yesterday, even though subscription column still says active', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare("UPDATE clinics SET subscription = 'active', subscription_until = ? WHERE clinic_id = ?")
    .run(isoDaysFromToday(-1), 'c-1');

  const calls = [];
  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner(calls) });

  assert.equal(result.licence, null, 'paid-until in the past is not paid');
  // The RESPONSE must say unpaid even though the DB column literally says
  // 'active' — this is what makes the clinic show money wording instead of
  // connectivity wording. Returning the raw column value here would be the
  // bug: the clinic would see "active" and never know to ask about billing.
  assert.equal(result.subscription, 'unpaid');
  assert.equal(calls.length, 0);
});

test('a subscription_until written without zero-padding compares correctly (date, not string)', () => {
  // '2026-9-1' vs a properly padded "today" must not be compared as strings —
  // see this file's own header comment on why. Pin it with a deliberately
  // unpadded far-future date.
  const db = freshDb();
  const token = enrol(db, 'c-1');
  const future = new Date();
  future.setUTCFullYear(future.getUTCFullYear() + 1);
  const unpadded = `${future.getUTCFullYear()}-${future.getUTCMonth() + 1}-${future.getUTCDate()}`; // no zero-padding
  db.prepare('UPDATE clinics SET subscription_until = ? WHERE clinic_id = ?').run(unpadded, 'c-1');

  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.ok(result.licence, `an unpadded future date (${unpadded}) must still be read as being in the future`);
});

test('an unparseable subscription_until fails closed — not entitled, not a crash', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare("UPDATE clinics SET subscription_until = 'not-a-date' WHERE clinic_id = ?").run('c-1');

  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.equal(result.licence, null);
  assert.equal(result.subscription, 'unpaid');
});

// --- STATS_V1 (docs/plans/2026-08-22-statistics.md): `collect` ---------------

test('collect defaults to every known counter when collect_set has never been set (NULL)', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.deepEqual(result.collect.slice().sort(), COUNTER_NAMES.slice().sort());
});

test('collect reflects the clinic\'s own collect_set once the vendor has picked a subset', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare('UPDATE clinics SET collect_set = ? WHERE clinic_id = ?')
    .run(JSON.stringify(['patients_total', 'billed_today']), 'c-1');

  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.deepEqual(result.collect.slice().sort(), ['billed_today', 'patients_total']);
});

test('collect_set explicitly set to an empty list means "collect nothing" — not the default', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare('UPDATE clinics SET collect_set = ? WHERE clinic_id = ?').run(JSON.stringify([]), 'c-1');

  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.deepEqual(result.collect, [], 'an explicit empty choice must not fall back to the default set');
});

test('a hand-corrupted collect_set falls back to the default set, not a 500-equivalent crash', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare("UPDATE clinics SET collect_set = 'not json at all' WHERE clinic_id = ?").run('c-1');

  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.deepEqual(result.collect.slice().sort(), COUNTER_NAMES.slice().sort(),
    'a corrupt column must fail OPEN to the default catalogue, never crash the check-in');
});

test('collect_set that is valid JSON but not an array falls back to the default set', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare('UPDATE clinics SET collect_set = ? WHERE clinic_id = ?').run(JSON.stringify({ not: 'an array' }), 'c-1');

  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.deepEqual(result.collect.slice().sort(), COUNTER_NAMES.slice().sort());
});

test('a counter name in collect_set that no longer exists in the catalogue is filtered out, not passed through', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare('UPDATE clinics SET collect_set = ? WHERE clinic_id = ?')
    .run(JSON.stringify(['patients_total', 'a_counter_removed_in_a_later_release']), 'c-1');

  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.deepEqual(result.collect, ['patients_total']);
});

// --- STATS_V1: incoming `stats` ----------------------------------------------

test('an old clinic that never sends `stats` at all checks in exactly as before — the field is optional forever', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  const result = checkIn(db, { installToken: token, version: '1.0.0' }, { signLicence: fakeSigner() });
  assert.ok(result, 'a missing stats field must never fail the check-in');

  const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ?').get('c-1');
  assert.deepEqual(JSON.parse(row.payload).stats, {}, 'no stats sent must still leave a well-shaped, empty stats object stored');
});

test('valid stats are stored, keyed by catalogue name, merged alongside module_requests/fingerprint_changed in the same payload', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  checkIn(db, {
    installToken: token,
    moduleRequests: [{ module_key: 'crm', requested_at: '2026-08-20T00:00:00Z' }],
    stats: { patients_total: 42, billed_today: 1500.5 },
  }, { signLicence: fakeSigner() });

  const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ?').get('c-1');
  const payload = JSON.parse(row.payload);
  assert.deepEqual(payload.stats, { patients_total: 42, billed_today: 1500.5 });
  // "merge, don't clobber" — the OTHER fields this same route already wrote
  // into this payload must still be there.
  assert.equal(payload.module_requests.length, 1);
  assert.equal(payload.module_requests[0].module_key, 'crm');
  assert.equal(payload.fingerprint_changed, false);
});

test('unknown stat keys are dropped silently — a panel newer than this install may name a counter it does not have', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  checkIn(db, { installToken: token, stats: { patients_total: 3, not_a_real_counter: 99, future_counter_v9: 1 } }, { signLicence: fakeSigner() });

  const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ?').get('c-1');
  assert.deepEqual(JSON.parse(row.payload).stats, { patients_total: 3 });
});

test('non-finite / non-numeric stat values are dropped, never stored as a string or NaN', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  checkIn(db, {
    installToken: token,
    stats: { patients_total: 'not a number', billed_today: NaN, unpaid_total: Infinity, visits_today: 7 },
  }, { signLicence: fakeSigner() });

  const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ?').get('c-1');
  assert.deepEqual(JSON.parse(row.payload).stats, { visits_today: 7 });
});

test('a stats key of "__proto__" or "constructor" is dropped like any other unknown key, and pollutes nothing', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  assert.doesNotThrow(() => checkIn(db, {
    installToken: token,
    stats: { __proto__: 5, constructor: 6, patients_total: 1 },
  }, { signLicence: fakeSigner() }));

  const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ?').get('c-1');
  assert.deepEqual(JSON.parse(row.payload).stats, { patients_total: 1 });
  assert.equal(({}).polluted, undefined, 'must never pollute Object.prototype');
});

test('a stats object with more entries than the bound is truncated, not rejected', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  // Every real catalogue name, each repeated with a bogus name too — far more
  // than MAX_STATS_KEYS worth of junk keys, none of which should ever count.
  const stats = {};
  for (const name of COUNTER_NAMES) stats[name] = 1;
  for (let i = 0; i < 200; i++) stats[`junk_${i}`] = i;

  assert.doesNotThrow(() => checkIn(db, { installToken: token, stats }, { signLicence: fakeSigner() }));
  const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ?').get('c-1');
  const stored = JSON.parse(row.payload).stats;
  assert.ok(Object.keys(stored).length <= COUNTER_NAMES.length, 'only real catalogue names can ever survive, however much junk was sent');
});

test('garbage stats shapes (array, string, number, null) never fail the check-in', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  for (const bad of [['not', 'an', 'object'], 'just a string', 42, null]) {
    const result = checkIn(db, { installToken: token, stats: bad }, { signLicence: fakeSigner() });
    assert.ok(result, `stats=${JSON.stringify(bad)} must not fail the check-in`);
    const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ? ORDER BY id DESC LIMIT 1').get('c-1');
    assert.deepEqual(JSON.parse(row.payload).stats, {}, 'a garbage shape must store as an empty stats object, never crash or store the garbage itself');
  }
});

test('a counter the vendor un-ticked between check-ins is still stored if reported — it is still a known name, harmless either way', () => {
  // Deliberately NOT filtered against the clinic's OWN collect_set: the
  // no-PII/known-vocabulary guarantee is enforced by COUNTER_NAMES, not by
  // whatever this clinic was last told to collect. See normaliseStats' own
  // header for why this is a deliberate choice, not an oversight.
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare('UPDATE clinics SET collect_set = ? WHERE clinic_id = ?').run(JSON.stringify(['patients_total']), 'c-1');

  checkIn(db, { installToken: token, stats: { patients_total: 5, billed_today: 900 } }, { signLicence: fakeSigner() });

  const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ?').get('c-1');
  assert.deepEqual(JSON.parse(row.payload).stats, { patients_total: 5, billed_today: 900 },
    'a known counter name is stored whether or not it is in the clinic\'s CURRENT collect_set');
});

test('stats never affects entitlement — a broken stats object still re-arms an otherwise-paid clinic', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  grantModule(db, 'c-1', 'crm');

  const result = checkIn(db, { installToken: token, stats: 'garbage' }, { signLicence: fakeSigner() });
  assert.ok(result.licence, 'a malformed stats payload must never cost a paid clinic its licence renewal');
});

// --- rule 6 & 7: module_requests carried up, deduplicated, idempotent ------

test('a module_request is carried up as an open lead', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  checkIn(db, {
    installToken: token,
    moduleRequests: [{ module_key: 'crm', requested_at: '2026-08-20T00:00:00Z' }],
  }, { signLicence: fakeSigner() });

  const row = db.prepare('SELECT * FROM module_requests WHERE clinic_id = ?').get('c-1');
  assert.equal(row.module_key, 'crm');
  assert.equal(row.status, 'open');
  assert.equal(row.requested_at, '2026-08-20T00:00:00Z');
});

test('the same module_key sent twice in ONE call creates only one lead', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  checkIn(db, {
    installToken: token,
    moduleRequests: [
      { module_key: 'crm', requested_at: '2026-08-20T00:00:00Z' },
      { module_key: 'crm', requested_at: '2026-08-20T00:00:01Z' },
    ],
  }, { signLicence: fakeSigner() });

  const rows = db.prepare("SELECT * FROM module_requests WHERE clinic_id = ? AND module_key = 'crm'").all('c-1');
  assert.equal(rows.length, 1);
});

test('the same check-in sent twice (retry) does not duplicate the lead — idempotent', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  const body = { installToken: token, version: '1.0.0', moduleRequests: [{ module_key: 'telegram', requested_at: '2026-08-20T00:00:00Z' }] };

  checkIn(db, body, { signLicence: fakeSigner() });
  checkIn(db, body, { signLicence: fakeSigner() });

  const leads = db.prepare("SELECT * FROM module_requests WHERE clinic_id = ? AND module_key = 'telegram'").all('c-1');
  assert.equal(leads.length, 1, 'a retried check-in must not create a second lead');

  // But it IS still evidence — two checkins rows, because a check-in happened twice.
  const checkins = db.prepare('SELECT COUNT(*) n FROM checkins WHERE clinic_id = ?').get('c-1');
  assert.equal(checkins.n, 2);
});

test('a module_request already granted (in clinic_modules) is still a fine, harmless no-op lead', () => {
  // Not de-duplicated against clinic_modules — module_requests only tracks its
  // OWN open/granted/declined status. Requesting something already owned just
  // creates (and later a human declines/ignores) a lead; it must not crash.
  const db = freshDb();
  const token = enrol(db, 'c-1');
  grantModule(db, 'c-1', 'crm');
  assert.doesNotThrow(() => checkIn(db, {
    installToken: token,
    moduleRequests: [{ module_key: 'crm', requested_at: '2026-08-20T00:00:00Z' }],
  }, { signLicence: fakeSigner() }));
});

// --- attack: malformed module_requests must never crash or fail the call ---

test('module_requests that is not an array is dropped, not fatal', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  for (const bad of ['a string', 42, { not: 'an array' }, null]) {
    const result = checkIn(db, { installToken: token, moduleRequests: bad }, { signLicence: fakeSigner() });
    assert.ok(result, `moduleRequests=${JSON.stringify(bad)} must not fail the check-in`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM module_requests').get().n, 0);
});

test('500 module_requests entries do not crash and are still narrowed correctly, wherever the real one sits', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  const many = Array.from({ length: 500 }, (_, i) => ({ module_key: `bogus-${i}`, requested_at: '2026-08-20T00:00:00Z' }));
  // Planted in the MIDDLE of the batch, not the end — a positional cap (take
  // only the first N) would silently drop this even though it is a perfectly
  // legitimate, sellable request. See checkin.js's own comment on why there
  // is no such cap.
  many.splice(250, 0, { module_key: 'crm', requested_at: '2026-08-20T00:00:00Z' });

  assert.doesNotThrow(() => checkIn(db, { installToken: token, moduleRequests: many }, { signLicence: fakeSigner() }));
  const rows = db.prepare('SELECT * FROM module_requests WHERE clinic_id = ?').all('c-1');
  assert.equal(rows.length, 1, 'only the one sellable key should ever reach the table');
  assert.equal(rows[0].module_key, 'crm');
});

test('a non-sellable module_key is dropped, not fatal, and does not block a sellable one in the same batch', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  checkIn(db, {
    installToken: token,
    moduleRequests: [
      { module_key: 'not-a-real-module', requested_at: '2026-08-20T00:00:00Z' },
      { module_key: 'crm', requested_at: '2026-08-20T00:00:00Z' },
    ],
  }, { signLicence: fakeSigner() });

  const rows = db.prepare('SELECT * FROM module_requests WHERE clinic_id = ?').all('c-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].module_key, 'crm');
});

test('a "__proto__" module_key is dropped like any other unsellable key, and pollutes nothing', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  assert.doesNotThrow(() => checkIn(db, {
    installToken: token,
    moduleRequests: [{ module_key: '__proto__', requested_at: 't' }],
  }, { signLicence: fakeSigner() }));

  assert.equal(db.prepare('SELECT COUNT(*) n FROM module_requests').get().n, 0);
  assert.equal(({}).polluted, undefined, 'must never pollute Object.prototype');
});

test('missing or garbage requested_at is stamped with receipt time, not rejected', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  checkIn(db, {
    installToken: token,
    moduleRequests: [{ module_key: 'crm' }], // no requested_at at all
  }, { signLicence: fakeSigner() });

  const row = db.prepare('SELECT * FROM module_requests WHERE clinic_id = ?').get('c-1');
  assert.ok(row.requested_at, 'requested_at has no schema default — some value must be stored');
});

test('entries that are not objects at all are dropped without crashing', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  assert.doesNotThrow(() => checkIn(db, {
    installToken: token,
    moduleRequests: ['crm', 42, null, ['nested', 'array'], { module_key: 'telegram', requested_at: 't' }],
  }, { signLicence: fakeSigner() }));

  const rows = db.prepare('SELECT * FROM module_requests WHERE clinic_id = ?').all('c-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].module_key, 'telegram');
});

// --- attack: version / fingerprint are advisory only ------------------------

test('an absent version and fingerprint never fail the check-in', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  assert.doesNotThrow(() => checkIn(db, { installToken: token }, { signLicence: fakeSigner() }));
  const row = clinicRow(db, 'c-1');
  assert.equal(row.last_version, null);
  assert.equal(row.last_fingerprint, null);
});

test('a 10,000-character version or fingerprint is truncated, not rejected', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  const huge = 'x'.repeat(10_000);
  assert.doesNotThrow(() => checkIn(db, { installToken: token, version: huge, fingerprint: huge }, { signLicence: fakeSigner() }));
  const row = clinicRow(db, 'c-1');
  assert.ok(row.last_version.length < 10_000);
  assert.ok(row.last_fingerprint.length < 10_000);
});

test('an object version or fingerprint does not crash and is not stringified to "[object Object]"', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  assert.doesNotThrow(() => checkIn(db, { installToken: token, version: { v: 1 }, fingerprint: { f: 1 } }, { signLicence: fakeSigner() }));
  const row = clinicRow(db, 'c-1');
  assert.equal(row.last_version, null);
  assert.equal(row.last_fingerprint, null);
});

// --- attack: a token whose clinic row was deleted out from under it --------

test('a valid-looking token whose clinic row has since been deleted behaves exactly like an unknown token', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  checkIn(db, { installToken: token, version: '1.0.0' }, { signLicence: fakeSigner() }); // one real check-in first
  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins').get().n, 1);

  db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run('c-1');

  // checkins.clinic_id is deliberately NOT a foreign key (see 001_registry.sql)
  // — history survives the clinic row. Confirm the delete didn't cascade here.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins').get().n, 1, 'check-in history must survive the clinic row being deleted');

  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.equal(result, null, 'the token authenticates nothing once its clinic row is gone');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins').get().n, 1, 'no new row for a token that no longer resolves to any clinic');
});

// --- UPDATE_DELIVERY_V1: the `update` offer -----------------------------------

test('update defaults to null when no releases are registered at all', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  const result = checkIn(db, { installToken: token, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.equal(result.update, null);
});

test('a published, unhalted, newer release is offered as `update`, with the manifest passed through as an object', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  insertRelease(db, '2.4.0', { manifest: { payload: { version: '2.4.0', sha256: 'abc' }, sig: 'realsig' } });

  const result = checkIn(db, { installToken: token, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.ok(result.update, 'a newer, published, unhalted release must be offered');
  assert.equal(result.update.version, '2.4.0');
  assert.deepEqual(result.update.manifest, { payload: { version: '2.4.0', sha256: 'abc' }, sig: 'realsig' });
});

test('ATTACK: a release registered but never published (ring -1, the schema default) is never offered', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  insertRelease(db, '2.4.0', { ring: -1 });

  const result = checkIn(db, { installToken: token, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.equal(result.update, null);
});

test('a halted release is never offered, even though otherwise eligible', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  insertRelease(db, '2.4.0', { halted: 1 });

  const result = checkIn(db, { installToken: token, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.equal(result.update, null);
});

test('a clinic already on the offered version gets update: null', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  insertRelease(db, '2.4.0');

  const result = checkIn(db, { installToken: token, version: '2.4.0' }, { signLicence: fakeSigner() });
  assert.equal(result.update, null);
});

test('ring gating: a ring-0 publish does not reach a ring-2 clinic (the schema default ring), but does reach a ring-0 clinic', () => {
  const db = freshDb();
  const tokenWide = enrol(db, 'c-wide'); // default ring 2
  const tokenNarrow = enrol(db, 'c-narrow');
  db.prepare('UPDATE clinics SET ring = 0 WHERE clinic_id = ?').run('c-narrow');
  insertRelease(db, '2.4.0', { ring: 0 });

  const resultWide = checkIn(db, { installToken: tokenWide, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.equal(resultWide.update, null, 'ring 0 is the narrowest audience');

  const resultNarrow = checkIn(db, { installToken: tokenNarrow, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.equal(resultNarrow.update.version, '2.4.0');
});

test('promoting a release from ring 1 to ring 2 makes it reach a ring-2 clinic that previously saw nothing', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1'); // default ring 2
  insertRelease(db, '2.4.0', { ring: 1 });

  assert.equal(checkIn(db, { installToken: token, version: '2.0.0' }, { signLicence: fakeSigner() }).update, null);

  db.prepare('UPDATE releases SET ring = 2 WHERE version = ?').run('2.4.0');
  const result = checkIn(db, { installToken: token, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.equal(result.update.version, '2.4.0');
});

test('pin decision: installed 2.3.0, pinned 2.4.0, release 2.4.0 published -> offered (the pin is a ceiling, not a lock)', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare('UPDATE clinics SET pinned_version = ? WHERE clinic_id = ?').run('2.4.0', 'c-1');
  insertRelease(db, '2.4.0');

  const result = checkIn(db, { installToken: token, version: '2.3.0' }, { signLicence: fakeSigner() });
  assert.equal(result.update.version, '2.4.0');
});

test('pin decision: a release newer than the pin is never offered, even though it is otherwise eligible', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare('UPDATE clinics SET pinned_version = ? WHERE clinic_id = ?').run('2.4.0', 'c-1');
  insertRelease(db, '2.5.0');

  const result = checkIn(db, { installToken: token, version: '2.3.0' }, { signLicence: fakeSigner() });
  assert.equal(result.update, null, 'a pinned clinic must not be offered anything newer than the pin, despite eligibility otherwise');
});

test('two eligible releases: the response is deterministic — always the single newest one', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  insertRelease(db, '2.4.0');
  insertRelease(db, '2.5.0');

  const result = checkIn(db, { installToken: token, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.equal(result.update.version, '2.5.0');
});

test('ATTACK: manifest is passed through opaquely — an attacker-shaped payload inside it never fails the check-in', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  insertRelease(db, '2.4.0', {
    manifest: { payload: { __proto__: { polluted: true }, nested: { arbitrary: ['shapes', 1, null] } }, sig: 'whatever-not-verified-here' },
  });

  const result = checkIn(db, { installToken: token, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.ok(result.update, 'an attacker-shaped payload inside manifest must still be offered, unexamined');
  assert.equal(result.update.manifest.sig, 'whatever-not-verified-here');
  assert.equal(({}).polluted, undefined, 'must never pollute Object.prototype');
});

test('a release whose stored manifest is hand-corrupted (unparseable) is not offered, rather than handing back something unusable', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare(
    `INSERT INTO releases (version, notes_ru, url, sha256, manifest, ring, halted) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('2.4.0', 'notes', 'url', 'hash', 'not json at all', 2, 0);

  const result = checkIn(db, { installToken: token, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.equal(result.update, null);
});

test('the update offer is unaffected by subscription — an unpaid clinic still sees an available update', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = ?").run('c-1');
  insertRelease(db, '2.4.0');

  const result = checkIn(db, { installToken: token, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.equal(result.licence, null, 'sanity: still unpaid, no licence');
  assert.equal(result.update.version, '2.4.0', 'a software update offer is not a money gate');
});

// --- UPDATE_DELIVERY_V1: `update_result` ------------------------------------

test('an old clinic that never sends update_result at all checks in exactly as before — the field is optional forever', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  const result = checkIn(db, { installToken: token, version: '1.0.0' }, { signLicence: fakeSigner() });
  assert.ok(result, 'a missing update_result must never fail the check-in');

  const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ?').get('c-1');
  assert.equal(JSON.parse(row.payload).update_result, null, 'no update_result sent must still leave a well-shaped null stored');
});

test('a valid update_result is recorded verbatim in the checkin payload, merged alongside stats/module_requests', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  insertRelease(db, '2.4.0');
  checkIn(db, {
    installToken: token,
    stats: { patients_total: 3 },
    updateResult: { version: '2.4.0', ok: true },
  }, { signLicence: fakeSigner() });

  const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ?').get('c-1');
  const payload = JSON.parse(row.payload);
  assert.deepEqual(payload.update_result, { version: '2.4.0', ok: true });
  assert.deepEqual(payload.stats, { patients_total: 3 }, 'merge, not clobber — the other payload fields must still be there');
});

test('a successful update_result increments outcome_successes and never halts', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  insertRelease(db, '2.4.0');

  checkIn(db, { installToken: token, updateResult: { version: '2.4.0', ok: true } }, { signLicence: fakeSigner() });

  const row = releaseRow(db, '2.4.0');
  assert.equal(row.outcome_successes, 1);
  assert.equal(row.outcome_failures, 0);
  assert.equal(row.halted, 0);
});

test('a failed update_result increments outcome_failures', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  insertRelease(db, '2.4.0');

  checkIn(db, { installToken: token, updateResult: { version: '2.4.0', ok: false } }, { signLicence: fakeSigner() });

  const row = releaseRow(db, '2.4.0');
  assert.equal(row.outcome_failures, 1);
  assert.equal(row.halted, 0, 'one failure alone must not halt (below DEFAULT_HALT_THRESHOLD)');
});

test('the acceptance boundary: exactly two failures (zero successes) auto-halts the release, inside the SAME transaction as the second failure', () => {
  const db = freshDb();
  const tokenA = enrol(db, 'c-a');
  const tokenB = enrol(db, 'c-b');
  insertRelease(db, '2.4.0');

  checkIn(db, { installToken: tokenA, updateResult: { version: '2.4.0', ok: false } }, { signLicence: fakeSigner() });
  assert.equal(releaseRow(db, '2.4.0').halted, 0, 'one failure must not halt yet');

  checkIn(db, { installToken: tokenB, updateResult: { version: '2.4.0', ok: false } }, { signLicence: fakeSigner() });
  assert.equal(releaseRow(db, '2.4.0').halted, 1, 'the second failure must halt it, atomically with recording that failure');
});

test('a halted release stops being offered to a third clinic — the acceptance scenario, end to end', () => {
  const db = freshDb();
  const tokenA = enrol(db, 'c-a');
  const tokenB = enrol(db, 'c-b');
  const tokenC = enrol(db, 'c-c');
  insertRelease(db, '2.4.0');

  checkIn(db, { installToken: tokenA, version: '2.0.0', updateResult: { version: '2.4.0', ok: false } }, { signLicence: fakeSigner() });
  checkIn(db, { installToken: tokenB, version: '2.0.0', updateResult: { version: '2.4.0', ok: false } }, { signLicence: fakeSigner() });
  assert.equal(releaseRow(db, '2.4.0').halted, 1, 'sanity: it must be halted by now');

  const resultC = checkIn(db, { installToken: tokenC, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.equal(resultC.update, null, 'a third clinic checking in after the halt must be offered nothing');
});

test('unhalting a release (as the admin API would) makes offers resume, with no further failures reported', () => {
  const db = freshDb();
  const tokenA = enrol(db, 'c-a');
  const tokenC = enrol(db, 'c-c');
  insertRelease(db, '2.4.0', { halted: 1 }); // as if auto-halted already
  db.prepare('UPDATE releases SET outcome_failures = 2 WHERE version = ?').run('2.4.0');

  assert.equal(checkIn(db, { installToken: tokenA, version: '2.0.0' }, { signLicence: fakeSigner() }).update, null);

  db.prepare('UPDATE releases SET halted = 0 WHERE version = ?').run('2.4.0'); // the unhalt

  const result = checkIn(db, { installToken: tokenC, version: '2.0.0' }, { signLicence: fakeSigner() });
  assert.equal(result.update.version, '2.4.0', 'offers must resume once unhalted');
});

test('a success reported after an unhalt does not resurrect the halt from stale failure counts', () => {
  // Regression guard for the exact bug this file's own comment warns about:
  // if a SUCCESS were allowed to re-trigger shouldHalt using the old,
  // never-reset failure counter, an unhalted release could freeze itself
  // again on the very next ordinary success report.
  const db = freshDb();
  const token = enrol(db, 'c-1');
  insertRelease(db, '2.4.0', { halted: 0 });
  db.prepare('UPDATE releases SET outcome_failures = 2, outcome_successes = 0 WHERE version = ?').run('2.4.0');

  checkIn(db, { installToken: token, updateResult: { version: '2.4.0', ok: true } }, { signLicence: fakeSigner() });

  const row = releaseRow(db, '2.4.0');
  assert.equal(row.halted, 0, 'a success must never itself flip halted, however stale the failure count is');
  assert.equal(row.outcome_successes, 1);
});

test('update_result naming a version that was never registered as a release is recorded as evidence but touches no release row, and never throws', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  assert.doesNotThrow(() => checkIn(db, {
    installToken: token, updateResult: { version: '9.9.9-never-registered', ok: false },
  }, { signLicence: fakeSigner() }));

  const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ?').get('c-1');
  assert.deepEqual(JSON.parse(row.payload).update_result, { version: '9.9.9-never-registered', ok: false });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM releases').get().n, 0, 'no release row may be invented');
});

test('ATTACK: garbage update_result shapes never fail the check-in and store a well-shaped null', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  for (const bad of ['a string', 42, null, ['array', 'not', 'object'], {}, { version: '2.4.0' }, { ok: true }, { version: '', ok: true }, { version: 42, ok: true }, { version: '2.4.0', ok: 'yes' }, { version: '2.4.0', ok: 1 }]) {
    const result = checkIn(db, { installToken: token, updateResult: bad }, { signLicence: fakeSigner() });
    assert.ok(result, `updateResult=${JSON.stringify(bad)} must not fail the check-in`);
    const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ? ORDER BY id DESC LIMIT 1').get('c-1');
    assert.equal(JSON.parse(row.payload).update_result, null, `updateResult=${JSON.stringify(bad)} must normalise to null, not be stored as-is`);
  }
});

test('a __proto__-shaped update_result never pollutes Object.prototype', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  assert.doesNotThrow(() => checkIn(db, {
    installToken: token, updateResult: { __proto__: { version: '2.4.0', ok: true } },
  }, { signLicence: fakeSigner() }));
  assert.equal(({}).polluted, undefined);
});

test('update_result never affects entitlement — a failed update report still re-arms an otherwise-paid clinic', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  grantModule(db, 'c-1', 'crm');
  insertRelease(db, '2.4.0');

  const result = checkIn(db, { installToken: token, updateResult: { version: '2.4.0', ok: false } }, { signLicence: fakeSigner() });
  assert.ok(result.licence, 'a failed update attempt must never cost a paid clinic its licence renewal');
});

test('a version string longer than the bound is truncated, not rejected outright, in update_result', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  const huge = '9.9.9-' + 'x'.repeat(200);
  assert.doesNotThrow(() => checkIn(db, { installToken: token, updateResult: { version: huge, ok: true } }, { signLicence: fakeSigner() }));
  const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ?').get('c-1');
  const stored = JSON.parse(row.payload).update_result;
  assert.ok(stored.version.length <= 32, 'version must be bounded, matching normaliseUpdateResult\'s own cap');
});

// BRANCH_MODULES_INHERIT_V1 — a branch runs the modules of its network.
//
// Owner's decision (2026-09-02): "everything in the main clinic should be
// active as if it is a one system". Without this the branch activated fine and
// then sat there with CRM and telephony dark, and nothing on any screen said
// why — the modules simply were not in its licence.
test('a branch inherits its parent clinic modules', () => {
  const db = freshDb();
  enrol(db, 'c-1');
  const branchToken = enrol(db, 'c-1-b1');
  db.prepare('UPDATE clinics SET parent_clinic_id = ? WHERE clinic_id = ?').run('c-1', 'c-1-b1');
  grantModule(db, 'c-1', 'crm');
  grantModule(db, 'c-1', 'callcenter');

  const calls = [];
  checkIn(db, { installToken: branchToken }, { signLicence: fakeSigner(calls) });
  assert.deepEqual(calls[0].modules, ['callcenter', 'crm'],
    'the branch gets what the network has, without a row of its own');
});

test('a branch keeps a module granted only to it', () => {
  const db = freshDb();
  enrol(db, 'c-1');
  const branchToken = enrol(db, 'c-1-b1');
  db.prepare('UPDATE clinics SET parent_clinic_id = ? WHERE clinic_id = ?').run('c-1', 'c-1-b1');
  grantModule(db, 'c-1', 'crm');
  grantModule(db, 'c-1-b1', 'telegram');

  const calls = [];
  checkIn(db, { installToken: branchToken }, { signLicence: fakeSigner(calls) });
  // Union, not replacement: inheriting must never take something away.
  assert.deepEqual(calls[0].modules, ['crm', 'telegram']);
});

test('a clinic with no parent is unaffected', () => {
  const db = freshDb();
  const token = enrol(db, 'c-solo');
  grantModule(db, 'c-solo', 'crm');
  const other = enrol(db, 'c-other');
  grantModule(db, 'c-other', 'callcenter');

  const calls = [];
  checkIn(db, { installToken: token }, { signLicence: fakeSigner(calls) });
  assert.deepEqual(calls[0].modules, ['crm'], 'no parent means nothing borrowed from anyone');
  assert.ok(!calls[0].modules.includes('callcenter'));
});
