// ROLE_REPORTS_SETTINGS_V1 — отчёты по группам: роль видит только выданные
// группы, ненастроенная роль — как было, свои начисления врача — всегда.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { runReport, ownerReport, doctorInpatientShare, doctorTierPositions, doctorReferralReward } from './rpc/reports.js';
import { cashierReport } from './rpc/cashier-report.js';
import { callcenterReport } from './rpc/callcenter.js';
import { canSeeReportKey, reportGroupOf } from './report-access.js';
import { REPORT_GROUP, catalogByKey } from '../../public/js/shared/permission-catalog.js';

const RANGE = { from: '2026-01-01', to: '2026-12-31' };
const TIER = { from: '2026-01', to: '2026-12' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const mk = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, custom_role_code, is_doctor) VALUES (?,?,?,?,?,?,?)');
  mk.run(41, 'kassa', 'x', 'Старший кассир', 'cashier', 'kassa_only', 0);
  mk.run(42, 'cash', 'x', 'Кассир', 'cashier', null, 0);
  mk.run(43, 'lab', 'x', 'Лаборант', 'lab', null, 0);
  mk.run(44, 'doc1', 'x', 'Врач Один', 'doctor', null, 1);
  mk.run(45, 'doc2', 'x', 'Врач Два', 'doctor', null, 1);
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('kassa_only', 'Только касса', 'cashier')").run();
  return db;
}
function setPerms(db, role, perms) {
  const has = db.prepare('SELECT 1 FROM role_permissions WHERE role = ?').get(role);
  if (has) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
function addGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  setPerms(db, role, perms);
}

const KASSA = { id: 41, role: 'cashier', extra_roles: [], custom_role_code: 'kassa_only' };
const CASHIER = { id: 42, role: 'cashier', extra_roles: [] };
const LAB = { id: 43, role: 'lab', extra_roles: [] };
const DOC1 = { id: 44, role: 'doctor', extra_roles: [] };
const DOC2 = { id: 45, role: 'doctor', extra_roles: [] };

// Ровно то, что пишет экран «Роли», когда у раздела отмечена одна «Касса».
const ONLY_CASHIER = {
  reports: 'view',
  'reports.revenue': 'none', 'reports.cashier': 'view', 'reports.doctor_pay': 'none',
  'reports.referrals': 'none', 'reports.services': 'none', 'reports.stock': 'none', 'reports.callcenter': 'none',
};

const is403 = (e) => e && e.status === 403;

test('роль только с «Кассой»: отчёт кассира есть, всё остальное — 403', () => {
  const db = seed();
  try {
    setPerms(db, 'kassa_only', { sections: ['cashier', 'reports-hub'], levels: { 'reports-hub': 'viewer' }, grants: ONLY_CASHIER });
    assert.ok(cashierReport(db, RANGE, KASSA), 'отчёт кассира отказал роли, которой его выдали');
    assert.ok(runReport(db, { kind: 'payments', ...RANGE }, KASSA), 'прежний вид «payments» — это касса');
    for (const kind of ['total_revenue', 'invoices_full', 'doctor_salaries', 'by_doctors', 'referrals', 'by_services', 'procurement', 'stock_expiry']) {
      assert.throws(() => runReport(db, { kind, ...RANGE }, KASSA), is403, 'вид «' + kind + '» открылся роли только с кассой');
    }
    assert.throws(() => ownerReport(db, RANGE, KASSA), is403);
    assert.throws(() => callcenterReport(db, RANGE, KASSA), is403);
    // Прежние виды без денег (визиты, пациенты) — это раздел целиком: он открыт.
    assert.ok(runReport(db, { kind: 'visits', ...RANGE }, KASSA));
    // Неизвестный вид — по-прежнему 400, а не 403: права не маскируют опечатку.
    assert.throws(() => runReport(db, { kind: 'no_such_kind', ...RANGE }, KASSA), (e) => e.status === 400);
  } finally { db.close(); }
});

