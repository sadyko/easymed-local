// CRM_LINK_ALL_V1 (редакция 2б, 2026-10-16) — ПРАВИЛА ВОРОНКИ ПО РЕВЬЮ ЗАДАЧ 1–3
// (docs/specs/2026-10-16-crm-link-all-doors-design.md, «Revision 2b», P-1…P-6). Повторы ревью
// воронки (zz-funnel-a F1/F1b/F3, -c C1/C3, -d D1, -e E1, -api API-1) и денег (zz-money-phone
// P1/P2) — настоящими тестами.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, cardLines, addVisitLine, calendarBook, callcenterBook, deskRegister } from '../test-helpers/crm-link-all.js';
import { crmNoShowSweep, crmArrivalCatchUp } from '../services/crm/no-show.js';
import { bookingSeed, localAt, apptItem } from '../test-helpers/api-booking-seed.js';
import { ingestItem } from '../services/api/bookings.js';
import { syncVisitOutcomes } from '../services/api/visit-events.js';
import { calendarBook as calendarBookRpc } from '../services/rpc/calendar.js';

const TODAY = localDay(0);
const D3 = localDay(3);
const D7 = localDay(7);
const D10 = localDay(10);
const D12 = localDay(12);
const svcs = (t, vid) => vsOf(t, vid).map((x) => x.service_id);
const cancel = (t, who, vid, day, hour = 12) => t.rpc('calendar_book', who, { visit_id: vid, start: at(day, hour), status: 'cancelled' });

