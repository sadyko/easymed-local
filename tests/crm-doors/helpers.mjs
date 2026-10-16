// CRM doors evidence matrix — shared helpers (CRM_LINK_ALL_V1 acceptance test, frozen 2026-10-16).
// Imports the repo's own test stand by absolute file:// URL; bare imports inside
// the repo then resolve from the repo's node_modules.
//
// REPO_URL may point at another tree (e.g. an export of an older commit).
import assert from 'node:assert/strict';

// CRM_LINK_ALL_V1 — the matrix lives in the repo now: by default it tests the tree it sits in.
export const REPO = process.env.REPO_URL || new URL('../../', import.meta.url).href;
const H = await import(REPO + 'server/test-helpers/crm-unify-app.js');
export const { localDay, at, daysAgoIso } = H;

export const TODAY = localDay(0);
export const D = localDay(3);          // S2 booked day (future)
export const D2 = localDay(5);         // a second future day (reschedule / wizard future)
export const PID = 77;                  // patient of the stand ('Пациент Тест', +998 90 909 26 38)
export const nowIso = () => new Date().toISOString();
/** A slot later today (local 23:00) — far enough from "now" for a test run. */
export const TODAY_SLOT = () => at(TODAY, 23, 0);

/** The stand: real DB (all migrations) + real app + logins per role (crm-unify-app.js),
 *  plus a consultation type for «Повторный визит». */
export async function start() {
  return H.startCrmApp((db) => {
    db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active) VALUES (5,'Повторный','Повторный приём',80000,1)").run();
  });
}

// ─── States ────────────────────────────────────────────────────────────────
/** S1 — open card from an INCOMING CALL within 72h: no date, no lines, nobody
 *  assigned, no creator — the columns leadFromCall writes (lead-from-call.js:163).
 *  patient: 77 (known caller) or null (unknown number — the card has the phone only). */
