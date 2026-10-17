// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r1/zz-money-cprime-twins.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW (money lens) — CRM_LINK_ALL_V1 R1 step C′ links a registrar's booking
// of ANOTHER day to the patient's live card; the mirror then writes the visit's services onto
// the card. A cancel returns those lines to the card as «waiting» (visit-status.js cancelled:
// visit_id = NULL, scheduled_date kept, visit_service_id kept). What happens to the money on
// the next booking / walk-in of that day?
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, cardLines, calendarBook, deskRegister } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const D = localDay(3);
const D2 = localDay(5);
const lines = (t, rid) => t.db.prepare('SELECT id, service_id, scheduled_date, status, visit_id, visit_service_id, visit_service_auto FROM crm_request_services WHERE request_id = ? ORDER BY id').all(rid);
const vsAll = (t, vid) => t.db.prepare('SELECT id, service_id, status, visit_id, invoice_item_id, total FROM visit_services WHERE visit_id = ? ORDER BY id').all(vid);
const sum = (rows) => rows.filter((x) => x.status !== 'cancelled').reduce((a, x) => a + Number(x.total || 0), 0);

async function cancel(t, who, vid, day, hour = 12) {
  const r = await t.rpc('calendar_book', who, { visit_id: vid, start: at(day, hour), status: 'cancelled' });
  assert.equal(r.status, 200, r.text);
}

test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-MONEY C1: registrar books D2 (card waits for D) → cancels → rebooks D2 the same consultation: the new visit carries ONE consultation', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const v1 = await calendarBook(t, 'reg', D2, { hour: 12, svc: 30, doctor: 10 });
    console.log('link v1:', JSON.stringify(link(t, v1)), 'card:', JSON.stringify(lines(t, rid)));
    await cancel(t, 'reg', v1, D2, 12);
    console.log('after cancel: card', JSON.stringify(lines(t, rid)), 'v1 lines', JSON.stringify(vsAll(t, v1)));
    const v2 = await calendarBook(t, 'reg', D2, { hour: 15, svc: 30, doctor: 10 });
    const rows = vsAll(t, v2).filter((x) => x.status !== 'cancelled');
    console.log('v2 lines:', JSON.stringify(rows), 'sum', sum(rows), 'card', JSON.stringify(lines(t, rid)));
    assert.deepEqual(rows.map((x) => x.service_id), [30], 'second consultation in the rebooked visit (double bill)');
    assert.equal(sum(rows), 100000);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-MONEY C2: registrar books TODAY 17:00 consultation (card waits for D) → patient cancels → walks in for the analysis only: the walk-in bill has no consultation', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const v1 = await calendarBook(t, 'reg', TODAY, { hour: 17, svc: 30, doctor: 10 });
    console.log('link v1:', JSON.stringify(link(t, v1)));
    await cancel(t, 'reg', v1, TODAY, 17);
    console.log('after cancel: card', JSON.stringify(lines(t, rid)));
    const { vid, ids } = await deskRegister(t, 'reg', { items: [{ svc: 40, doctor: null }] });
    const rows = vsAll(t, vid).filter((x) => x.status !== 'cancelled');
    console.log('walk-in lines:', JSON.stringify(rows), 'card', JSON.stringify(lines(t, rid)));
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: rows.map((x) => x.id), discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const total = Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount);
    console.log('walk-in invoice total', total);
    assert.deepEqual(rows.map((x) => x.service_id), [40], 'cancelled consultation came back into the walk-in visit');
    assert.equal(total, 40000);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-MONEY C3: live card links two bookings on two days with the SAME consultation — each visit one line, card two lines, nothing waits unbooked', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const v1 = await calendarBook(t, 'reg', D2, { hour: 12, svc: 30, doctor: 10 });
    const v2 = await calendarBook(t, 'reg', localDay(6), { hour: 12, svc: 30, doctor: 10 });
    console.log('links', JSON.stringify(link(t, v1)), JSON.stringify(link(t, v2)), 'card', JSON.stringify(lines(t, rid)));
    assert.deepEqual(vsAll(t, v1).map((x) => x.service_id), [30]);
    assert.deepEqual(vsAll(t, v2).map((x) => x.service_id), [30]);
    // reschedule v2 onto D2? (I6 — calendar refuses or moves) — instead reschedule v2 to day D (card's own analysis day)
    const mv = await t.rpc('calendar_book', 'reg', { visit_id: v2, start: at(D, 9), doctor_id: 10 });
    console.log('reschedule v2→D:', mv.status, 'card', JSON.stringify(lines(t, rid)), 'v2', JSON.stringify(vsAll(t, v2)));
    assert.deepEqual(vsAll(t, v2).map((x) => x.service_id), [30], 'reschedule pulled the card analysis into the visit');
  } finally { t.close(); }
});