// ─── P-1 — карточки API идут только за своей записью ─────────────────────────────
const NOW = localAt('2030-03-11', '09:00');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);
async function partnerCallbackCard() {
  const s = bookingSeed();
  const r = await ingestItem(s.db, { ...apptItem({ connId: s.connId, publicId: 'rq_call0001', startMs: NOW, receivedMs: NOW }), type: 'request.new',
    data: { external_id: 'cb-1', service_id: 301 } }, { now: NOW });
  const card = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', r.id).c;
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const old = new Date(Date.now() - 5 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  s.db.prepare('UPDATE crm_requests SET patient_id = 1, updated_at = ?, created_at = ? WHERE id = ?').run(old, old, card);
  return { s, r, card };
}

test('CRM_LINK_ALL_V1 P-1 (ревью API-1): карточка заявки партнёра — своя запись врача её не берёт: партнёру не сообщается, отменить её партнёр не может', async () => {
  const { s, r, card } = await partnerCallbackCard();
  const doctor = { id: 7, role: 'doctor', extra_roles: [] };
  const b = await calendarBookRpc(s.db, { patient_id: 1, doctor_id: 7, service_id: 302, start: new Date(localAt('2030-03-20', '11:00')).toISOString(), duration_minutes: 20, status: 'scheduled' }, doctor);
  const vid = b.visit.id;
  assert.equal(one(s.db, 'SELECT request_id FROM crm_booking_links WHERE visit_id = ?', vid), undefined, 'запись врача привязана к карточке заявки партнёра');
  syncVisitOutcomes(s.db, { now: NOW, kekPath: s.kekPath });
  const row = one(s.db, 'SELECT status, visit_id FROM api_requests WHERE id = ?', r.id);
  assert.notEqual(row.visit_id, vid, 'заявка партнёра привязана к своему приёму врача');
  await ingestItem(s.db, { type: 'appointment.cancel', cursor: '9', public_id: 'rq_call0001', connection_id: s.connId }, { now: NOW + 60000, kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM visits WHERE id = ?', vid).status, 'scheduled', 'партнёр отменил приём врача');
  assert.ok(one(s.db, 'SELECT status FROM crm_requests WHERE id = ?', card));
});

test('CRM_LINK_ALL_V1 P-1: сверка исходов партнёра не видит привязок «только для воронки» (защита в глубину)', async () => {
  const { s, r, card } = await partnerCallbackCard();
  const vid = Number(s.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (1, 7, ?, 'scheduled')")
    .run(new Date(localAt('2030-03-20', '11:00')).toISOString()).lastInsertRowid);
  s.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'patient')").run(vid, card);
  syncVisitOutcomes(s.db, { now: NOW, kekPath: s.kekPath });
  const row = one(s.db, 'SELECT status, visit_id FROM api_requests WHERE id = ?', r.id);
  assert.notEqual(row.visit_id, vid, 'заявка партнёра привязана по привязке для воронки');
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM api_outbox WHERE event = 'appointment.created'").get().n, 0, 'партнёру ушло событие о чужой записи');
});

// ─── P-2 — звонок, приведший пациента, впереди старой карточки ───────────────────
test('CRM_LINK_ALL_V1 P-2 (ревью F1): стойка — свежий звонок без пациента (в окне) берёт приход, а не карточка тридцатидневной давности', async () => {
  const t = await startCrmApp();
  try {
    const stale = addLead(t.db, { status: 'in_process', updated: daysAgoIso(30), assigned: 4, name: 'Старая' });
    const phoneLead = addLead(t.db, { patient: null, phone: '909092638', name: '909092638', assigned: 3 });
    const { vid } = await deskRegister(t, 'reg');
    assert.equal(link(t, vid) && link(t, vid).request_id, phoneLead, 'визит взяла старая карточка, а не звонок, который привёл пациента');
    assert.equal(t.lead(phoneLead).status, 'came');
    assert.equal(t.lead(phoneLead).patient_id, 77);
    assert.equal(t.lead(stale).status, 'in_process', 'конверсию получила давняя карточка другого оператора');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 P-2 (ревью F1b): колл-центр в календаре — свой свежий звонок без пациента впереди давней карточки другого оператора', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, { status: 'in_process', updated: daysAgoIso(30), assigned: 4, name: 'Старая' });
    const phoneLead = addLead(t.db, { patient: null, phone: '909092638', name: '909092638', assigned: 3 });
    const vid = await callcenterBook(t, D3);
    assert.equal(link(t, vid) && link(t, vid).request_id, phoneLead, 'запись своего звонка ушла в давнюю карточку');
  } finally { t.close(); }
});

// ─── P-3 — отмена записи, привязанной для воронки, возвращает карточку ────────────
test('CRM_LINK_ALL_V1 P-3 (ревью F3): запись регистратуры и её отмена оставляют карточку как была — ступень, дата, без фантомной строки', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', date: D10, updated: daysAgoIso(1), assigned: 3 });
    addLine(t.db, rid, { svc: 40, day: D12 });
    const vid = await calendarBook(t, 'reg', D3);
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.equal((await cancel(t, 'reg', vid, D3)).status, 200);
    const L = t.lead(rid);
    assert.equal(L.status, 'recall', '«Перезвонить» потеряно');
    assert.equal(L.scheduled_date, D10, 'дата «Перезвонить» потеряна');
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.scheduled_date]), [[40, D12]], 'фантомная строка от отменённой записи');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 P-3: карточку после записи сдвинул оператор — отмена её не возвращает', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', date: D10, updated: daysAgoIso(1), assigned: 3 });
    const vid = await calendarBook(t, 'reg', D3);
    assert.equal(t.lead(rid).status, 'scheduled');
    t.db.prepare("UPDATE crm_requests SET status = 'approved' WHERE id = ?").run(rid);
    assert.equal((await cancel(t, 'reg', vid, D3)).status, 200);
    assert.equal(t.lead(rid).status, 'approved', 'отмена переписала ступень, которую поставил оператор');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 P-3: у карточки осталась другая живая запись — отмена одной её не возвращает', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', date: D10, updated: daysAgoIso(1), assigned: 3 });
    const v1 = await calendarBook(t, 'reg', D3);
    const v2 = await calendarBook(t, 'reg', D7, { hour: 15 });
    assert.notEqual(v1, v2);
    assert.equal((await cancel(t, 'reg', v1, D3)).status, 200);
    assert.equal(t.lead(rid).status, 'scheduled', 'карточка с другой записью вернулась в «Перезвонить»');
  } finally { t.close(); }
});

// ─── P-4 — «Не пришёл» только без других записей ───────────────────────────────
test('CRM_LINK_ALL_V1 P-4 (ревью D1): «Не пришёл» на записи регистратуры, взятой C′, не уносит карточку с живой записью колл-центра на следующей неделе', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    await callcenterBook(t, D7, { svc: 30, doctor: 10 });
    assert.equal(t.lead(rid).status, 'scheduled');
    const v0 = await calendarBook(t, 'reg', TODAY, { hour: 8, svc: 40, doctor: 10 });
    const ns = await t.rpc('calendar_book', 'reg', { visit_id: v0, start: at(TODAY, 8), status: 'no_show' });
    assert.equal(ns.status, 200, ns.text);
    assert.notEqual(t.lead(rid).status, 'no_show', 'карточка с живой записью на следующей неделе ушла в «Не пришёл»');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 P-4: единственная запись карточки — «Не пришёл» по-прежнему уносит её в «Не пришёл»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const v0 = await calendarBook(t, 'reg', TODAY, { hour: 8, svc: 40, doctor: 10 });
    assert.equal(link(t, v0).request_id, rid);
    const ns = await t.rpc('calendar_book', 'reg', { visit_id: v0, start: at(TODAY, 8), status: 'no_show' });
    assert.equal(ns.status, 200, ns.text);
    assert.equal(t.lead(rid).status, 'no_show');
  } finally { t.close(); }
});

