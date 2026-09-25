// ROLE_REPORTS_SETTINGS_V1 (mig 152) — оператору колл-центра выдана его группа
// отчётов «Колл-центр», и только она.
//
// Форма проверки — та же, что у 141/144: выдали что хотели · никому ничего не
// расширили · повторный накат ничего не переписывает. Плюс проверка, ради
// которой миграция и существует: сервер отдаёт оператору его отчёт.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { callcenterReport } from '../../services/rpc/callcenter.js';
import { runReport } from '../../services/rpc/reports.js';

const RANGE = { from: '2026-01-01', to: '2026-12-31' };
const grantsOf = (db, role) =>
  (JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions).grants) || {};

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('152 выдаёт колл-центру группу «Колл-центр» — и ничего больше', () => {
  const db = freshDb();
  try {
    assert.equal(grantsOf(db, 'callcenter')['reports.callcenter'], 'view');
    const other = Object.keys(grantsOf(db, 'callcenter')).filter((k) => k.startsWith('reports'));
    assert.deepEqual(other, ['reports.callcenter'], 'оператору выданы другие группы отчётов');
    for (const role of ['admin', 'registrar', 'doctor', 'nurse', 'cashier', 'lab', 'inventory', 'head_doctor', 'senior_nurse']) {
      assert.ok(!('reports.callcenter' in grantsOf(db, role)), 'ключ выдан роли ' + role);
    }
    // Сервер: свой отчёт — да, чужая группа — по-прежнему нет.
    const op = { id: 70, role: 'callcenter', extra_roles: [] };
    assert.ok(callcenterReport(db, RANGE, op));
    assert.throws(() => runReport(db, { kind: 'total_revenue', ...RANGE }, op), (e) => e.status === 403);
  } finally { db.close(); }
});

test('152 выдаёт и своей роли на основе колл-центра, у которой есть строка прав', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('cc_night', 'Ночной оператор', 'callcenter')").run();
    db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('reg2', 'Регистратор 2', 'registrar')").run();
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('cc_night', JSON.stringify({ sections: ['crm'], levels: {} }));
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('reg2', JSON.stringify({ sections: ['patients'], levels: {} }));
    db.prepare("DELETE FROM schema_migrations WHERE name LIKE '152%'").run();
    migrate(db);
    assert.equal(grantsOf(db, 'cc_night')['reports.callcenter'], 'view');
    assert.ok(!('reports.callcenter' in grantsOf(db, 'reg2')), 'своя роль на другой основе получила отчёт');
  } finally { db.close(); }
});

test('152 идемпотентна и не перебивает решение клиники', () => {
  const db = freshDb();
  try {
    const row = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='callcenter'").get().permissions);
    row.grants['reports.callcenter'] = 'none';
    db.prepare("UPDATE role_permissions SET permissions = ? WHERE role='callcenter'").run(JSON.stringify(row));
    db.prepare("DELETE FROM schema_migrations WHERE name LIKE '152%'").run();
    migrate(db);
    assert.equal(grantsOf(db, 'callcenter')['reports.callcenter'], 'none', 'повторный накат перебил «Нет» клиники');
  } finally { db.close(); }
});
