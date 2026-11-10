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
    join: { doctor_id: 10, start: at(D, 10), lines: [{ service_id: 31 }] } }), 'ensure_visit join');
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
    join: { doctor_id: 10, start: at(D, 10), lines: [{ service_id: 31 }] } }), 'ensure_visit join');
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

// CRM_JOIN_NOT_MOVE_V1 (ревью M4) — запись, к которой присоединяли, отменили или перенесли,
// пока окно было открыто: отказ join_target_gone, без нового визита и без двойной записи.
test('CRM_JOIN_NOT_MOVE_V1 (ревью M4): join, а записи уже нет (отменили, время занял другой) — отказ join_target_gone, визит не заводится', async () => {
  reset();
  const rid = seedS1(t);
  const { vid: bid } = await crmCardBook(t, rid, D, 'cc', { hour: 10 });
  t.db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(bid);
  otherBooking(D, 10);
  const before = t.db.prepare('SELECT COUNT(*) n FROM visits').get().n;
  const r = await t.rpc('ensure_visit', 'cc', { patient_id: PID, date: at(D, 10), doctor_id: 10,
    join: { doctor_id: 10, start: at(D, 10), lines: [{ service_id: 31 }] } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error.code, 'join_target_gone');
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM visits').get().n, before, 'заведён визит при исчезнувшей записи');
});

test('CRM_JOIN_NOT_MOVE_V1 (ревью M4): запись перенесли на 11:00, окно присоединяет к 10:00 — join_target_gone, запись не тронута', async () => {
  reset();
  const rid = seedS1(t);
  const { vid: bid } = await crmCardBook(t, rid, D, 'cc', { hour: 10 });
  t.db.prepare('UPDATE visits SET visit_date = ? WHERE id = ?').run(at(D, 11), bid);
  const r = await t.rpc('ensure_visit', 'cc', { patient_id: PID, date: at(D, 10), doctor_id: 10,
    join: { doctor_id: 10, start: at(D, 10), lines: [{ service_id: 31 }] } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error.code, 'join_target_gone');
  assert.equal(hm(visitRow(bid).visit_date), '11:00');
  assert.equal(visitRow(bid).duration_minutes, 30);
});

// ═══ ревью M2 — присоединение НЕ РАСТИТ запись от повторов: длина — из строк записи ═══
test('JOIN_EXTENDS_BOOKING_V1 (ревью M2): тот же join трижды (повтор, сбой сети) — запись удлинилась один раз', async () => {
  reset();
  const rid = seedS1(t);
  const { vid: bid } = await crmCardBook(t, rid, D, 'cc', { hour: 10 });
  for (let i = 0; i < 3; i++) {
    const { vid } = await (async () => {
      const ev = ok(await t.rpc('ensure_visit', 'reg', { patient_id: PID, date: at(D, 10), doctor_id: 10,
        join: { doctor_id: 10, start: at(D, 10), lines: [{ service_id: 31 }] } }), 'join #' + i);
      if (i === 0) await addVisitLine(t, 'reg', ev.visit.id, { svc: 31, doctor: 10, scheduledAt: at(D, 10), status: true });
      return { vid: ev.visit.id };
    })();
    assert.equal(vid, bid);
  }
  assert.equal(visitRow(bid).duration_minutes, 60, 'запись выросла от повторов');
});

test('JOIN_EXTENDS_BOOKING_V1 (ревью M2): book на время записи той же услугой, повторённый, — длина не растёт (услуга уже в записи)', async () => {
  reset();
  const rid = seedS1(t);
  const { vid: bid } = await crmCardBook(t, rid, D, 'cc', { hour: 10 });
  for (let i = 0; i < 3; i++) {
    ok(await t.rpc('ensure_visit', 'cc', { patient_id: PID, date: at(D, 10), doctor_id: 10,
      book: { doctor_id: 10, service_id: 30, start: at(D, 10), duration_minutes: 30 } }), 'book #' + i);
  }
  assert.equal(visitRow(bid).duration_minutes, 30, 'запись выросла от повторной той же услуги');
});

// ═══ ревью M3 — перенос сохраняет полную длину записи ═══
test('JOIN_EXTENDS_BOOKING_V1 (ревью M3): запись удлинилась присоединением (60), затем явный перенос на 14:00 — длина остаётся 60', async () => {
  reset();
  const rid = seedS1(t);
  const { vid: bid } = await crmCardBook(t, rid, D, 'cc', { hour: 10 });
  ok(await t.rpc('ensure_visit', 'cc', { patient_id: PID, date: at(D, 10), doctor_id: 10,
    join: { doctor_id: 10, start: at(D, 10), lines: [{ service_id: 31 }] } }), 'join');
  assert.equal(visitRow(bid).duration_minutes, 60);
  const mv = ok(await t.rpc('ensure_visit', 'cc', { patient_id: PID, date: at(D, 14), doctor_id: 10,
    book: { doctor_id: 10, service_id: 30, start: at(D, 14), duration_minutes: 30 } }), 'перенос');
  assert.equal(mv.moved, true);
  assert.equal(hm(visitRow(bid).visit_date), '14:00');
  assert.equal(visitRow(bid).duration_minutes, 60, 'перенос обрезал запись до 30 минут');
});

// ═══ ревью M5 — конец приёма врача назван (until), когда удлинить нельзя ═══
test('JOIN_EXTENDS_BOOKING_V1 (ревью M5): запись 17:30–18:00, присоединение +30 — не удлиняется, ответ называет конец приёма врача', async () => {
  reset();
  const bk = ok(await t.rpc('calendar_book', 'reg', { patient_id: PID, doctor_id: 10, service_id: 30, start: at(D, 17, 30) }), 'запись 17:30');
  const bid = bk.visit.id;
  await addVisitLine(t, 'reg', bid, { svc: 30, doctor: 10, scheduledAt: at(D, 17, 30), status: true });
  const ev = ok(await t.rpc('ensure_visit', 'cc', { patient_id: PID, date: at(D, 17, 30), doctor_id: 10,
    join: { doctor_id: 10, start: at(D, 17, 30), lines: [{ service_id: 31 }] } }), 'join 17:30');
  assert.equal(ev.joined, true);
  assert.equal(ev.extended, false);
  assert.equal(ev.ends, '18:30');
  assert.equal(ev.next, null);
  assert.equal(ev.until, '18:00');
  assert.equal(visitRow(bid).duration_minutes, 30);
});
