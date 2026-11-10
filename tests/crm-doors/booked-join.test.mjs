// BOOKED_JOIN_V1 (решение владельца 2026-11-07) — УСЛУГА К ВРАЧУ, К КОТОРОМУ ПАЦИЕНТ
// УЖЕ ЗАПИСАН В ЭТОТ ДЕНЬ, ИДЁТ В ЭТУ ЗАПИСЬ.
//
// Колл-центр записал пациента к врачу (из карточки CRM или в календаре при карточке с
// одним телефоном). Регистратор добавляет к тому же врачу ещё услугу: мастер визита и
// калькулятор теперь ставят её на время записи и шлют её БЕЗ брони слота (book) — та же
// запись, тот же визит. Здесь — та же последовательность вызовов на настоящем сервере
// (стенд crm-doors): визит один, обе услуги в нём, счёт один, отказа «время занято» нет.
// Сегодня и другой день; карточка с пациентом и карточка с одним телефоном.
//
// Run (repo root): LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/booked-join.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { start, TODAY, D, PID, at, seedS1, crmCardBook, calendarPickerBook, addVisitLine, visitsOf, vsOf } from './helpers.mjs';

const t = await start();
t.db.prepare("INSERT INTO services (id, name, price, type, requires_doctor, duration_minutes) VALUES (31,'ЭКГ с расшифровкой',50000,'imaging',1,30)").run();
after(() => t.close && t.close());

