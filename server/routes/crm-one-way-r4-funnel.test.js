// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r4/zz-r4-funnel.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// R4 — funnel repros (CRM_ONE_WAY_V1 O10 / R4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';

const D3 = localDay(3);
const D7 = localDay(7);
const st = (t, rid) => { const r = t.lead(rid); return [r.status, r.scheduled_date]; };

test('CRM_ONE_WAY_V1 (повтор r4) — R4-F1: card booked from a wish; operator moves it to «Перезвонить» with a recall date while the booking lives; the booking is cancelled — stage AND the human recall date stay (O10: never overwrite a human move)', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    addLine(t.db, rid, { svc: 30, day: D3, doctor: 10 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v = b.json.data.visit.id;
    assert.deepEqual(st(t, rid), ['scheduled', D3]);
    const up = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { status: 'recall', scheduled_date: D7 }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(up.status, 200, up.text);
    assert.deepEqual(st(t, rid), ['recall', D7]);
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(D3, 12), status: 'cancelled' })).status, 200);
    console.log('R4-F1 after cancel:', JSON.stringify(st(t, rid)));
    assert.deepEqual(st(t, rid), ['recall', D7], 'the cancel erased the recall date the operator set');
  } finally { t.close(); }
});
