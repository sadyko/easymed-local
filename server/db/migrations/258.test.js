// FIX_318_V1 (L4) — миграция 258: роль «Медпредставитель» без дубля по имени и
// с минимальными правами до настройки клиникой. Миграцию 252 не трогаем: на
// базах, где она уже прошла, правка файла ничего бы не исправила.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { canViewSection, sectionLevel } from '../../services/roles.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dirUpTo(max) {
  const tmp = tmpDir('em-mig258-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) <= max)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  return tmp;
}
const MINIMAL = { sections: ['referrals'], levels: { referrals: 'viewer' }, patient_tabs: {} };
const perms = (db, role) => {
  const r = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  return r ? JSON.parse(r.permissions) : null;
};

test('мигр. 258: медпредставитель до настройки прав видит только «Реферирование» (просмотр), а не весь колл-центр', () => {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(257));
  db.prepare("INSERT INTO users (id, username, password_hash, role, custom_role_code) VALUES (4, 'rep', 'x', 'callcenter', 'medrep')").run();
  const rep = { id: 4, role: 'callcenter', custom_role_code: 'medrep' };
  assert.ok(canViewSection(db, rep, 'crm'), 'до 258: роль без строки прав работает по основе — весь колл-центр');
  migrate(db, dirUpTo(258));
  assert.deepEqual(perms(db, 'medrep'), MINIMAL);
  assert.equal(canViewSection(db, rep, 'crm'), false, 'CRM колл-центра — нет');
  assert.equal(sectionLevel(db, rep, 'referrals'), 'viewer', '«Реферирование» — просмотр');
});

test('мигр. 258: своя роль клиники «Медпредставитель» под другим кодом — дубль medrep, который никто не носит, убран', () => {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(251));
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('med_rep', 'Медпредставитель', 'callcenter')").run();
  migrate(db, dirUpTo(252));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM custom_roles WHERE trim(name) = 'Медпредставитель'").get().n, 2, '252 завела дубль');
  migrate(db, dirUpTo(258));
  assert.deepEqual(db.prepare("SELECT code FROM custom_roles WHERE trim(name) = 'Медпредставитель'").all().map((r) => r.code), ['med_rep']);
  assert.equal(perms(db, 'medrep'), null, 'прав для убранного дубля не заведено');
  assert.equal(perms(db, 'med_rep'), null, 'своя роль клиники не тронута');
});

test('мигр. 258: дубль, который уже носит сотрудник или который клиника настроила, не удаляется; настроенные права не переписываются', () => {
  const db = openDb(':memory:');
  migrate(db, dirUpTo(251));
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('med_rep', 'Медпредставитель', 'callcenter')").run();
  migrate(db, dirUpTo(252));
  db.prepare("INSERT INTO users (id, username, password_hash, role, custom_role_code) VALUES (4, 'rep', 'x', 'callcenter', 'medrep')").run();
  migrate(db, dirUpTo(258));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM custom_roles WHERE code = 'medrep'").get().n, 1, 'роль с сотрудником остаётся');
  assert.deepEqual(perms(db, 'medrep'), MINIMAL);

  const db2 = openDb(':memory:');
  migrate(db2, dirUpTo(257));
  const own = { sections: ['referrals', 'crm'], levels: { referrals: 'editor', crm: 'viewer' } };
  db2.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('medrep', ?)").run(JSON.stringify(own));
  migrate(db2, dirUpTo(258));
  assert.deepEqual(perms(db2, 'medrep'), own, 'права, выданные клиникой, не трогаем');
});
