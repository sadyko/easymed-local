// CRM_LINK_ALL_V1 (редакция 2, 2026-10-16) — «ПОКАЗЫВАТЬ, А НЕ КОПИРОВАТЬ».
// Привязки новых правил — шаг C′ (source 'patient', R1/R2) и телефон (source 'phone', R5) —
// только для воронки (DISPLAY_LINK_SOURCES): зеркало записи (booking-mirror.js) их не видит,
// строки визита в карточку не копируются и строки карточки в визит из-за них не идут. Ступень и
// дата карточки по ним двигаются, как прежде. Здесь же — повторы ревью денег (zz-money-cprime-
// twins C1–C3, zz-money-resched-twin R1) и воронки (zz-funnel-a F3b), перенесённые как
// настоящие тесты (docs/specs/2026-10-16-crm-link-all-doors-design.md, «Revision 2»).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, calendarBook, callcenterBook, addVisitLine, deskRegister } from '../test-helpers/crm-link-all.js';
import { requestOfVisit, cancellableBookingsOf } from '../services/crm/booking-mirror.js';
import { DISPLAY_LINK_SOURCES } from '../services/crm/display-links.js';

const TODAY = localDay(0);
const D = localDay(3);
const D2 = localDay(5);
const D12 = localDay(12);
const allLines = (t, rid) => t.db.prepare(`SELECT service_id, scheduled_date, status, visit_id, visit_service_id FROM crm_request_services
                                            WHERE request_id = ? ORDER BY id`).all(rid);
const vsLive = (t, vid) => t.db.prepare("SELECT id, service_id, total FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid);
const sum = (rows) => rows.reduce((a, x) => a + Number(x.total || 0), 0);
const cancel = (t, who, vid, day, hour = 12) => t.rpc('calendar_book', who, { visit_id: vid, start: at(day, hour), status: 'cancelled' });
const invoiceTotal = async (t, vid, ids) => {
  const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  return Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount);
};

// ─── правило ────────────────────────────────────────────────────────────────
test('CRM_LINK_ALL_V1 ред. 2: привязки «только для воронки» — одна константа; requestOfVisit зеркала их не видит, шаг связи — видит', async () => {
  assert.deepEqual([...DISPLAY_LINK_SOURCES], ['patient', 'phone']);
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const ins = t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 2)");
    const link = t.db.prepare('INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, ?)');
    for (const [src, seen] of [['patient', false], ['phone', false], ['callcenter', true], ['match', true], [null, true]]) {
      const vid = Number(ins.run(at(D, 9)).lastInsertRowid);
      link.run(vid, rid, src);
      assert.equal(requestOfVisit(t.db, vid), seen ? rid : null, 'зеркало ' + src);
      assert.equal(requestOfVisit(t.db, vid, { display: true }), rid, 'воронка ' + src);
    }
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2: запись регистратуры на другой день — живая карточка «Записан» с привязкой, но строки визита в неё не копируются', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const vid = await calendarBook(t, 'reg', D2);
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'patient' });
    assert.deepEqual(allLines(t, rid).map((l) => [l.service_id, l.scheduled_date, l.status, l.visit_id]), [[40, D, 'pending', null]], 'строка визита скопирована в карточку');
    assert.deepEqual(vsLive(t, vid).map((x) => x.service_id), [30]);
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.equal(t.lead(rid).scheduled_date, D2, 'дата карточки — ближайший записанный день (cardDateOf видит привязку)');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2: карточка по телефону — привязка «phone», строки визита в неё не копируются', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    addLine(t.db, rid, { svc: 40, day: D });
    const vid = await calendarBook(t, 'reg', D);
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'phone' });
    assert.deepEqual(allLines(t, rid).map((l) => [l.service_id, l.status, l.visit_id]), [[40, 'pending', null]]);
    assert.deepEqual(vsLive(t, vid).map((x) => x.service_id), [30]);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2: «Отказ» в CRM не отменяет запись, привязанную только для воронки (телефон, колл-центр в календаре)', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638', assigned: 3 });
    const vid = await callcenterBook(t, D);
    assert.equal(link(t, vid).source, 'phone');
    assert.deepEqual(cancellableBookingsOf(t.db, rid), [], 'запись по телефону — в списке отмены «Отказа»');
    const up = await t.dbq('boss', { table: 'crm_requests', op: 'update', values: { status: 'stopped' }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(up.status, 200, up.text);
    assert.equal(t.db.prepare('SELECT status FROM visits WHERE id = ?').get(vid).status, 'scheduled', '«Отказ» отменил запись пациента');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2: запись колл-центра из живой карточки (C′ для колл-центра — прежняя привязка «callcenter») по-прежнему зеркалится', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const vid = await callcenterBook(t, D);
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'callcenter' });
    assert.deepEqual(allLines(t, rid).map((l) => [l.service_id, l.visit_id]), [[30, vid]], 'строка записи колл-центра не дошла до карточки');
  } finally { t.close(); }
});

