// GRANTS_V1 — права по справочнику: настройка роли меняет ответ ворот, а её
// отсутствие оставляет всё, как было.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { grantLevel, grantAllows, requireGrant, GrantError } from './grants.js';
import { admissionVitalsAdd, admissionVitalsList, admissionVitalsDelete } from './rpc/vitals.js';
import { CATALOG, catalogRows, levelAllows } from '../../public/js/shared/permission-catalog.js';

const NURSE = { id: 31, role: 'nurse', extra_roles: [] };
const REG   = { id: 32, role: 'registrar', extra_roles: [] };
const CUSTOM = { id: 33, role: 'nurse', extra_roles: [], custom_role_code: 'palatnaya' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const mk = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, custom_role_code) VALUES (?,?,?,?,?,?)');
  mk.run(31, 'nurse1', 'x', 'Медсестра', 'nurse', null);
  mk.run(32, 'reg1', 'x', 'Регистратор', 'registrar', null);
  mk.run(33, 'nurse2', 'x', 'Палатная', 'nurse', 'palatnaya');
  return db;
}
function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = grants;
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

test('без настройки — как было: список ролей из кода решает', () => {
  const db = seed();
  try {
    assert.equal(grantLevel(db, NURSE, 'inpatient.vitals'), null, 'у роли не должно быть записи, пока её не настроили');
    assert.equal(grantAllows(db, NURSE, 'inpatient.vitals', 'edit', ['nurse', 'admin']), true);
    assert.equal(grantAllows(db, REG, 'inpatient.vitals', 'edit', ['nurse', 'admin']), false);
  } finally { db.close(); }
});

test('настроенный уровень главнее списка из кода — и в обе стороны', () => {
  const db = seed();
  try {
    // Заведующая ЗАКРЫЛА медсестре измерения — список из кода уже не спасает.
    setGrants(db, 'nurse', { 'inpatient.vitals': 'view' });
    assert.equal(grantAllows(db, NURSE, 'inpatient.vitals', 'edit', ['nurse', 'admin']), false);
    assert.equal(grantAllows(db, NURSE, 'inpatient.vitals', 'view', ['nurse', 'admin']), true);
    // И ОТКРЫЛА регистратуре — хотя в коде её никогда не было.
    setGrants(db, 'registrar', { 'inpatient.vitals': 'edit' });
    assert.equal(grantAllows(db, REG, 'inpatient.vitals', 'edit', ['nurse', 'admin']), true);
  } finally { db.close(); }
});

test('уровни вложены: «удаление» даёт и «изменение», и «просмотр»', () => {
  const db = seed();
  try {
    setGrants(db, 'nurse', { 'inpatient.vitals': 'delete' });
    for (const need of ['view', 'edit', 'delete']) assert.equal(grantAllows(db, NURSE, 'inpatient.vitals', need, []), true, need);
    setGrants(db, 'nurse', { 'inpatient.vitals': 'none' });
    assert.equal(grantAllows(db, NURSE, 'inpatient.vitals', 'view', ['nurse']), false, '«Нет» — это нет, даже если код разрешал');
  } finally { db.close(); }
});

test('несколько ролей — самая щедрая; своя роль клиники ЗАМЕНЯЕТ основу', () => {
  const db = seed();
  try {
    setGrants(db, 'nurse', { 'inpatient.vitals': 'none' });
    setGrants(db, 'senior_nurse', { 'inpatient.vitals': 'edit' });
    const both = { id: 31, role: 'nurse', extra_roles: ['senior_nurse'] };
    assert.equal(grantLevel(db, both, 'inpatient.vitals'), 'edit', 'дополнительная роль — прибавка');

    // Своя роль «Палатная» на основе медсестры: пока строки нет — как медсестра.
    assert.equal(grantLevel(db, CUSTOM, 'inpatient.vitals'), 'none');
    setGrants(db, 'palatnaya', { 'inpatient.vitals': 'delete' });
    assert.equal(grantLevel(db, CUSTOM, 'inpatient.vitals'), 'delete', 'своя роль не заменила основу');
  } finally { db.close(); }
});

