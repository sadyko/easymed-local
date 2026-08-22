import test from 'node:test';
import assert from 'node:assert/strict';
import { offerFor, shouldHalt, DEFAULT_HALT_THRESHOLD } from './rings.js';

// UPDATE_DELIVERY_V1 — pure decision logic, tested exhaustively like
// ladder.js's own boundary-by-boundary suite. No database, no HTTP: every
// rule here is an argument, so every rung is a one-line test.

function release(version, ring, halted = false) {
  return { version, ring, halted };
}

// --- offerFor: ring direction ------------------------------------------------

test('a release published to ring 0 is offered to a ring-0 clinic', () => {
  const offer = offerFor({ releases: [release('2.4.0', 0)], clinic: { ring: 0 }, installedVersion: '2.0.0' });
  assert.equal(offer?.version, '2.4.0');
});

test('a release published to ring 0 must NOT reach a ring-2 clinic', () => {
  const offer = offerFor({ releases: [release('2.4.0', 0)], clinic: { ring: 2 }, installedVersion: '2.0.0' });
  assert.equal(offer, null, 'ring 0 is the narrowest audience — a ring-2 clinic is not in it');
});

test('a release published to ring 0 must NOT reach a ring-1 clinic either', () => {
  const offer = offerFor({ releases: [release('2.4.0', 0)], clinic: { ring: 1 }, installedVersion: '2.0.0' });
  assert.equal(offer, null);
});

test('a release published to ring 2 ("everyone") reaches a ring-0 clinic', () => {
  const offer = offerFor({ releases: [release('2.4.0', 2)], clinic: { ring: 0 }, installedVersion: '2.0.0' });
  assert.equal(offer?.version, '2.4.0', 'published to everyone must include the vendor\'s own ring-0 install');
});

test('a release published to ring 2 reaches a ring-1 clinic', () => {
  const offer = offerFor({ releases: [release('2.4.0', 2)], clinic: { ring: 1 }, installedVersion: '2.0.0' });
  assert.equal(offer?.version, '2.4.0');
});

test('a release published to ring 1 reaches a ring-1 clinic but not a ring-2 clinic', () => {
  const releases = [release('2.4.0', 1)];
  assert.equal(offerFor({ releases, clinic: { ring: 1 }, installedVersion: '2.0.0' })?.version, '2.4.0');
  assert.equal(offerFor({ releases, clinic: { ring: 2 }, installedVersion: '2.0.0' }), null);
});

test('a release published exactly to the clinic\'s own ring reaches it (boundary: clinic.ring === release.ring)', () => {
  const offer = offerFor({ releases: [release('2.4.0', 1)], clinic: { ring: 1 }, installedVersion: '2.0.0' });
  assert.ok(offer, 'the boundary itself must be inclusive');
});

// --- offerFor: unpublished (-1) never offered -------------------------------

test('ATTACK: a release registered but never published (ring -1) must never be offered, even to the narrowest ring', () => {
  const offer = offerFor({ releases: [release('2.4.0', -1)], clinic: { ring: 0 }, installedVersion: '2.0.0' });
  assert.equal(offer, null);
});

// --- offerFor: halted --------------------------------------------------------

test('a halted release is never offered, even though otherwise eligible', () => {
  const offer = offerFor({ releases: [release('2.4.0', 2, true)], clinic: { ring: 2 }, installedVersion: '2.0.0' });
  assert.equal(offer, null);
});

test('halted:1 (SQLite integer form) is treated the same as halted:true', () => {
  const offer = offerFor({ releases: [{ version: '2.4.0', ring: 2, halted: 1 }], clinic: { ring: 2 }, installedVersion: '2.0.0' });
  assert.equal(offer, null);
});

test('halted:0 (SQLite integer form) is treated the same as halted:false — offered normally', () => {
  const offer = offerFor({ releases: [{ version: '2.4.0', ring: 2, halted: 0 }], clinic: { ring: 2 }, installedVersion: '2.0.0' });
  assert.ok(offer);
});

// --- offerFor: version comparison -------------------------------------------

test('a clinic already on the offered version is offered nothing', () => {
  const offer = offerFor({ releases: [release('2.4.0', 2)], clinic: { ring: 2 }, installedVersion: '2.4.0' });
  assert.equal(offer, null);
});

test('a clinic AHEAD of the release (installed newer) is offered nothing', () => {
  const offer = offerFor({ releases: [release('2.4.0', 2)], clinic: { ring: 2 }, installedVersion: '2.5.0' });
  assert.equal(offer, null);
});

test('a clinic behind the release is offered it', () => {
  const offer = offerFor({ releases: [release('2.4.0', 2)], clinic: { ring: 2 }, installedVersion: '2.3.9' });
  assert.equal(offer?.version, '2.4.0');
});

