// CRM_ONE_WAY_V1 (O10) — повторы ревью раунда 3, воронка (scratchpad crm-link-review/tree3/server/routes/
// zz-r3-funnel.test.js, заметки crm-link-review/r3/NOTES.md), перенесены настоящими тестами с прежними
// ожиданиями: след отмены (crm_booking_undo) — по записи, «живая запись» — ждёт пациента (сегодня или
// позже, без прихода), триггер мигр. 246 снят (привязки при смене пациента не теряются).
// TRIG-b (стоимость триггера на 200 000 визитов) — устарел: триггера больше нет (мигр. 246 переписана).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, calendarBook, callcenterBook } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const D3 = localDay(3);
const D7 = localDay(7);
const D10 = localDay(10);
const mark = (t, vid, day, hour, status, who = 'reg') => t.rpc('calendar_book', who, { visit_id: vid, start: at(day, hour), status });
const displayCard = (t, { stale = false } = {}) => {
  const rid = addLead(t.db, { status: 'recall', date: D10, updated: daysAgoIso(stale ? 5 : 1), assigned: 3 });
  addLine(t.db, rid, { svc: 40, day: localDay(12) });
  return rid;
};
const st = (t, rid) => { const r = t.lead(rid); return [r.status, r.scheduled_date]; };

// G1a — human moved the card while booking 1 was live; booking 1 cancelled (trail not spent because
// the card is no longer in the stage the booking set); booking 2 (C') the same day; booking 2 cancelled
// -> the card must come back to where the HUMAN put it (state before booking 2), not to the state before booking 1.
test('CRM_ONE_WAY_V1 (повтор R3-G1a): rebook after a human move, cancel — card returns to the human\'s stage, not the pre-booking-1 stage', async () => {
  const t = await startCrmApp();
  try {
    const rid = displayCard(t);
    const v1 = await calendarBook(t, 'reg', D3);
    assert.deepEqual(link(t, v1), { request_id: rid, source: 'patient' });
    assert.deepEqual(st(t, rid), ['scheduled', D3]);
    // operator moves the card by hand to «В обработке» (patient hesitates)
    const up = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { status: 'in_process' }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(up.status, 200, up.text);
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    assert.equal(t.lead(rid).status, 'in_process', 'cancel 1 overwrote the human move');
    const v2 = await calendarBook(t, 'reg', D7, { hour: 15 });
    assert.equal(link(t, v2) && link(t, v2).source, 'patient');
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.equal((await mark(t, v2, D7, 15, 'cancelled')).status, 200);
    assert.equal(t.lead(rid).status, 'in_process', 'cancel 2 restored the stage from BEFORE booking 1 (human move lost): ' + JSON.stringify(st(t, rid)));
  } finally { t.close(); }
});

// G1b — booking 1 (C') missed (no_show), card «Не пришёл»; rebook (C', card stale -> reopen);
// rebook cancelled -> card must not jump back over the no-show to the pre-booking-1 stage/date.
test('CRM_ONE_WAY_V1 (повтор R3-G1b): no-show then rebook (C\') then cancel — the no-show fact is not erased by the stale trail of booking 1', async () => {
  const t = await startCrmApp();
  try {
    const rid = displayCard(t);
    const v1 = await calendarBook(t, 'reg', TODAY, { hour: 8 });
    assert.deepEqual(link(t, v1), { request_id: rid, source: 'patient' });
    assert.equal((await mark(t, v1, TODAY, 8, 'no_show')).status, 200);
    assert.equal(t.lead(rid).status, 'no_show');
    t.db.prepare('UPDATE crm_requests SET updated_at = ? WHERE id = ?').run(daysAgoIso(5), rid);   // card untouched for 5 days
    const v2 = await calendarBook(t, 'reg', D3, { hour: 15 });
    assert.equal(link(t, v2) && link(t, v2).source, 'patient');
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.equal((await mark(t, v2, D3, 15, 'cancelled')).status, 200);
    assert.notDeepEqual(st(t, rid), ['recall', D10], 'cancel of booking 2 restored the state before booking 1 (no-show erased)');
  } finally { t.close(); }
});

// G1c — trail survives a whole cycle: booking 1 arrived (card «Пришёл»), human re-opens the card with a
// new follow-up date, books the follow-up (C'), cancels it -> the card should get the human's date back.
test('CRM_ONE_WAY_V1 (повтор R3-G1c): arrived cycle, human reopen with new date, follow-up booked and cancelled — human date restored', async () => {
  const t = await startCrmApp();
  try {
    const rid = displayCard(t);
    const v1 = await calendarBook(t, 'reg', TODAY, { hour: 8 });
    assert.equal(link(t, v1) && link(t, v1).source, 'patient');
    assert.equal((await mark(t, v1, TODAY, 8, 'arrived')).status, 200);
    assert.equal(t.lead(rid).status, 'came');
    const D20 = localDay(20);
    const up = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { status: 'recall', scheduled_date: D20 }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(up.status, 200, up.text);
    const v2 = await calendarBook(t, 'reg', D7, { hour: 15 });
    assert.equal(link(t, v2) && link(t, v2).source, 'patient');
    assert.equal((await mark(t, v2, D7, 15, 'cancelled')).status, 200);
    assert.deepEqual(st(t, rid), ['recall', D20], 'cancel restored the trail of the ARRIVED booking 1');
  } finally { t.close(); }
});

