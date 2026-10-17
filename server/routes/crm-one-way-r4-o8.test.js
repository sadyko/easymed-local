// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r4/zz-r4-money-a.test.js» (H2, H3) и «r4/zz-r4-o8-old.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// R4 adversarial review (CRM_ONE_WAY_V1) — repros asserting the SAFE behaviour. Scratch only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, callcenterBook, cardLines } from '../test-helpers/crm-link-all.js';
import { crmOneWayRepair } from '../services/crm/one-way-repair.js';

const D3 = localDay(3);
const cancel = (t, vid, day, hour) => t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(day, hour), status: 'cancelled' });
const lineOf = (t, id) => t.db.prepare('SELECT * FROM crm_request_services WHERE id = ?').get(id);
const seed = (db) => {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петров', 'doctor', 1)").run();
};

// H2 — O8 on OLD data: a call-centre calendar booking (booking_lines_add) left a mirror copy in the card
// in the same request. R2 (owner): such services ARE booked lines of the card and come back undated after a cancel.
test('CRM_ONE_WAY_V1 (повтор r4) — R4-H2: O8 repair keeps a call-centre calendar service as a booked line (R2); a cancel after the upgrade returns it undated — same as a post-upgrade booking', async () => {
  // control: the NEW code path
  const t0 = await startCrmApp(seed);
  let newCodeAfterCancel;
  try {
    const rid = addLead(t0.db, { assigned: 3 });
    const v = await callcenterBook(t0, D3, { svc: 30, doctor: 10 });
    assert.deepEqual(link(t0, v), { request_id: rid, source: 'callcenter' });
    assert.equal((await cancel(t0, v, D3, 12)).status, 200);
    newCodeAfterCancel = cardLines(t0, rid).map((l) => [l.service_id, l.scheduled_date, l.visit_id]);
  } finally { t0.close(); }
  assert.deepEqual(newCodeAfterCancel, [[30, null, null]]);

  // OLD data, as booking_lines_add + mirrorVisit step 3 (c20fb960^ booking-mirror.js:462) left it
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3, status: 'scheduled', date: D3 });
    const T = '2026-10-10T09:00:00Z';
    const v = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, service_id, visit_date, status, created_by, created_at) VALUES (77, 10, 30, ?, 'scheduled', 3, ?)").run(at(D3, 12), T).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source, created_by, created_request) VALUES (?, ?, 'callcenter', 3, 0)").run(v, rid);
    const x = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, created_at) VALUES (?, 30, 10, 1, 100000, 100000, 'added', 3, ?)").run(v, T).lastInsertRowid);
    t.db.prepare(`INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, doctor_id, visit_id, visit_service_id, visit_service_auto, created_at)
                  VALUES (?, 30, ?, 'pending', 10, ?, ?, 0, ?)`).run(rid, D3, v, x, T);
    const out = crmOneWayRepair(t.db);
    console.log('R4-H2 repair counts:', JSON.stringify(out.counts));
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.visit_id, l.visit_service_id]), [[30, v, x]], 'repair deleted the call-centre booked line (R2)');
    assert.equal((await cancel(t, v, D3, 12)).status, 200);
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.scheduled_date, l.visit_id]), newCodeAfterCancel, 'after the upgrade a cancel returns nothing to the card');
  } finally { t.close(); }
});

// H3 — O8 race: the operator's wish saved 1 s after the registrar's line, later adopted by it (old adoptPendingLine, auto 0).
test('CRM_ONE_WAY_V1 (повтор r4) — R4-H3: O8 never deletes an operator line — a wish saved 1 s after the registrar line and adopted by it stays', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3, status: 'scheduled', date: D3 });
    const T = '2026-10-10T09:00:00Z';
    const v = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by, created_at) VALUES (77, 10, ?, 'scheduled', 2, ?)").run(at(D3, 12), T).lastInsertRowid);
    const y = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, created_at) VALUES (?, 40, NULL, 1, 40000, 40000, 'added', 2, ?)").run(v, T).lastInsertRowid);
    // operator's wish (card window insert, no visit) at T+1 s; adopted later (old adoptPendingLine: auto 0, visit+vs set)
    const wish = Number(t.db.prepare(`INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id, visit_service_id, visit_service_auto, created_at)
                                     VALUES (?, 40, ?, 'pending', ?, ?, 0, '2026-10-10T09:00:01Z')`).run(rid, D3, v, y).lastInsertRowid);
    const out = crmOneWayRepair(t.db);
    console.log('R4-H3 repair counts:', JSON.stringify(out.counts));
    assert.ok(lineOf(t, wish), 'operator wish deleted by the repair');
  } finally { t.close(); }
});
