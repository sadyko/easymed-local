// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r4/zz-r4-money-c.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// R4 — batch 3: O5 restore of a line that held the visit without a visit line (I5 «at arrival»).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { addVisitLine } from '../test-helpers/crm-link-all.js';

const lineOf = (t, id) => ({ ...t.db.prepare('SELECT * FROM crm_request_services WHERE id = ?').get(id) });
const vsAll = (t, vid) => t.db.prepare("SELECT id, service_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((x) => ({ ...x }));

test('CRM_ONE_WAY_V1 (повтор r4) — R4-M5: analysis added from the card to an invoiced booking waits for arrival (I5); mistaken cancel + restore — the analysis still sits in the visit at arrival (O5 restore = put it back)', async () => {
  const t = await startCrmApp();
  try {
    const today = localDay(0);
    const rid = addLead(t.db, { assigned: 3 });
    addLine(t.db, rid, { svc: 30, day: today, doctor: 10 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(today, 23), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v = b.json.data.visit.id;
    // the wizard / cashier issues an invoice before arrival (act) — the booking now «has work»
    const ids = vsAll(t, v).map((x) => x.id);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    // the operator adds an analysis to this booking from the card (O3 add) -> held, placed at arrival (I5)
    const ins = await t.dbq('cc', { table: 'crm_request_services', op: 'insert', returning: true, single: 'single',
      values: { request_id: rid, service_id: 40, scheduled_date: today, status: 'pending', visit_id: v } });
    assert.equal(ins.status, 200, ins.text);
    const lab = ins.json.data.id;
    assert.deepEqual([lineOf(t, lab).visit_id, lineOf(t, lab).visit_service_id], [v, null], 'held for arrival');
    // mistaken cancel, then «Записан» again
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(today, 23), status: 'cancelled' })).status, 200);
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(today, 23), status: 'scheduled' })).status, 200);
    console.log('R4-M5 after restore:', JSON.stringify((({ visit_id, visit_service_id, scheduled_date, released_from_visit_id }) => ({ visit_id, visit_service_id, scheduled_date, released_from_visit_id }))(lineOf(t, lab))));
    // the patient arrives
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(today, 23), status: 'arrived' })).status, 200);
    console.log('R4-M5 visit lines at arrival:', JSON.stringify(vsAll(t, v)));
    assert.ok(vsAll(t, v).some((x) => x.service_id === 40), 'the analysis the call centre added never reached the visit');
  } finally { t.close(); }
});
