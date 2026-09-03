// PROD_GUARD_V1 — the one check standing between an unreviewed test and a
// real request to the vendor's production control plane.
//
// Every endpoint-resolution function in this codebase (checkinUrl in
// checkin.js, enrollUrl in enroll.js, controlBaseUrl in updater.js, relayUrl
// and relayTokenUrl in relay.js, and the inline resolution inside
// createBranchOnControlPlane) shares the same fallback: no
// EASYMED_CONTROL_URL in the environment means "talk to
// settings.easymed.uz". That default is correct for a real clinic and wrong
// for a test that forgot to inject fetchImpl or set the env var — the
// difference between the two used to be silent until the vendor's own nginx
// log showed a burst of 401s from a developer's machine (2026-09-02: three
// scheduleRelayPublish() tests in relay.test.js passed `fetchImpl:
// vendor.fetch` — the fixture's property is actually `fetchImpl`, so the
// value was `undefined`, and the default parameter fell through to the real
// globalThis.fetch against the real endpoint).
//
// THE SIGNAL THAT TELLS THEM APART. Node itself sets NODE_TEST_CONTEXT in
// every `node --test` worker (verified against this repo's own Node build:
// the value is 'child-v8', but this check only ever asks whether the
// variable is SET, never what it says, so it does not pin itself to that
// string). A production install never runs under `node --test`, so this
// guard can never misfire against a real clinic — it can only ever fire
// inside a test process that is one missing env/fetchImpl override away from
// a real HTTP request to production.
//
// Call this right before the actual network call — with the SAME `env` and
// `fetchImpl` the caller resolved via its own default parameters (`env =
// process.env`, `fetchImpl = globalThis.fetch`), never with process.env or
// globalThis.fetch directly. Two things make a call safe even inside a test
// process:
//   * an explicit EASYMED_CONTROL_URL — the caller is deliberately pointing
//     at some other server (a local fixture, an e2e test's own in-process
//     control plane, or — for a real clinic — nothing, since this branch is
//     only reached when it's unset); or
//   * an injected fetchImpl that is not the real, unmocked globalThis.fetch —
//     a fake/spy can't reach the network no matter what URL it's given, so a
//     test that supplies one (with any `env`, even `{}`) is safe by
//     construction and must not be flagged.
// Only when NEITHER holds — no override URL AND the real fetch would be
// used — does reaching this point from a test process mean a genuine mistake
// (a forgotten override, or, as happened once, a typo'd fixture property
// that silently evaluated to `undefined` and fell through to the default).
export function assertControlUrlIsTestSafe(env, fetchImpl) {
  if (env && env.EASYMED_CONTROL_URL) return;
  if (fetchImpl && fetchImpl !== globalThis.fetch) return;
  if (!process.env.NODE_TEST_CONTEXT) return;
  throw new Error(
    'refusing to reach the production control-plane URL from inside a test process ' +
    '(NODE_TEST_CONTEXT is set, EASYMED_CONTROL_URL is not, and no fetchImpl override was given) — ' +
    'inject a fetchImpl, or set EASYMED_CONTROL_URL for this call/test'
  );
}
