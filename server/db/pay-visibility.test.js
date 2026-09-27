// FINAL_ROLES_SYNC_FIX_V1 (M1) — ставки врачей и доля врача у услуги не для
// всего персонала.
//
// Регистратура и касса читали через /api/db doctor_rates и
// services.default_doctor_percent — сколько получает каждый врач с каждой
// услуги, — хотя «Оплата врачей» им закрыта. Теперь:
//   • doctor_rates: все строки — администратор, держатели «Оплаты врачей» и
//     плитки «Ставки врачей»; врач — только свои;
//   • services.default_doctor_percent и ступени doctor_tier_*: остальным
//     приходят пустыми, остальные колонки услуги — как были.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';
import { compile } from './query-compiler.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const DOC_A = { id: 2, role: 'doctor', extra_roles: [] };
const DOC_B = { id: 3, role: 'doctor', extra_roles: [] };
const REG   = { id: 4, role: 'registrar', extra_roles: [] };
const CASH  = { id: 5, role: 'cashier', extra_roles: [] };
const NURSE = { id: 6, role: 'nurse', extra_roles: [] };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const mk = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  for (const u of [ADMIN, DOC_A, DOC_B, REG, CASH, NURSE]) mk.run(u.id, 'u' + u.id, 'x', 'Сотрудник ' + u.id, u.role);
  db.prepare("INSERT INTO services (id, name, price, default_doctor_percent, doctor_tier_from, doctor_tier_percent) VALUES (21, 'МРТ', 900000, 30, 10, 40)").run();
  db.prepare('INSERT INTO doctor_rates (doctor_id, service_id, percent, active) VALUES (2, 21, 35, 1)').run();
  db.prepare('INSERT INTO doctor_rates (doctor_id, service_id, percent, active) VALUES (3, 21, 25, 1)').run();
  return db;
}

const run = (db, desc, user) => {
  const q = compile(desc, user, { db });
  return db.prepare(q.sql).all(...q.params);
};
const RATES = { op: 'select', table: 'doctor_rates', columns: '*', filters: [] };
const SVC = { op: 'select', table: 'services', columns: '*', filters: [{ col: 'id', op: 'eq', val: 21 }] };

function grant(db, role, key, level) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions || '{}') : {};
  perms.grants = { ...(perms.grants || {}), [key]: level };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

test('M1: ставки врачей — администратор все, врач свои, регистратура и медсестра ни одной', () => {
  const db = seed();
  try {
    assert.equal(run(db, RATES, ADMIN).length, 2);
    assert.deepEqual(run(db, RATES, DOC_A).map((r) => r.doctor_id), [2], 'врач видит только свои ставки');
    assert.deepEqual(run(db, RATES, DOC_B).map((r) => r.doctor_id), [3]);
    for (const u of [REG, NURSE]) assert.equal(run(db, RATES, u).length, 0, u.role + ' читает ставки врачей');
  } finally { db.close(); }
});

test('M1: держатель «Оплаты врачей» или плитки «Ставки врачей» видит все ставки', () => {
  const db = seed();
  try {
    assert.equal(run(db, RATES, CASH).length, 0, 'касса без «Оплаты врачей» (мигр. 179) ставок не видит');
    grant(db, 'cashier', 'reports.doctor_pay', 'view');
    assert.equal(run(db, RATES, CASH).length, 2, 'выдали «Оплату врачей» — видны все');
    grant(db, 'nurse', 'settings.doctor_rates', 'view');
    assert.equal(run(db, RATES, NURSE).length, 2, 'выдали плитку «Ставки врачей» на «Просмотр» — видны все');
  } finally { db.close(); }
});

test('M1: доля врача у услуги — пустая для регистратуры и врача, видна администратору и «Оплате врачей»', () => {
  const db = seed();
  try {
    const a = run(db, SVC, ADMIN)[0];
    assert.equal(a.default_doctor_percent, 30);
    assert.equal(a.doctor_tier_percent, 40);
    for (const u of [REG, DOC_A, NURSE]) {
      const r = run(db, SVC, u)[0];
      assert.equal(r.name, 'МРТ', 'остальные колонки услуги — как были');
      assert.equal(r.price, 900000);
      assert.equal(r.default_doctor_percent, null, u.role + ' видит долю врача');
      assert.equal(r.doctor_tier_percent, null);
      assert.equal(r.doctor_tier_from, null);
    }
    const named = run(db, { ...SVC, columns: 'id, name, default_doctor_percent' }, REG)[0];
    assert.equal(named.default_doctor_percent, null, 'и по имени колонки — тоже пусто');
    grant(db, 'registrar', 'reports.doctor_pay', 'view');
    assert.equal(run(db, SVC, REG)[0].default_doctor_percent, 30);
  } finally { db.close(); }
});

test('M1: строка счёта больше не тянет долю врача через services(...)', () => {
  const db = seed();
  try {
    assert.throws(() => compile({ op: 'select', table: 'invoice_items', columns: 'id, services(default_doctor_percent)', filters: [] }, REG, { db }));
    assert.doesNotThrow(() => compile({ op: 'select', table: 'invoice_items', columns: 'id, services(id, name, type)', filters: [] }, REG, { db }));
  } finally { db.close(); }
});
