// CRM_ONE_WAY_V1 (2026-10-17) — ДВЕРИ ЗАПИСИ НА НАСТОЯЩЕМ ПРИЛОЖЕНИИ: услуги записи живут только
// в визите (docs/specs/2026-10-17-crm-one-way-booking-design.md). Повторы ревью раунда 3
// (scratchpad crm-link-review/tree3 zz-r3-money: M1, M2, M7, M8) и правила O3–O6 дверями
// экранов (/api/rpc + /api/db). Каждый сценарий сверяет ВСЕ строки визитов и счета до и после:
// деньги двигает только задуманная строка.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, addVisitLine, calendarBook, callcenterBook, cardLines } from '../test-helpers/crm-link-all.js';
import { BOOKED_LINE_LOCKED } from '../services/crm/one-way.js';

const D2 = localDay(5);
const D3 = localDay(3);
const vsAll = (t, vid) => t.db.prepare("SELECT service_id, doctor_id, quantity FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((x) => ({ ...x }));
const money = (t) => ({
  vs: t.db.prepare('SELECT id, visit_id, service_id, consultation_type_id, doctor_id, quantity, unit_price, status FROM visit_services ORDER BY id').all().map((x) => ({ ...x })),
  inv: t.db.prepare('SELECT id, visit_id, total_amount, paid_amount, status FROM invoices ORDER BY id').all().map((x) => ({ ...x })),
});
const cancel = (t, vid, day, hour) => t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(day, hour), status: 'cancelled' });
const lineOf = (t, id) => t.db.prepare('SELECT * FROM crm_request_services WHERE id = ?').get(id);
async function billOf(t, vid) {
  const ids = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((r) => r.id);
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  return Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount);
}
const seed = (db) => {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петров', 'doctor', 1)").run();
};
const cardBookings = async (t, rid) => {
  const r = await t.rpc('crm_card_bookings', 'cc', { request_id: rid });
  assert.equal(r.status, 200, r.text);
  return r.json.data.bookings.map((b) => ({ visit_id: b.visit_id, status: b.status, services: b.services.map((s) => s.name) }));
};

// ── Повторы ревью раунда 3 (деньги) ─────────────────────────────────────────

test('CRM_ONE_WAY_V1 (повтор M1): консультация колл-центра (врач 10) отменена, регистратура в тот же день пишет к врачу 11 — одна консультация, 100 000', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const v1 = await callcenterBook(t, D3, { svc: 30, doctor: 10 });
    assert.deepEqual(link(t, v1), { request_id: rid, source: 'callcenter' });
    // решение владельца R2 — консультация колл-центра — строка записи карточки (указатель на строку визита)
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.visit_id]), [[30, v1]]);
    assert.equal((await cancel(t, v1, D3, 12)).status, 200);
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.scheduled_date, l.visit_id]), [[30, null, null]], 'O4 — назад в карточку без дня');
    const v2 = await calendarBook(t, 'reg', D3, { hour: 15, svc: 30, doctor: 11 });
    assert.deepEqual(vsAll(t, v2).map((x) => [x.service_id, x.doctor_id]), [[30, 11]]);
    assert.deepEqual(vsAll(t, v1).map((x) => [x.service_id, x.doctor_id]), [[30, 10]], 'отменённая запись — история, строка при ней');
    assert.equal(await billOf(t, v2), 100000);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор M2): консультация колл-центра отменена, регистратура в тот же день пишет анализ — только анализ, 40 000', async () => {
  const t = await startCrmApp(seed);
  try {
    addLead(t.db, { assigned: 3 });
    const v1 = await callcenterBook(t, D3, { svc: 30, doctor: 10 });
    assert.equal((await cancel(t, v1, D3, 12)).status, 200);
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 40, start: at(D3, 15), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v2 = b.json.data.visit.id;
    await addVisitLine(t, 'reg', v2, { svc: 40, doctor: null });
    assert.deepEqual(vsAll(t, v2).map((x) => x.service_id), [40]);
    assert.equal(await billOf(t, v2), 40000);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (C1, O4): желание карточки записано колл-центром, запись отменили; регистратура пишет ту же консультацию в тот же день — одна консультация; отпущенная строка в неё не садится', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const wish = t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, doctor_id, scheduled_date, status) VALUES (?, 30, 10, ?, 'pending')").run(rid, D3).lastInsertRowid;
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v1 = b.json.data.visit.id;
    assert.deepEqual(vsAll(t, v1).map((x) => x.service_id), [30], 'O1 — желание село в визит одной строкой');
    assert.equal(lineOf(t, wish).visit_id, v1);
    assert.equal((await cancel(t, v1, D3, 12)).status, 200);
    const l = lineOf(t, wish);
    assert.deepEqual([l.status, l.scheduled_date, l.visit_id, l.visit_service_id, l.released_from_visit_id], ['pending', null, null, null, v1], 'O4 — назад в карточку без дня');
    const v2 = await calendarBook(t, 'reg', D3, { hour: 15, svc: 30, doctor: 10 });
    assert.deepEqual(vsAll(t, v2).map((x) => x.service_id), [30], 'одна консультация');
    assert.equal(lineOf(t, wish).visit_id, null, 'отпущенная строка сама в запись не садится');
    assert.equal(await billOf(t, v2), 100000);
  } finally { t.close(); }
});

