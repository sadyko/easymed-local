// Doors 7–9 (appended to SCENARIOS from scenarios.mjs).
import {
  TODAY, D, D2, PID, at, TODAY_SLOT,
  seedS1, seedS2, calendarPickerBook, fastRegister, wizardRegister, invoiceAndPay,
} from './helpers.mjs';
import { SCENARIOS, DESK_NO_LINES, WIZ_NO_DESK } from './scenarios.mjs';

const add = (id, door, state, who, desc, run, gap = null) => SCENARIOS.push({ id, door, state, who, desc, run, gap });

// ─── DOOR 7 — call-centre booking for TODAY, then registration ───────────────
const S2T = (t) => seedS2(t, TODAY, { hour: 23 });   // booked from the card (mirror line, visit_service_auto = 1)
async function S2Tcal(t) {                              // booked by the call centre in the calendar (booking_lines_add, auto = 0)
  const rid = seedS1(t);
  const { vid } = await calendarPickerBook(t, 'cc', TODAY, { hour: 23 });
  return { rid, bid: vid };
}
const TWIN = 'booking_lines_add lines are not mirror lines (insertBookingLine, booking-lines.js:112; the mirror links them auto=0) → autoLineFor/yieldAutoLine (booking-mirror.js:591-596/603, visit_service_auto = 1 only; pruneAutoLinesOnInvoice :791-797 likewise) never lets the registrar line replace them → the visit holds the consultation twice';

add('7-fast-S2T-same', 7, 'S2T', 'reg', 'fast registration; the registrar picks the booked consultation 30/Ivanov', async (t) => {
  const s = await S2T(t);
  const { vid } = await fastRegister(t, 'reg');
  return { ...s, vid };
});
add('7-fast-S2T-other', 7, 'S2T', 'reg', 'fast registration; the registrar adds a different service (blood test 40)', async (t) => {
  const s = await S2T(t);
  const { vid } = await fastRegister(t, 'reg', { items: [{ svc: 40 }] });
  return { ...s, vid };
}, { reason: DESK_NO_LINES, expect: 'lines' });
add('7-fast-S2Tcal-same', 7, 'S2Tcal', 'reg', 'call centre booked TODAY in the calendar (booking_lines_add); fast registration picks the same consultation', async (t) => {
  const s = await S2Tcal(t);
  const { vid } = await fastRegister(t, 'reg');
  return { ...s, vid };
}, { reason: TWIN, expect: 'nodup' });
add('7-wiz-S2T-same', 7, 'S2T', 'reg', 'wizard TODAY at the booked slot (prefilled CRM line 30/Ivanov), no payment', async (t) => {
  const s = await S2T(t);
  const { vid } = await wizardRegister(t, 'reg', TODAY_SLOT());
  return { ...s, vid };
}, { reason: WIZ_NO_DESK, expect: 'came' });
add('7-wiz-S2T-same-pay', 7, 'S2T', 'reg', 'wizard TODAY at the booked slot + invoice + cash', async (t) => {
  const s = await S2T(t);
  const { vid } = await wizardRegister(t, 'reg', TODAY_SLOT(), { pay: true });
  return { ...s, vid };
});
add('7-wiz-S2T-earlier', 7, 'S2T', 'reg', 'wizard TODAY at an earlier time 22:00 (same doctor) — the booking is moved', async (t) => {
  const s = await S2T(t);
  const { vid } = await wizardRegister(t, 'reg', at(TODAY, 22));
  return { ...s, vid };
}, { reason: WIZ_NO_DESK, expect: 'came' });
add('7-wiz-S2Tcal-same', 7, 'S2Tcal', 'reg', 'call centre booked TODAY in the calendar; wizard at the same slot', async (t) => {
  const s = await S2Tcal(t);
  const { vid } = await wizardRegister(t, 'reg', TODAY_SLOT());
  return { ...s, vid };
}, { reason: TWIN, expect: 'nodup' });

