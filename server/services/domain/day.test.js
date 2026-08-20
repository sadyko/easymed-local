// CLINIC_DAY_V1 — REGRESSION: the dashboard and the reports compared raw UTC
// while the till compared local time, so takings near local midnight landed on
// different days in different screens and could not be reconciled.
//
// These tests must hold in ANY timezone, including UTC itself, so rather than
// hard-coding an offset they ask SQLite what the offset is and build a
// timestamp that is deliberately on the far side of the UTC/local boundary.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { today, localDate, localMonth, inLocalRange, isLocalToday, localHour, localWeekday } from './day.js';
import { dashboardSummary } from '../rpc/dashboard.js';
import { reportsOverview } from '../rpc/reports.js';

// Local minus UTC, in seconds (+18000 for Tashkent, -18000 for US Eastern, 0 for UTC).
function localOffsetSeconds(db) {
  return db.prepare(
    "SELECT CAST(strftime('%s','now','localtime') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) AS s"
  ).get().s;
}

// The UTC instant at which the clinic's local clock reads `hhmm` TODAY, in the
// exact format the app stores ('YYYY-MM-DDTHH:MM:SSZ').
function storedUtcForLocalTime(db, hhmm) {
  const off = localOffsetSeconds(db);
  const localDay = today(db);
  const shift = -off;
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', datetime(?, ?)) x")
    .get(`${localDay}T${hhmm}:00`, `${shift >= 0 ? '+' : ''}${shift} seconds`).x;
}

// A local wall-clock time whose UTC date differs from its local date, so the
// old UTC-based comparison provably lands on the wrong day. East of UTC that is
// just after local midnight; west of UTC, just before it. At UTC exactly there
// is no such time — the boundary bug cannot occur — so callers skip that case.
function boundaryLocalTime(db) {
  const off = localOffsetSeconds(db);
  if (off > 0) return '00:30';
  if (off < 0) return '23:30';
  return null;
}

test('day helpers emit local-time SQL, never raw UTC', () => {
  assert.equal(localDate('i.created_at'), "date(i.created_at, 'localtime')");
  assert.equal(localMonth('i.created_at'), "strftime('%Y-%m', i.created_at, 'localtime')");
  assert.match(inLocalRange('p.paid_at'), /date\(p\.paid_at, 'localtime'\) BETWEEN date\(\?\) AND date\(\?\)/);
  assert.match(isLocalToday('created_at'), /date\(created_at, 'localtime'\) = date\('now','localtime'\)/);
});

test('today() is the LOCAL calendar day, which is what the till already uses', () => {
  const db = openDb(':memory:'); migrate(db);
  const helper = today(db);
  const till = db.prepare("SELECT date('now','localtime') d").get().d;
  assert.equal(helper, till);
  db.close();
});

test('a payment taken just across the local-midnight boundary counts on the local day', (t) => {
  const db = openDb(':memory:'); migrate(db);
  const hhmm = boundaryLocalTime(db);
  if (hhmm === null) { db.close(); return t.skip('machine runs at UTC — no boundary to cross'); }

  const paidAt = storedUtcForLocalTime(db, hhmm);
  const localDay = today(db);
  const utcDay = paidAt.slice(0, 10);
  assert.notEqual(utcDay, localDay, 'fixture must straddle the boundary to be meaningful');

  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('A',1)").run().lastInsertRowid;
  const inv = db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,50000,50000,'paid')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,50000,'cash',?)").run(inv, paidAt);

  // The dashboard's "collected today" must see it — it did not before the fix.
  assert.equal(dashboardSummary(db, {}, { id: 1, role: 'admin' }).collected_today, 50000);

  // And a report for the local day must contain it too, so the two agree.
  const o = reportsOverview(db, { from: localDay, to: localDay }, { id: 1, role: 'admin' });
  assert.equal(o.cash_collected, 50000);

  // Asking for the UTC day instead must NOT find it: the clinic day is the
  // local one, and the report is no longer keyed on the stored UTC date.
  const wrong = reportsOverview(db, { from: utcDay, to: utcDay }, { id: 1, role: 'admin' });
  assert.equal(wrong.cash_collected, 0);
  db.close();
});

test('dashboard and reports agree with the cashier on which day a payment belongs to', (t) => {
  const db = openDb(':memory:'); migrate(db);
  const hhmm = boundaryLocalTime(db);
  if (hhmm === null) { db.close(); return t.skip('machine runs at UTC — no boundary to cross'); }

  const paidAt = storedUtcForLocalTime(db, hhmm);
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('A',1)").run().lastInsertRowid;
  const inv = db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status, paid_at) VALUES (?,50000,50000,'paid',?)").run(pid, paidAt).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,50000,'cash',?)").run(inv, paidAt);

  // The cashier's own «сегодня» rule (cashier.js) — unchanged, already local.
  const tillSeesIt = db.prepare(
    "SELECT COUNT(*) n FROM invoices WHERE status='paid' AND date(COALESCE(paid_at, created_at),'localtime') = date('now','localtime')"
  ).get().n;

  const dashSeesIt = dashboardSummary(db, {}, { id: 1, role: 'admin' }).collected_today > 0 ? 1 : 0;
  assert.equal(dashSeesIt, tillSeesIt, 'dashboard and till must place the payment on the same day');
  db.close();
});

// CALLCENTER_REPORT_V1 — час и день недели тоже ЛОКАЛЬНЫЕ.
//
// «Самые загруженные часы» колл-центра считаются по времени создания заявки, а
// оно хранится в UTC. При UTC+5 заявка, принятая в 09:00 по клинике, лежит как
// 04:00Z — без перевода отчёт показал бы утренний пик на пять часов раньше, то
// есть до открытия клиники. Ровно этот класс ошибки описан в шапке day.js, и
// правило там же: местное время выводится ТОЛЬКО здесь.
test('localHour / localWeekday переводят UTC в местное время клиники', () => {
  const db = openDb(':memory:');
  db.prepare('CREATE TABLE t (at TEXT)').run();
  // Смещение берём у самой базы, чтобы тест шёл на любой машине.
  const off = db.prepare("SELECT CAST(strftime('%H','2026-08-17T12:00:00Z','localtime') AS INTEGER) - 12 AS h").get().h;

  db.prepare('INSERT INTO t (at) VALUES (?)').run('2026-08-17T04:00:00Z');
  const r = db.prepare(`SELECT ${localHour('at')} AS h, ${localWeekday('at')} AS w FROM t`).get();

  assert.equal(Number(r.h), ((4 + off) % 24 + 24) % 24);
  assert.equal(Number(r.w), 1);   // 2026-08-17 — понедельник (0=вс)
  db.close();
});

// Час должен быть пригоден для группировки И сортировки: '09' сортируется как
// строка правильно, '9' — нет.
test('localHour возвращает двузначный час', () => {
  const db = openDb(':memory:');
  db.prepare('CREATE TABLE t (at TEXT)').run();
  db.prepare('INSERT INTO t (at) VALUES (?)').run('2026-08-17T00:30:00Z');
  const h = db.prepare(`SELECT ${localHour('at')} AS h FROM t`).get().h;
  assert.equal(String(h).length, 2, 'ожидали формат HH, получили: ' + h);
  db.close();
});