for (const via of ['addLine', 'desk']) {
  test(`CRM_ONE_WAY_V1 (повтор M8, ${via}): визит регистратуры, который карточка ждала, отменили по ошибке и вернули — консультация в визите, деньги на месте`, async () => {
    const t = await startCrmApp(seed);
    try {
      const rid = addLead(t.db, { assigned: 3, updated: daysAgoIso(1) });
      const day = via === 'desk' ? localDay(0) : D2;
      const v1 = await calendarBook(t, 'reg', day, { hour: 23, svc: 30, doctor: 10 });
      assert.deepEqual(link(t, v1), { request_id: rid, source: 'match' });
      assert.equal((await cancel(t, v1, day, 23)).status, 200);
      const back = await t.rpc('calendar_book', 'reg', { visit_id: v1, start: at(day, 23), status: 'scheduled' });
      assert.equal(back.status, 200, back.text);
      if (via === 'addLine') await addVisitLine(t, 'reg', v1, { svc: 40, doctor: null });
      else {
        const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
        assert.equal(ev.status, 200, ev.text);
        assert.equal(ev.json.data.visit.id, v1);
      }
      assert.ok(vsAll(t, v1).some((x) => x.service_id === 30), 'восстановленный визит потерял консультацию');
      assert.equal(t.lead(rid).status, via === 'desk' ? 'came' : 'scheduled', 'карточка снова держит запись');
    } finally { t.close(); }
  });
}

test('CRM_ONE_WAY_V1 (повтор M7, решение владельца R2): колл-центр добавил консультацию в календаре к визиту, который карточка ждала, — строка записи карточки; запись отменили — консультация в карточке без дня, строки визита не тронуты', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3, updated: daysAgoIso(1) });
    const v1 = await calendarBook(t, 'reg', D2, { hour: 12, svc: 40, doctor: 10 });
    assert.deepEqual(link(t, v1), { request_id: rid, source: 'match' });
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: v1, patient_id: 77, lines: [{ service_id: 30, doctor_id: 10, scheduled_at: at(D2, 12) }] });
    assert.equal(add.status, 200, add.text);
    // анализ — своя запись регистратуры (только история, O2); консультация — услуга колл-центра (R2)
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.visit_id]), [[30, v1]]);
    const before = vsAll(t, v1);
    assert.equal((await cancel(t, v1, D2, 12)).status, 200);
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.scheduled_date, l.visit_id, l.status]), [[30, null, null, 'pending']]);
    assert.deepEqual(vsAll(t, v1), before, 'строки отменённого визита — история');
    assert.deepEqual(await cardBookings(t, rid), [{ visit_id: v1, status: 'cancelled', services: ['Анализ крови', 'Консультация терапевта'] }]);
  } finally { t.close(); }
});

// ── O3: карточка и строки записи ────────────────────────────────────────────

