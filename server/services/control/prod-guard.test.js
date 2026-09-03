import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertControlUrlIsTestSafe } from './prod-guard.js';

// PROD_GUARD_V1 — this is the only thing standing between a test that forgot
// to inject fetchImpl/env and a real HTTP request to the vendor's production
// control plane (settings.easymed.uz). The bug it exists to catch already
// happened once: relay.test.js passed `fetchImpl: vendor.fetch` where the
// fixture's property is actually `vendor.fetchImpl` — the typo silently
// produced `fetchImpl: undefined`, the function's own default parameter fell
// through to the real globalThis.fetch, and three scheduleRelayPublish()
// tests fired real PUT/GET requests at production on every `npm test` run.
//
// These tests run themselves under `node --test`, so NODE_TEST_CONTEXT is
// genuinely set for real for the whole file — exactly the situation the
// guard is meant to act in. The one negative case (case 4) has to fake its
// ABSENCE by deleting it for the duration of one assertion.

test('throws when there is no override URL and fetchImpl resolves to the real fetch', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this suite must itself run under node --test for the case below to mean anything');
  assert.throws(
    () => assertControlUrlIsTestSafe({}, globalThis.fetch),
    /production control-plane/,
  );
});

test('throws the same way when fetchImpl is omitted entirely (its own default is the real fetch)', () => {
  assert.throws(() => assertControlUrlIsTestSafe(undefined, undefined));
  assert.throws(() => assertControlUrlIsTestSafe({}, undefined));
});

test('does not throw when EASYMED_CONTROL_URL is set, no matter what fetchImpl is', () => {
  assert.doesNotThrow(() => assertControlUrlIsTestSafe({ EASYMED_CONTROL_URL: 'http://127.0.0.1:65535' }, globalThis.fetch));
  assert.doesNotThrow(() => assertControlUrlIsTestSafe({ EASYMED_CONTROL_URL: 'http://127.0.0.1:65535' }, undefined));
});

test('does not throw when fetchImpl is a real override (a fake cannot reach the network regardless of env)', () => {
  const fake = async () => ({ ok: true });
  assert.doesNotThrow(() => assertControlUrlIsTestSafe({}, fake));
  assert.doesNotThrow(() => assertControlUrlIsTestSafe(undefined, fake));
});

test('does not throw outside a test process, even with no override at all', () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.doesNotThrow(() => assertControlUrlIsTestSafe({}, globalThis.fetch));
  } finally {
    // Restored unconditionally, in a finally, so a failed assertion above
    // can never leave the REST of this file running with the guard disabled.
    process.env.NODE_TEST_CONTEXT = saved;
  }
});
