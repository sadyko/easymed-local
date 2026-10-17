// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r2/zz-m2-twin.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL RE-REVIEW round 2 (money) — Task 6 booked-twin.js (R7b) + Task 7 (R7a) interplay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { vsOf, callcenterBook, addVisitLine } from '../test-helpers/crm-link-all.js';
import { isBookedTwin } from '../../public/js/admin/views/booked-rows.js';
import { retireBookedTwin } from '../services/crm/booked-twin.js';

const TODAY = localDay(0);
const seedEkg = (db) => {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'nurse', 'x', 'Петрова', 'doctor', 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, requires_doctor, duration_minutes) VALUES (50, 'ЭКГ', 50000, 'procedure', 0, 15)").run();
};
const rawVs = (t, id) => t.db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id) || null;

// S1 — R7a/R7b rule mismatch. The call centre booked «ЭКГ» (no doctor required) with executor 10
// (service-picker-modal sends a.doctor.id for ANY service). Fast registration shows it as a booked
// row (doctor locked). The registrar adds «ЭКГ» again with executor 11 (or had added it before
// picking the patient — showBookedRows attaches only when isBookedTwin, i.e. doctors equal or one
// missing). The screen's guards (addLine, registerWalkIn) use isBookedTwin → "not a twin" → the save
// inserts Y and invoices [Y, X]. The server net (sameService) ignores the doctor for a service that
// does not require one → it DELETES X, whose id the screen is invoicing.
// CRM_ONE_WAY_V1 — УБРАН: M2-S1 — предусловие («экран пропускает вторую строку ЭКГ») снято правкой S1 (ff71a63f, общее правило shared/same-service.js); остался контроль S1-control.

// Control for S1: same rows, executor equal → screen treats them as twins (no second row is built).
test('CRM_ONE_WAY_V1 (повтор r2) — M2-S1-control: same executor — the screen itself refuses the second row (isBookedTwin true)', () => {
  assert.equal(isBookedTwin({ serviceId: 50, doctorId: 10 }, { serviceId: 50, doctorId: 10 }), true);
  assert.equal(isBookedTwin({ serviceId: 50, doctorId: null }, { serviceId: 50, doctorId: 10 }), true);
});

// (3) two cards book the same consultation onto one visit → one X shared; the desk line Y takes it:
// both card lines follow to Y, nothing orphaned, one consultation in the bill.
test('CRM_ONE_WAY_V1 (повтор r2) — M2-T2: two cards share the booked line — both card lines relinked to the desk line, one consultation', async () => {
  const t = await startCrmApp();
  try {
    const a = addLead(t.db, { assigned: 3, name: 'A' });
    const b = addLead(t.db, { assigned: 4, name: 'B' });
    addLine(t.db, a, { svc: 30, day: TODAY, doctor: 10 });
    addLine(t.db, b, { svc: 30, day: TODAY, doctor: 10 });
    const ev0 = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(TODAY, 18), duration_minutes: 30, status: 'scheduled' });
    assert.equal(ev0.status, 200, ev0.text);
    const vid = ev0.json.data.visit.id;
    const before = vsOf(t, vid);
    const held = t.db.prepare("SELECT request_id, visit_service_id, visit_service_auto FROM crm_request_services WHERE visit_id = ? AND status <> 'cancelled'").all(vid);
    console.log('T2 before', JSON.stringify(before), JSON.stringify(held));
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    const y = await addVisitLine(t, 'reg', vid, { svc: 30, doctor: 10 });
    const after = vsOf(t, vid);
    const lines = t.db.prepare("SELECT request_id, status, visit_service_id FROM crm_request_services WHERE request_id IN (?, ?) AND status <> 'cancelled'").all(a, b);
    console.log('T2 after', JSON.stringify(after), JSON.stringify(lines));
    assert.deepEqual(after.map((r) => r.id), [y]);
    assert.equal(lines.length, 2);
    for (const l of lines) assert.equal(l.visit_service_id, y, 'card line orphaned');
  } finally { t.close(); }
});

// (3) never touched: billed X, started X, other doctor (requires_doctor), quantity 2, registrar's own booking line.
for (const kind of ['billed', 'started', 'otherDoctor', 'qty2', 'registrarLine', 'yQty2']) {
  test(`CRM_ONE_WAY_V1 (повтор r2) — M2-T3 (${kind}): retireBookedTwin leaves the booked line alone`, async () => {
    const t = await startCrmApp((db) => db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петров', 'doctor', 1)").run());
    try {
      const vid = kind === 'registrarLine'
        ? (await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(TODAY, 18), duration_minutes: 30, status: 'scheduled' })).json.data.visit.id
        : await callcenterBook(t, TODAY, { hour: 18, svc: 30, doctor: 10 });
      let x;
      if (kind === 'registrarLine') x = await addVisitLine(t, 'reg', vid, { svc: 30, doctor: 10 });
      else x = vsOf(t, vid)[0].id;
      if (kind === 'billed') {
        const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: vid, visit_service_ids: [x], discount_amount: 0, payer_id: null });
        assert.equal(inv.status, 200, inv.text);
      }
      if (kind === 'started') t.db.prepare("UPDATE visit_services SET status = 'in_progress' WHERE id = ?").run(x);
      if (kind === 'qty2') t.db.prepare('UPDATE visit_services SET quantity = 2, total = 200000 WHERE id = ?').run(x);
      const snap = JSON.stringify(rawVs(t, x));
      const y = await addVisitLine(t, 'reg', vid, { svc: 30, doctor: kind === 'otherDoctor' ? 11 : 10, quantity: kind === 'yQty2' ? 2 : 1 });
      console.log(kind, 'x', snap === JSON.stringify(rawVs(t, x)) ? 'unchanged' : JSON.stringify(rawVs(t, x)), 'visit', JSON.stringify(vsOf(t, vid)));
      if (kind === 'registrarLine') assert.ok(rawVs(t, x), 'registrar line deleted');
      else assert.equal(JSON.stringify(rawVs(t, x)), snap, 'booked line touched');
      assert.ok(rawVs(t, y));
    } finally { t.close(); }
  });
}

// (3) I7 — retireBookedTwin never throws
test('CRM_ONE_WAY_V1 (повтор r2) — M2-T4: retireBookedTwin with garbage ids / missing tables returns null', async () => {
  const t = await startCrmApp();
  try {
    assert.equal(retireBookedTwin(t.db, 999999), null);
    assert.equal(retireBookedTwin(t.db, 'x'), null);
  } finally { t.close(); }
});