test('CRM_ONE_WAY_V1 (O3): карточка добавляет анализ в свою запись (строка с visit_id записи) — одна строка визита и строка записи; убирает его крестиком — строка уходит из визита', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    addLine(t.db, rid, { svc: 30, day: D3, doctor: 10 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    const v = b.json.data.visit.id;
    const ins = await t.dbq('cc', { table: 'crm_request_services', op: 'insert', returning: true, single: 'single',
      values: { request_id: rid, service_id: 40, scheduled_date: D3, status: 'pending', visit_id: v } });
    assert.equal(ins.status, 200, ins.text);
    const lid = ins.json.data.id;
    assert.deepEqual(vsAll(t, v).map((x) => x.service_id), [30, 40]);
    const l = lineOf(t, lid);
    assert.equal(l.visit_id, v);
    assert.ok(l.visit_service_id);
    const before = money(t);
    const del = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { status: 'cancelled' }, filters: [{ col: 'id', op: 'eq', val: lid }] });
    assert.equal(del.status, 200, del.text);
    assert.deepEqual(vsAll(t, v).map((x) => x.service_id), [30]);
    const after = money(t);
    assert.deepEqual(after.vs, before.vs.filter((x) => x.id !== l.visit_service_id), 'ушла только строка анализа');
    assert.deepEqual(after.inv, before.inv);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (O3): строку визита сняли в календаре (booking_line_remove) — строка записи карточки ждёт без дня, отпущенная; ни одна запись её сама не берёт', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const lid = addLine(t.db, rid, { svc: 40, day: D3 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    const v = b.json.data.visit.id;
    const x = lineOf(t, lid).visit_service_id;
    assert.ok(x);
    const rm = await t.rpc('booking_line_remove', 'cc', { visit_service_id: x });
    assert.equal(rm.status, 200, rm.text);
    const l = lineOf(t, lid);
    assert.deepEqual([l.status, l.scheduled_date, l.visit_id, l.released_from_visit_id], ['pending', null, null, v]);
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: at(D3, 15), doctor_id: 10 });
    assert.equal(ev.status, 200, ev.text);
    assert.deepEqual(vsAll(t, v), [], 'опция «без даты» регистрации отпущенную строку не берёт');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (O6): день, врач и визит строки записи из карточки через /api/db не меняются — отказ, ничего не тронуто; правка комментария проходит', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const lid = addLine(t.db, rid, { svc: 30, day: D3, doctor: 10 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const before = money(t);
    const was = lineOf(t, lid);
    for (const values of [{ scheduled_date: D2, visit_id: null }, { doctor_id: 11 }, { visit_id: null }]) {
      const r = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: lid }] });
      assert.equal(r.status, 409, r.text);
      assert.equal(r.json.error.message, BOOKED_LINE_LOCKED);
    }
    assert.deepEqual({ ...lineOf(t, lid) }, { ...was });
    assert.deepEqual(money(t), before);
    const ok = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { note: 'перезвонить', scheduled_date: D3, doctor_id: 10 }, filters: [{ col: 'id', op: 'eq', val: lid }] });
    assert.equal(ok.status, 200, ok.text);
  } finally { t.close(); }
});

// ── O4 / O5: отмена и возврат ──────────────────────────────────────────────