const visitsOn = (day) => visitsOf(t).filter((v) => { const d = t.db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(v.id).visit_date; const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0') === day; });
const ok = (r, what) => { assert.equal(r.status, 200, what + ': ' + r.text); return r.json.data; };
function reset() {
  for (const tbl of ['invoice_items', 'payments', 'invoices', 'crm_booking_links', 'crm_request_services', 'crm_requests', 'visit_services', 'visits']) {
    try { t.db.prepare(`DELETE FROM ${tbl}`).run(); } catch { /* таблицы может не быть */ }
  }
}

/** Мастер визита (visit-wizard.js createVisit) — строка, идущая в запись: ensure_visit без book. */
async function wizardJoin(whenIso, { who = 'reg', svc = 31, doctor = 10 } = {}) {
  const ev = ok(await t.rpc('ensure_visit', who, { patient_id: PID, date: whenIso, doctor_id: doctor, visit_type: 'outpatient',
    referral_source_id: null, branch_id: 1, notes: null }), 'ensure_visit');
  const vsId = await addVisitLine(t, who, ev.visit.id, { svc, doctor, scheduledAt: whenIso, status: true });
  return { vid: ev.visit.id, vsId, ev };
}

for (const [label, day, hour] of [['сегодня', TODAY, 23], ['другой день', D, 10]]) {
  test(`карточка CRM с пациентом, запись ${label}: ЭКГ к тому же врачу — в ту же запись, визит один, счёт один`, async () => {
    reset();
    const rid = seedS1(t);
    const { vid: bid } = await crmCardBook(t, rid, day, 'cc', { hour });
    const when = at(day, hour);
    const { vid, vsId } = await wizardJoin(when);
    assert.equal(vid, bid, 'услуга ушла не в визит записи');
    assert.equal(visitsOn(day).length, 1, 'второй визит на день');
    assert.deepEqual(vsOf(t, bid).map((r) => r.service_id).sort(), [30, 31]);
    const booked = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 30').get(bid).id;
    const inv = ok(await t.rpc('create_invoice_for_visit', 'reg', { visit_id: bid, visit_service_ids: [booked, vsId], discount_amount: 0, payer_id: null }), 'invoice');
    assert.equal(inv.invoice.total_amount, 150000);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM invoices WHERE visit_id = ?').get(bid).n, 1);
    const slot = t.db.prepare('SELECT scheduled_at FROM visit_services WHERE id = ?').get(vsId).scheduled_at;
    assert.equal(new Date(slot).getTime(), new Date(when).getTime(), 'время строки — не время записи');
  });
}

test('карточка с одним телефоном, запись в календаре на сегодня: ЭКГ к тому же врачу — в ту же запись', async () => {
  reset();
  seedS1(t, { patient: null });
  const { vid: bid } = await calendarPickerBook(t, 'reg', TODAY, { hour: 23 });
  const { vid } = await wizardJoin(at(TODAY, 23));
  assert.equal(vid, bid);
  assert.equal(visitsOn(TODAY).length, 1);
  assert.deepEqual(vsOf(t, bid).map((r) => r.service_id).sort(), [30, 31]);
});

// ═══════════════════════════════════════════════════════════════════════════
// CRM_JOIN_NOT_MOVE_V1 · JOIN_EXTENDS_BOOKING_V1 (3.23.0, снимок владельца 2026-11-10) —
// карточка CRM «Даты приёма»: пациент записан к врачу на 10:10, оператор добавляет
// к тому же врачу ещё услугу. Прежде окно не знало про запись, предлагало 09:30 и на
// «Сохранить и записать» ПЕРЕНОСИЛО запись (moved, 10:10 → 09:30). Теперь услуга
// идёт в запись: визит тот же, время то же, а запись удлиняется на услугу, если
// время за ней свободно. Перенос — только явным выбором «Перенести запись на …».
// ═══════════════════════════════════════════════════════════════════════════
const hm = (iso) => { const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const visitRow = (id) => t.db.prepare('SELECT id, visit_date, duration_minutes, status FROM visits WHERE id = ?').get(id);
/** Чужой пациент у того же врача — «следующая запись». */
function otherBooking(day, hour, mm = 0) {
  try { t.db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Другой Пациент','+998 90 000 00 78')").run(); } catch { /* уже есть */ }
  return Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, duration_minutes, status, created_by) VALUES (78, 10, ?, 30, 'scheduled', 1)")
    .run(at(day, hour, mm)).lastInsertRowid);
}

test('CRM_JOIN_NOT_MOVE_V1: карточка CRM — ЭКГ к тому же врачу на время записи (join): визит тот же, время то же, запись удлинилась', async () => {
  reset();
  const rid = seedS1(t);
  const { vid: bid } = await crmCardBook(t, rid, D, 'cc', { hour: 10 });
  assert.equal(visitRow(bid).duration_minutes, 30);
  const ev = ok(await t.rpc('ensure_visit', 'cc', { patient_id: PID, date: at(D, 10), doctor_id: 10,
    join: { doctor_id: 10, start: at(D, 10), duration_minutes: 30 } }), 'ensure_visit join');
  assert.equal(ev.visit.id, bid, 'услуга ушла не в визит записи');
  assert.equal(ev.joined, true, 'ответ не назвал присоединение');
  assert.ok(!ev.moved, 'запись перенесена');
  assert.equal(ev.extended, true, 'время за записью свободно — запись не удлинилась');
  const v = visitRow(bid);
  assert.equal(hm(v.visit_date), '10:00', 'время записи сдвинулось');
  assert.equal(v.duration_minutes, 60, 'запись не удлинилась на длительность ЭКГ');
  assert.equal(visitsOn(D).length, 1, 'второй визит на день');
});

test('CRM_JOIN_NOT_MOVE_V1: старый экран шлёт book на ВРЕМЯ ЗАПИСИ того же врача — сервер присоединяет, не переносит', async () => {
  reset();
  const rid = seedS1(t);
  const { vid: bid } = await crmCardBook(t, rid, D, 'cc', { hour: 10 });
  const ev = ok(await t.rpc('ensure_visit', 'cc', { patient_id: PID, date: at(D, 10), doctor_id: 10,
    book: { doctor_id: 10, service_id: 31, start: at(D, 10), duration_minutes: 30 } }), 'ensure_visit book на время записи');
  assert.equal(ev.visit.id, bid);
  assert.equal(ev.joined, true);
  assert.ok(!ev.moved, 'запись «перенесена» на своё же время');
  assert.equal(visitRow(bid).duration_minutes, 60);
});

test('JOIN_EXTENDS_BOOKING_V1: следующая запись раньше конца — запись не удлиняется, ответ называет, когда кончится и кто следующий', async () => {
  reset();
  const rid = seedS1(t);
  const { vid: bid } = await crmCardBook(t, rid, D, 'cc', { hour: 10 });
  otherBooking(D, 10, 40);
  const ev = ok(await t.rpc('ensure_visit', 'cc', { patient_id: PID, date: at(D, 10), doctor_id: 10,
    join: { doctor_id: 10, start: at(D, 10), duration_minutes: 30 } }), 'ensure_visit join');
  assert.equal(ev.visit.id, bid);
  assert.equal(ev.joined, true);
  assert.equal(ev.extended, false);
  assert.equal(ev.ends, '11:00');
  assert.equal(ev.next, '10:40');
  assert.equal(visitRow(bid).duration_minutes, 30, 'запись удлинилась на чужой приём');
});

test('CRM_JOIN_NOT_MOVE_V1: другое время того же врача — это ЯВНЫЙ перенос (book), он по-прежнему переносит и называет откуда', async () => {
  reset();
  const rid = seedS1(t);
  const { vid: bid } = await crmCardBook(t, rid, D, 'cc', { hour: 10 });
  const ev = ok(await t.rpc('ensure_visit', 'cc', { patient_id: PID, date: at(D, 9, 30), doctor_id: 10,
    book: { doctor_id: 10, service_id: 30, start: at(D, 9, 30), duration_minutes: 30 } }), 'ensure_visit перенос');
  assert.equal(ev.moved, true);
  assert.equal(ev.from.start, '10:00');
  assert.equal(hm(visitRow(bid).visit_date), '09:30');
});

test('CRM_JOIN_NOT_MOVE_V1: join, а записи уже нет (отменили) — визит дня без времени, ничего не удлиняется', async () => {
  reset();
  const rid = seedS1(t);
  const { vid: bid } = await crmCardBook(t, rid, D, 'cc', { hour: 10 });
  t.db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(bid);
  const ev = ok(await t.rpc('ensure_visit', 'cc', { patient_id: PID, date: at(D, 10), doctor_id: 10,
    join: { doctor_id: 10, start: at(D, 10), duration_minutes: 30 } }), 'ensure_visit join без записи');
  assert.notEqual(ev.visit.id, bid);
  assert.ok(!ev.joined, 'присоединение к отменённой записи');
  assert.equal(ev.booked, false);
});
