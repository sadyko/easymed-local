// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r2/zz-f2-funnel.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL RE-REVIEW round 2 (funnel lens) — P-2…P-7, R3, R4, display-link reschedule. Each test asserts the
// SAFE / specified behaviour; a FAIL = the suspected problem is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, cardLines, addVisitLine, calendarBook, callcenterBook, deskRegister } from '../test-helpers/crm-link-all.js';
import { crmNoShowSweep } from '../services/crm/no-show.js';

const TODAY = localDay(0);
const D3 = localDay(3);
const D7 = localDay(7);
const mark = (t, vid, day, hour, status, who = 'reg') => t.rpc('calendar_book', who, { visit_id: vid, start: at(day, hour), status });
const liveBookings = (t, rid) => t.db.prepare(`SELECT v.id FROM visits v WHERE v.status NOT IN ('cancelled','no_show') AND (
    v.id IN (SELECT visit_id FROM crm_booking_links WHERE request_id = ?) OR
    v.id IN (SELECT visit_id FROM crm_request_services WHERE request_id = ? AND status = 'pending'))`).all(rid, rid);

// F-1 — P-3 restores only through the visit that carries the undo trail; the card's date is not re-derived.
test('CRM_ONE_WAY_V1 (повтор r2) — F-1a: two registrar bookings joined by C′; cancel the FIRST → card date must follow to the remaining booking', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'in_process', updated: daysAgoIso(1), assigned: 3 });
    const v1 = await calendarBook(t, 'reg', D3);
    const v2 = await calendarBook(t, 'reg', D7, { svc: 40, doctor: 10 });
    console.log('F-1a links', JSON.stringify(link(t, v1)), JSON.stringify(link(t, v2)), 'card', t.lead(rid).status, t.lead(rid).scheduled_date);
    const c = await mark(t, v1, D3, 12, 'cancelled');
    assert.equal(c.status, 200, c.text);
    console.log('F-1a after cancel v1', t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.equal(t.lead(rid).scheduled_date, D7, 'card still shows the cancelled day');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — F-1b: two registrar bookings joined by C′; cancel the first, then the second → card must not stay «Записан» with no booking', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'in_process', updated: daysAgoIso(1), assigned: 3 });
    const v1 = await calendarBook(t, 'reg', D3);
    const v2 = await calendarBook(t, 'reg', D7, { svc: 40, doctor: 10 });
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    assert.equal((await mark(t, v2, D7, 12, 'cancelled')).status, 200);
    const L = t.lead(rid);
    console.log('F-1b after both cancelled', L.status, L.scheduled_date, 'live bookings', liveBookings(t, rid).length,
      'undo', JSON.stringify(t.db.prepare('SELECT visit_id, prev_status, set_status FROM crm_booking_undo WHERE request_id = ?').all(rid)));
    // sweep the day after the "date" — the card would be stuck forever
    crmNoShowSweep(t.db, { day: localDay(4) });
    console.log('F-1b after sweep D4', t.lead(rid).status);
    assert.equal(liveBookings(t, rid).length, 0);
    assert.notEqual(t.lead(rid).status, 'scheduled', 'card «Записан» although every booking is cancelled');
  } finally { t.close(); }
});

// F-2 — R4 «Подтверждён» then cancel. Before R4 the card stayed «Записан» on confirm and the cancel put it back.
test('CRM_ONE_WAY_V1 (повтор r2) — F-2a (call centre card): confirm in calendar, then cancel → card must not stay «Подтверждён» with no booking', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const v = await callcenterBook(t, D3, { svc: 30, doctor: 10 });
    console.log('F-2a booked', t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.equal((await mark(t, v, D3, 12, 'confirmed')).status, 200);
    console.log('F-2a confirmed', t.lead(rid).status);
    assert.equal(t.lead(rid).status, 'approved');
    assert.equal((await mark(t, v, D3, 12, 'cancelled')).status, 200);
    console.log('F-2a cancelled', t.lead(rid).status, t.lead(rid).scheduled_date, 'live', liveBookings(t, rid).length);
    assert.notEqual(t.lead(rid).status, 'approved', 'card «Подтверждён» for a cancelled booking (stuck: sweep never moves it)');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — F-2b (C′ display link): confirm in calendar, then cancel → card must not stay «Подтверждён» with the cancelled date', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', date: localDay(10), updated: daysAgoIso(1), assigned: 3 });
    const v = await calendarBook(t, 'reg', D3);
    console.log('F-2b booked', JSON.stringify(link(t, v)), t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.equal((await mark(t, v, D3, 12, 'confirmed')).status, 200);
    assert.equal(t.lead(rid).status, 'approved');
    assert.equal((await mark(t, v, D3, 12, 'cancelled')).status, 200);
    const L = t.lead(rid);
    crmNoShowSweep(t.db, { day: localDay(4) });
    console.log('F-2b cancelled', L.status, L.scheduled_date, 'after sweep', t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.ok(!(L.status === 'approved' && L.scheduled_date === D3), 'card «Подтверждён» on the cancelled day, no booking — stuck');
  } finally { t.close(); }
});