test('CRM_ONE_WAY_V1 (O4): отменённая запись — строки в карточке без дня; запись того же дня и регистрация на стойке их не берут; оператор назначил день — следующая запись берёт', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const lid = addLine(t.db, rid, { svc: 40, day: localDay(0) });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(localDay(0), 23), duration_minutes: 30, status: 'scheduled' });
    const v1 = b.json.data.visit.id;
    assert.deepEqual(vsAll(t, v1).map((x) => x.service_id), [40]);
    assert.equal((await cancel(t, v1, localDay(0), 23)).status, 200);
    const before = money(t);
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    assert.equal(ev.status, 200, ev.text);
    const v2 = ev.json.data.visit.id;
    assert.notEqual(v2, v1);
    assert.deepEqual(vsAll(t, v2), [], 'стойка не взяла отпущенную строку');
    assert.deepEqual(money(t).vs, before.vs);
    const up = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { scheduled_date: D3 }, filters: [{ col: 'id', op: 'eq', val: lid }] });
    assert.equal(up.status, 200, up.text);
    assert.equal(lineOf(t, lid).released_from_visit_id, null, 'правка дня сняла отметку');
    const b3 = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    const v3 = b3.json.data.visit.id;
    assert.deepEqual(vsAll(t, v3).map((x) => x.service_id), [40], 'записали снова — одна строка');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (O5): запись карточки отменили по ошибке и вернули «Записан» — строка карточки снова указывает на строку визита, карточка «Записан» с днём записи; деньги не двинулись', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const lid = addLine(t.db, rid, { svc: 40, day: D3 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    const v = b.json.data.visit.id;
    const x = lineOf(t, lid).visit_service_id;
    const before = money(t);
    assert.equal((await cancel(t, v, D3, 12)).status, 200);
    assert.equal(lineOf(t, lid).visit_id, null);
    const back = await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(D3, 12), status: 'scheduled' });
    assert.equal(back.status, 200, back.text);
    const l = lineOf(t, lid);
    assert.deepEqual([l.visit_id, l.visit_service_id, l.scheduled_date, l.released_from_visit_id], [v, x, D3, null]);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['scheduled', D3]);
    assert.deepEqual(money(t), before);
  } finally { t.close(); }
});

// ── Решения владельца 2026-10-17 (R2) и контролёра (R4) ─────────────────────

test('CRM_ONE_WAY_V1 (решение владельца R2): услуга, добавленная в запись, которую карточка держит привязкой колл-центра, — строка записи карточки; отмена возвращает её без дня. Своя запись регистратуры — только история', async () => {
  const t = await startCrmApp(seed);
  try {
    // запись колл-центра (привязка 'callcenter'); регистратура дописывает анализ своей дверью
    const rid = addLead(t.db, { assigned: 3 });
    const v1 = await callcenterBook(t, D3, { svc: 30, doctor: 10 });
    assert.deepEqual(link(t, v1), { request_id: rid, source: 'callcenter' });
    const lab = await addVisitLine(t, 'reg', v1, { svc: 40, doctor: null });
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.visit_service_id]),
      [[30, vsAll(t, v1).length && t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 30').get(v1).id], [40, lab]]);
    const before = money(t);
    assert.equal((await cancel(t, v1, D3, 12)).status, 200);
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.scheduled_date, l.visit_id]), [[30, null, null], [40, null, null]], 'O4 — обе услуги в карточке без дня');
    assert.deepEqual(money(t).vs, before.vs, 'строки отменённого визита — история');
    // своя запись регистратуры (шаг C 'match') — её услуги карточке строками не становятся
    const rid2 = addLead(t.db, { assigned: 3, updated: daysAgoIso(1), name: 'Вторая' });
    const v2 = await calendarBook(t, 'reg', D2, { hour: 12, svc: 30, doctor: 10 });
    assert.equal(link(t, v2).request_id, rid2);
    assert.equal(link(t, v2).source, 'match');
    await addVisitLine(t, 'reg', v2, { svc: 40, doctor: null });
    assert.deepEqual(cardLines(t, rid2), [], 'запись регистратуры скопирована в карточку');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (решение контролёра R4): карточка без строк, две записи регистратуры (шаг C), обе отменили — ступень и дата до первой записи; человек передвинул карточку — ступень его, дата пересчитана', async () => {
  const t = await startCrmApp(seed);
  try {
    const D10 = localDay(10);
    const rid = addLead(t.db, { status: 'recall', date: D10, updated: daysAgoIso(1), assigned: 3 });
    const v1 = await calendarBook(t, 'reg', D3, { hour: 12 });
    const v2 = await calendarBook(t, 'reg', localDay(7), { hour: 15 });
    assert.equal(link(t, v1).request_id, rid);
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.equal((await cancel(t, v1, D3, 12)).status, 200);
    assert.equal(t.lead(rid).status, 'scheduled', 'вторая запись жива — карточка записана');
    assert.equal((await cancel(t, v2, localDay(7), 15)).status, 200);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['recall', D10], 'карточка не вернулась туда, где была до записей');
    void v2;
    // человек передвинул карточку, пока запись жила, — отмена ступень не трогает
    const rid2 = addLead(t.db, { status: 'recall', date: D10, updated: daysAgoIso(1), assigned: 3, name: 'Вторая' });
    t.db.prepare("UPDATE crm_requests SET status = 'stopped' WHERE id = ?").run(rid);   // первая — в сторону
    const v3 = await calendarBook(t, 'reg', D3, { hour: 16 });
    assert.equal(link(t, v3).request_id, rid2);
    const up = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { status: 'in_process' }, filters: [{ col: 'id', op: 'eq', val: rid2 }] });
    assert.equal(up.status, 200, up.text);
    assert.equal((await cancel(t, v3, D3, 16)).status, 200);
    assert.deepEqual([t.lead(rid2).status, t.lead(rid2).scheduled_date], ['in_process', null], 'отмена переписала ход человека');
  } finally { t.close(); }
});

