// V3120_FIX — сводка после осмотра 2026-09-27 (d-inpatient): деньги только
// тем, кому открыта выручка; депозит — не «амбулатория»; отменённая заявка —
// не выписка; долг организаций отдельно от долга пациентов; пробирки в работе
// считаются по частичному индексу (миграция 199).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { dashboardSummary, dashboardTrend } from './dashboard.js';

const H = 3600000;
const ADMIN = { id: 1, role: 'admin', full_name: 'Админ' };
const LAB = { id: 7, role: 'lab', full_name: 'Лаборант' };

const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id,username,password_hash,role,full_name) VALUES (?,?,?,?,?)');
  u.run(1, 'a', 'x', 'admin', 'Админ');
  u.run(2, 'n', 'x', 'nurse', 'Медсестра');
  u.run(3, 'd', 'x', 'doctor', 'Врач');
  u.run(5, 's', 'x', 'nurse', 'Старшая');
  u.run(7, 'l', 'x', 'lab', 'Лаборант');
  u.run(9, 'c', 'x', 'cashier', 'Касса');
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const wA = db.prepare("INSERT INTO wards (name, billing_mode, price_per_day) VALUES ('Общая','daily',100000)").run().lastInsertRowid;
  const wV = db.prepare("INSERT INTO wards (name, billing_mode, price_per_day) VALUES ('VIP','daily',500000)").run().lastInsertRowid;
  const bed = (w, code) => db.prepare("INSERT INTO beds (ward_id, code, status) VALUES (?,?,'free')").run(w, code).lastInsertRowid;
  return { db, pid, wA, wV, A1: bed(wA, 'A1'), A2: bed(wA, 'A2'), V1: bed(wV, 'V1') };
}

/** Пациент лежит с `startMs`; moves — [[время, койка, палата], …]. */
function stay(ctx, startMs, firstBed, firstWard, moves = [], status = 'active') {
  const { db, pid } = ctx;
  const last = moves.length ? moves[moves.length - 1] : [null, firstBed, firstWard];
  const id = db.prepare(`INSERT INTO admissions (patient_id, ward_id, bed_id, doctor_id, attending_doctor_id, status, admitted_at)
                         VALUES (?,?,?,3,3,?,?)`).run(pid, last[2], last[1], status, iso(startMs)).lastInsertRowid;
  let fromBed = firstBed, fromWard = firstWard;
  for (const [t, b, w] of moves) {
    db.prepare(`INSERT INTO admission_transfers (admission_id, from_bed_id, to_bed_id, from_ward_id, to_ward_id, kind, transferred_at)
                VALUES (?,?,?,?,?,'transfer',?)`).run(id, fromBed, b, fromWard, w, iso(t));
    fromBed = b; fromWard = w;
  }
  return id;
}

// ─── 4. Сводка ──────────────────────────────────────────────────────────────

function seedMoney(ctx) {
  const { db, pid } = ctx;
  const now = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
  const adm = stay(ctx, Date.now() - 2 * H, ctx.A1, ctx.wA);
  const dep = db.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status) VALUES ('DEP-A-1', ?, 1000000, 1000000, 'paid')").run(pid).lastInsertRowid;
  const invAdm = db.prepare("INSERT INTO invoices (invoice_number, patient_id, admission_id, total_amount, paid_amount, status) VALUES ('INV-1', ?, ?, 400000, 400000, 'paid')").run(pid, adm).lastInsertRowid;
  const invCl = db.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status) VALUES ('INV-2', ?, 70000, 70000, 'paid')").run(pid).lastInsertRowid;
  db.prepare(`INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 1000000, 'cash', ${now})`).run(dep);
  db.prepare(`INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 400000, 'wallet', ${now})`).run(invAdm);
  db.prepare(`INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 70000, 'card', ${now})`).run(invCl);
  // Долг пациента и долг организации.
  const payer = db.prepare("INSERT INTO payers (name) VALUES ('Страховая')").run().lastInsertRowid;
  db.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status) VALUES ('INV-3', ?, 30000, 0, 'unpaid')").run(pid);
  db.prepare("INSERT INTO invoices (invoice_number, patient_id, payer_id, total_amount, paid_amount, status) VALUES ('INV-4', ?, ?, 900000, 0, 'unpaid')").run(pid, payer);
  // Отменённая заявка с discharged_at — не выписка.
  db.prepare(`INSERT INTO admissions (patient_id, status, admitted_at, discharged_at) VALUES (?, 'cancelled', ${now}, ${now})`).run(pid);
  return { adm };
}

test('сводка: оплата стационара с депозита — стационар, депозит — «не распределено», итог — приход', () => {
  const ctx = seed();
  seedMoney(ctx);
  const t = dashboardTrend(ctx.db, { days: 1 }, ADMIN);
  const d = t.series[0];
  assert.equal(d.inpatient, 400000, 'стационар жил на депозите');
  assert.equal(d.clinic, 70000, 'депозит — не амбулатория');
  assert.equal(d.unassigned, 1000000 - 400000);
  assert.equal(d.total, 1070000, 'приход кассы');
  assert.equal(d.clinic + d.inpatient + d.unassigned, d.total);
  assert.equal(d.discharges, 0, 'отменённая заявка — не выписка');
  ctx.db.close();
});

test('сводка: долг организаций отдельно от долга пациентов', () => {
  const ctx = seed();
  seedMoney(ctx);
  const s = dashboardSummary(ctx.db, {}, ADMIN);
  assert.equal(s.outstanding_amount, 930000);
  assert.equal(s.outstanding_patient_amount, 30000);
  assert.equal(s.outstanding_patient_count, 1);
  assert.equal(s.outstanding_payer_amount, 900000);
  assert.equal(s.outstanding_payer_count, 1);
  ctx.db.close();
});

test('сводка: деньги — только тем, кому открыта выручка; счётчики — всем', () => {
  const ctx = seed();
  seedMoney(ctx);
  const s = dashboardSummary(ctx.db, {}, LAB);
  assert.equal(s.money_visible, false);
  for (const k of ['collected_today', 'outstanding_amount', 'outstanding_patient_amount', 'outstanding_payer_amount']) {
    assert.equal(s[k], null, k + ' виден без права на выручку');
  }
  for (const b of s.buildings) assert.equal(b.collected_today, null);
  assert.equal(s.outstanding_count, 2, 'число счетов остаётся');
  const t = dashboardTrend(ctx.db, { days: 1 }, LAB);
  assert.equal(t.money_visible, false);
  assert.equal(t.series[0].total, null);
  assert.equal(t.totals.inpatient, null);
  assert.equal(t.inpatient.accrued_unbilled, null);
  assert.equal(t.inpatient.in_bed, 1, 'койки видны');

  const a = dashboardSummary(ctx.db, {}, ADMIN);
  assert.equal(a.money_visible, true);
  assert.equal(a.collected_today, 1070000);
  ctx.db.close();
});

test('сводка: пробирки в работе считаются по частичному индексу, а не проходом по таблице', () => {
  const ctx = seed();
  const plan = ctx.db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM visit_services vs JOIN services s ON s.id = vs.service_id
     WHERE vs.status IN ('queued','in_progress') AND s.is_lab=1`).all().map((r) => r.detail).join(' | ');
  assert.match(plan, /idx_visit_services_lab_pending/, plan);
  ctx.db.close();
});