// F-6 — a booking created directly with status «Подтверждён» (calendar_book status confirmed).
test('CRM_ONE_WAY_V1 (повтор r2) — F-6: booking created directly as «Подтверждён» moves the card the same as confirm-after-book', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'confirmed' });
    console.log('F-6 create confirmed', b.status, b.text.slice(0, 120));
    if (b.status !== 200) return;   // door does not allow it — nothing to check
    console.log('F-6 card', t.lead(rid).status, JSON.stringify(link(t, b.json.data.visit.id)));
    assert.equal(t.lead(rid).status, 'approved', 'a confirmed booking leaves the card «Записан»');
  } finally { t.close(); }
});

// F-5 — R4 forward only.
test('CRM_ONE_WAY_V1 (повтор r2) — F-5: «Подтверждён» never moves a closed (won / lost / no_show) card', async () => {
  const t = await startCrmApp();
  try {
    const won = addLead(t.db, { status: 'came', assigned: 3 });
    const v = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 3)").run(at(D3, 12)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'callcenter')").run(v, won);
    const lost = addLead(t.db, { status: 'stopped', assigned: 3 });
    const v2 = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 3)").run(at(D7, 12)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'patient')").run(v2, lost);
    const ns = addLead(t.db, { status: 'no_show', assigned: 3 });
    const v3 = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 3)").run(at(localDay(8), 12)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'phone')").run(v3, ns);
    for (const [vid, d] of [[v, D3], [v2, D7], [v3, localDay(8)]]) assert.equal((await mark(t, vid, d, 12, 'confirmed')).status, 200);
    assert.deepEqual([t.lead(won).status, t.lead(lost).status, t.lead(ns).status], ['came', 'stopped', 'no_show']);
  } finally { t.close(); }
});

// F-9 — reschedule of a display-linked booking: date follows, updated_at does not move.
test('CRM_ONE_WAY_V1 (повтор r2) — F-9: C′-linked booking moved in the calendar → card date follows, updated_at untouched, stage unchanged', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'in_process', updated: daysAgoIso(1), assigned: 3 });
    const v = await calendarBook(t, 'reg', D3);
    t.db.prepare('UPDATE crm_requests SET updated_at = ? WHERE id = ?').run(daysAgoIso(2), rid);
    const before = t.lead(rid);
    const m = await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(D7, 15), status: 'scheduled' });
    assert.equal(m.status, 200, m.text);
    const after = t.lead(rid);
    console.log('F-9', JSON.stringify(link(t, v)), before.scheduled_date, '->', after.scheduled_date, before.updated_at, '->', after.updated_at, after.status);
    assert.equal(after.scheduled_date, D7);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.status, before.status);
  } finally { t.close(); }
});

// F-10 — P-7 when the visit is held by ANOTHER card's LINK (not a line): the desk-closed card shows nothing.
test('CRM_ONE_WAY_V1 (повтор r2) — F-10: desk closes card Y; visit held by card X\'s call-centre LINK → Y must still list the visit («Записи пациента»)', async () => {
  const t = await startCrmApp();
  try {
    const X = addLead(t.db, { assigned: 3, name: 'X' });
    // call centre books today 17:00 from the calendar, no lines (link only)
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(TODAY, 17), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    console.log('F-10 link', JSON.stringify(link(t, vid)));
    const Y = addLead(t.db, { assigned: 4, name: 'Y', date: TODAY });   // second operator's card, waits today
    await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
    const { crmCardBookings } = await import('../services/rpc/crm-card-bookings.js');
    const boss = { id: 1, role: 'admin', extra_roles: [] };
    const showsY = crmCardBookings(t.db, { request_id: Y }, boss).bookings.map((x) => x.visit_id);
    console.log('F-10 X', t.lead(X).status, 'Y', t.lead(Y).status, 'Y shows', JSON.stringify(showsY));
    if (t.lead(Y).status === 'came') assert.ok(showsY.includes(vid), 'card closed «Пришёл» by the desk shows no booking (G4 for this shape)');
  } finally { t.close(); }
});

