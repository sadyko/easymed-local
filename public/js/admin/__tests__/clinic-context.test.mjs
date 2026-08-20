// CLINIC_AFTER_LOGIN_V1 — window.CLINIC must survive a fresh login.
//
// The bug this pins: admin.js boot() resolves the clinic BEFORE it resolves the
// user (initClinicContext at :2219, rehydrateUserFromSession at :2227), but
// /api/rpc sits behind requireAuth. On a first login there is no session cookie
// yet, so get_clinic_by_slug answers 401, loadClinicBySlug swallows it and
// returns null, and window.CLINIC stays null for the WHOLE page lifetime —
// initClinicContext only ever runs once, at boot.
//
// Every screen gated on currentClinicId() then degrades silently. lab-settings
// is the one that says so out loud: «Не удалось загрузить: нет привязки к
// клинике (window.CLINIC пуст)» — which a laborant hits right after saving a
// panel, because savePanel() calls reload() on success.

import { test } from 'node:test';
import assert from 'node:assert';
import { ensureClinicContext } from '../clinic-context.js';

// Minimal supabase double: .rpc(name, args) resolving to {data, error}.
function mockSupabase(result) {
  const calls = [];
  return {
    calls,
    rpc(name, args) { calls.push([name, args]); return Promise.resolve(result); },
  };
}

const CLINIC = { id: 1, slug: 'local', name: 'Ann Family Clinic', active: true };

test('fills window.CLINIC when boot left it null', async () => {
  globalThis.window = { CLINIC: null, location: { hostname: '192.168.100.10' } };
  const supabase = mockSupabase({ data: CLINIC, error: null });

  const out = await ensureClinicContext(supabase);

  assert.strictEqual(window.CLINIC.id, 1);
  assert.strictEqual(window.CLINIC.name, 'Ann Family Clinic');
  assert.strictEqual(out.id, 1);
  assert.strictEqual(supabase.calls.length, 1, 'must actually ask for the clinic');
});

test('does not re-fetch when boot already resolved the clinic', async () => {
  globalThis.window = { CLINIC: CLINIC, location: { hostname: '192.168.100.10' } };
  const supabase = mockSupabase({ data: CLINIC, error: null });

  await ensureClinicContext(supabase);

  assert.strictEqual(supabase.calls.length, 0, 'a resolved clinic must not be re-fetched on every call');
});

// A clinic that still cannot be resolved must not throw: the app degrades, it
// does not fail to boot. This is what makes the fix safe to call unconditionally.
test('tolerates an RPC that still fails', async () => {
  globalThis.window = { CLINIC: null, location: { hostname: '192.168.100.10' } };
  const supabase = mockSupabase({ data: null, error: { message: 'Login required.' } });

  const out = await ensureClinicContext(supabase);

  assert.strictEqual(out, null);
  assert.strictEqual(window.CLINIC, null);
});