test('ненастроенная роль — как было: «Отчёты» выданы — видно всё, не выданы — ничего', () => {
  const db = seed();
  try {
    // Штатный кассир: миграции дали ему «Отчёты» (reports-hub), групп он не настраивал.
    for (const kind of ['total_revenue', 'doctor_salaries', 'procurement', 'by_services', 'referrals']) {
      assert.ok(runReport(db, { kind, ...RANGE }, CASHIER), 'ненастроенный кассир потерял «' + kind + '»');
    }
    assert.ok(ownerReport(db, RANGE, CASHIER));
    assert.ok(cashierReport(db, RANGE, CASHIER));
    assert.ok(callcenterReport(db, RANGE, CASHIER));
    // Лаборант: «Отчётов» у него не было — хаб ему не открывался, теперь и сервер отказывает.
    assert.throws(() => runReport(db, { kind: 'total_revenue', ...RANGE }, LAB), is403);
    assert.throws(() => cashierReport(db, RANGE, LAB), is403);
    // Администратор — всегда.
    assert.ok(runReport(db, { kind: 'doctor_salaries', ...RANGE }, { id: 1, role: 'admin' }));
  } finally { db.close(); }
});

test('раздел «Отчёты: Нет» закрывает группы, даже если у группы остался уровень', () => {
  const db = seed();
  try {
    addGrants(db, 'cashier', { reports: 'none', 'reports.cashier': 'view' });
    assert.throws(() => cashierReport(db, RANGE, CASHIER), is403);
  } finally { db.close(); }
});

test('врач видит СВОИ начисления без единого ключа «Отчётов»; чужие — только с «Оплатой врачей»', () => {
  const db = seed();
  try {
    addGrants(db, 'doctor', { reports: 'none' });   // врачу закрыли весь раздел
    assert.ok(doctorInpatientShare(db, { doctor_id: 44, ...RANGE }, DOC1));
    assert.ok(doctorTierPositions(db, { doctor_id: 44, ...TIER }, DOC1));
    assert.ok(doctorReferralReward(db, { doctor_id: 44, ...RANGE }, DOC1));

    assert.throws(() => doctorInpatientShare(db, { doctor_id: 45, ...RANGE }, DOC1), is403);
    assert.throws(() => doctorTierPositions(db, { doctor_id: 45, ...TIER }, DOC1), is403, 'ступени чужого врача открыты любому');
    assert.throws(() => doctorReferralReward(db, { doctor_id: 45, ...RANGE }, DOC1), is403);

    // «Оплата врачей» — открывает чужие начисления (раздел тоже открыт).
    addGrants(db, 'doctor', { reports: 'view', 'reports.doctor_pay': 'view' });
    assert.ok(doctorInpatientShare(db, { doctor_id: 45, ...RANGE }, DOC1));
    assert.ok(doctorTierPositions(db, { doctor_id: 45, ...TIER }, DOC1));
    assert.ok(doctorReferralReward(db, { doctor_id: 45, ...RANGE }, DOC2));
  } finally { db.close(); }
});

test('другие группы чужих начислений не открывают; «Рефералы» — только вознаграждение за направления', () => {
  const db = seed();
  try {
    setPerms(db, 'kassa_only', { sections: ['reports-hub'], levels: {}, grants: { ...ONLY_CASHIER, 'reports.referrals': 'view' } });
    assert.throws(() => doctorInpatientShare(db, { doctor_id: 45, ...RANGE }, KASSA), is403, 'касса увидела стационарную долю врача');
    assert.throws(() => doctorTierPositions(db, { doctor_id: 45, ...TIER }, KASSA), is403);
    assert.ok(doctorReferralReward(db, { doctor_id: 45, ...RANGE }, KASSA), 'группа «Рефералы» и так видит вознаграждение каждого врача');
  } finally { db.close(); }
});

test('карта «вид → группа» указывает только на настоящие строки справочника', () => {
  const byKey = catalogByKey();
  for (const [kind, key] of Object.entries(REPORT_GROUP)) {
    const row = byKey.get(key);
    assert.ok(row, kind + ' → ' + key + ': такой строки в справочнике нет');
    assert.ok(key === 'reports' || row.parent === 'reports', kind + ' → ' + key + ': не раздел «Отчёты»');
    assert.ok(!row.locked, kind + ' → закрытая строка');
    assert.equal(reportGroupOf(kind), key);
  }
  assert.equal(reportGroupOf('telegram'), null, 'Telegram-бот — только администратор, группы у него нет');
  assert.equal(canSeeReportKey(null, null, 'reports.cashier'), false);
});
