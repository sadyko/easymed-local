import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { canonical } from './canonical.js';
import { controlState, __setPublicKeyForTests } from './state.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
__setPublicKeyForTests(publicKey);

function workspace({ licence, identity } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-ctl-'));
  if (identity !== null) {
    fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(identity ?? {
      clinic_id: 'c-000047', unlock_secret: 's3cret', subscription: 'active',
    }));
  }
  if (licence) fs.writeFileSync(path.join(dir, 'licence.dat'), licence);
  const db = openDb(':memory:'); migrate(db);
  return { dir, db };
}

const issue = (over = {}) => {
  const payload = {
    clinic_id: 'c-000047', clinic_name: 'Нурафшон Мед',
    modules: ['crm'], valid_until: '2026-09-03T00:00:00Z',
    issued_at: '2026-08-20T00:00:00Z', nonce: 'n1', ...over,
  };
  return JSON.stringify({ payload, sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64') });
};

test('a healthy licence reports the modules it grants', () => {
  const { dir, db } = workspace({ licence: issue() });
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.locked, false);
  assert.deepEqual(s.modules, ['crm']);
  assert.equal(s.clinicName, 'Нурафшон Мед');
  assert.equal(s.state, 'ok');
});

test('an expired licence locks', () => {
  const { dir, db } = workspace({ licence: issue() });
  const s = controlState(db, dir, new Date('2026-09-10T00:00:00Z'));
  assert.equal(s.locked, true);
  assert.deepEqual(s.modules, [], 'a locked clinic has no modules');
});

test('no licence file at all is locked, not broken', () => {
  const { dir, db } = workspace();
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.locked, true);
  assert.equal(s.reason, 'unlicensed');
});

test('a shredded licence file is locked, not a crash', () => {
  const { dir, db } = workspace({ licence: 'garbage' });
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.locked, true);
});

test('an unenrolled install is locked but says so distinctly', () => {
  const { dir, db } = workspace({ identity: null });
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.locked, true);
  assert.equal(s.reason, 'not_enrolled');
});

test('a phone unlock rescues an expired licence', () => {
  const { dir, db } = workspace({ licence: issue() });
  db.prepare("INSERT INTO control_state (key, value) VALUES ('offline_extension_until', '2026-09-20T00:00:00Z')").run();
  const s = controlState(db, dir, new Date('2026-09-10T00:00:00Z'));
  assert.equal(s.locked, false, 'the extension outlives the licence date');
  assert.deepEqual(s.modules, ['crm'], 'and the modules come back');
});

test('an extension in the past does not rescue anything', () => {
  const { dir, db } = workspace({ licence: issue() });
  db.prepare("INSERT INTO control_state (key, value) VALUES ('offline_extension_until', '2026-09-05T00:00:00Z')").run();
  assert.equal(controlState(db, dir, new Date('2026-09-10T00:00:00Z')).locked, true);
});

test('a module is only granted if the licence names it', () => {
  const { dir, db } = workspace({ licence: issue({ modules: ['crm', 'telegram'] }) });
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.has('crm'), true);
  assert.equal(s.has('telegram'), true);
  assert.equal(s.has('marketing'), false);
});

test('an unreadable data directory does not throw', () => {
  const db = openDb(':memory:'); migrate(db);
  const s = controlState(db, path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()), new Date());
  assert.equal(s.locked, true);
});

// --- Adversarial follow-up: the given implementation calls effectiveNow() and
// clockAnomaly() OUTSIDE any try/catch. Both WRITE to control_state, and on a
// database that has never been migrated (or one whose control_state table has
// been dropped, or a read-only/full-disk mount) that write throws a raw
// SqliteError straight out of controlState() — the one thing this module is
// forbidden from doing. Reproduced directly: effectiveNow(openDb(':memory:'))
// with no migrate() throws "no such table: control_state". state.js wraps the
// call in try/catch and reports 'clock_unavailable'; this test would fail with
// an uncaught exception (not an assertion failure) if that guard were removed.
test('a database with no control_state table (unmigrated) locks instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-ctl-'));
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ clinic_id: 'c-000047' }));
  fs.writeFileSync(path.join(dir, 'licence.dat'), issue());
  const db = openDb(':memory:'); // deliberately NOT migrated
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.locked, true);
  assert.equal(s.reason, 'clock_unavailable');
});

// control.json parses as valid JSON but is not the shape expected: null, an
// array, a bare string, or an object whose clinic_id is a number rather than a
// string. Each must lock as 'not_enrolled' (identity is nonsense) rather than
// reaching verifyLicence with a non-string clinicId and being misreported as
// 'wrong_clinic', and must not throw.
test('control.json parsing to null/array/string/non-string-clinic_id locks as not_enrolled', () => {
  const variants = ['null', '[]', '"just a string"', JSON.stringify({ clinic_id: 123 })];
  for (const raw of variants) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-ctl-'));
    fs.writeFileSync(path.join(dir, 'control.json'), raw);
    const db = openDb(':memory:'); migrate(db);
    const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
    assert.equal(s.locked, true, `variant ${raw}`);
    assert.equal(s.reason, 'not_enrolled', `variant ${raw}`);
  }
});