test('отказ — понятной фразой с адресом, где выдают права', () => {
  const db = seed();
  try {
    setGrants(db, 'nurse', { 'inpatient.vitals': 'view' });
    assert.throws(() => requireGrant(db, NURSE, 'inpatient.vitals', 'edit', ['nurse'], 'записывать измерения'),
      (e) => e instanceof GrantError && e.status === 403 && /Записывать измерения — недоступно вашей роли/.test(e.message) && /Настройки → Роли/.test(e.message));
  } finally { db.close(); }
});

// --- Живые ворота: измерения --------------------------------------------------

function admitPatient(db) {
  db.prepare("INSERT INTO patients (id, full_name, mrn, phone) VALUES (1, 'Тест', 'P-1', '+998900000000')").run();
  db.prepare("INSERT INTO admissions (id, patient_id, status, admitted_at) VALUES (1, 1, 'active', '2026-09-18T08:00:00Z')").run();
}

test('ворота измерений слушают матрицу: закрыли медсестре запись — сервер отказывает словами', () => {
  const db = seed();
  try {
    admitPatient(db);
    const ok = admissionVitalsAdd(db, { admission_id: 1, temp_c: 36.6 }, NURSE);
    assert.ok(ok.vital && ok.vital.id, 'до настройки медсестра записывает, как и раньше');

    setGrants(db, 'nurse', { 'inpatient.vitals': 'view' });
    assert.throws(() => admissionVitalsAdd(db, { admission_id: 1, temp_c: 36.7 }, NURSE),
      (e) => e.status === 403 && /аписывать измерения/.test(e.message));
    assert.equal(admissionVitalsList(db, { admission_id: 1 }, NURSE).rows.length, 1, 'просмотр остался');

    // Удаление — по умолчанию только администратору; медсестре — только если выдали.
    assert.throws(() => admissionVitalsDelete(db, { vital_id: ok.vital.id }, NURSE), (e) => e.status === 403);
    setGrants(db, 'nurse', { 'inpatient.vitals': 'delete' });
    assert.equal(admissionVitalsDelete(db, { vital_id: ok.vital.id }, NURSE).ok, true);
    assert.equal(admissionVitalsList(db, { admission_id: 1 }, NURSE).rows.length, 0);
  } finally { db.close(); }
});

// --- Справочник честный -------------------------------------------------------

test('каждая строка справочника называет проверку, а ключи не повторяются', () => {
  const keys = new Set();
  for (const r of catalogRows()) {
    assert.ok(!keys.has(r.key), 'ключ повторяется: ' + r.key);
    keys.add(r.key);
    assert.ok(r.label && r.desc, 'у строки нет подписи или описания: ' + r.key);
    assert.ok(Array.isArray(r.levels) && r.levels[0] === 'none', 'уровни строки начинаются с «Нет»: ' + r.key);
    if (r.kind !== 'section') assert.ok(r.enforced, 'окно/действие без проверки — галочка-обманка: ' + r.key);
  }
  // Ключи действий стационара, на которые переведены ворота сервера.
  for (const k of ['inpatient.prescriptions', 'inpatient.marks', 'inpatient.vitals', 'inpatient.reviews', 'inpatient.services', 'inpatient.discharge', 'inpatient.requests', 'inpatient.beds', 'inpatient.patients', 'inpatient.history']) {
    assert.ok(keys.has(k), 'сервер проверяет ' + k + ', а в справочнике его нет');
  }
  assert.equal(levelAllows('edit', 'view'), true);
  assert.equal(levelAllows('view', 'edit'), false);
  assert.equal(CATALOG.length, 17, 'в справочнике семнадцать разделов — как в списке владельца');
});
