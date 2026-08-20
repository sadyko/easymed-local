// CLINIC_AFTER_LOGIN_V1 — the clinic must be resolved on EVERY path into the app.
//
// The bug this pins, and the reason a first fix did not work:
//
//   boot()                                    initClinicContext()  → 401 → CLINIC = null
//     └ rehydrateUserFromSession() → null → showLogin(); RETURN    ← boot ends here
//   showLogin() submit → verifyLogin() → onAuthed()                ← no page reload
//
// Logging in through the form never reloads the page, so anything added to
// boot() AFTER the `return` is dead code for exactly the users who need it.
// onAuthed() is where all three entries converge — login submit, first-login
// reset, and boot-with-an-existing-session — so the resolve has to live there.
//
// A source-level guard (same approach as migrations/055.test.js, which parses
// admin.js NAV) because boot()/onAuthed() cannot be imported without a DOM.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// public/js/admin/__tests__ -> repo root is four levels up.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const admin = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin.js'), 'utf8');

// The body of `async function onAuthed(...)` up to the next top-level function.
function onAuthedBody() {
  const start = admin.indexOf('async function onAuthed(');
  assert.ok(start > -1, 'onAuthed() must exist — it is the single post-login entry point');
  const rest = admin.slice(start);
  const end = rest.indexOf('\n}\n');
  assert.ok(end > -1, 'could not delimit onAuthed()');
  return rest.slice(0, end);
}

test('onAuthed resolves the clinic, so a form login is not left without one', () => {
  assert.match(
    onAuthedBody(),
    /ensureClinicContext\s*\(/,
    'onAuthed() must call ensureClinicContext(): boot() returns at showLogin(), so a fix placed there never runs for a user who logs in via the form',
  );
});

test('the clinic is resolved before anything that reads it', () => {
  const body = onAuthedBody();
  const clinicAt = body.search(/ensureClinicContext\s*\(/);
  const branchAt = body.search(/initBranchContext\s*\(/);
  assert.ok(clinicAt > -1 && branchAt > -1, 'both calls must be present');
  assert.ok(
    clinicAt < branchAt,
    'ensureClinicContext() must run before initBranchContext(): branch/scope resolution and every screen it starts read currentClinicId()',
  );
});

test('admin.js imports ensureClinicContext', () => {
  assert.match(
    admin,
    /import\s*\{[^}]*ensureClinicContext[^}]*\}\s*from\s*'\.\/admin\/clinic-context\.js/,
    'the helper must actually be imported, or onAuthed() throws a ReferenceError at login',
  );
});