export function seedS1(t, { patient = PID } = {}) {
  return Number(t.db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, patient_id, call_id)
                              VALUES (?, ?, 'telephony', 'in_process', ?, NULL)`)
    .run(patient ? 'Пациент Тест' : '+998 90 909 26 38', '+998 90 909 26 38', patient).lastInsertRowid);
}
/** S3 — open call card whose last activity is 5 days old (outside the 72h window). */
export function seedS3(t, opts = {}) {
  const id = seedS1(t, opts);
  const old = daysAgoIso(5);
  t.db.prepare('UPDATE crm_requests SET created_at = ?, updated_at = ? WHERE id = ?').run(old, old, id);
  return id;
}
/** S2 — S1 card, then the operator books it from the card (door 1) for `day`
 *  with a doctor service (consultation 30 at Ivanov 10). */
export async function seedS2(t, day = D, { who = 'cc', hour = 10 } = {}) {
  const rid = seedS1(t);
  const out = await crmCardBook(t, rid, day, who, { hour });
  return { rid, bid: out.vid };
}

// ─── Doors ────────────────────────────────────────────────────────────────
const ok = (r, what) => { assert.equal(r.status, 200, what + ': ' + r.text); return r.json.data; };

/** DOOR 1 — CRM card «Даты приёма» → «Сохранить и записать» (crm.js:3004).
 *   1. persist(): /api/db UPDATE crm_requests {…, patient_id, scheduled_date: primaryDate(),
 *      status: BOOKED_STATUS if the card stands before «Записан»} .eq(id)        — crm.js:2389, 2394
 *      (new card: INSERT crm_requests {…, status: BOOKED_STATUS})                — crm.js:2411
 *   2. saveLines(): /api/db INSERT crm_request_services [{request_id, service_id, scheduled_date,
 *      doctor_id, status:'pending'}]                                             — crm.js:2494
 *   3. bookDays(): rpc ensure_visit {patient_id, date: start_iso, doctor_id,
 *      book:{doctor_id, service_id, start: start_iso, duration_minutes}}        — crm.js:2831-2847
 *   4. /api/db UPDATE crm_request_services {visit_id} .eq(request_id).eq(scheduled_date, day)
 *      .eq(status,'pending')                                                     — crm.js:2920 */
export async function crmCardBook(t, rid, day, who = 'cc', { hour = 10, svc = 30, doctor = 10, pid = PID, cardDate = day } = {}) {
  if (!rid) {
    const ins = ok(await t.dbq(who, { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
      values: { full_name: 'Пациент Тест', phone: '+998 90 909 26 38', source: 'call', patient_id: pid, scheduled_date: day, status: 'scheduled' } }), 'crm_requests insert');
    rid = ins.id;
  } else {
    const c = card(t, rid);
    const before = ['in_process', 'recall'].includes(c.status);
    ok(await t.dbq(who, { table: 'crm_requests', op: 'update',
      values: { full_name: c.full_name, phone: c.phone, patient_id: pid, scheduled_date: cardDate, ...(before ? { status: 'scheduled' } : {}) },
      filters: [{ col: 'id', op: 'eq', val: rid }] }), 'crm_requests update');
  }
  ok(await t.dbq(who, { table: 'crm_request_services', op: 'insert',
    values: [{ request_id: rid, service_id: svc, scheduled_date: day, doctor_id: doctor, status: 'pending' }] }), 'crm line insert');
  const b = ok(await t.rpc('ensure_visit', who, { patient_id: pid, date: at(day, hour), doctor_id: doctor,
    book: { doctor_id: doctor, service_id: svc, start: at(day, hour), duration_minutes: 30 } }), 'ensure_visit book');
  const vid = b.visit.id;
  // crm.js:2887 — day_visit_busy: the day counts as failed, the lines are NOT linked.
  if (b.booked !== false) {
    ok(await t.dbq(who, { table: 'crm_request_services', op: 'update', values: { visit_id: vid },
      filters: [{ col: 'request_id', op: 'eq', val: rid }, { col: 'scheduled_date', op: 'eq', val: day }, { col: 'status', op: 'eq', val: 'pending' }] }), 'line→visit');
  }
  return { rid, vid, booked: b.booked, reason: b.reason || null };
}

/** DOOR 2 — calendar empty slot → service picker → save (room-calendar.js:693 bookAt →
 *  service-picker-modal.js:3014 wizSave):
 *   1. rpc calendar_book {patient_id, doctor_id, service_id, start, duration_minutes, status:'scheduled'}
 *      (spm.js:3065 via calendarBookOrAsk :3637; day_visit_busy → confirm → same call with
 *      add_to_day_visit:true :3646)
 *   2a. callcenter (no VISIT_LINE_ROLES): rpc booking_lines_add {visit_id, patient_id,
 *       lines:[{service_id, doctor_id, scheduled_at}]}                            — spm.js:3102
 *   2b. admin/registrar/doctor: /api/db INSERT visit_services {visit_id, service_id, doctor_id,
 *       quantity:1, unit_price, total, scheduled_at, price_tier}                 — spm.js:3128 */
export async function calendarPickerBook(t, who, day, { hour = 12, svc = 30, doctor = 10, pid = PID } = {}) {
  const start = at(day, hour);
  const args = { patient_id: pid, doctor_id: doctor, service_id: svc, start, duration_minutes: 30, status: 'scheduled' };
  let r = await t.rpc('calendar_book', who, args);
  let addedToDay = false;
  if (r.status !== 200 && /day_visit_busy/.test(r.text)) {
    r = await t.rpc('calendar_book', who, { ...args, add_to_day_visit: true });
    addedToDay = true;
  }
  const vid = ok(r, 'calendar_book').visit.id;
  if (who === 'cc') {
    ok(await t.rpc('booking_lines_add', who, { visit_id: vid, patient_id: pid, lines: [{ service_id: svc, doctor_id: doctor, scheduled_at: start }] }), 'booking_lines_add');
  } else {
    await addVisitLine(t, who, vid, { svc, doctor, scheduledAt: start });
  }
  return { vid, addedToDay };
}

/** DOOR 4 — registration wizard createVisit (visit-wizard.js:2564):
 *   1. rpc ensure_visit {patient_id, date: ISO, doctor_id, visit_type:'outpatient',
 *      referral_source_id:null, branch_id, notes:null, [book:{doctor_id, service_id, start,
 *      duration_minutes}]} — NO desk                                              — visit-wizard.js:2686-2695
 *   2. /api/db INSERT visit_services {visit_id, service_id, quantity, unit_price, total,
 *      status:'added', price_tier, doctor_id, scheduled_at}                        — visit-wizard.js:2773
 *   3. (pay now) rpc create_invoice_for_visit {visit_id, visit_service_ids, discount_amount, payer_id:null}
 *      — visit-wizard.js:2809; cash is then taken at the cashier: record_payment (cashier-desk.js:1961) */
export async function wizardRegister(t, who, whenIso, { book = true, pay = false, svc = 30, doctor = 10, pid = PID } = {}) {
  const ev = ok(await t.rpc('ensure_visit', who, { patient_id: pid, date: whenIso, doctor_id: doctor, visit_type: 'outpatient',
    referral_source_id: null, branch_id: 1, notes: null,
    ...(book ? { book: { doctor_id: doctor, service_id: svc, start: whenIso, duration_minutes: 30 } } : {}) }), 'ensure_visit');
  const vid = ev.visit.id;
  const vsId = await addVisitLine(t, who, vid, { svc, doctor, scheduledAt: book ? whenIso : null, status: true });
  if (pay) await invoiceAndPay(t, who, vid, [vsId]);
  return { vid, ev };
}

/** DOOR 6 — «Повторный визит» (service-workspace.js:1425 openRevisitModal → :1576 bookVisit):
 *   1. rpc calendar_book {patient_id, doctor_id, service_id:null, start, duration_minutes, status:'scheduled', notes}
 *      (day_visit_busy → add_to_day_visit:true, spm.js:3646)
 *   2. /api/db UPDATE visits {visit_kind:'repeat'} .eq(id)                        — service-workspace.js:1590
 *   3. /api/db INSERT visit_services {visit_id, consultation_type_id, service_id:null, doctor_id,
 *      quantity:1, unit_price, total}                                            — service-workspace.js:1594 */
export async function repeatVisit(t, who, day, { hour = 15, doctor = 10, pid = PID } = {}) {
  const args = { patient_id: pid, doctor_id: doctor, service_id: null, start: at(day, hour), duration_minutes: 20, status: 'scheduled', notes: '' };
  let r = await t.rpc('calendar_book', who, args);
  if (r.status !== 200 && /day_visit_busy/.test(r.text)) r = await t.rpc('calendar_book', who, { ...args, add_to_day_visit: true });
  const vid = ok(r, 'calendar_book (revisit)').visit.id;
  ok(await t.dbq(who, { table: 'visits', op: 'update', values: { visit_kind: 'repeat' }, filters: [{ col: 'id', op: 'eq', val: vid }] }), 'visit_kind');
  ok(await t.dbq(who, { table: 'visit_services', op: 'insert', returning: true, single: 'single',
    values: { visit_id: vid, consultation_type_id: 5, service_id: null, doctor_id: doctor, quantity: 1, unit_price: 80000, total: 80000 } }), 'revisit line');
  return { vid };
}

/** Invoice + cash payment (create_invoice_for_visit, then record_payment at the cashier). */
export async function invoiceAndPay(t, who, vid, vsIds) {
  const inv = ok(await t.rpc('create_invoice_for_visit', who, { visit_id: vid, visit_service_ids: vsIds, discount_amount: 0, payer_id: null }), 'invoice').invoice;
  const due = t.db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(inv.id).total_amount;
  ok(await t.rpc('record_payment', 'kassa', { invoice_id: inv.id, amount: Number(due), method: 'cash' }), 'record_payment');
  return inv.id;
}

/** /api/db INSERT visit_services the way the desk screens do it. */
export async function addVisitLine(t, who, vid, { svc = 30, doctor = 10, price = null, scheduledAt = null, status = false } = {}) {
  const p = price ?? (t.db.prepare('SELECT price FROM services WHERE id = ?').get(svc) || {}).price ?? 0;
  const r = await t.dbq(who, { table: 'visit_services', op: 'insert', returning: true, single: 'single',
    values: { visit_id: vid, service_id: svc, doctor_id: doctor, quantity: 1, unit_price: p, total: p, price_tier: 'primary',
      ...(scheduledAt ? { scheduled_at: scheduledAt } : {}), ...(status ? { status: 'added' } : {}) } });
  assert.equal(r.status, 200, 'visit_services insert: ' + r.text);
  return r.json.data && r.json.data.id;
}

// ─── Observations ─────────────────────────────────────────────────────────
export const card = (t, id) => t.db.prepare('SELECT * FROM crm_requests WHERE id = ?').get(id);
export const cardsOf = (t, pid = PID) => t.db.prepare('SELECT id, status, scheduled_date, source FROM crm_requests WHERE patient_id = ? ORDER BY id').all(pid);
export const visitsOf = (t, pid = PID) => t.db.prepare(`SELECT id, status FROM visits
                                                         WHERE patient_id = ? AND status NOT IN ('cancelled','no_show') ORDER BY id`).all(pid);
export const vsOf = (t, vid) => t.db.prepare(`SELECT id, service_id, consultation_type_id, status FROM visit_services
                                               WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id`).all(vid);

/** Compact, id-free record of a cell.
 *   stage/date — the card; lines — what the card shows: 'svc@day:status/visit'
 *   (day T=today, D, D2; visit V = this door's visit, B = the S2 booking);
 *   link — crm_booking_links of V → 'card' | 'other' | 'none';
 *   cards/visits — counts for the patient (live visits); vs — services in V. */
export function cell(t, rid, { vid = null, bid = null, pid = PID } = {}) {
  const dayTag = (d) => (!d ? '-' : d === TODAY ? 'T' : d === D ? 'D' : d === D2 ? 'D2' : d);
  const vTag = (v) => (!v ? '' : v === vid ? '/V' : v === bid ? '/B' : '/v' + v);
  const c = rid ? card(t, rid) : null;
  const ls = rid ? t.db.prepare(`SELECT service_id, consultation_type_id, scheduled_date, status, visit_id FROM crm_request_services
                                  WHERE request_id = ? AND status <> 'cancelled' ORDER BY id`).all(rid) : [];
  const links = vid ? t.db.prepare('SELECT request_id FROM crm_booking_links WHERE visit_id = ?').all(vid) : [];
  return {
    stage: c ? c.status : null,
    date: c ? dayTag(c.scheduled_date) : null,
    lines: ls.map((l) => `${l.service_id ?? 'c' + l.consultation_type_id}@${dayTag(l.scheduled_date)}:${l.status}${vTag(l.visit_id)}`),
    link: !links.length ? 'none' : links.some((l) => l.request_id === rid) ? 'card' : 'other',
    cards: cardsOf(t, pid).length,
    visits: visitsOf(t, pid).length,
    vs: vid ? vsOf(t, vid).map((x) => x.service_id ?? 'c' + x.consultation_type_id) : [],
  };
}

/** DOOR 3 — fast registration registerWalkIn (walk-in-booking.js:185-333), every sub-path ends here:
 *   1. rpc ensure_visit {patient_id, date: now ISO, doctor_id: first line's doctor, visit_type:'outpatient',
 *      referral_source_id, branch_id, notes:null, desk:true} — no book            — walk-in-booking.js:212-224
 *   2. rpc service_price_quote (read)                                             — walk-in-booking.js:247
 *   3. /api/db INSERT visit_services {visit_id, service_id, quantity:1, unit_price, total,
 *      status:'added', price_tier, doctor_id} per line                           — walk-in-booking.js:267-283
 *   4. rpc create_invoice_for_visit {visit_id, visit_service_ids, discount_amount:0, payer_id:null}
 *                                                                                 — walk-in-booking.js:291-296
 *   (issue_queue_numbers follows; cash is taken at the cashier — record_payment.) */
export async function fastRegister(t, who = 'reg', { pid = PID, items = [{ svc: 30, doctor: 10 }], pay = false } = {}) {
  const head = items.find((l) => l.doctor) || null;
  const ev = ok(await t.rpc('ensure_visit', who, { patient_id: pid, date: nowIso(), doctor_id: head ? head.doctor : null,
    visit_type: 'outpatient', referral_source_id: null, branch_id: 1, notes: null, desk: true }), 'ensure_visit desk');
  const vid = ev.visit.id;
  const ids = [];
  for (const it of items) ids.push(await addVisitLine(t, who, vid, { svc: it.svc, doctor: it.doctor || null, status: true }));
  const inv = ok(await t.rpc('create_invoice_for_visit', who, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null }), 'invoice').invoice;
  if (pay) {
    const due = t.db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(inv.id).total_amount;
    ok(await t.rpc('record_payment', 'kassa', { invoice_id: inv.id, amount: Number(due), method: 'cash' }), 'record_payment');
  }
  return { vid, created: ev.created, invoiceId: inv.id };
}

/** NEW PATIENT (fast registration (a) and the quick-patient window): savePatient →
 *  /api/db INSERT patients … .select().single() (data.js:564), then rpc crm_link_new_patient
 *  {patient_id} (data.js:583). The duplicate check (data.js:611-682) is reads only. */
export const NEW_PHONE = '+998 91 123 45 67';
export async function createPatient(t, who = 'reg', { phone = NEW_PHONE, last = 'Новиков', first = 'Пётр' } = {}) {
  const p = ok(await t.dbq(who, { table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { last_name: last, first_name: first, full_name: `${last} ${first}`, phone, branch_id: 1 } }), 'patients insert');
  ok(await t.rpc('crm_link_new_patient', who, { patient_id: p.id }), 'crm_link_new_patient');
  return p.id;
}
/** An unknown caller's card: phone only (no patient yet), S1 / S3 age. */
export function seedPhoneCard(t, { phone = NEW_PHONE, old = false } = {}) {
  const id = Number(t.db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, patient_id)
                                  VALUES (?, ?, 'telephony', 'in_process', NULL)`).run(phone, phone).lastInsertRowid);
  if (old) { const o = daysAgoIso(5); t.db.prepare('UPDATE crm_requests SET created_at = ?, updated_at = ? WHERE id = ?').run(o, o, id); }
  return id;
}
