// REFERRALS_CRM_V1 — миграция 252: представитель и специальность у источника,
// роль клиники «Медпредставитель».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dirUpTo(max) {
  const tmp = tmpDir('em-mig252-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) <= max)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  return tmp;
}
const cols = (db) => db.prepare('PRAGMA table_info(referral_sources)').all().map((c) => c.name);

test('до 252 колонок нет, после — есть; роль medrep заведена один раз', () => {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(251));
  assert.ok(!cols(db).includes('representative_id'));
  assert.ok(!cols(db).includes('specialty'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM custom_roles WHERE code = 'medrep'").get().n, 0);

  migrate(db, dirUpTo(252));
  assert.ok(cols(db).includes('representative_id'));
  assert.ok(cols(db).includes('specialty'));
  const role = db.prepare("SELECT name, base_role, active FROM custom_roles WHERE code = 'medrep'").get();
  assert.deepEqual(role, { name: 'Медпредставитель', base_role: 'callcenter', active: 1 });
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_referral_sources_representative'").get(),
    'индекса по представителю нет');
});

test('своя роль клиники с кодом medrep не перезаписывается', () => {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(251));
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('medrep', 'Торговый представитель', 'registrar')").run();
  migrate(db, dirUpTo(252));
  const role = db.prepare("SELECT name, base_role FROM custom_roles WHERE code = 'medrep'").get();
  assert.deepEqual(role, { name: 'Торговый представитель', base_role: 'registrar' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM custom_roles WHERE code = 'medrep'").get().n, 1);
});

test('представитель снимается при удалении сотрудника, внешний врач остаётся', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, custom_role_code) VALUES (7, 'rep', 'x', 'callcenter', 'Представитель', 'medrep')").run();
  db.prepare("INSERT INTO referral_sources (name, first_name, representative_id, specialty) VALUES ('Внешний Врач', 'Внешний', 7, 'ЛОР')").run();
  const id = db.prepare("SELECT id FROM referral_sources WHERE name = 'Внешний Врач'").get().id;
  db.pragma('foreign_keys = ON');
  db.prepare('DELETE FROM users WHERE id = 7').run();
  const row = db.prepare('SELECT representative_id, specialty, active FROM referral_sources WHERE id = ?').get(id);
  assert.equal(row.representative_id, null);
  assert.equal(row.specialty, 'ЛОР');
  assert.equal(row.active, 1);
});
