// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r2/zz-f2-r1a.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW (funnel lens) of CRM_LINK_ALL_V1 T1-T3 — repro tests. Each test asserts the
// behaviour that the owner decisions / the pre-T1 rules expect; a FAIL = the suspected defect is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, cardLines, addVisitLine, calendarBook, callcenterBook, deskRegister } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const D3 = localDay(3);
const D10 = localDay(10);

// F1 — C′ runs BEFORE step D (phone). A fresh phone-only lead (today's call, waiting for this visit)
// loses the visit to a stale live card of the same patient: the stale card is reopened and closed,
// the fresh lead (the call that produced the visit) stays patientless and open.
test('CRM_ONE_WAY_V1 (повтор r2) — F1 desk: fresh phone-only call lead (in window) must get the walk-in, not a 30-day-old live card', async () => {
  const t = await startCrmApp();
  try {
    const stale = addLead(t.db, { status: 'in_process', updated: daysAgoIso(30), assigned: 4, name: 'Старая' });
    const phoneLead = addLead(t.db, { patient: null, phone: '909092638', name: '909092638', assigned: 3 });
    const { vid } = await deskRegister(t, 'reg');
    const L = link(t, vid);
    console.log('F1 link', L, 'stale', t.lead(stale).status, 'phoneLead', t.lead(phoneLead).status, t.lead(phoneLead).patient_id);
    assert.equal(L && L.request_id, phoneLead, 'visit joined the stale card instead of the call that brought the patient');
    assert.equal(t.lead(phoneLead).status, 'came');
    assert.equal(t.lead(stale).status, 'in_process', 'a 30-day-old card of another operator got the conversion');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — F1b call centre (calendar): fresh phone-only lead of THIS operator vs stale live card of another operator', async () => {
  const t = await startCrmApp();
  try {
    const stale = addLead(t.db, { status: 'in_process', updated: daysAgoIso(30), assigned: 4, name: 'Старая' });
    const phoneLead = addLead(t.db, { patient: null, phone: '909092638', name: '909092638', assigned: 3 });
    const vid = await callcenterBook(t, D3);
    const L = link(t, vid);
    console.log('F1b link', L, 'stale', t.lead(stale).status, t.lead(stale).updated_at, 'phoneLead', t.lead(phoneLead).status, t.lead(phoneLead).patient_id);
    assert.equal(L && L.request_id, phoneLead, 'operator A booked from her own call; the booking went to operator B\'s stale card');
  } finally { t.close(); }
});

// F2 — crmWonCardLines fires for ANY today visit held by a won card, also BEFORE the patient arrives
// (multi-day card: first arrival closed it, today's line is still a booking — R3 / P8).
test('CRM_ONE_WAY_V1 (повтор r2) — F2: won card holding a booking for LATER TODAY — a service added before arrival must not become a "done" card line', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'came', date: localDay(-1) });
    // call centre booked today 17:00 for the card (line held by the visit), patient not here yet
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 3)").run(at(TODAY, 17)).lastInsertRowid);
    const lid = addLine(t.db, rid, { svc: 40, day: TODAY, visit: vid });
    const vs40 = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, 40, 1, 40000, 40000, 'added', 3)").run(vid).lastInsertRowid);
    t.db.prepare('UPDATE crm_request_services SET visit_service_id = ?, visit_service_auto = 1 WHERE id = ?').run(vs40, lid);
    const before = await t.rpc('booking_lines_add', 'cc', { visit_id: vid, patient_id: 77, lines: [{ service_id: 30, doctor_id: 10 }] });
    console.log('F2 cc add BEFORE registrar line:', before.status);
    // registrar adds a service in the visit window (/api/db) at 09:00 — patient not arrived
    await addVisitLine(t, 'reg', vid, { svc: 30, doctor: 10 });
    const lines = cardLines(t, rid).map((l) => [l.service_id, l.status, l.visit_id]);
    console.log('F2 card lines', JSON.stringify(lines));
    const done = cardLines(t, rid).filter((l) => l.status === 'done');
    assert.equal(done.length, 0, 'card shows a service as DONE although the patient has not arrived');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — F2c: after F2 the visit counts as "arrived by evidence": call centre can no longer add services; cancel leaves a done line', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'came', date: localDay(-1) });
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 3)").run(at(TODAY, 17)).lastInsertRowid);
    const lid = addLine(t.db, rid, { svc: 40, day: TODAY, visit: vid });
    const vs40 = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, 40, 1, 40000, 40000, 'added', 3)").run(vid).lastInsertRowid);
    t.db.prepare('UPDATE crm_request_services SET visit_service_id = ?, visit_service_auto = 1 WHERE id = ?').run(vs40, lid);
    await addVisitLine(t, 'reg', vid, { svc: 30, doctor: 10 });
    const { arrivedByEvidence } = await import('../services/crm/booking-mirror.js');
    console.log('F2c arrivedByEvidence', arrivedByEvidence(t.db, vid));
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: vid, patient_id: 77, lines: [{ service_id: 30, doctor_id: 10 }] });
    console.log('F2c cc add', add.status, add.text.slice(0, 200));
    const cancel = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(TODAY, 17), status: 'cancelled' });
    console.log('F2c cancel', cancel.status);
    console.log('F2c card lines after cancel', JSON.stringify(cardLines(t, rid).map((l) => [l.service_id, l.status, l.visit_id])));
    assert.equal(arrivedByEvidence(t.db, vid), false, 'visit not arrived but evidence says arrived');
  } finally { t.close(); }
});

