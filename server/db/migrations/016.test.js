import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

// 016 grants the doctor their own cabinet. It originally wrote the key
// `doctor-room`, which NOTHING reads — the sidebar gates that module on
// `consultation` (admin.js NAV). So the grant existed in the database, showed as
// ticked in the Roles editor, and still left every doctor without their queue.
//
// This test asserted `doctor-room` — it was pinning the bug in place, which is
// why the suite stayed green while the feature was dead. Migration 055 renames
// the key; the assertion now states the INTENT (the doctor can reach their
// cabinet) against the key that actually gates it.
test('016 grants the doctor their cabinet — under the key the sidebar reads', () => {
  const db = openDb(':memory:'); migrate(db);

  const doc = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='doctor'").get().permissions);
  assert.ok(doc.sections.includes('consultation'), 'doctor role can open «Мои услуги»');
  assert.equal(doc.levels.consultation, 'editor');
  assert.ok(!doc.sections.includes('doctor-room'), 'the dead key must not survive');

  const admin = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='admin'").get().permissions);
  assert.ok(admin.sections.includes('consultation'), 'admin row includes it too');
  assert.ok(!admin.sections.includes('doctor-room'));
  db.close();
});
