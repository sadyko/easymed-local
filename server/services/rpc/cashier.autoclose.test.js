import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { autoCloseStaleShifts, openCashShift } from './cashier.js';

// SHIFT_AUTOCLOSE_V1 — смена живёт один календарный день (00:00–00:00):
// открытая вчера смена закрывается автоматически, сегодняшняя — не трогается,
// и вчерашняя незакрытая смена не мешает открыть новую утром.
function seed(db) {
  const uid = db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('kassir', 'x', 'Кассир', 'cashier')").run().lastInsertRowid;
  return { uid, user: { id: uid, role: 'cashier' } };
}

test('yesterday\'s open shift auto-closes at its midnight with zero over/short', () => {
  const db = openDb(':memory:'); migrate(db);
  const { uid } = seed(db);
  db.prepare(`INSERT INTO cash_shifts (cashier_id, opening_float, status, opened_at)
              VALUES (?, 100000, 'open', strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-1 day')))`).run(uid);

  const res = autoCloseStaleShifts(db);
  assert.equal(res.closed, 1);

  const s = db.prepare('SELECT * FROM cash_shifts WHERE cashier_id=?').get(uid);
  assert.equal(s.status, 'closed');
  assert.equal(s.over_short, 0);
  assert.equal(s.counted_amount, s.expected_amount);
  assert.equal(s.expected_amount, 100000);   // float only — no payments/movements
  assert.match(s.notes, /автоматически/);
  // closed_at = локальная полночь после дня открытия (в UTC) — она строго
  // позже opened_at и не позже текущего момента
  assert.ok(s.closed_at > s.opened_at, 'closed_at after opened_at');
  const nowIso = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') n").get().n;
  assert.ok(s.closed_at <= nowIso, 'closed_at not in the future');
});

test('today\'s shift is left open; stale one does not block a new shift', () => {
  const db = openDb(':memory:'); migrate(db);
  const { uid, user } = seed(db);
  // вчерашняя незакрытая
  db.prepare(`INSERT INTO cash_shifts (cashier_id, opening_float, status, opened_at)
              VALUES (?, 50000, 'open', strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-1 day')))`).run(uid);

  // открытие новой смены сегодня проходит (вчерашняя закрывается лениво)
  const { shift } = openCashShift(db, { opening_float: 200000 }, user);
  assert.equal(shift.status, 'open');

  const rows = db.prepare('SELECT status, opening_float FROM cash_shifts WHERE cashier_id=? ORDER BY id').all(uid);
  assert.deepEqual(rows.map(r => r.status), ['closed', 'open']);

  // сегодняшняя смена повторным вызовом не закрывается
  const res = autoCloseStaleShifts(db);
  assert.equal(res.closed, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cash_shifts WHERE status='open'").get().n, 1);
});
