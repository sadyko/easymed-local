// CRM_ONE_WAY_V1 (O8) — разовое исправление строк карточек при установке (crm/one-way-repair.js):
// копии зеркала уходят, строки отменённых записей — отпущенные желания, старые ссылки сняты;
// строку оператора не удаляет никогда; строки визитов и счета не меняются; второй раз — ничего.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { crmOneWayRepair } from './one-way-repair.js';

const T0 = '2026-10-01T09:00:00Z';
const plus = (sec) => new Date(Date.parse(T0) + sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
function base() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (2, 'reg', 'x', 'Регистратор', 'registrar', 0), (7, 'doc', 'x', 'Врач', 'doctor', 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (30, 'Консультация', 100000, 'consultation'), (40, 'Анализ', 40000, 'lab')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (77, 'Пациент', '+998900000077')").run();
  const rid = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Пациент', '+998900000077', 'scheduled', 77)").run().lastInsertRowid);
  const visit = (day, status = 'scheduled') => Number(db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by, created_at) VALUES (77, 7, ?, ?, 2, ?)')
    .run(`${day}T10:00:00Z`, status, T0).lastInsertRowid);
  const vline = (vid, svc, at = T0) => Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, created_at) VALUES (?, ?, 7, 1, 100, 100, 'added', 2, ?)")
    .run(vid, svc, at).lastInsertRowid);
  const cline = (o) => Number(db.prepare(`INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id, visit_service_id, visit_service_auto, created_at)
                                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(rid, o.svc ?? 30, o.day ?? null, o.status ?? 'pending', o.visit ?? null, o.vs ?? null, o.auto ?? 0, o.at ?? T0).lastInsertRowid);
  return { db, rid, visit, vline, cline };
}
const row = (db, id) => { const r = db.prepare('SELECT * FROM crm_request_services WHERE id = ?').get(id); return r ? { ...r } : null; };
const money = (db) => ({
  vs: db.prepare('SELECT * FROM visit_services ORDER BY id').all().map((x) => ({ ...x })),
  inv: db.prepare('SELECT * FROM invoices ORDER BY id').all().map((x) => ({ ...x })),
});

test('CRM_ONE_WAY_V1 O8: копия зеркала (заведена тем же запросом, что строка визита) удаляется; строка оператора, севшая на строку регистратуры позже, и желание со строкой CRM — остаются', () => {
  const { db, visit, vline, cline } = base();
  const v = visit('2026-10-20');
  const x = vline(v, 30);
  const copy = cline({ day: '2026-10-20', visit: v, vs: x, at: plus(1) });
  const doneCopy = cline({ day: '2026-10-20', visit: v, vs: x, at: plus(0), status: 'done' });
  const operator = cline({ day: '2026-10-20', visit: v, vs: x, at: plus(600) });
  const earlier = cline({ day: '2026-10-20', visit: v, vs: x, at: plus(-3600) });
  const y = vline(v, 40);
  const wish = cline({ svc: 40, day: '2026-10-20', visit: v, vs: y, auto: 1, at: plus(-60) });
  const before = money(db);
  const out = crmOneWayRepair(db);
  assert.equal(out.skipped, false);
  assert.equal(row(db, copy), null);
  assert.equal(row(db, doneCopy), null);
  for (const id of [operator, earlier, wish]) assert.ok(row(db, id), 'строка оператора удалена');
  assert.equal(out.counts.deleted_copy, 2);
  assert.equal(out.counts.kept_ambiguous, 2);
  assert.deepEqual(money(db), before, 'строки визита и счета не тронуты');
  const log = db.prepare('SELECT line_id, action FROM crm_one_way_repair_log ORDER BY id').all().map((r) => [r.line_id, r.action]);
  assert.ok(log.some(([id, a]) => id === copy && a === 'deleted_copy'));
});

test('CRM_ONE_WAY_V1 O8: строки отменённой записи — отпущенные желания; старые ссылки прежней отмены сняты; ссылка в живой визит снята; снятые строки не тронуты', () => {
  const { db, visit, vline, cline } = base();
  const w = visit('2026-10-21', 'cancelled');
  const xw = vline(w, 30);
  const held = cline({ day: '2026-10-21', visit: w, vs: xw, at: plus(-600) });
  const stale = cline({ day: '2026-10-21', visit: null, vs: xw, at: plus(-600) });
  const redated = cline({ day: '2026-10-25', visit: null, vs: xw, at: plus(-600) });
  const live = visit('2026-10-22');
  const xl = vline(live, 40);
  const moved = cline({ svc: 40, day: '2026-10-28', visit: null, vs: xl, at: plus(-600) });
  const gone = cline({ day: '2026-10-21', visit: w, vs: xw, status: 'cancelled', at: plus(-600) });
  const before = money(db);
  const out = crmOneWayRepair(db);
  const r = row(db, held);
  assert.deepEqual([r.status, r.scheduled_date, r.visit_id, r.visit_service_id, r.released_from_visit_id, r.released_vs_id], ['pending', null, null, null, w, xw]);
  const s = row(db, stale);
  assert.deepEqual([s.scheduled_date, s.visit_service_id, s.released_from_visit_id], [null, null, w]);
  const d = row(db, redated);
  assert.deepEqual([d.scheduled_date, d.visit_service_id, d.released_from_visit_id], ['2026-10-25', null, null], 'день оператора сохранён');
  const m = row(db, moved);
  assert.deepEqual([m.scheduled_date, m.visit_service_id, m.released_from_visit_id], ['2026-10-28', null, null]);
  assert.deepEqual(row(db, gone).visit_id, w, 'снятая строка — история, не трогается');
  assert.deepEqual([out.counts.released, out.counts.released_stale, out.counts.cleared_stale, out.counts.cleared_moved], [1, 1, 1, 1]);
  assert.deepEqual(money(db), before);
});

test('CRM_ONE_WAY_V1 O8: исправление проходит один раз — отметка и итог; второй вызов ничего не делает', () => {
  const { db, visit, vline, cline } = base();
  const v = visit('2026-10-20');
  const x = vline(v, 30);
  cline({ day: '2026-10-20', visit: v, vs: x, at: plus(1) });
  const first = crmOneWayRepair(db);
  assert.match(first.summary, /копий удалено: 1/);
  const mark = db.prepare('SELECT done_at, summary FROM crm_one_way_repair WHERE id = 1').get();
  assert.ok(mark.done_at);
  assert.equal(mark.summary, first.summary);
  cline({ day: '2026-10-20', visit: v, vs: x, at: plus(1) });
  const second = crmOneWayRepair(db);
  assert.equal(second.skipped, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_request_services').get().n, 1, 'второй проход удалил строку');
});
