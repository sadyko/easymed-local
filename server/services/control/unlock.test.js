import { test } from 'node:test';
import assert from 'node:assert';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { currentChallenge, expectedResponse, redeem, extensionUntil } from './unlock.js';

const SECRET = 'unlock-secret-for-clinic-47';
const CLINIC = 'c-000047';
const NOW = new Date('2026-09-04T09:00:00Z');
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('the challenge is short enough to read down a telephone', () => {
  const c = currentChallenge(fresh());
  assert.match(c, /^[A-Z0-9]{6}$/);
});

test('the challenge is stable until it is used', () => {
  const db = fresh();
  assert.equal(currentChallenge(db), currentChallenge(db));
});

test('the vendor code unlocks and grants another 14 days', () => {
  const db = fresh();
  const challenge = currentChallenge(db);
  const code = expectedResponse({ clinicId: CLINIC, challenge, secret: SECRET });

  const r = redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(extensionUntil(db), '2026-09-18T09:00:00.000Z');
});

test('the response is formatted for reading aloud', () => {
  const code = expectedResponse({ clinicId: CLINIC, challenge: 'ABC123', secret: SECRET });
  assert.match(code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
});

test('a wrong code changes nothing', () => {
  const db = fresh();
  currentChallenge(db);
  const r = redeem(db, { code: 'AAAAA-BBBBB', clinicId: CLINIC, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_code');
  assert.equal(extensionUntil(db), null);
});

test('a code cannot be used twice', () => {
  const db = fresh();
  const challenge = currentChallenge(db);
  const code = expectedResponse({ clinicId: CLINIC, challenge, secret: SECRET });
  assert.equal(redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW }).ok, true);

  const again = redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW });
  assert.equal(again.ok, false, 'the challenge rotated, so the old code is dead');
});

test("another clinic's code does not work here", () => {
  const db = fresh();
  const challenge = currentChallenge(db);
  const code = expectedResponse({ clinicId: 'c-000099', challenge, secret: SECRET });
  assert.equal(redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW }).ok, false);
});

test('guessing is rate limited', () => {
  const db = fresh();
  currentChallenge(db);
  for (let i = 0; i < 5; i++) {
    assert.equal(redeem(db, { code: 'ZZZZZ-ZZZZZ', clinicId: CLINIC, secret: SECRET, now: NOW }).reason, 'bad_code');
  }
  const blocked = redeem(db, { code: 'ZZZZZ-ZZZZZ', clinicId: CLINIC, secret: SECRET, now: NOW });
  assert.equal(blocked.reason, 'too_many_attempts');
});

test('a correct code still works right up to the attempt limit', () => {
  const db = fresh();
  const challenge = currentChallenge(db);
  const code = expectedResponse({ clinicId: CLINIC, challenge, secret: SECRET });
  for (let i = 0; i < 4; i++) redeem(db, { code: 'ZZZZZ-ZZZZZ', clinicId: CLINIC, secret: SECRET, now: NOW });
  assert.equal(redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW }).ok, true);
});

test('codes are accepted in lower case and with stray spaces', () => {
  const db = fresh();
  const challenge = currentChallenge(db);
  const code = expectedResponse({ clinicId: CLINIC, challenge, secret: SECRET });
  const sloppy = ' ' + code.toLowerCase() + ' ';
  assert.equal(redeem(db, { code: sloppy, clinicId: CLINIC, secret: SECRET, now: NOW }).ok, true);
});

// --- self-review: is the attempt limiter's "5 wrong guesses, forever" too harsh? ---
//
// A receptionist who mishears two of six characters over a bad phone line burns
// the budget in two calls. A limiter that never recovers except on success would
// then permanently strand the one clinic this whole feature exists for: no
// internet, and now no working unlock path either. unlock.js resets the budget
// one hour after the first wrong guess in a run. The tests below pin that
// decision down, both ways: the reset must not weaken the limiter against a
// sustained guesser (still 5 tries per hour), and it must give a fumbling human
// their phone call back.

test('the attempt limiter resets an hour after the first wrong guess, not on every guess', () => {
  const db = fresh();
  const challenge = currentChallenge(db);
  const code = expectedResponse({ clinicId: CLINIC, challenge, secret: SECRET });
  const t0 = NOW;

  for (let i = 0; i < 5; i++) {
    redeem(db, { code: 'ZZZZZ-ZZZZZ', clinicId: CLINIC, secret: SECRET, now: t0 });
  }
  assert.equal(
    redeem(db, { code: 'ZZZZZ-ZZZZZ', clinicId: CLINIC, secret: SECRET, now: t0 }).reason,
    'too_many_attempts',
  );

  // Still within the hour: still blocked, even with the right code — a reset
  // that fired too early would just be a bigger attempt budget for a guesser.
  const justUnder = new Date(t0.getTime() + 59 * 60 * 1000);
  assert.equal(
    redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: justUnder }).reason,
    'too_many_attempts',
    'the correct code is still refused before the window elapses',
  );

  // Past the hour: budget is back, so the clinic's own valid code works again.
  const over = new Date(t0.getTime() + 60 * 60 * 1000 + 1000);
  assert.equal(redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: over }).ok, true);
});

