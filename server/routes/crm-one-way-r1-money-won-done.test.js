// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r1/zz-money-won-done.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW (money lens) — CRM_LINK_ALL_V1 R6 crmWonCardLines writes 'done'
// card lines onto a visit that is still a BOOKING (patient not here), whenever the card
// holding it is in «Пришёл». 'done' on crm_request_services is arrival evidence
// (booking-mirror.js arrivedByEvidence :87) — so the mirror, booking_lines_add/remove
// and the no-show pass start treating the booking as an arrived visit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { vsOf, cardLines, calendarBook, callcenterBook, addVisitLine } from '../test-helpers/crm-link-all.js';
import { arrivedByEvidence } from '../services/crm/booking-mirror.js';

const TODAY = localDay(0);
const allLines = (t, rid) => t.db.prepare('SELECT id, service_id, status, visit_id, visit_service_id FROM crm_request_services WHERE request_id = ? ORDER BY id').all(rid);

// Scenario A — R3: a card closed «Пришёл» last week still holds a follow-up analysis for TODAY.
// The registrar books today 17:00 (calendar → catalogue): step A takes the analysis line (by
// design, R3), the registrar's consultation line goes in via /api/db. The patient is NOT here.
async function scenarioA(t) {
  const rid = addLead(t.db, { status: 'came', updated: daysAgoIso(9) });
  addLine(t.db, rid, { svc: 40, day: TODAY });
  const vid = await calendarBook(t, 'reg', TODAY, { hour: 17, svc: 30, doctor: 10 });
  return { rid, vid };
}

test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-MONEY W1: booking for later today held by an old «Пришёл» card — no card line may be "done" before the patient arrives', async () => {
  const t = await startCrmApp();
  try {
    const { rid, vid } = await scenarioA(t);
    const v = t.db.prepare('SELECT status FROM visits WHERE id = ?').get(vid);
    assert.equal(v.status, 'scheduled', 'precondition: still a booking');
    console.log('card lines:', JSON.stringify(allLines(t, rid)));
    console.log('visit lines:', JSON.stringify(vsOf(t, vid)));
    assert.deepEqual(allLines(t, rid).filter((l) => l.status === 'done'), [], 'card shows a service as DONE for a patient who has not come');
    assert.equal(arrivedByEvidence(t.db, vid), false, 'the booking now counts as an ARRIVED visit (arrivedByEvidence)');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-MONEY W2: same booking — the call centre can still remove the analysis from the booking (booking_line_remove)', async () => {
  const t = await startCrmApp();
  try {
    const { vid } = await scenarioA(t);
    const an = vsOf(t, vid).find((x) => x.service_id === 40);
    assert.ok(an, 'precondition: analysis in the booking');
    const r = await t.rpc('booking_line_remove', 'cc', { visit_service_id: an.id });
    console.log('booking_line_remove:', r.status, r.text);
    assert.equal(r.status, 200, 'call centre refused: ' + r.text);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-MONEY W3: same booking — the CRM cancels the analysis line; it must leave the visit and the bill', async () => {
  const t = await startCrmApp();
  try {
    const { rid, vid } = await scenarioA(t);
    const line = allLines(t, rid).find((l) => l.service_id === 40 && l.status === 'pending');
    assert.ok(line && line.visit_id === vid, 'precondition: analysis line holds the booking');
    const up = await t.dbq('boss', { table: 'crm_request_services', op: 'update', filters: [{ col: 'id', op: 'eq', val: line.id }], values: { status: 'cancelled' } });
    assert.equal(up.status, 200, up.text);
    const left = vsOf(t, vid);
    console.log('visit lines after CRM cancel:', JSON.stringify(left));
    const ids = left.map((x) => x.id);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const total = Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount);
    console.log('invoice total:', total);
    assert.deepEqual(left.map((x) => x.service_id), [30], 'analysis cancelled in the CRM stayed in the visit');
    assert.equal(total, 100000, 'bill carries the analysis the CRM cancelled');
  } finally { t.close(); }
});

// Control for W3: identical, but the 'done' rows written by crmWonCardLines are deleted before
// the CRM cancel — proves the 'done' rows are what freezes the mirror.
test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-MONEY W3-control: without the crmWonCardLines "done" rows the CRM cancel removes the analysis', async () => {
  const t = await startCrmApp();
  try {
    const { rid, vid } = await scenarioA(t);
    t.db.prepare("DELETE FROM crm_request_services WHERE request_id = ? AND status = 'done'").run(rid);
    const line = allLines(t, rid).find((l) => l.service_id === 40 && l.status === 'pending');
    const up = await t.dbq('boss', { table: 'crm_request_services', op: 'update', filters: [{ col: 'id', op: 'eq', val: line.id }], values: { status: 'cancelled' } });
    assert.equal(up.status, 200, up.text);
    assert.deepEqual(vsOf(t, vid).map((x) => x.service_id), [30]);
  } finally { t.close(); }
});

// Scenario B — D1/C′ widening: call centre books tomorrow (card live, C′/E link) and today the
// card is closed «Пришёл» by a walk-in at the desk. Tomorrow's booking stays held by a won card.
// We simulate "tomorrow is today" by booking TODAY+0 for the second visit is impossible (I6),
// so we use an operator drag to «Пришёл» instead: a card holding today's later booking.
test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-MONEY W4: card dragged to «Пришёл» in the CRM while it holds a later-today booking — a registrar line added in the visit window becomes "done"', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const vid = await callcenterBook(t, TODAY, { hour: 18 });
    const mv = await t.dbq('boss', { table: 'crm_requests', op: 'update', filters: [{ col: 'id', op: 'eq', val: rid }], values: { status: 'came' } });
    console.log('drag to came:', mv.status, mv.text.slice(0, 200));
    if (mv.status !== 200) return;   // a drag to won is refused — scenario not reachable this way
    await addVisitLine(t, 'reg', vid, { svc: 40, doctor: null });
    console.log('card lines:', JSON.stringify(allLines(t, rid)));
    assert.deepEqual(allLines(t, rid).filter((l) => l.status === 'done'), [], '"done" line on a booking the patient has not come to');
    assert.equal(arrivedByEvidence(t.db, vid), false, 'booking counts as arrived');
  } finally { t.close(); }
});
