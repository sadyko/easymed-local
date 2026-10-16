// CRM_LINK_ALL_V1 — scenarios added by the plan docs/plans/2026-10-16-crm-link-all.md
// (appended to SCENARIOS from scenarios-789.mjs). They have no frozen «today's
// behaviour» cell: their expectation lives only in DECIDED (matrix.test.mjs).
import {
  TODAY, PID, nowIso, TODAY_SLOT, calendarPickerBook, invoiceAndPay,
  seedS1, seedS2, seedS3, seedPhoneCard, wizardRegister, createPatient,
} from './helpers.mjs';
import { SCENARIOS } from './scenarios-789.mjs';

const add = (id, door, state, who, desc, run, gap = null) => SCENARIOS.push({ id, door, state, who, desc, run, gap });
const pickCard = (t, pid = PID) => { const c = t.db.prepare('SELECT id FROM crm_requests WHERE patient_id = ? ORDER BY id DESC').get(pid); return c ? c.id : null; };

// ─── Task 5 — R3 (D2): the wizard's «now» registration is a desk arrival ─────
// «now» = live-queue / no-slot mode: ensure_visit WITHOUT book, desk: true (visit-wizard.js createVisit).
const st = {
  S1: (t) => ({ rid: seedS1(t) }),
  S2: async (t) => seedS2(t),
  S3: (t) => ({ rid: seedS3(t) }),
  S4: () => ({ rid: null }),
  S1p: (t) => ({ rid: seedS1(t, { patient: null }) }),
};
for (const [state, seed] of Object.entries(st)) {
  add(`4-now-${state}`, 4, state, 'reg', 'wizard TODAY «now» (no slot / live queue) — desk arrival (R3)', async (t) => {
    const s = await seed(t);
    const { vid } = await wizardRegister(t, 'reg', nowIso(), { book: false, desk: true });
    return { ...s, rid: s.rid || pickCard(t), vid };
  });
}
add('5-S1p-crm-wizard-now', 5, 'S1p', 'reg', 'QPM from the CRM card → convert → wizard TODAY «now» (R3)', async (t) => {
  const rid = seedPhoneCard(t);
  const pid = await createPatient(t, 'reg');
  const up = await t.dbq('reg', { table: 'crm_requests', op: 'update', values: { patient_id: pid }, filters: [{ col: 'id', op: 'eq', val: rid }] });
  if (up.status !== 200) throw new Error(up.text);
  const { vid } = await wizardRegister(t, 'reg', nowIso(), { pid, book: false, desk: true });
  return { rid, vid, pid };
});
add('7-wiz-S2T-now', 7, 'S2T', 'reg', 'call centre booked TODAY 23:00 from the card; the patient comes early — wizard «now» (R3)', async (t) => {
  const s = await seedS2(t, TODAY, { hour: 23 });
  const { vid } = await wizardRegister(t, 'reg', nowIso(), { book: false, desk: true });
  return { ...s, vid };
});

// ─── Task 7 — R7a: the screens register the booked row instead of inserting a second one ───
// CRM_LINK_ALL_V1 (R7a; редакция 2) — the call sequences of the NEW fast registration and wizard
// (views/booked-rows.js, walk-in-booking.js, visit-wizard.js): no second insert of a booked row.
const ok = (r, what) => { if (r.status !== 200) throw new Error(what + ': ' + r.text); return r.json.data; };
const bookedLine = (t, vid) => t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status = 'added' ORDER BY id").get(vid).id;
async function S2Tcal(t) {
  const rid = seedS1(t);
  const { vid } = await calendarPickerBook(t, 'cc', TODAY, { hour: 23 });
  return { rid, bid: vid };
}
add('7-fast-S2Tcal-r7a', 7, 'S2Tcal', 'reg', 'call centre booked TODAY in the calendar; NEW fast registration registers the «из записи» row (no insert, invoice on the booked line)', async (t) => {
  const s = await S2Tcal(t);
  const ev = ok(await t.rpc('ensure_visit', 'reg', { patient_id: PID, date: nowIso(), doctor_id: 10, visit_type: 'outpatient', referral_source_id: null, branch_id: 1, notes: null, desk: true }), 'ensure_visit desk');
  ok(await t.rpc('create_invoice_for_visit', 'reg', { visit_id: ev.visit.id, visit_service_ids: [bookedLine(t, s.bid)], discount_amount: 0, payer_id: null }), 'invoice');
  return { ...s, vid: ev.visit.id };
});
add('7-fast-S2Tcal-r7a-drop', 7, 'S2Tcal', 'reg', 'NEW fast registration: the registrar removes the booked row (booking_line_remove before ensure_visit) and registers a blood test instead', async (t) => {
  const s = await S2Tcal(t);
  ok(await t.rpc('booking_line_remove', 'reg', { visit_service_id: bookedLine(t, s.bid) }), 'booking_line_remove');
  const ev = ok(await t.rpc('ensure_visit', 'reg', { patient_id: PID, date: nowIso(), doctor_id: null, visit_type: 'outpatient', referral_source_id: null, branch_id: 1, notes: null, desk: true }), 'ensure_visit desk');
  const r = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
    values: { visit_id: ev.visit.id, service_id: 40, quantity: 1, unit_price: 40000, total: 40000, price_tier: 'primary', status: 'added' } });
  if (r.status !== 200) throw new Error(r.text);
  ok(await t.rpc('create_invoice_for_visit', 'reg', { visit_id: ev.visit.id, visit_service_ids: [r.json.data.id], discount_amount: 0, payer_id: null }), 'invoice');
  return { ...s, vid: ev.visit.id };
});
add('7-wiz-S2Tcal-r7a', 7, 'S2Tcal', 'reg', 'NEW wizard at the booked slot: the «из записи» line is not inserted again; paid', async (t) => {
  const s = await S2Tcal(t);
  const ev = ok(await t.rpc('ensure_visit', 'reg', { patient_id: PID, date: TODAY_SLOT(), doctor_id: 10, visit_type: 'outpatient', referral_source_id: null, branch_id: 1, notes: null,
    book: { doctor_id: 10, service_id: 30, start: TODAY_SLOT(), duration_minutes: 30 } }), 'ensure_visit');
  await invoiceAndPay(t, 'reg', ev.visit.id, [bookedLine(t, s.bid)]);
  return { ...s, vid: ev.visit.id };
});

export { SCENARIOS };
