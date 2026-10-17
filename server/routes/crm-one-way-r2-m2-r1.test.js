// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r2/zz-m2-r1.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL RE-REVIEW round 2 (money) — round-1 F1..F5 + phone P1/P2 + B1, adapted to
// «show, don't copy»: expectations are on VISIT LINES and BILLS (not card lines).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, calendarBook, callcenterBook, deskRegister, addVisitLine } from '../test-helpers/crm-link-all.js';
import { arrivedByEvidence } from '../services/crm/booking-mirror.js';

const TODAY = localDay(0);
const allLines = (t, rid) => t.db.prepare('SELECT id, service_id, scheduled_date, status, visit_id, visit_service_id, visit_service_auto FROM crm_request_services WHERE request_id = ? ORDER BY id').all(rid);
const vsAll = (t, vid) => t.db.prepare("SELECT id, service_id, status, visit_id, invoice_item_id, total FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid);
const sum = (rows) => rows.reduce((a, x) => a + Number(x.total || 0), 0);
async function bill(t, vid, who = 'kassa') {
  const rows = vsAll(t, vid);
  const inv = await t.rpc('create_invoice_for_visit', who, { visit_id: vid, visit_service_ids: rows.map((x) => x.id), discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  return Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount);
}

// ── F1 (W1-W3)
async function scenarioA(t) {
  const rid = addLead(t.db, { status: 'came', updated: daysAgoIso(9) });
  addLine(t.db, rid, { svc: 40, day: TODAY });
  const vid = await calendarBook(t, 'reg', TODAY, { hour: 17, svc: 30, doctor: 10 });
  return { rid, vid };
}
test('CRM_ONE_WAY_V1 (повтор r2) — M2-F1 W1: booking later today held by an old «Пришёл» card — no done card line, not arrived by evidence', async () => {
  const t = await startCrmApp();
  try {
    const { rid, vid } = await scenarioA(t);
    assert.deepEqual(allLines(t, rid).filter((l) => l.status === 'done'), []);
    assert.equal(arrivedByEvidence(t.db, vid), false);
  } finally { t.close(); }
});
test('CRM_ONE_WAY_V1 (повтор r2) — M2-F1 W2: call centre can still remove the analysis from that booking', async () => {
  const t = await startCrmApp();
  try {
    const { vid } = await scenarioA(t);
    const an = vsOf(t, vid).find((x) => x.service_id === 40);
    assert.ok(an, 'precondition: analysis in the booking');
    const r = await t.rpc('booking_line_remove', 'cc', { visit_service_id: an.id });
    assert.equal(r.status, 200, r.text);
  } finally { t.close(); }
});
test('CRM_ONE_WAY_V1 (повтор r2) — M2-F1 W3: CRM cancels the analysis line — it leaves the visit; bill 100 000', async () => {
  const t = await startCrmApp();
  try {
    const { rid, vid } = await scenarioA(t);
    const line = allLines(t, rid).find((l) => l.service_id === 40 && l.status === 'pending');
    assert.ok(line && line.visit_id === vid);
    const up = await t.dbq('boss', { table: 'crm_request_services', op: 'update', filters: [{ col: 'id', op: 'eq', val: line.id }], values: { status: 'cancelled' } });
    assert.equal(up.status, 200, up.text);
    assert.deepEqual(vsAll(t, vid).map((x) => x.service_id), [30]);
    assert.equal(await bill(t, vid, 'reg'), 100000);
  } finally { t.close(); }
});

// ── F2 (C1, C2) — C′ booking cancelled, rebooked / walk-in
const D = localDay(3);
const D2 = localDay(5);
async function cancel(t, who, vid, day, hour = 12) {
  const r = await t.rpc('calendar_book', who, { visit_id: vid, start: at(day, hour), status: 'cancelled' });
  assert.equal(r.status, 200, r.text);
}
test('CRM_ONE_WAY_V1 (повтор r2) — M2-F2 C1: C′ booking D2 cancelled, rebooked D2 — ONE consultation, 100 000', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const v1 = await calendarBook(t, 'reg', D2, { hour: 12, svc: 30, doctor: 10 });
    assert.equal(link(t, v1)?.source, 'patient');
    await cancel(t, 'reg', v1, D2, 12);
    const v2 = await calendarBook(t, 'reg', D2, { hour: 15, svc: 30, doctor: 10 });
    const rows = vsAll(t, v2);
    assert.deepEqual(rows.map((x) => x.service_id), [30]);
    assert.equal(sum(rows), 100000);
  } finally { t.close(); }
});
test('CRM_ONE_WAY_V1 (повтор r2) — M2-F2 C2: C′ booking today 17:00 cancelled, walk-in for analysis only — bill 40 000', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const v1 = await calendarBook(t, 'reg', TODAY, { hour: 17, svc: 30, doctor: 10 });
    await cancel(t, 'reg', v1, TODAY, 17);
    const { vid } = await deskRegister(t, 'reg', { items: [{ svc: 40, doctor: null }] });
    assert.deepEqual(vsAll(t, vid).map((x) => x.service_id), [40]);
    assert.equal(await bill(t, vid, 'reg'), 40000);
    // the card's own D analysis stays a pending wish, untouched
    assert.ok(allLines(t, rid).some((l) => l.service_id === 40 && l.status === 'pending' && l.scheduled_date === D));
  } finally { t.close(); }
});

