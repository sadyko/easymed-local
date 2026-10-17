// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r4/zz-r4-money-b.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// R4 adversarial review (CRM_ONE_WAY_V1) — batch 2. Repros assert the SAFE behaviour. Scratch only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { BOOKED_LINE_LOCKED } from '../services/crm/one-way.js';

const D3 = localDay(3);
const D5 = localDay(5);
const vsAll = (t, vid) => t.db.prepare("SELECT id, service_id, doctor_id, quantity, unit_price FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((x) => ({ ...x }));
const cancel = (t, vid, day, hour) => t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(day, hour), status: 'cancelled' });
const lineOf = (t, id) => ({ ...t.db.prepare('SELECT * FROM crm_request_services WHERE id = ?').get(id) });
const money = (t) => ({
  vs: t.db.prepare('SELECT id, visit_id, service_id, consultation_type_id, doctor_id, quantity, unit_price, status FROM visit_services ORDER BY id').all().map((x) => ({ ...x })),
  inv: t.db.prepare('SELECT id, visit_id, total_amount, paid_amount, status FROM invoices ORDER BY id').all().map((x) => ({ ...x })),
});
async function billOf(t, vid) {
  const ids = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((r) => r.id);
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  return Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount);
}
const seed = (db) => {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петров', 'doctor', 1)").run();
};

// M1 — O1 orientation: a doctor-less wish books a doctor-less consultation line first; a second wish of the same
// consultation WITH the doctor does not see it as «the same service» (sameAsWish(wish, x) — wish is the «booked» side).
test('CRM_ONE_WAY_V1 (повтор r4) — R4-M1: two live cards, «консультация» without doctor and «консультация у Иванова» on the same day — one consultation in the visit (O1)', async () => {
  const t = await startCrmApp(seed);
  try {
    const old = addLead(t.db, { assigned: 3, name: 'Сайт', updated: '2026-01-01T00:00:00Z' });
    const fresh = addLead(t.db, { assigned: 3, name: 'Звонок' });   // updated most recently -> processed first by step A
    addLine(t.db, fresh, { svc: 30, day: D3, doctor: null });      // wish without doctor (plain «Сохранить», API request card…)
    addLine(t.db, old, { svc: 30, day: D3, doctor: 10 });          // the same consultation with the doctor
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v = b.json.data.visit.id;
    console.log('R4-M1 visit lines:', JSON.stringify(vsAll(t, v)));
    assert.equal(vsAll(t, v).filter((x) => x.service_id === 30).length, 1, 'two consultation lines in one visit');
    assert.equal(await billOf(t, v), 100000);
  } finally { t.close(); }
});

// D1 — the 409 door: bulk update by request_id (bulkBy) and upsert.
test('CRM_ONE_WAY_V1 (повтор r4) — R4-D1: /api/db bulk update (by request_id) cannot move a booked line; upsert by id cannot either', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const lid = addLine(t.db, rid, { svc: 30, day: D3, doctor: 10 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const was = lineOf(t, lid);
    assert.ok(was.visit_service_id);
    const before = money(t);
    const bulk = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { scheduled_date: D5 }, filters: [{ col: 'request_id', op: 'eq', val: rid }, { col: 'status', op: 'eq', val: 'pending' }] });
    console.log('R4-D1 bulk:', bulk.status, bulk.text.slice(0, 160));
    const up = await t.dbq('cc', { table: 'crm_request_services', op: 'upsert', values: { id: lid, request_id: rid, service_id: 30, scheduled_date: D5, status: 'pending', doctor_id: 11 } });
    console.log('R4-D1 upsert:', up.status, up.text.slice(0, 160));
    assert.deepEqual(lineOf(t, lid), was, 'booked line moved by a door other than the guarded update');
    assert.deepEqual(money(t), before);
  } finally { t.close(); }
});

// S — sequences (expected safe): move day, move doctor, cancel, restore with a new day+doctor in one call.
test('CRM_ONE_WAY_V1 (повтор r4) — R4-S1: cc booking (consult + analysis) — move day, move doctor, cancel, restore on another day with another doctor — 2 lines, billed once, card points at them', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const l1 = addLine(t.db, rid, { svc: 30, day: D3, doctor: 10 });
    const l2 = addLine(t.db, rid, { svc: 40, day: D3 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    const v = b.json.data.visit.id;
    const ids0 = vsAll(t, v).map((x) => x.id);
    assert.equal(ids0.length, 2);
    let r = await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(D5, 10) });
    assert.equal(r.status, 200, r.text);
    r = await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(D5, 10), doctor_id: 11 });
    assert.equal(r.status, 200, r.text);
    assert.equal((await cancel(t, v, D5, 10)).status, 200);
    const D6 = localDay(6);
    r = await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(D6, 9), doctor_id: 10, status: 'scheduled' });
    assert.equal(r.status, 200, r.text);
    const lines = vsAll(t, v);
    console.log('R4-S1 lines:', JSON.stringify(lines), 'card:', JSON.stringify([lineOf(t, l1), lineOf(t, l2)].map((l) => [l.service_id, l.scheduled_date, l.doctor_id, l.visit_id, l.visit_service_id, l.released_from_visit_id])));
    assert.deepEqual(lines.map((x) => x.id), ids0, 'visit lines changed');
    assert.deepEqual([lineOf(t, l1), lineOf(t, l2)].map((l) => [l.visit_id, l.visit_service_id, l.scheduled_date]), [[v, ids0[0], D6], [v, ids0[1], D6]]);
    const total = await billOf(t, v);
    assert.equal(total, 140000);
  } finally { t.close(); }
});
