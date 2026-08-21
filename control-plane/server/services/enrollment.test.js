import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import {
  createEnrollmentCode,
  redeemEnrollmentCode,
  __setCodeGeneratorForTests,
} from './enrollment.js';

// unlock.js's alphabet — imported here only to assert createEnrollmentCode's
// codes are actually drawn from it (see enrollment.js's own import of the
// same constant, for the same phone-legibility reason).
import { ALPHABET } from '../../../server/services/control/unlock.js';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function clinicRow(db, clinicId) {
  return db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get(clinicId);
}

// --- createEnrollmentCode ----------------------------------------------------

test('createEnrollmentCode returns a code shaped EM-XXXX-XXXX from the phone-safe alphabet', () => {
  const db = freshDb();
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  assert.match(code, /^EM-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const body = code.replace(/^EM-/, '').replace('-', '');
  for (const ch of body) assert.ok(ALPHABET.includes(ch), `${ch} is not in the phone-safe alphabet`);
  // The excluded characters specifically — this is the whole point of using
  // unlock.js's alphabet instead of e.g. crypto.randomBytes().toString('hex').
  for (const bad of ['I', 'O', '0', '1']) assert.ok(!body.includes(bad));
});

test('createEnrollmentCode creates the clinic row with the fields given', () => {
  const db = freshDb();
  const code = createEnrollmentCode(db, {
    clinicId: 'c-1', name: 'Нурафшон Мед', contactPhone: '+998901234567', contactName: 'Aziz',
  });
  const row = clinicRow(db, 'c-1');
  assert.equal(row.name, 'Нурафшон Мед');
  assert.equal(row.contact_phone, '+998901234567');
  assert.equal(row.contact_name, 'Aziz');
  assert.equal(row.enrollment_code, code);
  assert.equal(row.install_token, null);
  assert.ok(row.unlock_secret && row.unlock_secret.length > 0, 'unlock_secret must be generated');
});

test('createEnrollmentCode works with only the required fields (contact fields optional)', () => {
  const db = freshDb();
  assert.doesNotThrow(() => createEnrollmentCode(db, { clinicId: 'c-1', name: 'Clinic' }));
  const row = clinicRow(db, 'c-1');
  assert.equal(row.contact_phone, null);
  assert.equal(row.contact_name, null);
});

test('two clinics get two different codes', () => {
  const db = freshDb();
  const a = createEnrollmentCode(db, { clinicId: 'c-1', name: 'A' });
  const b = createEnrollmentCode(db, { clinicId: 'c-2', name: 'B' });
  assert.notEqual(a, b);
});

test('a collision in the generated code is retried, not thrown', (t) => {
  const db = freshDb();
  const occupied = createEnrollmentCode(db, { clinicId: 'c-existing', name: 'Existing' });

  let calls = 0;
  __setCodeGeneratorForTests(() => { calls++; return calls === 1 ? occupied : 'EM-ZZZZ-ZZZZ'; });
  t.after(() => __setCodeGeneratorForTests(null));

  const code = createEnrollmentCode(db, { clinicId: 'c-new', name: 'New Clinic' });
  assert.equal(code, 'EM-ZZZZ-ZZZZ');
  assert.equal(calls, 2, 'the first (colliding) code must have been retried, not returned');
});

test('a clinic_id collision is NOT retried — it throws, because the clinic already exists', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-dup', name: 'First' });
  assert.throws(
    () => createEnrollmentCode(db, { clinicId: 'c-dup', name: 'Second' }),
    /UNIQUE constraint failed/,
  );
});

test('createEnrollmentCode rejects a non-string clinicId', () => {
  const db = freshDb();
  assert.throws(() => createEnrollmentCode(db, { clinicId: 47, name: 'X' }), /clinicId/);
});

test('createEnrollmentCode rejects an empty name', () => {
  const db = freshDb();
  assert.throws(() => createEnrollmentCode(db, { clinicId: 'c-1', name: '' }), /name/);
});

// --- redeemEnrollmentCode: happy path ----------------------------------------

test('redeeming a valid code returns the clinic identity and issues an install_token', () => {
  const db = freshDb();
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });

  const result = redeemEnrollmentCode(db, { code, fingerprint: 'fp-abc' });
  assert.ok(result, 'a fresh, valid code must redeem');
  assert.equal(result.clinic_id, 'c-1');
  assert.equal(result.clinic_name, 'Test Clinic');
  assert.equal(result.subscription, 'active');
  assert.ok(result.install_token && result.install_token.length > 0);
  assert.ok(result.unlock_secret && result.unlock_secret.length > 0);

  const row = clinicRow(db, 'c-1');
  assert.equal(row.enrollment_code, null, 'the code must be cleared — single use');
  assert.equal(row.install_token, result.install_token);
  assert.equal(row.last_fingerprint, 'fp-abc');
});

test('redemption is single-use: a second redemption of the same code fails', () => {
  const db = freshDb();
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });

  const first = redeemEnrollmentCode(db, { code });
  assert.ok(first);
  const second = redeemEnrollmentCode(db, { code });
  assert.equal(second, null, 'the same code must not redeem twice');
});