// F-7 — R3 server side.
test('CRM_ONE_WAY_V1 (повтор r2) — F-7: wizard ensure_visit with desk + slot later today stays «Записан»; ≤30 min → «Пришёл»; doctor/callcenter desk ignored', async () => {
  const t = await startCrmApp();
  try {
    const now = new Date();
    const later = new Date(now.getTime() + 3 * 3600e3);
    if (later.getDate() !== now.getDate()) { console.log('F-7 skipped: too late in the day'); return; }
    const rid = addLead(t.db, { assigned: 3 });
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: later.toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true,
      book: { doctor_id: 10, start: later.toISOString(), duration_minutes: 30, service_id: 30 } });
    assert.equal(ev.status, 200, ev.text);
    console.log('F-7 later', t.lead(rid).status);
    assert.equal(t.lead(rid).status, 'scheduled', 'wizard booking for later today closed the card');
  } finally { t.close(); }
  const t2 = await startCrmApp();
  try {
    const rid = addLead(t2.db, { assigned: 3 });
    const soon = new Date(Date.now() + 20 * 60e3);
    const ev = await t2.rpc('ensure_visit', 'doc', { patient_id: 77, date: soon.toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true,
      book: { doctor_id: 10, start: soon.toISOString(), duration_minutes: 30, service_id: 30 } });
    console.log('F-7 doctor desk', ev.status, t2.lead(rid).status);
    assert.notEqual(t2.lead(rid).status, 'came', 'doctor desk:true trusted');
  } finally { t2.close(); }
});

// F-8 — registrar / doctor / admin never create a card.
test('CRM_ONE_WAY_V1 (повтор r2) — F-8: patient without any card — registrar desk, registrar/doctor/admin calendar bookings create NO card', async () => {
  const t = await startCrmApp();
  try {
    await deskRegister(t, 'reg');
    await calendarBook(t, 'reg', D3);
    await calendarBook(t, 'doc', D7);
    await calendarBook(t, 'boss', localDay(9));
    const n = t.db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n;
    assert.equal(n, 0, 'a non-call-centre door created a CRM card');
  } finally { t.close(); }
});

// F-4 — P-5: phone path and prepayment.
test('CRM_ONE_WAY_V1 (повтор r2) — F-4a: P-5 — phone-only lead, today\'s visit already PAID today → ensure_visit (no desk) → card «Пришёл»', async () => {
  const t = await startCrmApp();
  try {
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 2)").run(new Date(Date.now() - 3600e3).toISOString()).lastInsertRowid);
    t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 30, 10, 1, 100000, 100000, 'added', 2)").run(vid);
    t.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES (1, 'INV-1', ?, 77, 100000, 100000, 100000, 'paid')").run(vid);
    t.db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (1, 100000, 'cash', ?)").run(new Date().toISOString());
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638', assigned: 3 });
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    console.log('F-4a', JSON.stringify(link(t, vid)), t.lead(rid).status, t.lead(rid).patient_id);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — F-4b: P-5 must NOT fire on a PREPAYMENT (paid yesterday for today\'s later visit) — card «Записан»', async () => {
  const t = await startCrmApp();
  try {
    const later = new Date(); later.setHours(19, 0, 0, 0);
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 2)").run(later.toISOString()).lastInsertRowid);
    t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 30, 10, 1, 100000, 100000, 'added', 2)").run(vid);
    t.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES (1, 'INV-1', ?, 77, 100000, 100000, 100000, 'paid')").run(vid);
    t.db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (1, 100000, 'cash', ?)").run(new Date(Date.now() - 86400e3).toISOString());
    const rid = addLead(t.db, { status: 'recall', updated: daysAgoIso(1), assigned: 3 });
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: later.toISOString(), doctor_id: 10, visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    console.log('F-4b', JSON.stringify(link(t, vid)), t.lead(rid).status);
    assert.notEqual(t.lead(rid).status, 'came', 'prepayment treated as arrival');
  } finally { t.close(); }
});

// F-3 — P-4: card kept «Записан» by another booking keeps the date of the no-show visit.
test('CRM_ONE_WAY_V1 (повтор r2) — F-3: «Не пришёл» on a C′ visit, card kept by a call-centre booking next week → card date must point at the live booking', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    await callcenterBook(t, D7, { svc: 30, doctor: 10 });
    const v0 = await calendarBook(t, 'reg', TODAY, { hour: 8, svc: 40, doctor: 10 });
    assert.equal((await mark(t, v0, TODAY, 8, 'no_show')).status, 200);
    console.log('F-3', t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.equal(t.lead(rid).scheduled_date, D7, 'card date stays on the missed visit');
  } finally { t.close(); }
});
