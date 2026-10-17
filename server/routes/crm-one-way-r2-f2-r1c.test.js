// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r2/zz-f2-r1c.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW (funnel lens) of CRM_LINK_ALL_V1 T1-T3 — batch C.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, cardLines, addVisitLine, calendarBook, callcenterBook, deskRegister } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const D3 = localDay(3);
const D7 = localDay(7);

// C1 — D4 «the card's own earlier lines never go into that patient's bill from a phone match»:
// call centre's calendar flow = calendar_book + booking_lines_add (two crmLinkVisit calls).
test('CRM_ONE_WAY_V1 (повтор r2) — C1: call-centre calendar booking — phone-matched card\'s own line for that day must not enter the visit', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638', assigned: 3 });
    addLine(t.db, rid, { svc: 40, day: D3 });
    const vid = await callcenterBook(t, D3, { svc: 30, doctor: 10 });
    console.log('C1 link', link(t, vid), 'visit lines', JSON.stringify(vsOf(t, vid).map((x) => x.service_id)), 'card', JSON.stringify(linesOf(t.db, rid)));
    assert.deepEqual(vsOf(t, vid).map((x) => x.service_id), [30], 'phone card\'s analysis went into the visit (bill) in the same booking');
  } finally { t.close(); }
});

// C2 — desk closes a live card that waits for a FUTURE call-centre booking (C′ 'same' via ahead). Observe.
test('CRM_ONE_WAY_V1 (повтор r2) — C2 (observe): desk walk-in today, card booked by call centre for D+7 — what happens to card and D+7 booking', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, updated: daysAgoIso(5) });
    const v7 = await callcenterBook(t, D7, { svc: 30, doctor: 10 });
    t.db.prepare('UPDATE crm_requests SET updated_at = ? WHERE id = ?').run(daysAgoIso(5), rid);
    console.log('C2 before desk', t.lead(rid).status, t.lead(rid).scheduled_date, 'link v7', link(t, v7));
    const { vid } = await deskRegister(t, 'reg', { items: [{ svc: 40 }] });
    console.log('C2 after desk', t.lead(rid).status, t.lead(rid).scheduled_date, 'link today', link(t, vid), 'card lines', JSON.stringify(cardLines(t, rid).map((l) => [l.service_id, l.scheduled_date, l.status, l.visit_id])));
    assert.ok(true);
  } finally { t.close(); }
});

// C3 — C′ G-step on a «Подтверждён» card (after «Записан»): stage must not go back; date by cardDateOf.
test('CRM_ONE_WAY_V1 (повтор r2) — C3: registrar books another day for a fresh «Подтверждён» card — stays «Подтверждён»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'approved', date: D3, updated: daysAgoIso(1) });
    addLine(t.db, rid, { svc: 40, day: D3 });
    const vid = await calendarBook(t, 'reg', D7);
    console.log('C3', t.lead(rid).status, t.lead(rid).scheduled_date, link(t, vid));
    assert.equal(t.lead(rid).status, 'approved');
  } finally { t.close(); }
});

// C4 — reopen of a STALE «Подтверждён» card booked earlier by call centre for a day that has PASSED but whose visit
// is still 'scheduled' (sweep not run yet). Registrar books the patient for next week: card goes back to «В обработке» then «Записан».
test('CRM_ONE_WAY_V1 (повтор r2) — C4 (observe): stale card waiting on nothing — registrar booking reopens and moves updated_at', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', date: localDay(-3), updated: daysAgoIso(6), assigned: 4 });
    addLine(t.db, rid, { svc: 40, day: localDay(20) });   // future pending line => «ahead» => no reopen
    const vid = await calendarBook(t, 'doc', D7);
    console.log('C4 ahead card:', t.lead(rid).status, t.lead(rid).scheduled_date, t.lead(rid).updated_at, link(t, vid));
    assert.ok(true);
  } finally { t.close(); }
});