test('version compare is numeric per segment: 2.10.0 beats 2.9.0, not a string compare', () => {
  const offer = offerFor({ releases: [release('2.10.0', 2)], clinic: { ring: 2 }, installedVersion: '2.9.0' });
  assert.equal(offer?.version, '2.10.0');
});

// --- offerFor: two eligible releases — newest wins, deterministically ------

test('two eligible releases: the newest is offered, regardless of array order', () => {
  const inOrder = [release('2.4.0', 2), release('2.5.0', 2)];
  const reversed = [release('2.5.0', 2), release('2.4.0', 2)];
  assert.equal(offerFor({ releases: inOrder, clinic: { ring: 2 }, installedVersion: '2.0.0' })?.version, '2.5.0');
  assert.equal(offerFor({ releases: reversed, clinic: { ring: 2 }, installedVersion: '2.0.0' })?.version, '2.5.0');
});

test('three candidates at different rings/halt states: only the newest ELIGIBLE one wins, not merely the newest overall', () => {
  const releases = [
    release('2.6.0', 0),        // ring too narrow for a ring-2 clinic
    release('2.5.0', 2, true),  // halted
    release('2.4.0', 2),        // eligible
  ];
  const offer = offerFor({ releases, clinic: { ring: 2 }, installedVersion: '2.0.0' });
  assert.equal(offer?.version, '2.4.0');
});

// --- offerFor: pin as ceiling, not a lock ------------------------------------

test('pin decision: installed 2.3.0, pinned 2.4.0, release 2.4.0 published -> OFFERED (equal to the pin is allowed)', () => {
  const offer = offerFor({
    releases: [release('2.4.0', 2)],
    clinic: { ring: 2, pinnedVersion: '2.4.0' },
    installedVersion: '2.3.0',
  });
  assert.equal(offer?.version, '2.4.0', 'the pin is a ceiling — it must not block the pinned version itself');
});

test('pin decision: installed 2.3.0, pinned 2.4.0, release 2.5.0 published -> NOT offered (newer than the pin)', () => {
  const offer = offerFor({
    releases: [release('2.5.0', 2)],
    clinic: { ring: 2, pinnedVersion: '2.4.0' },
    installedVersion: '2.3.0',
  });
  assert.equal(offer, null);
});

test('a pinned clinic is still offered a release BELOW the pin, as long as it clears installedVersion', () => {
  const offer = offerFor({
    releases: [release('2.2.0', 2)],
    clinic: { ring: 2, pinnedVersion: '2.4.0' },
    installedVersion: '2.0.0',
  });
  assert.equal(offer?.version, '2.2.0');
});

test('a pinned clinic with two eligible releases (one at the pin, one over it) is offered only the one at the pin', () => {
  const offer = offerFor({
    releases: [release('2.4.0', 2), release('2.5.0', 2)],
    clinic: { ring: 2, pinnedVersion: '2.4.0' },
    installedVersion: '2.0.0',
  });
  assert.equal(offer?.version, '2.4.0');
});

test('an unpinned clinic (pinnedVersion null/undefined/absent) is unaffected by the pin rule', () => {
  const releases = [release('2.5.0', 2)];
  assert.equal(offerFor({ releases, clinic: { ring: 2, pinnedVersion: null }, installedVersion: '2.0.0' })?.version, '2.5.0');
  assert.equal(offerFor({ releases, clinic: { ring: 2 }, installedVersion: '2.0.0' })?.version, '2.5.0');
});

// --- offerFor: defensive / malformed inputs never throw ---------------------

test('an empty releases array offers nothing', () => {
  assert.equal(offerFor({ releases: [], clinic: { ring: 2 }, installedVersion: '2.0.0' }), null);
});

test('a missing installedVersion is treated as very old — the newest eligible release is still offered', () => {
  const offer = offerFor({ releases: [release('2.4.0', 2)], clinic: { ring: 2 }, installedVersion: undefined });
  assert.equal(offer?.version, '2.4.0', 'an unknown installed version must not block an otherwise-eligible offer');
});

test('malformed release rows (missing version, non-object, empty version) are skipped, not thrown', () => {
  const releases = [null, undefined, 42, 'not-an-object', {}, { version: '' }, { version: 42 }, release('2.4.0', 2)];
  assert.doesNotThrow(() => offerFor({ releases, clinic: { ring: 2 }, installedVersion: '2.0.0' }));
  const offer = offerFor({ releases, clinic: { ring: 2 }, installedVersion: '2.0.0' });
  assert.equal(offer?.version, '2.4.0', 'the one well-formed row must still be found among the garbage');
});

test('a clinic with a non-numeric ring is offered nothing, never a crash', () => {
  assert.doesNotThrow(() => offerFor({ releases: [release('2.4.0', 2)], clinic: { ring: 'not-a-number' }, installedVersion: '2.0.0' }));
  assert.equal(offerFor({ releases: [release('2.4.0', 2)], clinic: { ring: 'not-a-number' }, installedVersion: '2.0.0' }), null);
});

