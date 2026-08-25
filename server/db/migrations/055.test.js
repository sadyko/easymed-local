// ROLE_KEYS_V2 — the permission vocabulary must be ONE vocabulary.
//
// Three places name modules: admin.js NAV (what the sidebar renders),
// permissions.js NAV_MODULES (what the Roles editor offers), and the seeded rows
// in role_permissions. They had drifted into three different sets, and a grant
// written in one was simply not read by the others — silently. The editor's
// «Doctor's room» wrote `doctor-room`; the cabinet is gated on `consultation`;
// so every doctor was locked out of their own queue and nothing anywhere said so.
//
// These tests fail on the drift itself, not on its symptoms.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// admin.js NAV ids — the gates the sidebar actually renders.
function navIds() {
  const src = read('public/js/admin.js');
  const block = src.slice(src.indexOf('const NAV = ['), src.indexOf('];', src.indexOf('const NAV = [')));
  return [...block.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
}

// permissions.js NAV_MODULES keys — what the Roles editor offers to grant.
function grantableKeys() {
  const src = read('public/js/admin/permissions.js');
  const block = src.slice(src.indexOf('export const NAV_MODULES = ['), src.indexOf('export const NAV_MODULE_KEYS'));
  return [...block.matchAll(/\{\s*key:\s*'([^']+)'/g)].map((m) => m[1]);
}

// Keys that are real gates without being NAV ids, each with the line that reads
// it. Anything NOT here and not a NAV id is a dead key.
const NON_NAV_GATES = {
  // renderSidebar(): the «+ Новый пациент» CTA.
  registration: /isModuleAllowed\('registration'\)/,
  // isModuleAllowed('cashier-shifts') accepts `cashier` as an alias of the NAV id.
  cashier: /navId === 'cashier-shifts'\) return _effective\.has\('cashier-shifts'\) \|\| _effective\.has\('cashier'\)/,
  // CUSTDEV_V1 — the «Cust Dev» button inside the CRM screen. Its gate cannot
  // live in admin.js: the workplace is not a sidebar section, it is a button
  // next to «Канбан».
  custdev: /canView\('custdev'\)/,
};

// Files a non-NAV gate may live in. crm.js joined the list with CUSTDEV_V1 — a
// gate belongs where the thing it guards is drawn, and forcing it into admin.js
// just to satisfy this test would put the check in the wrong file.
const GATE_SOURCES = ['public/js/admin.js', 'public/js/admin/permissions.js', 'public/js/admin/views/crm.js'];

test('every grantable key is a real gate — no key the UI offers is dead', () => {
  const nav = new Set(navIds());
  const sources = GATE_SOURCES.map(read);
  const dead = [];
  for (const key of grantableKeys()) {
    if (nav.has(key)) continue;
    const re = NON_NAV_GATES[key];
    if (re && sources.some((src) => re.test(src))) continue;
    dead.push(key);
  }
  assert.deepEqual(dead, [], 'grantable keys that nothing checks (ticking them does nothing):\n' + dead.join('\n'));
});

test('`doctor-room` is gone from the grantable list — the cabinet gate is `consultation`', () => {
  const keys = grantableKeys();
  assert.ok(!keys.includes('doctor-room'), 'doctor-room is not a gate; the sidebar checks consultation');
  assert.ok(keys.includes('consultation'), 'the doctor cabinet must be grantable');
  assert.ok(navIds().includes('consultation'), 'and consultation must still be the NAV id');
});

// The reverse drift: a module the sidebar renders that no role could ever be
// granted is invisible to every non-admin, forever.
test('every sidebar module can be granted to a role', () => {
  const grantable = new Set(grantableKeys());
  const ungrantable = navIds().filter((id) => {
    if (grantable.has(id)) return false;
    // The NAV item is `cashier-shifts`; the grant key is its alias `cashier`.
    if (id === 'cashier-shifts') return !grantable.has('cashier');
    return true;
  });
  assert.deepEqual(ungrantable, [], 'sidebar modules with no way to grant them:\n' + ungrantable.join('\n'));
});

// ---------------------------------------------------------------------------
// Migration 055 — repairing rows already written against the dead key.
// ---------------------------------------------------------------------------
const perms = (db, role) => JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions);

test('055 renames doctor-room to consultation, keeping the granted level', () => {
  const db = openDb(':memory:');
  migrate(db);
  // Reproduce exactly what the old editor saved (this is the live DB's shape).
  db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(
    JSON.stringify({ sections: ['patients', 'doctor-room', 'labs'], levels: { patients: 'editor', 'doctor-room': 'admin' } }), 'doctor');
  db.exec(read('server/db/migrations/055_role_permission_keys.sql'));

  const p = perms(db, 'doctor');
  assert.ok(p.sections.includes('consultation'), 'the cabinet grant survives the rename');
  assert.ok(!p.sections.includes('doctor-room'), 'the dead key is gone');
  assert.equal(p.levels.consultation, 'admin', 'and keeps the level the admin chose');
  assert.equal(p.levels.patients, 'editor', 'other grants are untouched');
  db.close();
});

test('055 gives the registrar the gates their job needs', () => {
  const db = openDb(':memory:');
  migrate(db);   // 055 runs as part of the chain
  const p = perms(db, 'registrar');
  assert.ok(p.sections.includes('registration'), 'a registrar must be able to register a patient');
  assert.ok(p.sections.includes('crm'), 'and to convert a lead');
  assert.ok(p.sections.includes('patients'));
  db.close();
});

test('055 gives the nurse the procedures queue and the doctor a cabinet', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.ok(perms(db, 'nurse').sections.includes('procedures'));
  assert.ok(perms(db, 'doctor').sections.includes('consultation'));
  db.close();
});

test('055 is idempotent — re-running adds no duplicates', () => {
  const db = openDb(':memory:');
  migrate(db);
  const before = perms(db, 'registrar').sections.slice().sort();
  db.exec(read('server/db/migrations/055_role_permission_keys.sql'));
  db.exec(read('server/db/migrations/055_role_permission_keys.sql'));
  const after = perms(db, 'registrar').sections.slice().sort();
  assert.deepEqual(after, before);
  db.close();
});

test('every seeded role ends up with only live keys', () => {
  const db = openDb(':memory:');
  migrate(db);
  const nav = new Set(navIds());
  const grantable = new Set(grantableKeys());
  const bad = [];
  for (const row of db.prepare('SELECT role, permissions FROM role_permissions').all()) {
    for (const s of (JSON.parse(row.permissions).sections || [])) {
      if (!nav.has(s) && !grantable.has(s)) bad.push(`${row.role}: ${s}`);
    }
  }
  assert.deepEqual(bad, [], 'seeded grants nothing reads:\n' + bad.join('\n'));
  db.close();
});

// Every staff role must be able to do the thing it exists to do. This is the
// test that states the workflow, so a future permission edit that breaks a role
// fails here rather than in the clinic.
test('each role can reach its core screen', () => {
  const db = openDb(':memory:');
  migrate(db);
  const need = {
    registrar: ['patients', 'registration'],
    doctor:    ['patients', 'consultation'],
    cashier:   ['cashier'],
    lab:       ['labs'],
    nurse:     ['procedures'],
    inventory: ['inventory'],
  };
  const missing = [];
  for (const [role, keys] of Object.entries(need)) {
    const got = new Set(perms(db, role).sections || []);
    for (const k of keys) if (!got.has(k)) missing.push(`${role} cannot reach ${k}`);
  }
  assert.deepEqual(missing, [], missing.join('\n'));
  db.close();
});