// Ревью r4 (п. 7) — дата карточки пересчитывается или стирается отменой, только когда она — день отменённой
// записи. Дату, которую поставил человек, не трогает ни отмена при живой второй записи, ни отмена последней.
test('CRM_ONE_WAY_V1 (ревью r4, п. 7): дата карточки, поставленная человеком, переживает отмены записей; дата дня отменённой записи — пересчитывается', async () => {
  const t = await startCrmApp(seed);
  try {
    const D7 = localDay(7);
    const D9 = localDay(9);
    const rid = addLead(t.db, { assigned: 3 });
    addLine(t.db, rid, { svc: 30, day: D3, doctor: 10 });
    addLine(t.db, rid, { svc: 40, day: D2 });
    addLine(t.db, rid, { svc: 40, day: D7 });
    const book = async (day, svc) => {
      const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: svc, start: at(day, 12), duration_minutes: 30, status: 'scheduled' });
      assert.equal(b.status, 200, b.text);
      return b.json.data.visit.id;
    };
    const v3 = await book(D3, 30);
    const v5 = await book(D2, 40);
    const v7 = await book(D7, 40);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['scheduled', D3]);
    assert.equal((await cancel(t, v3, D3, 12)).status, 200);
    assert.equal(t.lead(rid).scheduled_date, D2, 'дата дня отменённой записи не пересчитана по живым');
    const up = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { scheduled_date: D9 }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(up.status, 200, up.text);
    assert.equal((await cancel(t, v5, D2, 12)).status, 200);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['scheduled', D9], 'отмена при живой записи переписала дату человека');
    assert.equal((await cancel(t, v7, D7, 12)).status, 200);
    assert.equal(t.lead(rid).scheduled_date, D9, 'отмена последней записи стёрла дату человека');
  } finally { t.close(); }
});

// Ревью r4 (п. 7, проверка опровержением) — «день отменённой записи» — и день, с которого запись сняли тем же
// вызовом (календарь отменяет и переносит одним calendar_book): дата карточки — дата записи, а не человека.
test('CRM_ONE_WAY_V1 (ревью r4, п. 7): отмена с переносом одним вызовом — карточка как после простой отмены (дата записи не остаётся)', async () => {
  const run = async (moveTo) => {
    const t = await startCrmApp(seed);
    try {
      const rid = addLead(t.db, { assigned: 3 });
      addLine(t.db, rid, { svc: 30, day: D3, doctor: 10 });
      const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
      assert.equal(b.status, 200, b.text);
      const v = b.json.data.visit.id;
      assert.equal(t.lead(rid).scheduled_date, D3);
      const c = await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(moveTo, 12), status: 'cancelled' });
      assert.equal(c.status, 200, c.text);
      return [t.lead(rid).status, t.lead(rid).scheduled_date];
    } finally { t.close(); }
  };
  const plain = await run(D3);
  assert.notEqual(plain[1], D3, 'простая отмена оставила дату записи');
  assert.deepEqual(await run(D2), plain, 'отмена с переносом оставила карточке день отменённой записи');
});