test('a release with a non-numeric ring is skipped, never a crash', () => {
  const releases = [{ version: '2.4.0', ring: 'garbage' }, release('2.3.0', 2)];
  assert.doesNotThrow(() => offerFor({ releases, clinic: { ring: 2 }, installedVersion: '2.0.0' }));
  assert.equal(offerFor({ releases, clinic: { ring: 2 }, installedVersion: '2.0.0' })?.version, '2.3.0');
});

test('offerFor never throws when releases is not an array, or clinic is missing', () => {
  assert.equal(offerFor({ releases: 'not-an-array', clinic: { ring: 2 }, installedVersion: '2.0.0' }), null);
  assert.equal(offerFor({ releases: [release('2.4.0', 2)], clinic: null, installedVersion: '2.0.0' }), null);
  assert.equal(offerFor({}), null);
});

// --- shouldHalt: the acceptance scenario ------------------------------------

test('exactly two failures, zero successes, halts at the default threshold — the acceptance scenario', () => {
  assert.equal(shouldHalt({ outcomes: { failures: 2, successes: 0 } }), true);
});

test('one failure alone never halts', () => {
  assert.equal(shouldHalt({ outcomes: { failures: 1, successes: 0 } }), false);
});

test('zero failures never halts, however many successes', () => {
  assert.equal(shouldHalt({ outcomes: { failures: 0, successes: 500 } }), false);
});

// --- shouldHalt: boundary arithmetic, exact --------------------------------

test('boundary at the default threshold: threshold-1 failures never halts, exactly threshold failures does', () => {
  assert.equal(shouldHalt({ outcomes: { failures: DEFAULT_HALT_THRESHOLD - 1, successes: 0 } }), false);
  assert.equal(shouldHalt({ outcomes: { failures: DEFAULT_HALT_THRESHOLD, successes: 0 } }), true);
});

test('boundary at a custom threshold of 3: 2 failures never halts, 3 failures (outnumbering successes) halts', () => {
  assert.equal(shouldHalt({ outcomes: { failures: 2, successes: 0 }, threshold: 3 }), false);
  assert.equal(shouldHalt({ outcomes: { failures: 3, successes: 0 }, threshold: 3 }), true);
});

test('a custom threshold of 1 halts on the very first failure', () => {
  assert.equal(shouldHalt({ outcomes: { failures: 1, successes: 0 }, threshold: 1 }), true);
});

test('failures overwhelmed by successes never halts, even far past the threshold — a mostly-healthy release is not broken', () => {
  assert.equal(shouldHalt({ outcomes: { failures: 5, successes: 500 } }), false);
});

test('failures exactly equal to successes never halts — "outnumber", not "at least as many"', () => {
  assert.equal(shouldHalt({ outcomes: { failures: 2, successes: 2 } }), false);
  assert.equal(shouldHalt({ outcomes: { failures: 10, successes: 10 } }), false);
});

test('failures one more than successes, both past threshold, halts', () => {
  assert.equal(shouldHalt({ outcomes: { failures: 3, successes: 2 } }), true);
});

test('an off-by-one implementation would either never halt at the boundary or halt one report early — walk failures 0..5 against threshold 2 and pin the exact transition', () => {
  const expected = [false, false, true, true, true, true]; // failures = 0,1,2,3,4,5 ; successes fixed at 0
  for (let failures = 0; failures <= 5; failures++) {
    assert.equal(shouldHalt({ outcomes: { failures, successes: 0 }, threshold: 2 }), expected[failures],
      `failures=${failures} threshold=2 expected ${expected[failures]}`);
  }
});

// --- shouldHalt: defensive / malformed inputs never throw -------------------

test('shouldHalt never throws on missing or garbage outcomes', () => {
  assert.equal(shouldHalt({}), false);
  assert.equal(shouldHalt({ outcomes: {} }), false);
  assert.equal(shouldHalt({ outcomes: { failures: 'not-a-number', successes: 0 } }), false);
  assert.equal(shouldHalt({ outcomes: null }), false);
  assert.equal(shouldHalt(), false);
});

test('a garbage threshold (NaN, string, negative-but-not-a-number) never throws', () => {
  assert.doesNotThrow(() => shouldHalt({ outcomes: { failures: 2, successes: 0 }, threshold: 'not-a-number' }));
  assert.equal(shouldHalt({ outcomes: { failures: 2, successes: 0 }, threshold: 'not-a-number' }), false);
});

test('a threshold of 0 halts as soon as failures outnumber successes, including failures=0 vs successes=0 staying false (0 is not > 0)', () => {
  assert.equal(shouldHalt({ outcomes: { failures: 0, successes: 0 }, threshold: 0 }), false, '0 failures is never > 0 successes');
  assert.equal(shouldHalt({ outcomes: { failures: 1, successes: 0 }, threshold: 0 }), true);
});
