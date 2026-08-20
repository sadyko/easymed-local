import { test } from 'node:test';
import assert from 'node:assert';
import { setLicence, isLicensed, licenceState, licenceKeyFor } from './licence.js';
import { LICENSED_MODULES, LICENSED_NAV_IDS } from './licensed-modules.js';

test('a module the licence names is unlocked', () => {
  setLicence({ locked: false, modules: ['crm'], state: 'ok', days_left: 13 });
  assert.equal(isLicensed('crm'), true);
});

test('a module the licence omits is locked', () => {
  setLicence({ locked: false, modules: ['crm'], state: 'ok', days_left: 13 });
  assert.equal(isLicensed('marketing'), false);
});

test('modules nobody sells are always open', () => {
  setLicence({ locked: false, modules: [], state: 'ok', days_left: 13 });
  assert.equal(isLicensed('patients'), true, 'the clinical core is never for sale');
  assert.equal(isLicensed('cashier-shifts'), true);
});

test('a lapsed subscription locks even the free modules', () => {
  setLicence({ locked: true, modules: [], state: 'locked', days_left: 0 });
  assert.equal(isLicensed('patients'), false);
});

test('before the server answers, nothing is treated as sold', () => {
  setLicence(null);
  assert.equal(isLicensed('patients'), true, 'never flash a lock at a paying clinic on boot');
  assert.equal(isLicensed('marketing'), false, 'but never flash a paid module open either');
});

test('nav ids map to licence keys', () => {
  assert.equal(licenceKeyFor('telegram-chat'), 'telegram');
  assert.equal(licenceKeyFor('crm'), 'crm');
  assert.equal(licenceKeyFor('patients'), null);
});

test('the ladder state is readable for the banner', () => {
  setLicence({ locked: false, modules: [], state: 'warn', days_left: 2, reason: 'offline' });
  assert.equal(licenceState().state, 'warn');
  assert.equal(licenceState().days_left, 2);
});

// ---------------------------------------------------------------------------
// Attacking a malformed licence payload — a hand-edited licence file, or a
// server bug, should never be able to lock out a paying clinic AND must never
// be able to open a module nobody bought.
// ---------------------------------------------------------------------------

test('a truthy but non-boolean "locked" (a string "false") must not lock everyone out', () => {
  setLicence({ locked: 'false', modules: ['crm'], state: 'ok', days_left: 5 });
  assert.equal(isLicensed('patients'), true, 'a stray string in `locked` is not a real lock');
  assert.equal(isLicensed('crm'), true, 'the module the licence actually lists still opens');
});

test('an empty licence object fails closed for paid modules, open for the core', () => {
  setLicence({});
  assert.equal(isLicensed('patients'), true);
  assert.equal(isLicensed('crm'), false);
});

test('`modules: null` fails closed instead of throwing', () => {
  setLicence({ locked: false, modules: null, state: 'ok', days_left: 5 });
  assert.doesNotThrow(() => isLicensed('crm'));
  assert.equal(isLicensed('crm'), false);
});

test('`modules` as a bare string fails closed instead of substring-matching', () => {
  // 'crm' is a substring of 'telegram-crm-marketing', so a naive .includes()
  // on the string itself (instead of requiring an array) would wrongly open
  // every module whose key appears anywhere in the string.
  setLicence({ locked: false, modules: 'telegram-crm-marketing', state: 'ok', days_left: 5 });
  assert.equal(isLicensed('crm'), false);
  assert.equal(isLicensed('telegram-chat'), false);
});

test('licenceState() fills in missing fields instead of handing back undefined', () => {
  setLicence({ state: 'warn' });
  const s = licenceState();
  assert.equal(s.state, 'warn');
  assert.equal(s.days_left, 0, 'missing days_left must read as a number, not undefined');
  assert.deepEqual(s.modules, []);
  assert.equal(s.locked, false);
});

// ---------------------------------------------------------------------------
// Prototype-pollution-shaped nav ids. A plain `{}` object literal inherits
// __proto__/constructor/toString/hasOwnProperty from Object.prototype, so a
// naive lookup table would treat these ids as "found" (truthy) instead of
// "not a real module". licensed-modules.js uses a null-prototype object so
// these all come back cleanly as `undefined` → null.
// ---------------------------------------------------------------------------

test('licenceKeyFor does not resolve inherited Object.prototype properties as licence keys', () => {
  assert.equal(licenceKeyFor('__proto__'), null);
  assert.equal(licenceKeyFor('constructor'), null);
  assert.equal(licenceKeyFor('toString'), null);
  assert.equal(licenceKeyFor('hasOwnProperty'), null);
});

test('those same ids are never treated as gated (isLicensed opens them like any other core id)', () => {
  setLicence({ locked: false, modules: [], state: 'ok', days_left: 5 });
  assert.equal(isLicensed('__proto__'), true);
  assert.equal(isLicensed('constructor'), true);
});

test('LICENSED_MODULES has no inherited Object.prototype baggage', () => {
  assert.equal(LICENSED_MODULES['__proto__'], undefined, 'must be a plain undefined lookup, not the prototype object');
  assert.equal(LICENSED_MODULES['constructor'], undefined);
  assert.equal(LICENSED_MODULES['toString'], undefined);
  assert.equal(Object.getPrototypeOf(LICENSED_MODULES), null, 'null-prototype object, not a {} literal');
});

test('exactly the three sellable modules are gated, named to match the real nav ids', () => {
  // Cross-checked against admin.js: NAV has {id:'crm'} and {id:'telegram-chat'},
  // both real sidebar entries. 'marketing' has NO NAV entry today — it is only
  // reachable as a route (case 'marketing' in the router, and a CRUMBS entry)
  // behind a "coming soon" placeholder. It is still listed here because the
  // licence and SELLABLE_MODULES on the server already name it, and the next
  // task (routing) needs a place to look it up — but there is currently no
  // sidebar link for a lock icon to attach to.
  assert.deepEqual([...LICENSED_NAV_IDS].sort(), ['crm', 'marketing', 'telegram-chat']);
});
