// CALLCENTER_ROLE_V1 (mig 059) — the seeded permission row for the new role.
//
// A role with no role_permissions row sees no sections at all, so the grant has
// to ship with the role; otherwise every clinic has to rebuild it by hand in
// Settings → Роли, which is exactly the manual step that produced the broken
// inventory→crm grant this migration replaces.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('059 seeds the callcenter role with the CRM section', () => {
  const db = freshDb();
  const row = db.prepare("SELECT permissions FROM role_permissions WHERE role='callcenter'").get();
  assert.ok(row, 'callcenter must have a seeded permissions row');
  const perms = JSON.parse(row.permissions);
  assert.ok(perms.sections.includes('crm'), 'callcenter must be granted the crm section');
  assert.equal(perms.levels.crm, 'admin', 'the call centre runs its own board');
  db.close();
});

test('059 does not widen any other role', () => {
  const db = freshDb();
  // The seeded grants of migration 013 must survive untouched — this migration
  // adds a role, it does not re-cut anyone else's access.
  const inv = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='inventory'").get().permissions);
  assert.deepEqual(inv.sections.sort(), ['dashboard', 'inventory', 'reports-hub']);
  db.close();
});

test('059 is idempotent under a re-run of the migration runner', () => {
  const db = freshDb();
  migrate(db);   // second pass must be a no-op, not a UNIQUE violation
  assert.equal(db.prepare("SELECT COUNT(*) c FROM role_permissions WHERE role='callcenter'").get().c, 1);
  db.close();
});
