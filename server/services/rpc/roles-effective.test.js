// ROLES_SAVE_TRUTH_V1 (2026-09-29) — role_effective_grants: что у роли есть
// СЕЙЧАС по каждой строке справочника с серверными воротами (спецификация
// docs/specs/2026-09-29-roles-save-truth-design.md, «Тесты», п. 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { roleEffectiveGrants, effectiveGrantsOf } from './roles-effective.js';
import { customRoleCreate } from './custom-roles.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { fallbackLevel } from '../gate-fallbacks.js';
import { catalogRows } from '../../../public/js/shared/permission-catalog.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const NURSE = { id: 2, role: 'nurse', extra_roles: [] };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin');
  ins.run(2, 'nurse1', 'x', 'nurse');
  return db;
}
function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
const levelsOf = (db, role) => roleEffectiveGrants(db, { role }, ADMIN).levels;

test('оператор колл-центра: «Видит все заявки» — нет, прослушивание — да, журнал — просмотр', () => {
  const db = fresh();
  try {
    const l = levelsOf(db, 'callcenter');
    assert.equal(l['crm.all'], 'none', 'экран снова нарисует оператору чужие заявки');
    assert.equal(l['crm.recording'], 'edit');
    assert.equal(l['crm.calls'], 'view');
  } finally { db.close(); }
});

test('регистратор: измерения, назначения, отметки и выписка стационара и crm.all — нет', () => {
  const db = fresh();
  try {
    const l = levelsOf(db, 'registrar');
    for (const k of ['inpatient.vitals', 'inpatient.prescriptions', 'inpatient.marks', 'inpatient.discharge', 'crm.all']) {
      assert.equal(l[k], 'none', k + ': экран снова раздаст регистратуре то, чего ворота не дают');
    }
  } finally { db.close(); }
});

test('медсестра: измерения — изменение', () => {
  const db = fresh();
  try { assert.equal(levelsOf(db, 'nurse')['inpatient.vitals'], 'edit'); } finally { db.close(); }
});

test('своя роль на основе оператора — ровно как оператор', () => {
  const db = fresh();
  try {
    customRoleCreate(db, { code: 'senior-op', name: 'Старший оператор', base_role: 'callcenter' }, ADMIN);
    assert.deepEqual(levelsOf(db, 'senior-op'), levelsOf(db, 'callcenter'));
  } finally { db.close(); }
});

test('своя роль на основе администратора — верхние уровни, пока ключ не настроен; своё «Нет» — нет', () => {
  const db = fresh();
  try {
    customRoleCreate(db, { code: 'deputy', name: 'Заместитель', base_role: 'admin' }, ADMIN);
    const byKey = new Map(catalogRows().map((r) => [r.key, r]));
    for (const [k, v] of Object.entries(levelsOf(db, 'deputy'))) {
      const levels = byKey.get(k).levels;
      assert.equal(v, levels[levels.length - 1], k + ': у роли на основе администратора не верхний уровень');
    }
    setGrants(db, 'deputy', { 'crm.all': 'none' });
    assert.equal(levelsOf(db, 'deputy')['crm.all'], 'none', 'своё «Нет» роли на основе администратора не прочиталось');
  } finally { db.close(); }
});

test('закрытый раздел даёт «Нет» внутри; записанный уровень — как записан, не выше уровней строки', () => {
  const db = fresh();
  try {
    setGrants(db, 'nurse', { inpatient: 'none' });
    const l = levelsOf(db, 'nurse');
    for (const k of ['inpatient.vitals', 'inpatient.marks', 'inpatient.services', 'inpatient.history']) assert.equal(l[k], 'none', k);
    setGrants(db, 'lab', { 'crm.all': 'delete', 'inpatient.vitals': 'view' });
    const lab = levelsOf(db, 'lab');
    assert.equal(lab['crm.all'], 'edit', 'уровень выше строки не срезан до её уровней');
    assert.equal(lab['inpatient.vitals'], 'view', 'записанный уровень не прочитался');
  } finally { db.close(); }
});

test('кто спрашивает: без «Ролей» — 403, с «Роли: Просмотр» — ответ; без входа — 401; нет роли — 404/400', () => {
  const db = fresh();
  try {
    assert.throws(() => roleEffectiveGrants(db, { role: 'callcenter' }, NURSE), (e) => e.status === 403);
    setGrants(db, 'nurse', { 'settings.roles': 'view' });
    assert.equal(roleEffectiveGrants(db, { role: 'callcenter' }, NURSE).levels['crm.all'], 'none');
    assert.throws(() => roleEffectiveGrants(db, { role: 'callcenter' }, null), (e) => e.status === 401);
    assert.throws(() => roleEffectiveGrants(db, { role: 'nobody' }, ADMIN), (e) => e.status === 404);
    assert.throws(() => roleEffectiveGrants(db, {}, ADMIN), (e) => e.status === 400);
  } finally { db.close(); }
});

test('в ответе — ровно строки с серверными воротами, без разделов и маршрутов; RPC — чистое чтение', () => {
  const db = fresh();
  try {
    const pseudo = { id: 0, role: 'nurse', extra_roles: [], custom_role_code: null };
    const want = catalogRows()
      .filter((r) => r.kind !== 'section' && !r.locked && fallbackLevel(db, pseudo, r.key, 'all') !== null)
      .map((r) => r.key).sort();
    assert.deepEqual(Object.keys(levelsOf(db, 'nurse')).sort(), want);
    for (const k of ['crm.all', 'inpatient.vitals', 'custdev.rate', 'reports.revenue', 'settings.roles', 'cashier.lines']) assert.ok(want.includes(k), k);
    for (const k of ['procurement', 'patients', 'patients.list', 'doctor.visits', 'mar.inpatient']) assert.ok(!want.includes(k), k + ' — без серверных ворот');
    assert.equal(typeof getRpc('role_effective_grants'), 'function');
    assert.equal(isReadOnlyRpc('role_effective_grants'), true, 'при запертой лицензии «Роли» не откроются');
    assert.deepEqual(effectiveGrantsOf(db, 'nurse'), levelsOf(db, 'nurse'));
  } finally { db.close(); }
});
