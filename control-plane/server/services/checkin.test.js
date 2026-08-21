import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from './enrollment.js';
import { checkIn } from './checkin.js';

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

// --- collect: reserved, always empty ----------------------------------------

test('collect is always an empty array', () => {
  const db = freshDb();
  const token = enrol(db, 'c-1');
  const result = checkIn(db, { installToken: token }, { signLicence: fakeSigner() });
  assert.deepEqual(result.collect, []);
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
