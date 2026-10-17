// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r1/zz-money-resched-twin.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW (money) — C′ mirrors a registrar booking of another day onto the live card;
// the booking is then moved (calendar drag) onto the day the card's own consultation line
// (no doctor yet) waits for. At the desk that line joins the visit: its consultation must be the
// one already in the visit, not a second one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, calendarBook } from '../test-helpers/crm-link-all.js';
const TODAY = localDay(0);
const D2 = localDay(4);
for (const desk of [true, false]) {
  test(`CRM_ONE_WAY_V1 (повтор r1) — ZZ-MONEY R1 (${desk ? 'fast registration ensure_visit desk' : 'wizard ensure_visit'}): card waits today for a consultation (no doctor); registrar booked D2 consult (C′), then dragged it to today — ONE consultation`, async () => {
    const t = await startCrmApp();
    try {
      const a = addLead(t.db, { assigned: 3, date: TODAY });
      addLine(t.db, a, { svc: 30, day: TODAY, doctor: null });
      const vid = await calendarBook(t, 'reg', D2, { hour: 12, svc: 30, doctor: 10 });
      console.log('link', JSON.stringify(link(t, vid)));
      const mv = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(TODAY, 17), doctor_id: 10 });
      assert.equal(mv.status, 200, mv.text);
      const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', ...(desk ? { desk: true } : {}) });
      assert.equal(ev.status, 200, ev.text);
      assert.equal(ev.json.data.visit.id, vid);
      const rows = vsOf(t, vid);
      console.log('visit lines', JSON.stringify(rows), 'card', JSON.stringify(t.db.prepare('SELECT service_id, scheduled_date, status, doctor_id, visit_id, visit_service_id FROM crm_request_services WHERE request_id = ?').all(a)));
      { const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: vid, visit_service_ids: rows.map((x) => x.id), discount_amount: 0, payer_id: null }); console.log('INVOICE', inv.status, inv.status === 200 ? t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount : inv.text); }
      assert.deepEqual(rows.map((x) => x.service_id), [30], 'second consultation in the visit');
    } finally { t.close(); }
  });
}