// TRIG-a — operator re-links the card to the wrong patient and back (misclick) — display link to the live
// C' booking is gone for good; cancelling that booking must still bring the card back (not stuck «Записан»).
test('CRM_ONE_WAY_V1 (повтор R3-TRIG-a): patient 77 -> 78 -> 77 (misclick) — cancel of the C\' booking still returns the card', async () => {
  const t = await startCrmApp((db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78, 'Другой', '+998 90 111 22 33')").run());
  try {
    const rid = displayCard(t);
    const v1 = await calendarBook(t, 'reg', D3);
    assert.equal(link(t, v1) && link(t, v1).source, 'patient');
    const set = (pid) => t.dbq('cc', { table: 'crm_requests', op: 'update', values: { patient_id: pid }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal((await set(78)).status, 200);
    assert.equal((await set(77)).status, 200);
    assert.equal(t.lead(rid).patient_id, 77);
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    assert.notEqual(t.lead(rid).status, 'scheduled', 'card stuck «Записан» on a cancelled booking after 77->78->77: ' + JSON.stringify(st(t, rid)));
  } finally { t.close(); }
});

// G1d/G1e — on the live DB nobody marks «Пришёл»/«Не пришёл» in the calendar (visit-status.js header: all 390
// visits 'scheduled'), and the no-show sweep moves the CARD only. A missed booking 5 days ago therefore stays
// 'scheduled' for ever. The card was swept to «Не пришёл», rebooked, and the rebooking is cancelled:
// the card must not stay «Записан» on the cancelled day with no live booking.
const pastVisit = (t, rid, source) => {
  const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (77, 10, ?, 'scheduled')").run(at(localDay(-5), 12)).lastInsertRowid);
  if (source) t.db.prepare('INSERT INTO crm_booking_links (visit_id, request_id, source, created_request) VALUES (?, ?, ?, 0)').run(vid, rid, source);
  return vid;
};
test('CRM_ONE_WAY_V1 (повтор R3-G1d): card swept to «Не пришёл» (old C\' visit still scheduled), rebooked (C\'), rebooking cancelled — card not stuck «Записан»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'no_show', date: localDay(-5), updated: daysAgoIso(5), assigned: 3 });
    pastVisit(t, rid, 'patient');
    const v2 = await calendarBook(t, 'reg', D3, { hour: 15 });
    assert.equal(link(t, v2) && link(t, v2).source, 'patient');
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.equal((await mark(t, v2, D3, 15, 'cancelled')).status, 200);
    assert.notDeepEqual(st(t, rid), ['scheduled', D3], 'card «Записан» on the cancelled day, no live booking');
  } finally { t.close(); }
});
test('CRM_ONE_WAY_V1 (повтор R3-G1e): call-centre card, old missed booking still scheduled, operator rebooks from the card, rebooking cancelled — card not stuck «Записан»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'no_show', date: localDay(-5), updated: daysAgoIso(5), assigned: 3 });
    pastVisit(t, rid, 'callcenter');
    const v2 = await callcenterBook(t, D3, { svc: 30, doctor: 10 });
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.equal((await mark(t, v2, D3, 12, 'cancelled')).status, 200);
    assert.notEqual(t.lead(rid).status, 'scheduled', 'card «Записан» with no live booking: ' + JSON.stringify(st(t, rid)));
  } finally { t.close(); }
});

// TRIG-c — patient merge (drop 77 into keep 76): the C' display link to 77's visit must survive (visits move first).
test('CRM_ONE_WAY_V1 (повтор R3-TRIG-c): patient merge keeps the card\'s display link; cancel still returns the card', async () => {
  const { mergeRows } = await import('../services/rpc/patient-merge.js');
  const t = await startCrmApp((db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (76, 'Пациент Тест', '+998 90 909 26 39')").run());
  try {
    const rid = displayCard(t);
    const v1 = await calendarBook(t, 'reg', D3);
    assert.equal(link(t, v1) && link(t, v1).source, 'patient');
    t.db.transaction(() => mergeRows(t.db, 76, 77))();
    assert.equal(t.lead(rid).patient_id, 76);
    assert.deepEqual(link(t, v1), { request_id: rid, source: 'patient' }, 'merge dropped the display link');
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    assert.deepEqual(st(t, rid), ['recall', D10]);
  } finally { t.close(); }
});

// CRM_ONE_WAY_V1 (O10) — ПРИВАТНОСТЬ ПРИ ЧТЕНИИ: триггер мигр. 246 снят, привязки при смене пациента
// карточки остаются — и ни одно правило даты, «Отказа» и прохода «Не пришёл» не берёт визит чужого пациента.
test('CRM_ONE_WAY_V1 (O10): карточку перевели на пациента 78 — перенос, «Отказ» и дата карточки визиты пациента 77 не видят', async () => {
  const { cardDateOf } = await import('../services/crm/booking-mirror.js');
  const t = await startCrmApp((db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78, 'Другой', '+998 90 111 22 33')").run());
  try {
    const rid = displayCard(t);
    const v1 = await calendarBook(t, 'reg', D3);
    assert.deepEqual(link(t, v1), { request_id: rid, source: 'patient' });
    const vcc = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 3)").run(at(D7, 10)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'callcenter')").run(vcc, rid);
    const up = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { patient_id: 78 }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(up.status, 200, up.text);
    const before = t.lead(rid).scheduled_date;
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v1, start: at(localDay(4), 12) })).status, 200);
    assert.equal(t.lead(rid).scheduled_date, before, 'перенос визита пациента 77 сдвинул дату карточки пациента 78');
    assert.equal(cardDateOf(t.db, rid, 'fallback'), localDay(12), 'дату карточки 78 дала запись пациента 77, а не её собственное желание');
    const stop = await t.dbq('boss', { table: 'crm_requests', op: 'update', values: { status: 'stopped' }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(stop.status, 200, stop.text);
    assert.equal(t.db.prepare('SELECT status FROM visits WHERE id = ?').get(vcc).status, 'scheduled', '«Отказ» карточки 78 отменил запись пациента 77');
  } finally { t.close(); }
});