// ── F3 (E1) — desk closes fresh B while old «Пришёл» A holds the visit by its R3 line
test('CRM_ONE_WAY_V1 (повтор r2) — M2-F3 E1: no services written onto A; B gets a display link (P-7); bill = registered services', async () => {
  const t = await startCrmApp();
  try {
    const a = addLead(t.db, { status: 'came', updated: daysAgoIso(9), name: 'A' });
    addLine(t.db, a, { svc: 40, day: TODAY });
    const b = addLead(t.db, { name: 'B' });
    const { vid } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
    assert.equal(t.lead(b).status, 'came');
    assert.ok(!allLines(t, a).some((l) => l.service_id === 30), 'consult written onto A');
    assert.equal(allLines(t, b).length, 0, 'B got card lines (copy)');
    const l = t.db.prepare('SELECT request_id, source FROM crm_booking_links WHERE visit_id = ?').all(vid);
    console.log('E1 links', JSON.stringify(l), 'visit', JSON.stringify(vsAll(t, vid)));
    assert.deepEqual(vsAll(t, vid).map((x) => x.service_id).sort(), [30, 40]);
    assert.equal(await bill(t, vid, 'reg'), 140000);
  } finally { t.close(); }
});

// ── F4 (H1) — desk consult; card line same consult (no doctor) moved to today; wizard ensure_visit
test('CRM_ONE_WAY_V1 (повтор r2) — M2-F4 H1: still ONE consultation, bill 100 000', async () => {
  const t = await startCrmApp();
  try {
    const a = addLead(t.db, {});
    const l = addLine(t.db, a, { svc: 30, day: localDay(1), doctor: null });
    const { vid } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
    assert.equal(t.lead(a).status, 'came');
    const up = await t.dbq('boss', { table: 'crm_request_services', op: 'update', values: { scheduled_date: TODAY }, filters: [{ col: 'id', op: 'eq', val: l }] });
    assert.equal(up.status, 200, up.text);
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    assert.equal(ev.json.data.visit.id, vid);
    assert.deepEqual(vsAll(t, vid).map((x) => x.service_id), [30]);
    assert.equal(await bill(t, vid), 100000);
  } finally { t.close(); }
});

