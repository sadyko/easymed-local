// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r5/zz-r5-attack.test.js» (RD, LC) (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// R5 — narrow re-check of the r4 fixes (tree5 = 0ee5356f). Repros assert the SAFE behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { crmOneWayRepair } from '../services/crm/one-way-repair.js';

const D3 = localDay(3);
const TODAY = localDay(0);
const vsAll = (t, vid) => t.db.prepare("SELECT id, service_id, doctor_id, created_by FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((x) => ({ ...x }));
const lineOf = (t, id) => ({ ...t.db.prepare('SELECT * FROM crm_request_services WHERE id = ?').get(id) });
const money = (t) => ({
  vs: t.db.prepare('SELECT id, visit_id, service_id, doctor_id, quantity, unit_price, status FROM visit_services ORDER BY id').all().map((x) => ({ ...x })),
  inv: t.db.prepare('SELECT id, visit_id, total_amount, paid_amount, status FROM invoices ORDER BY id').all().map((x) => ({ ...x })),
});
const seed = (db) => {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петров', 'doctor', 1)").run();
};
async function billOf(t, vid) {
  const ids = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((r) => r.id);
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  return Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount);
}

// ── O8 (b) released_dated — crafted v3.16-style rows (calendar booking linked to the card, then cancelled) ──

function craftCancelledBooking(t, rid, { day, hour = 23, doctor = 10 }) {
  const v = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, service_id, visit_date, status, created_by, created_at, updated_at) VALUES (77, ?, 30, ?, 'cancelled', 3, '2026-10-10T09:00:00Z', '2026-10-10T10:00:00Z')")
    .run(doctor, at(day, hour)).lastInsertRowid);
  t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source, created_by, created_request) VALUES (?, ?, 'callcenter', 3, 0)").run(v, rid);
  t.db.prepare("INSERT INTO crm_booking_undo (visit_id, request_id, prev_status, prev_scheduled_date, set_status, set_scheduled_date) VALUES (?, ?, 'in_process', NULL, 'scheduled', ?)").run(v, rid, day);
  return v;
}

test('CRM_ONE_WAY_V1 (повтор r5) — R5-RD-a: a wish the operator added for that day AFTER the booking was cancelled («consultation cancelled, I still come for the blood test») keeps its day; the patient registered that day gets the analysis', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3, status: 'in_process' });
    craftCancelledBooking(t, rid, { day: TODAY });
    const lab = Number(t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, created_at) VALUES (?, 40, ?, 'pending', '2026-10-10T11:00:00Z')").run(rid, TODAY).lastInsertRowid);
    const out = crmOneWayRepair(t.db);
    console.log('R5-RD-a repair:', JSON.stringify(out.counts), 'lab:', JSON.stringify((({ scheduled_date, released_from_visit_id }) => ({ scheduled_date, released_from_visit_id }))(lineOf(t, lab))));
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    assert.equal(ev.status, 200, ev.text);
    console.log('R5-RD-a desk visit lines:', JSON.stringify(vsAll(t, ev.json.data.visit.id)));
    assert.equal(lineOf(t, lab).released_from_visit_id, null, 'a wish added after the cancellation was released as «cancelled booking»');
    assert.ok(vsAll(t, ev.json.data.visit.id).some((x) => x.service_id === 40), 'the analysis did not reach the desk registration');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r5) — R5-RD-b: the cancelled booking was RE-BOOKED for the same day (live visit of the same card) — the card\'s wish of that day is not released', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3, status: 'scheduled', date: D3 });
    craftCancelledBooking(t, rid, { day: D3, hour: 10 });
    const v2 = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, service_id, visit_date, status, created_by, created_at) VALUES (77, 10, 30, ?, 'scheduled', 3, '2026-10-10T11:00:00Z')").run(at(D3, 15)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source, created_by, created_request) VALUES (?, ?, 'callcenter', 3, 0)").run(v2, rid);
    const wish = Number(t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, doctor_id, scheduled_date, status, created_at) VALUES (?, 30, 10, ?, 'pending', '2026-10-10T08:00:00Z')").run(rid, D3).lastInsertRowid);
    const out = crmOneWayRepair(t.db);
    console.log('R5-RD-b repair:', JSON.stringify(out.counts), 'wish:', JSON.stringify((({ scheduled_date, released_from_visit_id }) => ({ scheduled_date, released_from_visit_id }))(lineOf(t, wish))));
    assert.equal(lineOf(t, wish).scheduled_date, D3, 'wish of a re-booked (live) day released by the repair');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r5) — R5-RD-c: another card of the patient (no trail, no link to the cancelled booking) keeps its dated wish', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3, name: 'A' });
    const other = addLead(t.db, { assigned: 4, name: 'B' });
    craftCancelledBooking(t, rid, { day: D3 });
    const w = Number(t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?, 40, ?, 'pending')").run(other, D3).lastInsertRowid);
    crmOneWayRepair(t.db);
    assert.equal(lineOf(t, w).scheduled_date, D3);
    assert.equal(lineOf(t, w).released_from_visit_id, null);
  } finally { t.close(); }
});

// ── legacy_copy: a later cancel touches CARD lines only ─────────────────────

test('CRM_ONE_WAY_V1 (повтор r5) — R5-LC: registrar booking with mirror copies marked legacy_copy by O8; the booking is cancelled and restored — visit lines and invoices never change; copies are cancelled on the card only', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3, status: 'scheduled', date: D3 });
    const v = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, service_id, visit_date, status, created_by, created_at) VALUES (77, 10, 30, ?, 'scheduled', 2, '2026-10-10T09:00:00Z')").run(at(D3, 12)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source, created_by, created_request) VALUES (?, ?, 'match', 2, 0)").run(v, rid);
    const x = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, created_at) VALUES (?, 30, 10, 1, 100000, 100000, 'added', 2, '2026-10-10T09:00:00Z')").run(v).lastInsertRowid);
    const c = Number(t.db.prepare(`INSERT INTO crm_request_services (request_id, service_id, doctor_id, scheduled_date, status, visit_id, visit_service_id, visit_service_auto, created_at)
                                   VALUES (?, 30, 10, ?, 'pending', ?, ?, 0, '2026-10-10T09:00:01Z')`).run(rid, D3, v, x).lastInsertRowid);
    const out = crmOneWayRepair(t.db);
    assert.equal(out.counts.marked_copy, 1);
    const before = money(t);
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(D3, 12), status: 'cancelled' })).status, 200);
    assert.equal(lineOf(t, c).status, 'cancelled');
    assert.deepEqual(money(t), before, 'cancel changed visit lines/invoices');
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(D3, 12), status: 'scheduled' })).status, 200);
    assert.deepEqual(money(t), before, 'restore changed visit lines/invoices');
    assert.deepEqual(vsAll(t, v).map((l) => l.id), [x]);
    assert.equal(await billOf(t, v), 100000);
  } finally { t.close(); }
});
