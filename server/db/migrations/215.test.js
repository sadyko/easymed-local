// V3121_ROLES (мигр. 215) — роли, сохранённые на экране «действиями» (v0.9–3.0,
// раздел без своих действий записывался как «viewer») и пересохранённые на
// матрице (3.1+), получили явный «Просмотр» на всех действиях стационара и
// склада. Такая медсестра с 3.2 не может записать измерение, отметить введение
// препарата; кладовщик — выдать со склада. Миграция снимает эти ключи ТОЛЬКО
// у строки с точным отпечатком того старого перевода — и отдаёт решение
// прежнему правилу ролей (значение по умолчанию основы, не выше).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { grantAllows, grantLevel } from '../../services/grants.js';
import { grantsFromLegacy, catalogRows, CATALOG } from '../../../public/js/shared/permission-catalog.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '215_old_screen_view_restore.sql'), 'utf8');

// Строка, как её сохраняла цепочка «старый экран → матрица»: разделы без своих
// действий — «viewer», grants выведены grantsFromLegacy, а collectGrants убрал
// невыбранное «Нет» у разделов и строки «только администратор».
function oldScreenRow(sections, levels, extraGrants = {}) {
  const g = grantsFromLegacy({ sections, levels });
  for (const r of catalogRows()) if (r.adminDefault && g[r.key] === 'none') delete g[r.key];
  for (const s of CATALOG) if (g[s.key] === 'none') delete g[s.key];
  return { sections, levels, patient_tabs: {}, grants: { ...g, ...extraGrants } };
}

const NURSE = oldScreenRow(['patients', 'labs', 'dashboard', 'procedures', 'queue', 'beds'],
  { patients: 'editor', labs: 'viewer', dashboard: 'viewer', procedures: 'viewer', queue: 'viewer', beds: 'viewer' },
  { 'crm.calls': 'none', 'crm.dial': 'none', 'crm.recording': 'none', 'crm.convert': 'none' });
const STOCK = oldScreenRow(['inventory', 'dashboard', 'reports-hub'],
  { inventory: 'viewer', dashboard: 'viewer', 'reports-hub': 'viewer' });

function setup(rows) {
  const db = openDb(':memory:');
  migrate(db);
  const up = db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)');
  for (const [role, p] of Object.entries(rows)) up.run(role, JSON.stringify(p));
  return db;
}
const perms = (db, role) => JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions);
const nurse = { id: 1, role: 'nurse', extra_roles: [] };
const stock = { id: 2, role: 'inventory', extra_roles: [] };

test('215: медсестра со строкой старого экрана снова пишет измерения и отмечает введение — не выше основы', () => {
  const db = setup({ nurse: NURSE });
  try {
    assert.equal(grantAllows(db, nurse, 'inpatient.vitals', 'edit', ['nurse']), false, 'до поправки — только просмотр');
    assert.equal(grantAllows(db, nurse, 'inpatient.marks', 'edit', ['nurse']), false);
    db.exec(SQL);
    for (const k of ['inpatient', 'inpatient.requests', 'inpatient.patients', 'inpatient.beds', 'inpatient.history', 'inpatient.prescriptions',
      'inpatient.marks', 'inpatient.vitals', 'inpatient.reviews', 'inpatient.services', 'inpatient.discharge', 'mar', 'mar.outpatient', 'mar.inpatient',
      'kitchen', 'discharges']) {
      assert.equal(grantLevel(db, nurse, k), null, k + ' — решает прежнее правило ролей');
    }
    assert.equal(grantAllows(db, nurse, 'inpatient.vitals', 'edit', ['nurse', 'senior_nurse', 'doctor', 'admin']), true);
    assert.equal(grantAllows(db, nurse, 'inpatient.marks', 'edit', ['nurse', 'senior_nurse', 'admin']), true);
    // Не выше основы: назначения медсестре по умолчанию не выдаются, удалять измерения — тоже.
    assert.equal(grantAllows(db, nurse, 'inpatient.prescriptions', 'edit', ['doctor', 'head_doctor', 'admin']), false);
    assert.equal(grantAllows(db, nurse, 'inpatient.vitals', 'delete', ['admin']), false);
    const p = perms(db, 'nurse');
    assert.equal(p.levels.beds, 'editor', 'как у штатной медсестры: пересохранение на матрице не вернёт «Просмотр»');
    assert.equal(p.levels.procedures, 'viewer', 'остальные уровни не трогаем');
    assert.equal(p.grants.labs, 'view');
    assert.equal(p.grants['crm.dial'], 'none');
    // Пересохранение роли на экране «Роли» выводит из уровня «editor» изменение, а не просмотр.
    assert.equal(grantsFromLegacy(p)['inpatient.vitals'], 'edit');
    assert.equal(grantsFromLegacy(p)['inpatient.marks'], 'edit');
  } finally { db.close(); }
});

test('215: смешанная строка, собранная руками, не трогается', () => {
  const vitalsEdit = { ...NURSE, grants: { ...NURSE.grants, 'inpatient.vitals': 'edit' } };
  const marksNone = { ...NURSE, grants: { ...NURSE.grants, 'inpatient.marks': 'none' } };
  const partial = { ...NURSE, grants: { ...NURSE.grants } }; delete partial.grants['inpatient.reviews'];
  const bedsEditor = { ...NURSE, levels: { ...NURSE.levels, beds: 'editor' } };
  const db = setup({ a: vitalsEdit, b: marksNone, c: partial, d: bedsEditor });
  try {
    const before = db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all();
    db.exec(SQL);
    assert.deepEqual(db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all(), before);
  } finally { db.close(); }
});

test('215: склад со строкой старого экрана снова выдаёт со склада и ведёт все заявки', () => {
  const db = setup({ inventory: STOCK, stock_mix: { ...STOCK, grants: { ...STOCK.grants, 'procurement.issue': 'edit' } } });
  try {
    assert.equal(grantAllows(db, stock, 'procurement.issue', 'edit', ['admin', 'inventory']), false, 'до поправки выдача закрыта');
    db.exec(SQL);
    assert.equal(grantLevel(db, stock, 'procurement'), null);
    assert.equal(grantLevel(db, stock, 'procurement.issue'), null);
    assert.equal(grantAllows(db, stock, 'procurement.issue', 'edit', ['admin', 'inventory']), true);
    assert.equal(grantAllows(db, stock, 'procurement', 'edit', ['admin', 'inventory']), true);
    const p = perms(db, 'inventory');
    assert.equal(p.levels.inventory, 'editor');
    assert.equal(p.grants['reports.stock'], 'view', 'отчёты не трогаем');
    assert.equal(perms(db, 'stock_mix').grants['procurement.issue'], 'edit', 'настроенное руками не трогаем');
    assert.equal(perms(db, 'stock_mix').levels.inventory, 'viewer');
  } finally { db.close(); }
});

test('215: штатные роли свежей базы и повторный накат — без изменений', () => {
  const fresh = openDb(':memory:');
  try {
    migrate(fresh);
    const before = fresh.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all();
    fresh.exec(SQL);
    assert.deepEqual(fresh.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all(), before);
  } finally { fresh.close(); }
  const db = setup({ nurse: NURSE, inventory: STOCK });
  try {
    db.exec(SQL);
    const once = db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all();
    db.exec(SQL);
    assert.deepEqual(db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all(), once);
  } finally { db.close(); }
});
