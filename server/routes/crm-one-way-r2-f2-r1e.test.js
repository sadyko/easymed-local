// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r2/zz-f2-r1e.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW (funnel lens) — batch E: C′ on a visit the patient has ALREADY paid today (visits.status stays 'scheduled').
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, cardLines, addVisitLine } from '../test-helpers/crm-link-all.js';
import { crmNoShowSweep, crmArrivalCatchUp } from '../services/crm/no-show.js';

const TODAY = localDay(0);

test('CRM_ONE_WAY_V1 (повтор r2) — E1: patient already here and paid; registrar adds a service via the wizard (ensure_visit, no desk) — stale live card must not end «Записан» on a paid visit', async () => {
  const t = await startCrmApp();
  try {
    // morning: walk-in through the wizard path before the card existed / unlinked; visit paid
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 2)").run(new Date(Date.now() - 2 * 3600e3).toISOString()).lastInsertRowid);
    t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 30, 10, 1, 100000, 100000, 'queued', 2)").run(vid);
    t.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES (1, 'INV-1', ?, 77, 100000, 100000, 100000, 'paid')").run(vid);
    t.db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (1, 100000, 'cash', ?)").run(new Date(Date.now() - 3600e3).toISOString());
    const rid = addLead(t.db, { status: 'recall', updated: daysAgoIso(14), assigned: 3 });
    // registrar adds an analysis through the wizard: ensure_visit (no desk, no book) then /api/db line
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    assert.equal(ev.json.data.visit.id, vid);
    await addVisitLine(t, 'reg', vid, { svc: 40, doctor: null });
    console.log('E1 card', t.lead(rid).status, t.lead(rid).scheduled_date, 'link', link(t, vid), 'lines', JSON.stringify(cardLines(t, rid).map((l) => [l.service_id, l.status])));
    const tomorrow = localDay(1);
    crmArrivalCatchUp(t.db);
    crmNoShowSweep(t.db, { day: tomorrow });
    console.log('E1 after catch-up + sweep(tomorrow)', t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.notEqual(t.lead(rid).status, 'scheduled', 'card stuck in «Записан» for a visit the patient already paid');
  } finally { t.close(); }
});
