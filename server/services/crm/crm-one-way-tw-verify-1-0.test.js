// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью 8a «crm-twin-repros/zz-s8y-verify-1-0.test.js», перенесён настоящим
// тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6): строку записи из карточки
// не переносят — дверь /api/db отказывает (O6), консультации обоих дней остаются по одной; контроль (два одинаковых
// желания одной карточки) — одна консультация (O1, чтение 7a).
// zz-s8y-verify-1-0 — skeptic #1 for "merged card doubles the consultation" (e0e6f44e).
// Uses the real /api/db door logic (compile + mirrorBefore/run/mirrorAfter) for the card save,
// crmMergeLeads for the merge, and ensureVisit with `book` as bookDays sends it. No ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { compile } from '../../db/query-compiler.js';
import { ensureVisit } from '../rpc/visits.js';
import { crmMergeLeads } from '../rpc/crm-merge.js';
import { mirrorBefore, mirrorAfter } from './booking-mirror-db.js';
import { BOOKED_LINE_LOCKED } from './one-way.js';

const at = (day, hhmm) => { const [y, m, d] = day.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); return new Date(y, m - 1, d, h, mi).getTime(); };
const iso = (day, hhmm) => new Date(at(day, hhmm)).toISOString();
const D1 = '2030-03-11';
const D2 = '2030-03-12';
const CC = { id: 3, role: 'callcenter', extra_roles: [] };
const REG = { id: 2, role: 'registrar', extra_roles: [] };
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?, ?, ?, ?, ?, ?)');
  u.run(1, 'adm', 'x', 'Админ', 'admin', 0);
  u.run(2, 'reg', 'x', 'Регистратор', 'registrar', 0);
  u.run(3, 'cc', 'x', 'Оператор', 'callcenter', 0);
  u.run(7, 'doc', 'x', 'Петров П.П.', 'doctor', 1);
  db.prepare("INSERT INTO consultation_types (id, name, price, active, duration_minutes) VALUES (1, 'Первичный приём', 150000, 1, 30)").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Каримов Азиз', '+998901234567')").run();
  return db;
}
// /api/db door, as routes/db.js does it.
function door(db, user, body) {
  const compiled = compile(body, user, { db });
  const ctx = mirrorBefore(db, compiled.meta, body, user);
  if (ctx.refusal) return ctx.refusal;   // CRM_ONE_WAY_V1 — отказ двери (409), база не тронута
  db.prepare(compiled.sql).run(...compiled.params);
  mirrorAfter(db, ctx, compiled.meta, body, user);
  return null;
}
const card = (db, source, day) => Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, patient_id, scheduled_date)
  VALUES ('Каримов Азиз', '+998901234567', ?, 'in_process', 1, ?)`).run(source, day).lastInsertRowid);
const consult = (db, requestId, day) => Number(db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status) VALUES (?, 1, 7, ?, 'pending')").run(requestId, day).lastInsertRowid);
const book = (db, day, hhmm, user) => ensureVisit(db, { patient_id: 1, date: iso(day, hhmm), doctor_id: 7, book: { doctor_id: 7, start: iso(day, hhmm), duration_minutes: 30 } }, user);
const consults = (db, visitId) => db.prepare("SELECT id, unit_price FROM visit_services WHERE visit_id = ? AND consultation_type_id = 1 AND status <> 'cancelled'").all(visitId).map((x) => ({ ...x }));
const liveLines = (db) => db.prepare("SELECT id, request_id, scheduled_date, visit_id, visit_service_id, status FROM crm_request_services ORDER BY id").all().map((x) => ({ ...x }));

for (const viaMerge of [false, true]) {
  test(`CRM_ONE_WAY_V1 (повтор 8a V1-0, O6): ${viaMerge ? 'MERGED card' : 'two cards'} — B's booked Petrov consultation cannot be moved D1→D2 from the card: the door refuses, one consultation each day`, async () => {
    const db = clinic();
    const a = card(db, 'website', D2);
    const la = consult(db, a, D2);
    const v = await book(db, D2, '10:00', CC);
    const b = card(db, 'call', D1);
    const lb = consult(db, b, D1);
    const w = await book(db, D1, '15:00', REG);
    assert.notEqual(v.visit.id, w.visit.id);
    assert.equal(consults(db, v.visit.id).length, 1);
    assert.equal(consults(db, w.visit.id).length, 1);
    if (viaMerge) {
      const res = crmMergeLeads(db, { keep_id: a, merge_ids: [b] }, ADMIN);
      assert.equal(res.kept_id, a);
    }
    const owner = viaMerge ? a : b;
    // saveLines of the card holding lb: cancel pending w/o visit (none), then the linked rows patched.
    assert.equal(door(db, CC, { table: 'crm_request_services', op: 'update', values: { status: 'cancelled' },
      filters: [{ col: 'request_id', op: 'eq', val: owner }, { col: 'status', op: 'eq', val: 'pending' }, { col: 'visit_id', op: 'is', val: null }] }), null);
    if (viaMerge) {
      // та же строка, те же значения (сохранение карточки) — не перенос, проходит
      assert.equal(door(db, CC, { table: 'crm_request_services', op: 'update', values: { scheduled_date: D2, doctor_id: 7 },
        filters: [{ col: 'id', op: 'eq', val: la }] }), null);
    }
    // CRM_ONE_WAY_V1 (O6) — перенос строки записи из карточки — отказ двери, ничего не тронуто.
    assert.equal(door(db, CC, { table: 'crm_request_services', op: 'update', values: { scheduled_date: D2, doctor_id: 7, visit_id: null },
      filters: [{ col: 'id', op: 'eq', val: lb }] }), BOOKED_LINE_LOCKED);
    assert.equal(db.prepare('SELECT visit_id FROM crm_request_services WHERE id = ?').get(lb).visit_id, w.visit.id);
    assert.equal(consults(db, w.visit.id).length, 1, 'D1 consultation lost');
    // bookDays the operator could still send for D2 — the D2 visit keeps one consultation.
    const again = await book(db, D2, '15:00', CC);
    const rowsV = consults(db, again.visit.id);
    console.log(viaMerge ? 'MERGED' : 'TWO CARDS', 'again=', again.visit.id, 'V=', v.visit.id, 'consults in visit', JSON.stringify(rowsV),
      'W', JSON.stringify(consults(db, w.visit.id)), 'lines', JSON.stringify(liveLines(db)));
    assert.equal(rowsV.length, 1, 'one Petrov consultation on D2');
  });
}

// Control: the SAME end state of a card (two identical pending Petrov lines on D2) reached
// without any prior booking — the fresh path shares one visit line (homeFor).
test('CRM_ONE_WAY_V1 (повтор 8a V1-0 control, O1): one card, two identical Petrov lines on D2, booked fresh — one consultation', async () => {
  const db = clinic();
  const a = card(db, 'call', D2);
  consult(db, a, D2);
  consult(db, a, D2);
  const v = await book(db, D2, '10:00', CC);
  const rows = consults(db, v.visit.id);
  console.log('FRESH same-card twins:', JSON.stringify(rows), JSON.stringify(liveLines(db)));
  assert.equal(rows.length, 1);
});