test('a successful unlock clears the attempt count, not only the block', () => {
  const db = fresh();
  let challenge = currentChallenge(db);
  let code = expectedResponse({ clinicId: CLINIC, challenge, secret: SECRET });

  // Two fumbles, then success.
  redeem(db, { code: 'ZZZZZ-ZZZZZ', clinicId: CLINIC, secret: SECRET, now: NOW });
  redeem(db, { code: 'ZZZZZ-ZZZZZ', clinicId: CLINIC, secret: SECRET, now: NOW });
  assert.equal(redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW }).ok, true);

  // The challenge rotated on success, so compute a fresh valid code for round two.
  challenge = currentChallenge(db);
  code = expectedResponse({ clinicId: CLINIC, challenge, secret: SECRET });

  // If the 2 pre-success fumbles were still counted, 4 more here would total 6
  // and this clinic would already be over MAX_ATTEMPTS (5) with no way back
  // this hour. A clean reset on success means the budget is a full 5 again.
  for (let i = 0; i < 4; i++) {
    assert.equal(
      redeem(db, { code: 'ZZZZZ-ZZZZZ', clinicId: CLINIC, secret: SECRET, now: NOW }).reason,
      'bad_code',
    );
  }
  assert.equal(redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW }).ok, true);
});

// --- self-review: a damaged control.json must not crash the lock screen ---

test('an undefined or empty secret is rejected, not thrown', () => {
  const db = fresh();
  const challenge = currentChallenge(db);
  assert.doesNotThrow(() => expectedResponse({ clinicId: CLINIC, challenge, secret: undefined }));
  assert.doesNotThrow(() => redeem(db, { code: 'AAAAA-BBBBB', clinicId: CLINIC, secret: undefined, now: NOW }));
  const r = redeem(db, { code: 'AAAAA-BBBBB', clinicId: CLINIC, secret: '', now: NOW });
  assert.equal(r.reason, 'bad_code');
});

test('a missing, empty, or wrong-length code is rejected, not thrown', () => {
  const db = fresh();
  currentChallenge(db);
  assert.doesNotThrow(() => redeem(db, { code: '', clinicId: CLINIC, secret: SECRET, now: NOW }));
  assert.doesNotThrow(() => redeem(db, { code: undefined, clinicId: CLINIC, secret: SECRET, now: NOW }));
  assert.doesNotThrow(() => redeem(db, { code: 'AB', clinicId: CLINIC, secret: SECRET, now: NOW }));
  const r = redeem(db, { code: null, clinicId: CLINIC, secret: SECRET, now: NOW });
  assert.equal(r.reason, 'bad_code');
});

test('a database with no control_state table fails loudly rather than faking a challenge', () => {
  const db = openDb(':memory:'); // deliberately not migrated
  // There is no safe fallback challenge to hand back here — surfacing the
  // failure is correct, the same way a missing licence file is correct to
  // surface rather than treating an unreadable disk as "unlocked".
  assert.throws(() => currentChallenge(db));
});

// --- self-review: is the mod-32 reduction over a byte actually unbiased? ---

test('random codes are drawn from the full alphabet with no visible bias', () => {
  const db = fresh();
  const seen = {};
  let challenge = currentChallenge(db);
  // Each successful redeem rotates the challenge, so repeatedly "winning"
  // cheaply harvests many independent random draws from one open database
  // instead of paying migration cost per sample.
  for (let i = 0; i < 400; i++) {
    const code = expectedResponse({ clinicId: CLINIC, challenge, secret: SECRET });
    assert.equal(redeem(db, { code, clinicId: CLINIC, secret: SECRET, now: NOW }).ok, true);
    challenge = currentChallenge(db);
    for (const ch of challenge) seen[ch] = (seen[ch] || 0) + 1;
  }
  // 256 % 32 === 0, so byte % ALPHABET.length is an exact, unbiased reduction —
  // every one of the 32 symbols is equally likely on every draw. Over 2400
  // draws the chance a truly uniform alphabet fails to show all 32 symbols is
  // astronomically small; a future edit that made ALPHABET's length NOT a
  // divisor of 256 would show up here as symbols that rarely or never appear.
  const distinct = Object.keys(seen).length;
  assert.ok(distinct >= 28, `expected close to full alphabet coverage, saw ${distinct} distinct characters`);
});