// ─── повторы ревью денег (zz-money-cprime-twins, zz-money-resched-twin) ────────
test('CRM_LINK_ALL_V1 ред. 2 (ревью денег C1): запись на D2 → отмена → снова D2 той же консультацией — в новом визите ОДНА консультация', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const v1 = await calendarBook(t, 'reg', D2, { hour: 12, svc: 30, doctor: 10 });
    assert.equal((await cancel(t, 'reg', v1, D2, 12)).status, 200);
    const v2 = await calendarBook(t, 'reg', D2, { hour: 15, svc: 30, doctor: 10 });
    const rows = vsLive(t, v2);
    assert.deepEqual(rows.map((x) => x.service_id), [30], 'вторая консультация в новом визите (двойной счёт)');
    assert.equal(sum(rows), 100000);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2 (ревью денег C2): запись на сегодня 17:00 → отмена → приход только на анализ — в счёте нет консультации', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const v1 = await calendarBook(t, 'reg', TODAY, { hour: 17, svc: 30, doctor: 10 });
    assert.equal((await cancel(t, 'reg', v1, TODAY, 17)).status, 200);
    const { vid } = await deskRegister(t, 'reg', { items: [{ svc: 40, doctor: null }] });
    const rows = vsLive(t, vid);
    assert.deepEqual(rows.map((x) => x.service_id), [40], 'отменённая консультация вернулась в визит прихода');
    assert.equal(await invoiceTotal(t, vid, rows.map((x) => x.id)), 40000);
    assert.deepEqual(allLines(t, rid).filter((l) => l.scheduled_date === D).map((l) => [l.service_id, l.status, l.visit_id]), [[40, 'pending', null]], 'строка анализа дня D тронута');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2 (ревью денег C3): две записи на разные дни с той же консультацией, перенос второй на день анализа карточки — в визите только консультация', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const v1 = await calendarBook(t, 'reg', D2, { hour: 12, svc: 30, doctor: 10 });
    const v2 = await calendarBook(t, 'reg', localDay(6), { hour: 12, svc: 30, doctor: 10 });
    assert.deepEqual(vsLive(t, v1).map((x) => x.service_id), [30]);
    assert.deepEqual(vsLive(t, v2).map((x) => x.service_id), [30]);
    const mv = await t.rpc('calendar_book', 'reg', { visit_id: v2, start: at(D, 9), doctor_id: 10 });
    assert.equal(mv.status, 200, mv.text);
    assert.deepEqual(vsLive(t, v2).map((x) => x.service_id), [30], 'перенос втянул анализ карточки в визит');
  } finally { t.close(); }
});

for (const desk of [true, false]) {
  test(`CRM_LINK_ALL_V1 ред. 2 (ревью денег R1, ${desk ? 'быстрая регистрация' : 'мастер визита'}): карточка ждёт сегодня консультацию без врача; запись D2 перенесли на сегодня — ОДНА консультация`, async () => {
    const t = await startCrmApp();
    try {
      const a = addLead(t.db, { assigned: 3, date: TODAY });
      addLine(t.db, a, { svc: 30, day: TODAY, doctor: null });
      const vid = await calendarBook(t, 'reg', D2, { hour: 12, svc: 30, doctor: 10 });
      const mv = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(TODAY, 17), doctor_id: 10 });
      assert.equal(mv.status, 200, mv.text);
      const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', ...(desk ? { desk: true } : {}) });
      assert.equal(ev.status, 200, ev.text);
      assert.equal(ev.json.data.visit.id, vid);
      const rows = vsLive(t, vid);
      assert.deepEqual(rows.map((x) => x.service_id), [30], 'вторая консультация в визите');
      assert.equal(await invoiceTotal(t, vid, rows.map((x) => x.id)), 100000);
    } finally { t.close(); }
  });
}

// ─── повтор ревью воронки (zz-funnel-a F3b) ────────────────────────────────────
test('CRM_LINK_ALL_V1 ред. 2 (ревью воронки F3b): отменённая запись регистратуры не оставляет строки, которая въезжает в следующий визит дня', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', date: localDay(10), updated: daysAgoIso(1), assigned: 3 });
    addLine(t.db, rid, { svc: 40, day: D12 });
    const vid = await calendarBook(t, 'reg', D, { svc: 30, doctor: 10 });
    assert.equal((await cancel(t, 'reg', vid, D, 12)).status, 200);
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.scheduled_date]), [[40, D12]], 'фантомная строка от отменённой записи');
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 40, start: at(D, 15), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v2 = b.json.data.visit.id;
    await addVisitLine(t, 'reg', v2, { svc: 40, doctor: null });
    assert.deepEqual(vsLive(t, v2).map((x) => x.service_id), [40], 'отменённая консультация вернулась в новый визит');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2: перенос записи, привязанной для воронки, в календаре — дата карточки следует за записью (cardDateOf), строк не появляется', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    addLine(t.db, rid, { svc: 40, day: D12 });
    const vid = await calendarBook(t, 'reg', D2);
    assert.equal(link(t, vid).source, 'patient');
    assert.equal(t.lead(rid).scheduled_date, D2);
    const mv = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(D, 9), doctor_id: 10 });
    assert.equal(mv.status, 200, mv.text);
    assert.equal(t.lead(rid).scheduled_date, D, 'дата карточки осталась днём до переноса');
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.deepEqual(allLines(t, rid).map((l) => [l.service_id, l.scheduled_date, l.visit_id]), [[40, D12, null]]);
  } finally { t.close(); }
});
