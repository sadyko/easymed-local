// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r3/zz-r3-money.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// R3 adversarial review — money: releaseCancelledLines / settleStaleCopies (d6630801 CRM_TWIN_LINE).
// Each test asserts the SAFE behaviour (bill and visit lines); a FAIL = confirmed problem.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, addVisitLine, calendarBook, callcenterBook, cardLines } from '../test-helpers/crm-link-all.js';

const D2 = localDay(5);
const D3 = localDay(3);
const vsAll = (t, vid) => t.db.prepare("SELECT service_id, doctor_id, quantity FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid);
const cancel = (t, vid, day, hour) => t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(day, hour), status: 'cancelled' });
async function billOf(t, vid) {
  const ids = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((r) => r.id);
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  return Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount);
}
const seed = (db) => {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петров', 'doctor', 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, requires_doctor) VALUES (50, 'Массаж', 50000, 'procedure', 0)").run();
};

// M1 — call-centre booking from the card (consult, doctor 10) cancelled; the registrar books the SAME day
// with doctor 11 (patient wants another doctor). One consultation in the new visit, with doctor 11.
test('CRM_ONE_WAY_V1 (повтор r3) — R3-M1: callcenter consult (doctor 10) cancelled, registrar rebooks same day with doctor 11 — one consultation, 100 000', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const v1 = await callcenterBook(t, D3, { svc: 30, doctor: 10 });
    assert.deepEqual(link(t, v1), { request_id: rid, source: 'callcenter' });
    assert.equal((await cancel(t, v1, D3, 12)).status, 200);
    console.log('M1 card lines after cancel', JSON.stringify(cardLines(t, rid)));
    const v2 = await calendarBook(t, 'reg', D3, { hour: 15, svc: 30, doctor: 11 });
    console.log('M1 v2 lines', JSON.stringify(vsAll(t, v2)));
    assert.deepEqual(vsAll(t, v2).map((x) => [x.service_id, x.doctor_id]), [[30, 11]], 'consultation of doctor 10 rode into the doctor-11 visit');
    assert.equal(await billOf(t, v2), 100000);
  } finally { t.close(); }
});

// M2 — B1 for the call-centre card: callcenter consult cancelled; registrar books an ANALYSIS the same day.
test('CRM_ONE_WAY_V1 (повтор r3) — R3-M2: callcenter consult cancelled, registrar books an analysis the same day — only the analysis, 40 000', async () => {
  const t = await startCrmApp(seed);
  try {
    addLead(t.db, { assigned: 3 });
    const v1 = await callcenterBook(t, D3, { svc: 30, doctor: 10 });
    assert.equal((await cancel(t, v1, D3, 12)).status, 200);
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 40, start: at(D3, 15), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v2 = b.json.data.visit.id;
    await addVisitLine(t, 'reg', v2, { svc: 40, doctor: null });
    console.log('M2 v2 lines', JSON.stringify(vsAll(t, v2)));
    assert.deepEqual(vsAll(t, v2).map((x) => x.service_id), [40], 'phantom consultation in the analysis booking');
    assert.equal(await billOf(t, v2), 40000);
  } finally { t.close(); }
});

// M6 — the card's wish (massage) became a MIRROR line (auto=1); the registrar set it to a course x3 in the
// visit; booking cancelled; rebooked the same day -> the course x3 must not silently become x1.
// CRM_ONE_WAY_V1 — УБРАН: R3-M6 — опровергнут в ревью (у /api/db нет пути правки количества строки визита); копий строк больше нет.

// M7 — echo DROP: the call-centre operator ADDED a consultation (booking_lines_add) to a registrar visit that the
// card holds via step C ('match'). Visit cancelled -> the operator's own booked service must not vanish from the card.
test('CRM_ONE_WAY_V1 (повтор r3) — R3-M7: callcenter booking_lines_add on a match visit, cancel — the operator\'s line comes back to the card undated (решение владельца R2, O4)', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3, updated: daysAgoIso(1) });
    const v1 = await calendarBook(t, 'reg', D2, { hour: 12, svc: 40, doctor: 10 });
    assert.deepEqual(link(t, v1), { request_id: rid, source: 'match' });
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: v1, patient_id: 77, lines: [{ service_id: 30, doctor_id: 10, scheduled_at: at(D2, 12) }] });
    assert.equal(add.status, 200, add.text);
    console.log('M7 card lines before', JSON.stringify(cardLines(t, rid)));
    assert.equal((await cancel(t, v1, D2, 12)).status, 200);
    const after = cardLines(t, rid);
    console.log('M7 card lines after', JSON.stringify(after));
    // CRM_ONE_WAY_V1 (решение владельца R2, O4) — услуга колл-центра вернулась в карточку без дня, отпущенная отменой.
    assert.deepEqual(after.filter((l) => l.service_id === 30).map((l) => [l.status, l.scheduled_date, l.visit_id]), [['pending', null, null]],
      'the consultation the operator booked was dropped from the card');
  } finally { t.close(); }
});

