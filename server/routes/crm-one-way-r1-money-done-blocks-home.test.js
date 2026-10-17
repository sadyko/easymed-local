// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r1/zz-money-done-blocks-home.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW (money) — crmWonCardLines' 'done' rows make the registrar's visit line look
// "referenced", so homeFor (booking-mirror.js :527-537, candidate 1 "same service, not referenced")
// no longer lets a later card line of the same consultation (line without doctor) take it:
// placeHeldLines inserts a SECOND consultation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { vsOf, deskRegister } from '../test-helpers/crm-link-all.js';
const TODAY = localDay(0);
const TOMORROW = localDay(1);
async function run(t, { dropDone }) {
  const a = addLead(t.db, {});
  const l = addLine(t.db, a, { svc: 30, day: TOMORROW, doctor: null });
  const { vid } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
  assert.equal(t.lead(a).status, 'came');
  if (dropDone) t.db.prepare("DELETE FROM crm_request_services WHERE request_id = ? AND status = 'done'").run(a);
  // patient: «I'm here — do tomorrow's consultation today»: operator moves the card line to today
  const up = await t.dbq('boss', { table: 'crm_request_services', op: 'update', values: { scheduled_date: TODAY }, filters: [{ col: 'id', op: 'eq', val: l }] });
  assert.equal(up.status, 200, up.text);
  // registrar opens the visit wizard for the same patient (ensure_visit returns the day visit)
  const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient' });
  assert.equal(ev.status, 200, ev.text);
  assert.equal(ev.json.data.visit.id, vid);
  const rows = vsOf(t, vid);
  console.log(dropDone ? 'CONTROL' : 'POST', 'visit lines', JSON.stringify(rows), 'card', JSON.stringify(t.db.prepare('SELECT service_id, status, doctor_id, visit_id, visit_service_id FROM crm_request_services WHERE request_id = ?').all(a)));
      { const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: vid, visit_service_ids: rows.map((x) => x.id), discount_amount: 0, payer_id: null }); console.log('INVOICE', inv.status, inv.status === 200 ? t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount : inv.text); }
  return rows;
}
test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-MONEY H1: desk visit with consult; card line of the same consult (no doctor) moved to today; wizard → still ONE consultation', async () => {
  const t = await startCrmApp();
  try { assert.deepEqual((await run(t, { dropDone: false })).map((x) => x.service_id), [30], 'second consultation in the visit'); }
  finally { t.close(); }
});
test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-MONEY H1-control: same, without the crmWonCardLines done rows', async () => {
  const t = await startCrmApp();
  try { assert.deepEqual((await run(t, { dropDone: true })).map((x) => x.service_id), [30]); }
  finally { t.close(); }
});