// ── F5 (R1) — card waits today (consult, no doctor); C′ booking D2 dragged to today; desk / wizard
for (const desk of [true, false]) {
  test(`CRM_ONE_WAY_V1 (повтор r2) — M2-F5 R1 (${desk ? 'desk' : 'wizard'}): ONE consultation, bill 100 000`, async () => {
    const t = await startCrmApp();
    try {
      const a = addLead(t.db, { assigned: 3, date: TODAY });
      addLine(t.db, a, { svc: 30, day: TODAY, doctor: null });
      const vid = await calendarBook(t, 'reg', localDay(4), { hour: 12, svc: 30, doctor: 10 });
      const mv = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(TODAY, 17), doctor_id: 10 });
      assert.equal(mv.status, 200, mv.text);
      const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', ...(desk ? { desk: true } : {}) });
      assert.equal(ev.status, 200, ev.text);
      assert.equal(ev.json.data.visit.id, vid);
      console.log('R1', desk, 'visit', JSON.stringify(vsAll(t, vid)), 'card', JSON.stringify(allLines(t, a)));
      assert.deepEqual(vsAll(t, vid).map((x) => x.service_id), [30]);
      assert.equal(await bill(t, vid), 100000);
    } finally { t.close(); }
  });
}

// ── phone P1/P2 (round-1 pre-existing; P-6 claims to close it)
test('CRM_ONE_WAY_V1 (повтор r2) — M2-P1: phone lead with today analysis; booking 17:00 (step D); desk on the same visit — analysis NOT in the bill', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    addLine(t.db, rid, { svc: 40, day: TODAY });
    const vid = await calendarBook(t, 'reg', TODAY, { hour: 17 });
    assert.equal(link(t, vid)?.source, 'phone');
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    assert.equal(ev.status, 200, ev.text);
    assert.deepEqual(vsAll(t, vid).map((x) => x.service_id), [30]);
    assert.equal(await bill(t, vid), 100000);
  } finally { t.close(); }
});
test('CRM_ONE_WAY_V1 (повтор r2) — M2-P2: phone lead, undated consult; booking D analysis; wizard ensure_visit — consult NOT in the visit', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    addLine(t.db, rid, { svc: 30, day: null, doctor: 10 });
    const Dd = localDay(2);
    const vid = await calendarBook(t, 'reg', Dd, { hour: 9, svc: 40, doctor: null });
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: at(Dd, 9), visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    assert.deepEqual(vsAll(t, vid).map((x) => x.service_id), [40]);
  } finally { t.close(); }
});
// P1 variant through the call centre's calendar path (calendar_book → booking_lines_add), the path P-6 names
test('CRM_ONE_WAY_V1 (повтор r2) — M2-P1cc: phone lead with today analysis; CALL CENTRE books 17:00 (calendar_book + booking_lines_add) — analysis NOT in the visit', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    addLine(t.db, rid, { svc: 40, day: TODAY });
    const vid = await callcenterBook(t, TODAY, { hour: 17 });
    console.log('P1cc link', JSON.stringify(link(t, vid)), 'visit', JSON.stringify(vsAll(t, vid)), 'card', JSON.stringify(allLines(t, rid)));
    assert.deepEqual(vsAll(t, vid).map((x) => x.service_id), [30]);
  } finally { t.close(); }
});

// ── B1 (I4) prepaid C′ booking: reschedule + later line never change the billed line / invoice
test('CRM_ONE_WAY_V1 (повтор r2) — M2-B1: prepaid C′ booking — billed line and invoice unchanged by reschedule and a later same-service line', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const vid = await calendarBook(t, 'reg', D2);
    const tot0 = await bill(t, vid);
    const snap = () => JSON.stringify(t.db.prepare('SELECT id, service_id, status, invoice_item_id, unit_price, total, doctor_id FROM visit_services WHERE invoice_item_id IS NOT NULL ORDER BY id').all());
    const before = snap();
    const r3 = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(localDay(6), 10), doctor_id: 10 });
    console.log('B1 resched', r3.status);
    await addVisitLine(t, 'reg', vid, { svc: 30, doctor: 10 });
    assert.equal(snap(), before);
    assert.equal(Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount), tot0);
  } finally { t.close(); }
});
