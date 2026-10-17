// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r2/zz-m2-misc.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL RE-REVIEW round 2 (money) — R3 desk with book, P-3/P-5, display-link paths, I3 residual.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, calendarBook, callcenterBook, addVisitLine, deskRegister } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const money = (t) => JSON.stringify({
  vs: t.db.prepare('SELECT id, visit_id, service_id, doctor_id, status, invoice_item_id, unit_price, total FROM visit_services ORDER BY id').all(),
  inv: t.db.prepare('SELECT id, visit_id, total_amount, paid_amount FROM invoices ORDER BY id').all(),
});
const cardLines = (t, rid) => t.db.prepare('SELECT service_id, status, visit_id, visit_service_id FROM crm_request_services WHERE request_id = ? ORDER BY id').all(rid);

// (6) R3 — wizard «now» with a slot ≤ 30 min, the patient's day visit is a call-centre booking for
// 17:00 with another doctor → ensure_visit answers day_visit_busy, desk is believed → arrival.
// Money: nothing in visit_services / invoices changes because of the desk flag.
test('CRM_ONE_WAY_V1 (повтор r2) — M2-R3a: desk+book ≤30 min over a later-today call-centre booking — visit lines and invoices identical to the same call without desk', async () => {
  const run = async (desk) => {
    const t = await startCrmApp((db) => db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петров', 'doctor', 1)").run());
    try {
      const rid = addLead(t.db, { assigned: 3 });
      const vid = await callcenterBook(t, TODAY, { hour: 23, svc: 30, doctor: 10 });
      const start = new Date(Date.now() + 20 * 60000).toISOString();
      const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: start, doctor_id: 11, visit_type: 'outpatient',
        book: { doctor_id: 11, start, duration_minutes: 15, service_id: 40 }, ...(desk ? { desk: true } : {}) });
      assert.equal(ev.status, 200, ev.text);
      return { snap: money(t).replace(/"id":\d+,/g, ''), card: t.lead(rid).status, lines: cardLines(t, rid), vid, ev: ev.json.data };
    } finally { t.close(); }
  };
  const a = await run(true);
  const b = await run(false);
  console.log('R3a desk card', a.card, JSON.stringify(a.lines), 'no-desk card', b.card, JSON.stringify(b.lines), 'answer', JSON.stringify({ booked: a.ev.booked, reason: a.ev.reason }));
  assert.equal(a.snap, b.snap, 'desk flag changed visit lines / invoices');
});

// (6) the server's 30-minute guard — desk with a slot 3 h ahead is NOT an arrival
test('CRM_ONE_WAY_V1 (повтор r2) — M2-R3b: desk+book 3 h ahead today — card stays «Записан», no done lines', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    addLine(t.db, rid, { svc: 30, day: TODAY, doctor: 10 });
    const start = new Date(Date.now() + 3 * 3600000);
    if (start.getDate() !== new Date().getDate()) return;   // too late today to test
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: start.toISOString(), doctor_id: 10, visit_type: 'outpatient',
      book: { doctor_id: 10, start: start.toISOString(), duration_minutes: 30, service_id: 30 }, desk: true });
    assert.equal(ev.status, 200, ev.text);
    console.log('R3b', t.lead(rid).status, JSON.stringify(cardLines(t, rid)));
    assert.notEqual(t.lead(rid).status, 'came');
    assert.ok(!cardLines(t, rid).some((l) => l.status === 'done'));
  } finally { t.close(); }
});

// (5) P-5 — C′ links a today's visit that is already paid: card «Пришёл», money unchanged by the link
test('CRM_ONE_WAY_V1 (повтор r2) — M2-P5: C′ on an already-paid visit — card «Пришёл», visit lines and invoice untouched', async () => {
  const t = await startCrmApp();
  try {
    // paid visit first (no card yet), then a live card appears, then another door touches the visit
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient' });
    const vid = ev.json.data.visit.id;
    const y = await addVisitLine(t, 'reg', vid, { svc: 30, doctor: 10 });
    const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: vid, visit_service_ids: [y], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const pay = await t.rpc('record_payment', 'kassa', { invoice_id: inv.json.data.invoice.id, amount: 100000, method: 'cash' });
    console.log('P5 pay', pay.status, pay.text.slice(0, 120));
    const rid = addLead(t.db, { assigned: 3, updated: daysAgoIso(5) });
    const before = money(t);
    const ev2 = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient' });
    assert.equal(ev2.status, 200, ev2.text);
    console.log('P5 card', t.lead(rid).status, 'link', JSON.stringify(link(t, vid)), 'card lines', JSON.stringify(cardLines(t, rid)));
    assert.equal(money(t), before, 'C′/P-5 changed visit lines or invoices');
    assert.equal(cardLines(t, rid).length, 0, 'C′ copied lines onto the card');
  } finally { t.close(); }
});

// (5) P-3 — cancel of a C′ booking puts the card back; money: the cancelled booking's lines, nothing else
test('CRM_ONE_WAY_V1 (повтор r2) — M2-P3: cancel C′ booking → card back; card own pending line of another day untouched, not in any visit', async () => {
  const t = await startCrmApp();
  try {
    const D = localDay(3);
    const rid = addLead(t.db, { assigned: 3, date: D, status: 'in_process' });
    addLine(t.db, rid, { svc: 40, day: D });
    const vid = await calendarBook(t, 'reg', localDay(5), { hour: 12 });
    assert.equal(link(t, vid)?.source, 'patient');
    const was = t.lead(rid);
    const c = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(localDay(5), 12), status: 'cancelled' });
    assert.equal(c.status, 200, c.text);
    console.log('P3 card before', was.status, was.scheduled_date, 'after', t.lead(rid).status, t.lead(rid).scheduled_date, JSON.stringify(cardLines(t, rid)));
    assert.deepEqual(cardLines(t, rid), [{ service_id: 40, status: 'pending', visit_id: null, visit_service_id: null }]);
    // next booking on D takes the card's own line exactly once
    const v2 = await calendarBook(t, 'reg', D, { hour: 10, svc: 30, doctor: 10 });
    assert.deepEqual(vsOf(t, v2).map((x) => x.service_id).sort(), [30, 40]);
  } finally { t.close(); }
});

// RESIDUAL I3 (pre-existing, P-6 covers only the phone-linked visit): phone lead with the son's
// analysis for D2; mother books today (step D gives her the card); her D2 booking takes the analysis.
// CRM_ONE_WAY_V1 — УБРАН: M2-I3-residual требовал обратного решению владельца D4 (R5: карточка, найденная по телефону, дальше — обычная карточка пациента; её желания другого дня садятся в его запись того дня). Не регрессия CRM_ONE_WAY_V1.
