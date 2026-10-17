// CRM_ONE_WAY_V1 (2026-10-17) — повторы ревью «r6/zz-r6-attack.test.js» (scratchpad crm-link-review): правило 3
// разового исправления O8 (отпустить датированное желание отменённой записи) на строках в духе v3.16. Перенесены
// R6-RD-MOVE и R6-RD-DOC; R6-SYM-ORD и R6-SYM-MOVE — принятые ограничения выпуска 3.17.0 (план, раздел ревью r6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead } from '../test-helpers/crm-unify-app.js';
import { crmOneWayRepair } from '../services/crm/one-way-repair.js';
import { calendarBook } from '../test-helpers/crm-link-all.js';

const D3 = localDay(3);
const D5 = localDay(5);
const vsAll = (t, vid) => t.db.prepare("SELECT id, service_id, consultation_type_id, doctor_id, unit_price FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((x) => ({ ...x }));
const seed = (db) => {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петров', 'doctor', 1)").run();
  db.prepare("INSERT INTO consultation_types (id, name, price, active) VALUES (5, 'Приём терапевта', 100000, 1)").run();
  db.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price) VALUES (10, 5, 150000), (11, 5, 120000)').run();
};

// Отменённая запись календаря v3.16, привязанная к карточке колл-центром, со следом записи (её день — undoDay).
function craft(t, rid, { day, hour = 12, doctor = 10, service = 30, updated = '2026-10-10T10:00:00Z', undoDay = day } = {}) {
  const v = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, service_id, visit_date, status, created_by, created_at, updated_at) VALUES (77, ?, ?, ?, 'cancelled', 3, '2026-10-10T09:00:00Z', ?)")
    .run(doctor, service, at(day, hour), updated).lastInsertRowid);
  t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source, created_by, created_request, created_at) VALUES (?, ?, 'callcenter', 3, 0, '2026-10-10T09:00:00Z')").run(v, rid);
  t.db.prepare("INSERT INTO crm_booking_undo (visit_id, request_id, prev_status, prev_scheduled_date, set_status, set_scheduled_date, created_at) VALUES (?, ?, 'in_process', NULL, 'scheduled', ?, '2026-10-10T09:00:00Z')").run(v, rid, undoDay);
  return v;
}
const wishAt = (t, rid, { svc = 30, doctor = 10, day, at: when = '2026-10-10T08:00:00Z' }) => Number(t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, doctor_id, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
  .run(rid, svc, doctor, day, when).lastInsertRowid);

test('CRM_ONE_WAY_V1 (повтор r6) — R6-RD-MOVE: запись календаря v3.16 (врач 10, D3) перенесли на D5 и отменили до обновления; желание карточки на D3 — после обновления запись регистратуры на D3 к врачу 11 держит ОДНУ консультацию (M1)', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3, status: 'in_process' });
    const v = craft(t, rid, { day: D5, undoDay: D3 });   // визит теперь на D5 (перенесён), след помнит день записи D3
    const w = wishAt(t, rid, { day: D3 });
    const out = crmOneWayRepair(t.db);
    const st = t.db.prepare('SELECT scheduled_date, released_from_visit_id FROM crm_request_services WHERE id = ?').get(w);
    console.log('R6-RD-MOVE repair:', JSON.stringify(out.counts), 'wish:', JSON.stringify(st));
    assert.deepEqual([st.scheduled_date, st.released_from_visit_id], [null, v], 'желание дня перенесённой и отменённой записи не отпущено');
    const v2 = await calendarBook(t, 'reg', D3, { hour: 15, svc: 30, doctor: 11 });
    console.log('R6-RD-MOVE D3 booking lines:', JSON.stringify(vsAll(t, v2)));
    assert.deepEqual(vsAll(t, v2).map((x) => [x.service_id, x.doctor_id]), [[30, 11]], 'отменённая консультация врача 10 села в запись к врачу 11');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r6) — R6-RD-DOC: отменённая запись v3.16 была консультацией врача 10; отдельное желание карточки «консультация у Петрова» (11) того дня исправление не отпускает', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3, status: 'in_process' });
    const v = craft(t, rid, { day: D3, doctor: 10 });
    t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, created_at) VALUES (?, 30, 10, 1, 100000, 100000, 'added', 3, '2026-10-10T09:00:00Z')").run(v);
    const w10 = wishAt(t, rid, { day: D3, doctor: 10 });
    const w11 = wishAt(t, rid, { day: D3, doctor: 11 });
    const out = crmOneWayRepair(t.db);
    const st = (id) => t.db.prepare('SELECT scheduled_date, released_from_visit_id FROM crm_request_services WHERE id = ?').get(id);
    console.log('R6-RD-DOC repair:', JSON.stringify(out.counts), 'w10', JSON.stringify(st(w10)), 'w11', JSON.stringify(st(w11)));
    assert.deepEqual([st(w10).scheduled_date, st(w10).released_from_visit_id], [null, v], 'желание врача отменённой записи не отпущено');
    assert.equal(st(w11).scheduled_date, D3, 'желание врача 11 (в отменённой записи его не было) потеряло день');
    assert.equal(st(w11).released_from_visit_id, null);
  } finally { t.close(); }
});