// ─── DOOR 8 — calendar status marks / move / cancel (registrar) ──────────────
async function mark(t, vid, extra) {
  const v = t.db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(vid);
  const r = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: v.visit_date, ...extra });
  if (r.status !== 200) throw new Error(r.text);
}
add('8-S2-confirmed', 8, 'S2', 'reg', 'pill «Подтверждён» on the call-centre booking (D)', async (t) => {
  const s = await seedS2(t); await mark(t, s.bid, { status: 'confirmed' }); return { ...s, vid: s.bid };
}, { reason: "visit-status.js:238 crmVisitStatus returns for 'confirmed' (handles only arrived / no_show / cancelled); nothing maps it to the «Подтверждён» (approved) column", expect: 'approved' });
add('8-S2T-arrived', 8, 'S2T', 'reg', 'pill «Пришёл» on the call-centre booking for today', async (t) => {
  const s = await S2T(t); await mark(t, s.bid, { status: 'arrived' }); return { ...s, vid: s.bid };
});
add('8-S2-noshow', 8, 'S2', 'reg', 'pill «Не пришёл» on the booking', async (t) => {
  const s = await seedS2(t); await mark(t, s.bid, { status: 'no_show' }); return { ...s, vid: s.bid };
});
add('8-S2-move', 8, 'S2', 'reg', 'drag the booking from D to D2 11:00', async (t) => {
  const s = await seedS2(t);
  const r = await t.rpc('calendar_book', 'reg', { visit_id: s.bid, start: at(D2, 11) });
  if (r.status !== 200) throw new Error(r.text);
  return { ...s, vid: s.bid };
});
add('8-S2-cancel', 8, 'S2', 'reg', '«Отменить запись»', async (t) => {
  const s = await seedS2(t); await mark(t, s.bid, { status: 'cancelled' }); return { ...s, vid: s.bid };
});
add('8-S1cal-arrived', 8, 'S1', 'reg', 'registrar-booked calendar visit for TODAY of an S1 card (crm_booking_links) → «Пришёл»', async (t) => {
  const rid = seedS1(t);
  const { vid } = await calendarPickerBook(t, 'reg', TODAY, { hour: 23 });
  await mark(t, vid, { status: 'arrived' });
  return { rid, vid };
});
add('8-S1cal-cancel', 8, 'S1', 'reg', 'registrar-booked calendar visit for D of an S1 card → cancel', async (t) => {
  const rid = seedS1(t);
  const { vid } = await calendarPickerBook(t, 'reg', D);
  await mark(t, vid, { status: 'cancelled' });
  return { rid, vid };
});

// ─── DOOR 9 — cashier ─────────────────────────────────────────────────────────
const unbilled = (t, vid) => t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND invoice_item_id IS NULL AND status <> 'cancelled'").all(vid).map((r) => r.id);
add('9-S2T-pay', 9, 'S2T', 'kassa', '«Ждут счёта» → invoice → cash for the call-centre booking of today', async (t) => {
  const s = await S2T(t);
  await invoiceAndPay(t, 'kassa', s.bid, unbilled(t, s.bid));
  return { ...s, vid: s.bid };
});
add('9-S2-prepay', 9, 'S2', 'kassa', 'invoice → cash for the booking of a FUTURE day D (prepayment)', async (t) => {
  const s = await seedS2(t);
  await invoiceAndPay(t, 'kassa', s.bid, unbilled(t, s.bid));
  return { ...s, vid: s.bid };
});
add('9-S2T-addline', 9, 'S2T', 'boss', 'invoice, then «Исправить услуги» → cashier_line_add blood test 40 (admin: the cashier needs the cashier.lines grant), then cash', async (t) => {
  const s = await S2T(t);
  const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: s.bid, visit_service_ids: unbilled(t, s.bid), discount_amount: 0, payer_id: null });
  if (inv.status !== 200) throw new Error(inv.text);
  const invId = inv.json.data.invoice.id;
  const a = await t.rpc('cashier_line_add', 'boss', { invoice_id: invId, service_id: 40, doctor_id: null });
  if (a.status !== 200) throw new Error(a.text);
  const due = t.db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(invId).total_amount;
  const p = await t.rpc('record_payment', 'kassa', { invoice_id: invId, amount: Number(due), method: 'cash' });
  if (p.status !== 200) throw new Error(p.text);
  return { ...s, vid: s.bid };
});
add('9-S1cal-pay', 9, 'S1', 'kassa', 'registrar-booked calendar visit for TODAY of an S1 card, paid at the cashier', async (t) => {
  const rid = seedS1(t);
  const { vid } = await calendarPickerBook(t, 'reg', TODAY, { hour: 23 });
  await invoiceAndPay(t, 'kassa', vid, unbilled(t, vid));
  return { rid, vid };
});

export { SCENARIOS };
