// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r1/zz-funnel-d.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW (funnel lens) of CRM_LINK_ALL_V1 T1-T3 — batch D: «Не пришёл» / cancel with C′ links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, cardLines, addVisitLine, calendarBook, callcenterBook, deskRegister } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const D7 = localDay(7);

test('CRM_ONE_WAY_V1 (повтор r1) — D1: «Не пришёл» on a registrar visit that C′ joined must not send a card with a live call-centre booking next week to «Не пришёл»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const v7 = await callcenterBook(t, D7, { svc: 30, doctor: 10 });
    console.log('D1 card after cc booking', t.lead(rid).status, t.lead(rid).scheduled_date, link(t, v7));
    // registrar books an analysis for today 08:00 (the patient will not come)
    const v0 = await calendarBook(t, 'reg', TODAY, { hour: 8, svc: 40, doctor: 10 });
    console.log('D1 link v0', link(t, v0), 'card', t.lead(rid).status, t.lead(rid).scheduled_date);
    const ns = await t.rpc('calendar_book', 'reg', { visit_id: v0, start: at(TODAY, 8), status: 'no_show' });
    console.log('D1 mark no_show', ns.status, ns.text.slice(0, 160));
    console.log('D1 card after no_show', t.lead(rid).status, t.lead(rid).scheduled_date, JSON.stringify(cardLines(t, rid).map((l) => [l.service_id, l.scheduled_date, l.status, l.visit_id])));
    assert.notEqual(t.lead(rid).status, 'no_show', 'card with a live booking next week went to «Не пришёл» because of a registrar visit C′ attached');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r1) — D1-baseline-shape: same, but without the registrar visit — card stays «Записан»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    await callcenterBook(t, D7, { svc: 30, doctor: 10 });
    assert.equal(t.lead(rid).status, 'scheduled');
  } finally { t.close(); }
});