test('an unknown code (never issued) fails', () => {
  const db = freshDb();
  const result = redeemEnrollmentCode(db, { code: 'EM-NOPE-0000' });
  assert.equal(result, null);
});

// --- case / whitespace tolerance ---------------------------------------------

test('a code typed lowercase with stray whitespace still redeems', () => {
  const db = freshDb();
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  const typed = ' ' + code.toLowerCase() + ' ';
  const result = redeemEnrollmentCode(db, { code: typed });
  assert.ok(result, 'lowercase + surrounding whitespace must be forgiven');
  assert.equal(result.clinic_id, 'c-1');
});

// --- malformed code inputs must fail cleanly, never throw --------------------

test('an empty string code fails without throwing', () => {
  const db = freshDb();
  assert.doesNotThrow(() => {
    const result = redeemEnrollmentCode(db, { code: '' });
    assert.equal(result, null);
  });
});

test('a missing code fails without throwing', () => {
  const db = freshDb();
  assert.doesNotThrow(() => {
    const result = redeemEnrollmentCode(db, {});
    assert.equal(result, null);
  });
});

test('a non-string code (an object) fails without throwing', () => {
  const db = freshDb();
  assert.doesNotThrow(() => {
    const result = redeemEnrollmentCode(db, { code: { not: 'a string' } });
    assert.equal(result, null);
  });
});

test('an absurdly long code fails without throwing', () => {
  const db = freshDb();
  assert.doesNotThrow(() => {
    const result = redeemEnrollmentCode(db, { code: 'X'.repeat(10_000) });
    assert.equal(result, null);
  });
});

// --- fingerprint: advisory only, never a reason to fail ----------------------

test('an absent fingerprint redeems fine and is recorded as null', () => {
  const db = freshDb();
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  const result = redeemEnrollmentCode(db, { code });
  assert.ok(result);
  assert.equal(clinicRow(db, 'c-1').last_fingerprint, null);
});

test('an object fingerprint does not throw and is dropped, not stringified', () => {
  const db = freshDb();
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  assert.doesNotThrow(() => redeemEnrollmentCode(db, { code, fingerprint: { weird: true } }));
  const row = clinicRow(db, 'c-1');
  assert.equal(row.last_fingerprint, null, 'a non-string fingerprint must not become "[object Object]"');
});

test('a 10,000-character fingerprint is truncated, not rejected', () => {
  const db = freshDb();
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  const huge = 'f'.repeat(10_000);
  const result = redeemEnrollmentCode(db, { code, fingerprint: huge });
  assert.ok(result, 'an oversized fingerprint must never fail the enrollment');
  const stored = clinicRow(db, 'c-1').last_fingerprint;
  assert.ok(stored.length < 10_000);
});

// --- beforeCommit hook: what the route plugs signLicence() into -------------

test('beforeCommit receives the clinic id, name and granted modules', () => {
  const db = freshDb();
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  db.prepare('INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, ?)').run('c-1', 'crm');
  db.prepare('INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, ?)').run('c-1', 'telegram');

  let received = null;
  const result = redeemEnrollmentCode(db, { code }, {
    beforeCommit: (args) => { received = args; return { signed: true }; },
  });

  assert.ok(result);
  assert.deepEqual(received, { clinicId: 'c-1', clinicName: 'Test Clinic', modules: ['crm', 'telegram'] });
  assert.deepEqual(result.licence, { signed: true }, "beforeCommit's return value passes through as licence");
});

test('beforeCommit throwing rolls back the redemption — the code stays valid, no token is issued', () => {
  const db = freshDb();
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });

  assert.throws(() => redeemEnrollmentCode(db, { code }, {
    beforeCommit: () => { throw new Error('signing key not configured'); },
  }), /signing key not configured/);

  // Nothing committed: the code is untouched and no token was issued.
  const row = clinicRow(db, 'c-1');
  assert.equal(row.enrollment_code, code, 'the code must not be burned by a failed signing attempt');
  assert.equal(row.install_token, null);

  // And because nothing was consumed, the SAME code redeems normally once
  // whatever broke signing is fixed — this is the whole point of running
  // beforeCommit inside the transaction, before the UPDATE.
  const result = redeemEnrollmentCode(db, { code }, { beforeCommit: () => ({ signed: true }) });
  assert.ok(result, 'the code must still work after a prior signing failure');
});

// --- defensive: a row that already has an install_token -----------------------

test('a code pointing at a row that already has an install_token is refused, not overwritten', () => {
  // Unreachable in normal operation (enrollment_code and install_token are set
  // in the same UPDATE) — this simulates a hand-repaired/corrupted row to pin
  // the documented decision: refuse rather than mint a second token or
  // silently overwrite the one already issued.
  const db = freshDb();
  db.prepare(
    `INSERT INTO clinics (clinic_id, name, unlock_secret, enrollment_code, install_token)
     VALUES (?, ?, ?, ?, ?)`
  ).run('c-1', 'Already Enrolled', 'secret', 'EM-AAAA-1111', 'existing-token');

  const result = redeemEnrollmentCode(db, { code: 'EM-AAAA-1111' });
  assert.equal(result, null);

  const row = clinicRow(db, 'c-1');
  assert.equal(row.install_token, 'existing-token', 'the existing token must be left exactly as it was');
});
