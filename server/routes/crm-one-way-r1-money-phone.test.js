// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r1/zz-money-phone.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW (money) — R5/D4/I3: a phone-matched card's OWN earlier lines never reach the patient's bill.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, calendarBook, deskRegister, addVisitLine } from '../test-helpers/crm-link-all.js';
const TODAY = localDay(0);
const svcs = (t, vid) => vsOf(t, vid).map((x) => x.service_id);
test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-PHONE P1: call lead (no patient) has analysis for TODAY; registrar books 17:00 consult (step D); patient comes, fast registration on the same visit', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    addLine(t.db, rid, { svc: 40, day: TODAY });
    const vid = await calendarBook(t, 'reg', TODAY, { hour: 17 });
    console.log('after booking: link', JSON.stringify(link(t, vid)), 'visit', JSON.stringify(svcs(t, vid)));
    assert.deepEqual(svcs(t, vid), [30]);
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    assert.equal(ev.status, 200, ev.text);
    assert.equal(ev.json.data.visit.id, vid);
    console.log('after desk: visit', JSON.stringify(svcs(t, vid)), 'card', t.lead(rid).status);
    assert.deepEqual(svcs(t, vid), [30], 'phone card\'s own analysis went into the patient\'s visit (bill) at the next door');
  } finally { t.close(); }
});
test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-PHONE P2: same lead, undated consult on the card; registrar books analysis for a later day; wizard ensure_visit same visit', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    addLine(t.db, rid, { svc: 30, day: null, doctor: 10 });
    const D = localDay(2);
    const vid = await calendarBook(t, 'reg', D, { hour: 9, svc: 40, doctor: null });
    console.log('after booking: link', JSON.stringify(link(t, vid)), 'visit', JSON.stringify(svcs(t, vid)));
    assert.deepEqual(svcs(t, vid), [40]);
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: at(D, 9), visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    console.log('after wizard ensure_visit: visit', JSON.stringify(svcs(t, vid)));
    assert.deepEqual(svcs(t, vid), [40], 'phone card\'s own undated consultation went into the visit at the next door');
  } finally { t.close(); }
});
