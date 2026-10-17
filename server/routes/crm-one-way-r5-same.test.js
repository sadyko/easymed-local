// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r5/zz-r5-attack.test.js» (SYM, UC, DATE) (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// R5 — narrow re-check of the r4 fixes (tree5 = 0ee5356f). Repros assert the SAFE behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';

const D3 = localDay(3);
const D5 = localDay(5);
const TODAY = localDay(0);
const vsAll = (t, vid) => t.db.prepare("SELECT id, service_id, doctor_id, created_by FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((x) => ({ ...x }));
const lineOf = (t, id) => ({ ...t.db.prepare('SELECT * FROM crm_request_services WHERE id = ?').get(id) });
const seed = (db) => {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петров', 'doctor', 1)").run();
};
const regLine = (t, vid, { svc = 30, doctor = 10 } = {}) => t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
  values: { visit_id: vid, service_id: svc, doctor_id: doctor, quantity: 1, unit_price: svc === 30 ? 100000 : 40000, total: svc === 30 ? 100000 : 40000, price_tier: 'primary', status: 'added' } });

// ── symmetric «same service» ────────────────────────────────────────────────

test('CRM_ONE_WAY_V1 (повтор r5) — R5-SYM-a: two live cards, «консультация у Иванова» (10) and «консультация у Петрова» (11) the same day — two consultations, each card on its doctor\'s line', async () => {
  const t = await startCrmApp(seed);
  try {
    const a = addLead(t.db, { assigned: 3, name: 'A' });
    const b = addLead(t.db, { assigned: 3, name: 'B' });
    const la = addLine(t.db, a, { svc: 30, day: D3, doctor: 10 });
    const lb = addLine(t.db, b, { svc: 30, day: D3, doctor: 11 });
    const r = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    assert.equal(r.status, 200, r.text);
    const v = r.json.data.visit.id;
    const lines = vsAll(t, v);
    console.log('R5-SYM-a lines:', JSON.stringify(lines));
    assert.deepEqual(lines.map((x) => x.doctor_id).sort(), [10, 11]);
    assert.equal(lines.find((x) => x.id === lineOf(t, la).visit_service_id).doctor_id, 10);
    assert.equal(lines.find((x) => x.id === lineOf(t, lb).visit_service_id).doctor_id, 11);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r5) — R5-SYM-b: the visit already has a consultation WITHOUT doctor; cards want Иванов (10) and Петров (11) that day — the two named consultations are not merged into one line', async () => {
  const t = await startCrmApp(seed);
  try {
    const b0 = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b0.status, 200, b0.text);
    const v = b0.json.data.visit.id;
    const x = await regLine(t, v, { svc: 30, doctor: null });   // registrar: «Консультация терапевта», doctor not chosen
    assert.equal(x.status, 200, x.text);
    const a = addLead(t.db, { assigned: 3, name: 'A' });
    const b = addLead(t.db, { assigned: 3, name: 'B' });
    addLine(t.db, a, { svc: 30, day: D3, doctor: 10 });
    addLine(t.db, b, { svc: 30, day: D3, doctor: 11 });
    // any linking door on the visit (the call centre adds an analysis in the calendar)
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: v, patient_id: 77, lines: [{ service_id: 40 }] });
    assert.equal(add.status, 200, add.text);
    const pts = t.db.prepare("SELECT request_id, doctor_id, visit_service_id FROM crm_request_services WHERE service_id = 30 ORDER BY id").all().map((r) => ({ ...r }));
    console.log('R5-SYM-b visit:', JSON.stringify(vsAll(t, v)), 'card lines:', JSON.stringify(pts));
    const consults = vsAll(t, v).filter((l) => l.service_id === 30);
    assert.ok(consults.length >= 2, 'consultations of doctor 10 and doctor 11 collapsed into ONE line (' + consults.length + ')');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r5) — R5-SYM-c: the CRM line of «консультация у Иванова» (10) does not give way to a doctor-less human line — the booked doctor stays on the visit', async () => {
  const t = await startCrmApp(seed);
  try {
    const a = addLead(t.db, { assigned: 3 });
    const la = addLine(t.db, a, { svc: 30, day: D3, doctor: 10 });
    const r = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    const v = r.json.data.visit.id;
    assert.deepEqual(vsAll(t, v).map((l) => l.doctor_id), [10]);
    const y = await regLine(t, v, { svc: 30, doctor: null });
    assert.equal(y.status, 200, y.text);
    console.log('R5-SYM-c visit:', JSON.stringify(vsAll(t, v)), 'card line ->', lineOf(t, la).visit_service_id);
    assert.ok(vsAll(t, v).some((l) => l.service_id === 30 && l.doctor_id === 10), 'the doctor-10 booking line was replaced by a doctor-less one');
  } finally { t.close(); }
});

// ── un-cancel to «Пришёл» with a held line ──────────────────────────────────

test('CRM_ONE_WAY_V1 (повтор r5) — R5-UC: held line (invoice before arrival), cancel, then «Пришёл» directly — the analysis is placed in the visit, the card is closed', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    addLine(t.db, rid, { svc: 30, day: TODAY, doctor: 10 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(TODAY, 23), duration_minutes: 30, status: 'scheduled' });
    const v = b.json.data.visit.id;
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v, visit_service_ids: vsAll(t, v).map((x) => x.id), discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const ins = await t.dbq('cc', { table: 'crm_request_services', op: 'insert', returning: true, single: 'single', values: { request_id: rid, service_id: 40, scheduled_date: TODAY, status: 'pending', visit_id: v } });
    assert.equal(ins.status, 200, ins.text);
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(TODAY, 23), status: 'cancelled' })).status, 200);
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(TODAY, 23), status: 'arrived' })).status, 200);
    console.log('R5-UC visit:', JSON.stringify(vsAll(t, v)), 'card:', t.lead(rid).status);
    assert.ok(vsAll(t, v).some((x) => x.service_id === 40), 'analysis not placed');
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

// ── date rule with fromVisitDate ────────────────────────────────────────────

test('CRM_ONE_WAY_V1 (повтор r5) — R5-DATE-a: cancel + move in ONE calendar_book — the card does not keep the booking\'s old day', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    addLine(t.db, rid, { svc: 30, day: D3, doctor: 10 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    const v = b.json.data.visit.id;
    assert.equal(t.lead(rid).scheduled_date, D3);
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(D5, 9), status: 'cancelled' })).status, 200);
    console.log('R5-DATE-a card:', t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.notEqual(t.lead(rid).scheduled_date, D3);
    assert.notEqual(t.lead(rid).scheduled_date, D5);
  } finally { t.close(); }
});