// A hand-edited or corrupted licence payload can hold a modules array with
// non-string entries. has() sets a Set from `modules`; a stray number or
// object must never accidentally satisfy has(someModuleKey), and must not
// throw when JSON-serialised into the returned modules array.
test('non-string entries in a licence modules array are dropped, not matched by has()', () => {
  const { dir, db } = workspace({ licence: issue({ modules: [1, 2, {}, 'crm', null] }) });
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.deepEqual(s.modules, ['crm']);
  assert.equal(s.has('crm'), true);
  assert.equal(s.has(1), false);
});

// path.join(null, 'x') throws a TypeError before readJson ever runs — the one
// failure readJson's own try/catch cannot reach, because the throw happens
// building readJson's ARGUMENT, not inside it.
test('a null or undefined dataDir locks instead of throwing', () => {
  const db = openDb(':memory:'); migrate(db);
  assert.equal(controlState(db, null, new Date()).locked, true);
  assert.equal(controlState(db, undefined, new Date()).locked, true);
});

// offline_extension_until is attacker/corruption-reachable the same way any
// control_state row is (hand edit, half-written file recovered by SQLite's
// journal). new Date('not-a-date').getTime() is NaN, and Math.max([...NaN])
// is NaN, and new Date(NaN).toISOString() THROWS RangeError — reproduced
// directly against node:crypto's Date before writing this test. The isNaN
// filter in state.js exists to keep a corrupt extension row from taking down
// a licence that is otherwise perfectly healthy.
test('a garbage offline_extension_until value is ignored, not a crash', () => {
  const { dir, db } = workspace({ licence: issue() });
  db.prepare("INSERT INTO control_state (key, value) VALUES ('offline_extension_until', 'not-a-date')").run();
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.locked, false);
  assert.deepEqual(s.modules, ['crm']);
});

// Same failure mode, mirrored: the licence's OWN valid_until is unparseable
// (truncated write, hand edit) while a good extension exists. The extension
// must still rescue the install instead of the bad licence date poisoning the
// Math.max() comparison.
test('an unparseable valid_until in the licence does not crash when a valid extension exists', () => {
  const { dir, db } = workspace({ licence: issue({ valid_until: 'not-a-date' }) });
  db.prepare("INSERT INTO control_state (key, value) VALUES ('offline_extension_until', '2026-09-20T00:00:00Z')").run();
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.locked, false);
  assert.deepEqual(s.modules, ['crm']);
});

// The mirror image of the existing "extension in the past does not rescue"
// test: here the LICENCE is the one reaching further into the future, and a
// stale extension must not shorten it. Both directions of Math.max need
// covering, not just "extension wins when bigger".
test('a far-future licence is not shortened by a stale extension in the past', () => {
  const { dir, db } = workspace({ licence: issue({ valid_until: '2030-01-01T00:00:00Z' }) });
  db.prepare("INSERT INTO control_state (key, value) VALUES ('offline_extension_until', '2020-01-01T00:00:00Z')").run();
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(s.locked, false);
  assert.deepEqual(s.modules, ['crm']);
});

// SYSTEM_SETTINGS_V1 — the settings screen's subscription card shows the date
// the countdown runs against. That is the EFFECTIVE date (licence vs. phone
// extension, whichever reaches further), not the raw licence field: showing a
// date that disagrees with days_left would read as a bug to the clinic.
test('validUntil reports the date the countdown runs against', () => {
  const { dir, db } = workspace({ licence: issue() });
  const s = controlState(db, dir, new Date('2026-08-25T00:00:00Z'));
  assert.equal(new Date(s.validUntil).getTime(), new Date('2026-09-03T00:00:00Z').getTime());
});

test('a phone unlock that outlives the licence moves validUntil with it', () => {
  const { dir, db } = workspace({ licence: issue() });
  db.prepare("INSERT INTO control_state (key, value) VALUES ('offline_extension_until', '2026-09-20T00:00:00Z')").run();
  const s = controlState(db, dir, new Date('2026-09-10T00:00:00Z'));
  assert.equal(new Date(s.validUntil).getTime(), new Date('2026-09-20T00:00:00Z').getTime());
});

test('an unenrolled or unlicensed install has no validUntil, not a crash', () => {
  const { dir: noId, db: db1 } = workspace({ identity: null });
  assert.equal(controlState(db1, noId, new Date()).validUntil, null);
  const { dir: noLic, db: db2 } = workspace();
  assert.equal(controlState(db2, noLic, new Date()).validUntil, null);
});
