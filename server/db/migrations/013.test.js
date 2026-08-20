import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('013 creates role_permissions with one seeded row per built-in role', () => {
  const db = openDb(':memory:'); migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
  assert.ok(tables.includes('role_permissions'), 'role_permissions table missing');

  const roles = db.prepare('SELECT role FROM role_permissions ORDER BY role').all().map(r=>r.role);
  for (const r of ['admin','registrar','doctor','cashier','lab','nurse','inventory'])
    assert.ok(roles.includes(r), 'missing seeded role: ' + r);

  // role is UNIQUE
  assert.throws(() => db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('doctor','{}')").run());

  // permissions is valid JSON with a sections array; admin seeded with all modules
  const admin = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='admin'").get().permissions);
  assert.ok(Array.isArray(admin.sections), 'admin.sections not an array');
  for (const m of ['dashboard','reports-hub','patients','labs','inventory','patient-documents','settings'])
    assert.ok(admin.sections.includes(m), 'admin should include ' + m);
  assert.equal(admin.levels.patients, 'admin');

  // a non-admin role has a sensible subset + levels
  const doc = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='doctor'").get().permissions);
  assert.ok(doc.sections.includes('patients') && doc.sections.includes('labs'));
  assert.ok(!doc.sections.includes('settings'), 'doctor should NOT get settings by default');
  assert.equal(doc.levels.patients, 'editor');
});