// M8 — DROP + un-cancel: the registrar cancelled a booking by mistake and set it back to «Записан». The card's
// echo line was DROPPED by the cancel; the next mirror pass of the restored visit (any line added, the desk) must
// not delete the restored visit's consultation.
for (const via of ['addLine', 'desk']) {
  test(`CRM_ONE_WAY_V1 (повтор r3) — R3-M8 (${via}): match visit cancelled by mistake and restored — its consultation stays in the visit`, async () => {
    const t = await startCrmApp(seed);
    try {
      const rid = addLead(t.db, { assigned: 3, updated: daysAgoIso(1) });
      const day = via === 'desk' ? localDay(0) : D2;
      const v1 = await calendarBook(t, 'reg', day, { hour: 23, svc: 30, doctor: 10 });
      assert.deepEqual(link(t, v1), { request_id: rid, source: 'match' });
      const before = vsAll(t, v1);
      assert.deepEqual(before.map((x) => x.service_id), [30]);
      assert.equal((await cancel(t, v1, day, 23)).status, 200);
      const back = await t.rpc('calendar_book', 'reg', { visit_id: v1, start: at(day, 23), status: 'scheduled' });
      assert.equal(back.status, 200, back.text);
      assert.equal(t.db.prepare('SELECT status FROM visits WHERE id = ?').get(v1).status, 'scheduled');
      console.log('M8 card lines after restore', JSON.stringify(cardLines(t, rid)), 'vs', JSON.stringify(vsAll(t, v1)));
      if (via === 'addLine') await addVisitLine(t, 'reg', v1, { svc: 40, doctor: null });
      else {
        const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
        assert.equal(ev.status, 200, ev.text);
        assert.equal(ev.json.data.visit.id, v1);
      }
      console.log('M8 vs after mirror', JSON.stringify(vsAll(t, v1)));
      assert.ok(vsAll(t, v1).some((x) => x.service_id === 30), 'the restored visit lost its consultation');
    } finally { t.close(); }
  });
}

// M8 controls: no card at all / call-centre card (CARRY) — does a restore keep the consultation?
for (const kind of ['nocard', 'callcenter', 'match']) {
  test(`CRM_ONE_WAY_V1 (повтор r3) — R3-M8-ctl (${kind}): cancel + restore keeps the consultation`, async () => {
    const t = await startCrmApp(seed);
    try {
      let rid = null;
      if (kind === 'callcenter') rid = addLead(t.db, { assigned: 3 });
      if (kind === 'match') rid = addLead(t.db, { assigned: 3, updated: daysAgoIso(1) });
      const v1 = kind === 'callcenter' ? await callcenterBook(t, D2, { svc: 30, doctor: 10 }) : await calendarBook(t, 'reg', D2, { hour: 12, svc: 30, doctor: 10 });
      const all = () => JSON.stringify(t.db.prepare('SELECT id, service_id, status FROM visit_services WHERE visit_id = ?').all(v1));
      console.log(kind, 'link', JSON.stringify(link(t, v1)), 'after book', all());
      assert.equal((await cancel(t, v1, D2, 12)).status, 200);
      console.log(kind, 'after cancel', all(), rid ? JSON.stringify(t.db.prepare('SELECT id, status, visit_id, visit_service_id, visit_service_auto FROM crm_request_services WHERE request_id = ?').all(rid)) : '');
      const back = await t.rpc('calendar_book', 'reg', { visit_id: v1, start: at(D2, 12), status: 'scheduled' });
      assert.equal(back.status, 200, back.text);
      console.log(kind, 'after restore', all());
      assert.ok(vsAll(t, v1).some((x) => x.service_id === 30), 'restore lost the consultation');
    } finally { t.close(); }
  });
}
