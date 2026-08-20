import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getClinicBySlug } from './clinic.js';

test('get_clinic_by_slug returns a synthetic single-clinic row', () => {
  const db = openDb(':memory:'); migrate(db);
  const user = { id: 1, role: 'admin' };
  const clinic = getClinicBySlug(db, { slug: 'anything' }, user);
  assert.equal(clinic.id, 1);
  assert.equal(clinic.slug, 'local');
  assert.equal(clinic.active, true);
  assert.ok(clinic.name && typeof clinic.name === 'string' && clinic.name.length > 0);
});

test('get_clinic_by_slug pulls the clinic name from doc_settings when set', () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("UPDATE doc_settings SET clinic_name = 'Ann Family Clinic' WHERE id = 1").run();
  const clinic = getClinicBySlug(db, { slug: 'anything' }, { id: 1, role: 'admin' });
  assert.equal(clinic.name, 'Ann Family Clinic');
});

test('get_clinic_by_slug falls back to a default name when doc_settings.clinic_name is blank', () => {
  const db = openDb(':memory:'); migrate(db);
  const clinic = getClinicBySlug(db, { slug: 'anything' }, { id: 1, role: 'admin' });
  assert.equal(clinic.name, 'Easy-Med Local');
});

// clinic-context.js calls this RPC during boot(), BEFORE rehydrateUserFromSession()
// resolves any logged-in user — the app needs to know the clinic before it can even
// render the login screen. So the handler must not require an authenticated user.
test('get_clinic_by_slug does not require an authenticated user (runs pre-login)', () => {
  const db = openDb(':memory:'); migrate(db);
  assert.doesNotThrow(() => getClinicBySlug(db, { slug: 'anything' }, null));
  const clinic = getClinicBySlug(db, { slug: 'anything' }, undefined);
  assert.equal(clinic.slug, 'local');
});