// ─── P-5 — визит, на котором уже видно приход, — приход ─────────────────────────
test('CRM_LINK_ALL_V1 P-5 (ревью E1): пациент уже здесь и заплатил; мастер добавляет услугу — давняя карточка становится «Пришёл», а не «Записан»', async () => {
  const t = await startCrmApp();
  try {
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 2)").run(new Date(Date.now() - 2 * 3600e3).toISOString()).lastInsertRowid);
    const vs = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 30, 10, 1, 100000, 100000, 'added', 2)").run(vid).lastInsertRowid);
    const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: vid, visit_service_ids: [vs], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const pay = await t.rpc('record_payment', 'kassa', { invoice_id: inv.json.data.invoice.id, amount: 100000, method: 'cash' });
    assert.equal(pay.status, 200, pay.text);
    const rid = addLead(t.db, { status: 'recall', updated: daysAgoIso(14), assigned: 3 });
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    assert.equal(ev.json.data.visit.id, vid);
    await addVisitLine(t, 'reg', vid, { svc: 40, doctor: null });
    assert.equal(link(t, vid).request_id, rid);
    assert.equal(t.lead(rid).status, 'came', 'карточка «Записан» на визит, за который уже заплатили');
    crmArrivalCatchUp(t.db);
    crmNoShowSweep(t.db, { day: localDay(1) });
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

// ─── P-6 — строки карточки по телефону в этот визит не идут ──────────────────────
test('CRM_LINK_ALL_V1 P-6 (ревью денег P1): анализ карточки по телефону на сегодня не входит в визит пациента и на следующей двери (стойка)', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    addLine(t.db, rid, { svc: 40, day: TODAY });
    const vid = await calendarBook(t, 'reg', TODAY, { hour: 17 });
    assert.equal(link(t, vid).source, 'phone');
    assert.deepEqual(svcs(t, vid), [30]);
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    assert.equal(ev.status, 200, ev.text);
    assert.equal(ev.json.data.visit.id, vid);
    assert.deepEqual(svcs(t, vid), [30], 'анализ карточки по телефону ушёл в визит (счёт) на следующей двери');
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 P-6 (ревью денег P2): консультация без даты карточки по телефону не входит в визит и в мастере визита', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    addLine(t.db, rid, { svc: 30, day: null, doctor: 10 });
    const D = localDay(2);
    const vid = await calendarBook(t, 'reg', D, { hour: 9, svc: 40, doctor: null });
    assert.deepEqual(svcs(t, vid), [40]);
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: at(D, 9), visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    assert.deepEqual(svcs(t, vid), [40], 'консультация карточки по телефону ушла в визит');
    assert.ok(rid);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 P-6 (ревью воронки C1): колл-центр в календаре — своя строка карточки по телефону на этот день не входит в визит той же записью', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638', assigned: 3 });
    addLine(t.db, rid, { svc: 40, day: D3 });
    const vid = await callcenterBook(t, D3, { svc: 30, doctor: 10 });
    assert.deepEqual(svcs(t, vid), [30], 'анализ карточки по телефону ушёл в визит (счёт) той же записью');
    assert.equal(link(t, vid).source, 'phone', 'привязка по телефону заменена привязкой, которую видит зеркало');
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.visit_id]), [[40, null]]);
  } finally { t.close(); }
});

// ─── границы (ревью воронки C3) ──────────────────────────────────────────────
test('CRM_LINK_ALL_V1 (ревью воронки C3): регистратура записывает свежую карточку «Подтверждён» на другой день — карточка остаётся «Подтверждён»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'approved', date: D3, updated: daysAgoIso(1) });
    addLine(t.db, rid, { svc: 40, day: D3 });
    await calendarBook(t, 'reg', D7);
    assert.equal(t.lead(rid).status, 'approved');
  } finally { t.close(); }
});
