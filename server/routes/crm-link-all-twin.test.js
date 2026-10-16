// CRM_LINK_ALL_V1 (2026-10-16) — R7b (дефект G7): ВТОРОЙ КОПИИ ЗАПИСАННОЙ УСЛУГИ НЕТ.
// Колл-центр записал на сегодня в календаре (booking_lines_add), регистратура оформила ту же
// услугу — дверь /api/db: строка регистратуры занимает место строки записи (crm/booked-twin.js).
// Повтор, другой врач, количество, счёт и работа — не трогаются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, addLead } from '../test-helpers/crm-unify-app.js';
import { vsOf, cardLines, addVisitLine, callcenterBook, deskRegister } from '../test-helpers/crm-link-all.js';
import { retireBookedTwin } from '../services/crm/booked-twin.js';

const TODAY = localDay(0);

test('CRM_LINK_ALL_V1 R7b: запись колл-центра на сегодня, стойка оформила ту же консультацию — в визите одна строка, её id у экрана, строка карточки на ней', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const bid = await callcenterBook(t, TODAY, { hour: 23 });
    const booked = vsOf(t, bid);
    assert.equal(booked.length, 1);
    const { vid, ids } = await deskRegister(t, 'reg');
    assert.equal(vid, bid, 'второй визит на день (I6)');
    assert.deepEqual(vsOf(t, vid).map((x) => x.id), ids, 'в визите две консультации или не та строка');
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.status, l.visit_service_id]), [[30, 'done', ids[0]]]);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount), 100000, 'двойной счёт');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R7b: мастер на записанный слот — одна строка в визите и на карточке', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const bid = await callcenterBook(t, TODAY, { hour: 23 });
    const y = await addVisitLine(t, 'reg', bid);
    assert.deepEqual(vsOf(t, bid).map((x) => x.id), [y]);
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.status, l.visit_service_id]), [[30, 'pending', y]]);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R7b: настоящий повтор, другой врач и количество 2 — не заменяются', async () => {
  const t = await startCrmApp();
  try {
    t.db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11,'doc2','x','Петров','doctor',1)").run();
    addLead(t.db, {});
    const bid = await callcenterBook(t, TODAY, { hour: 23 });
    const y1 = await addVisitLine(t, 'reg', bid);
    const y2 = await addVisitLine(t, 'reg', bid);
    assert.deepEqual(vsOf(t, bid).map((x) => x.id), [y1, y2], 'второй приём того же дня регистратуры поглощён');
    const other = await addVisitLine(t, 'reg', bid, { doctor: 11 });
    assert.ok(vsOf(t, bid).some((x) => x.id === other), 'консультация другого врача поглощена');
  } finally { t.close(); }
  const t2 = await startCrmApp();
  try {
    addLead(t2.db, {});
    const bid = await callcenterBook(t2, TODAY, { hour: 23 });
    const x = vsOf(t2, bid)[0].id;
    const y = await addVisitLine(t2, 'reg', bid, { quantity: 2 });
    assert.deepEqual(vsOf(t2, bid).map((r) => r.id), [x, y], 'количество 2 заменило строку записи');
  } finally { t2.close(); }
});

test('CRM_LINK_ALL_V1 R7b: строка записи в счёте — не трогается (I4)', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, {});
    const bid = await callcenterBook(t, TODAY, { hour: 23 });
    const x = vsOf(t, bid)[0].id;
    const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: bid, visit_service_ids: [x], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const y = await addVisitLine(t, 'reg', bid);
    assert.deepEqual(vsOf(t, bid).map((r) => r.id), [x, y]);
    assert.ok(t.db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(x).invoice_item_id != null);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R7b: строку регистратуры (не колл-центр, не зеркало) вставка не заменяет — её закрывает экран (R7a)', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, {});
    const ev = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: new Date(Date.now() + 3 * 3600e3).toISOString(), duration_minutes: 30, status: 'scheduled' });
    assert.equal(ev.status, 200, ev.text);
    const vid = ev.json.data.visit.id;
    const x = await addVisitLine(t, 'reg', vid);
    const y = await addVisitLine(t, 'reg', vid);
    assert.deepEqual(vsOf(t, vid).map((r) => r.id), [x, y]);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R7b: визит соседнего здания и мусор — ничего не делает и не бросает', async () => {
  const t = await startCrmApp();
  try {
    assert.equal(retireBookedTwin(t.db, 999999), null);
    assert.equal(retireBookedTwin(t.db, 'x'), null);
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, sync_origin) VALUES (77, 10, ?, 'scheduled', 'B')").run(new Date().toISOString()).lastInsertRowid);
    const ins = t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 30, 10, 1, 100000, 100000, 'added', ?)");
    ins.run(vid, 3);
    const y = Number(ins.run(vid, 2).lastInsertRowid);
    assert.equal(retireBookedTwin(t.db, y), null);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(vid).n, 2);
  } finally { t.close(); }
});
