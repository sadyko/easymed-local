// LIFECYCLE_V1 — the reachability guard.
//
// Two faults hid in the old ad-hoc status assignment, and neither was visible
// from any single call site:
//   • 'requested' admissions could never be LEFT (dead end — the patient could
//     never be referred for inpatient care again);
//   • 'refunded' invoices could never be REACHED (checked in five places,
//     assigned by nobody).
//
// Both are properties of the lifecycle as a whole, so they get tested as one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSITIONS, TERMINAL, INITIAL, canTransition, assertTransition, TransitionError } from './lifecycle.js';

for (const entity of Object.keys(TRANSITIONS)) {
  test(`${entity}: every state is REACHABLE from an initial state`, () => {
    const table = TRANSITIONS[entity];
    const seen = new Set(INITIAL[entity]);
    const queue = [...INITIAL[entity]];
    while (queue.length) {
      for (const next of table[queue.shift()] || []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    const unreachable = Object.keys(table).filter((s) => !seen.has(s));
    assert.deepEqual(unreachable, [],
      `${entity} states that no sequence of transitions can ever produce: ${unreachable.join(', ')}`);
  });

  test(`${entity}: every state can be LEFT, unless it is declared terminal`, () => {
    const table = TRANSITIONS[entity];
    const stuck = Object.keys(table)
      .filter((s) => (table[s] || []).length === 0)
      .filter((s) => !TERMINAL[entity].includes(s));
    assert.deepEqual(stuck, [],
      `${entity} dead ends — add a transition out, or declare them terminal: ${stuck.join(', ')}`);
  });

  test(`${entity}: declared terminal states really are terminal, and initial states exist`, () => {
    for (const s of TERMINAL[entity]) {
      assert.ok(s in TRANSITIONS[entity], `${entity}: terminal '${s}' is not a real state`);
      assert.deepEqual(TRANSITIONS[entity][s], [], `${entity}: terminal '${s}' has a way out`);
    }
    for (const s of INITIAL[entity]) {
      assert.ok(s in TRANSITIONS[entity], `${entity}: initial '${s}' is not a real state`);
    }
  });
}

test('admission: the request dead end is gone — requested can be fulfilled or declined', () => {
  assert.ok(canTransition('admission', 'requested', 'active'));
  assert.ok(canTransition('admission', 'requested', 'cancelled'));
  // …but a request is not a stay: it cannot be discharged, and a finished stay
  // cannot be reopened.
  assert.throws(() => assertTransition('admission', 'requested', 'discharged'), TransitionError);
  assert.throws(() => assertTransition('admission', 'discharged', 'active'), TransitionError);
});

test('re-asserting the current state is allowed; an unknown entity throws', () => {
  assert.ok(canTransition('admission', 'active', 'active'));
  assert.throws(() => canTransition('spaceship', 'a', 'b'), TransitionError);
});
