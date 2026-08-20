// LIFECYCLE_V1 — the allowed status transitions, written down in one place.
//
// Statuses used to be assigned ad hoc wherever a handler happened to need one.
// Nothing described the shape of a lifecycle, so two opposite faults appeared
// and neither was visible from any single call site:
//
//   • states that could never be LEFT — a 'requested' admission had no handler
//     that could fulfil or cancel it, and because request_admission refuses a
//     second open request, the first one blocked that patient forever;
//   • states that could never be REACHED — 'refunded' is checked in five places
//     and assigned by nobody.
//
// A transition table makes both kinds fall out of a test (see lifecycle.test.js)
// instead of out of a support call.
//
// Rule: a status column is written only after assertTransition() has approved
// the move. Terminal states are declared, not discovered.

export class TransitionError extends Error {
  constructor(msg) {
    super(msg);
    this.status = 400;
  }
}

// entity -> { from -> [allowed to] }. A state mapping to [] is TERMINAL BY
// DESIGN; the reachability test asserts each one is deliberate.
export const TRANSITIONS = {
  admission: {
    // A doctor files a request; the ward either gives it a bed or declines it.
    requested:  ['active', 'cancelled'],
    active:     ['discharged'],
    discharged: [],   // terminal: the stay is over and billed
    cancelled:  [],   // terminal: the request was declined
  },
  invoice: {
    unpaid:   ['partial', 'paid', 'debt', 'void'],
    partial:  ['paid', 'debt', 'unpaid', 'void'],      // unpaid again after a full refund
    debt:     ['paid', 'unpaid', 'void'],              // stays 'debt' while part-paid — see money.js
    paid:     ['partial', 'unpaid', 'refunded'],       // refunds walk the ladder back down
    void:     [],       // terminal: cancelled before any money moved
    refunded: [],       // terminal: settled then fully returned
  },
};

// States a lifecycle may legitimately end in. Anything else with no outgoing
// transition is a dead end and fails the reachability test.
export const TERMINAL = {
  admission: ['discharged', 'cancelled'],
  invoice: ['void', 'refunded'],
};

// The state every entity starts in.
export const INITIAL = {
  admission: ['requested', 'active'],   // a walk-in is admitted without a request
  invoice: ['unpaid', 'paid'],          // a zero-balance invoice is born paid
};

export function canTransition(entity, from, to) {
  const table = TRANSITIONS[entity];
  if (!table) throw new TransitionError(`unknown entity: ${entity}`);
  if (from === to) return true;                    // idempotent re-assert
  return (table[from] || []).includes(to);
}

export function assertTransition(entity, from, to) {
  if (!canTransition(entity, from, to)) {
    throw new TransitionError(`${entity} cannot go from '${from}' to '${to}'.`);
  }
}