// F2b — desk: the visit is held by an OLD won card's line for today (step A) and the desk closes
// today's fresh card. R6 writes today's services onto the old card; the card the desk closed shows nothing.
test('CRM_ONE_WAY_V1 (повтор r2) — F2b desk: today\'s services must appear on the card the desk closed, not on last month\'s won card', async () => {
  const t = await startCrmApp();
  try {
    const old = addLead(t.db, { status: 'came', date: localDay(-30), updated: daysAgoIso(30), name: 'Прошлый' });
    addLine(t.db, old, { svc: 40, day: TODAY });   // follow-up analysis planned for today on the closed card
    const fresh = addLead(t.db, { name: 'Сегодняшний звонок' });
    const { vid, ids } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
    console.log('F2b link', link(t, vid), 'fresh', t.lead(fresh).status, 'old lines', JSON.stringify(cardLines(t, old).map((l) => [l.service_id, l.status])),
      'fresh lines', JSON.stringify(cardLines(t, fresh).map((l) => [l.service_id, l.status])), 'vs', JSON.stringify(vsOf(t, vid).map((x) => x.service_id)));
    assert.equal(t.lead(fresh).status, 'came');
    // Revision 2: shown via crm_card_bookings (P-7 display link), not copied
    const { crmCardBookings } = await import('../services/rpc/crm-card-bookings.js');
    const shown = crmCardBookings(t.db, { request_id: fresh }, { id: 1, role: 'admin', extra_roles: [] }).bookings;
    console.log('F2b fresh shows', JSON.stringify(shown));
    assert.ok(shown.some((b) => b.visit_id === vid && b.services.some((s) => s.name === 'Консультация терапевта')), 'the card the desk closed does not show the registered consultation (G4 not fixed here)');
    assert.ok(!cardLines(t, old).some((l) => l.service_id === 30), 'last month\'s won card got today\'s consultation');
  } finally { t.close(); }
});

// F3 — registrar books a patient whose live card waits for ANOTHER day; C′ joins; then the booking is cancelled.
test('CRM_ONE_WAY_V1 (повтор r2) — F3: registrar book + cancel must leave the card as it was (stage, date, no phantom pending line)', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', date: D10, updated: daysAgoIso(1), assigned: 3 });
    addLine(t.db, rid, { svc: 40, day: localDay(12) });   // operator planned analysis for D+12, not booked
    const vid = await calendarBook(t, 'reg', D3);
    console.log('F3 after book', t.lead(rid).status, t.lead(rid).scheduled_date, JSON.stringify(linesOf(t.db, rid)));
    const c = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(D3, 12), status: 'cancelled' });
    assert.equal(c.status, 200, c.text);
    const L = t.lead(rid);
    console.log('F3 after cancel', L.status, L.scheduled_date, JSON.stringify(linesOf(t.db, rid)));
    assert.equal(L.status, 'recall', '«Перезвонить» lost: registrar\'s cancelled booking moved the card');
    assert.equal(L.scheduled_date, D10, 'operator\'s recall date lost');
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.scheduled_date]), [[40, localDay(12)]], 'phantom pending line from the cancelled registrar booking');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — F3b: the phantom line from a cancelled registrar booking rides into the next visit of that day (unbooked service in the visit)', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', date: D10, updated: daysAgoIso(1), assigned: 3 });
    addLine(t.db, rid, { svc: 40, day: localDay(12) });
    const vid = await calendarBook(t, 'reg', D3, { svc: 30, doctor: 10 });
    const c = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(D3, 12), status: 'cancelled' });
    assert.equal(c.status, 200, c.text);
    // later the registrar books the same patient on D+3 for an analysis only
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 40, start: at(D3, 15), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v2 = b.json.data.visit.id;
    await addVisitLine(t, 'reg', v2, { svc: 40, doctor: null });
    const svcs = vsOf(t, v2).map((x) => x.service_id);
    console.log('F3b second visit lines', JSON.stringify(svcs), 'card', t.lead(rid).status, JSON.stringify(linesOf(t.db, rid)));
    assert.deepEqual(svcs, [40], 'the cancelled consultation came back into the new visit (registrar did not book it)');
  } finally { t.close(); }
});
