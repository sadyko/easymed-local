// CRM_LINK_ALL_V1 (2026-10-16) — R7b (дефект G7): ВТОРОЙ КОПИИ ЗАПИСАННОЙ УСЛУГИ НЕТ.
// Колл-центр записал на сегодня в календаре (booking_lines_add), регистратура оформила ту же
// услугу — дверь /api/db: строка регистратуры занимает место строки записи (crm/booked-twin.js).
// Повтор, другой врач, количество, счёт и работа — не трогаются.
// CRM_ONE_WAY_V1 (O2) — строки записи колл-центра из календаря в карточку не копируются: прежние
// ожидания «строка карточки на строке регистратуры» сменились на «у карточки строк нет».
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
    assert.deepEqual(cardLines(t, rid), [], 'CRM_ONE_WAY_V1 (O2) — копии в карточке нет');
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
    assert.deepEqual(cardLines(t, rid), [], 'CRM_ONE_WAY_V1 (O2) — копии в карточке нет');
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

// ─── CRM_LINK_ALL_V1 (редакция 2) — R7a + R7b вместе (повтор recheck t7-r7a-r7b-interplay) ─────
// Строка записи X (колл-центр) и строка регистратора той же услуги. Новый экран прицепляет строку
// регистратора к строке записи: вставки нет, сеть R7b не срабатывает, счёт на X — одна
// консультация. Старый экран вставляет Y: X уходит (R7b), счёт на Y — тоже одна. Набор [X, Y]
// после вставки Y — отказ кассы, а не двойной счёт.
test('CRM_LINK_ALL_V1 ред. 2 (R7a + R7b): новый экран — строка регистратора прицеплена к строке записи: вставки нет, счёт на строку записи, одна консультация', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, {});
    const bid = await callcenterBook(t, TODAY, { hour: 23 });
    const x = vsOf(t, bid)[0].id;
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    assert.equal(ev.json.data.visit.id, bid);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: bid, visit_service_ids: [x], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.deepEqual(vsOf(t, bid).map((r) => r.id), [x]);
    assert.equal(Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(bid).total_amount), 100000);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2 (R7a + R7b): старый экран вставил ту же услугу — строка записи уходит, счёт на строку экрана; набор [X, Y] — отказ, двойного счёта нет', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, {});
    const bid = await callcenterBook(t, TODAY, { hour: 23 });
    const x = vsOf(t, bid)[0].id;
    await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    const y = await addVisitLine(t, 'reg', bid);
    assert.deepEqual(vsOf(t, bid).map((r) => r.id), [y]);
    const both = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: bid, visit_service_ids: [x, y], discount_amount: 0, payer_id: null });
    assert.equal(both.status, 400, 'набор со снятой строкой записи выставлен');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM invoices WHERE visit_id = ?').get(bid).n, 0);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: bid, visit_service_ids: [y], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(bid).total_amount), 100000);
  } finally { t.close(); }
});

// CRM_LINK_ALL_V1 (повторное ревью денег, S1) — «ТА ЖЕ УСЛУГА» — ОДНО ПРАВИЛО У ЭКРАНА И У СЕТИ R7b.
// Экран (booked-rows.js isBookedTwin) сравнивал врача всегда, сеть (sameService зеркала) у услуги
// без врача врача не сравнивает: ЭКГ записи у исполнителя 10 и ЭКГ экрана у исполнителя 11 экран
// считал разными и вставлял вторую, сеть убирала строку записи, а экран выставлял её в счёт (400
// «Строка услуги № … не найдена»). Теперь правило одно — shared/same-service.js: сеть R7b берёт
// его, и оно совпадает с sameService зеркала во всех клетках; экран прицепляет строку всегда,
// когда сеть убрала бы строку записи.
test('CRM_LINK_ALL_V1 (ревью денег S1): shared/same-service.js = sameService зеркала во всех клетках (услуга без врача, с врачом, вид приёма; врач пуст / тот же / другой); экран прицепляет строку всегда, когда сеть убрала бы строку записи', async () => {
  const t = await startCrmApp((db) => {
    db.prepare("INSERT INTO services (id, name, price, type, requires_doctor, duration_minutes) VALUES (50, 'ЭКГ', 50000, 'procedure', 0, 15)").run();
    db.prepare("INSERT INTO consultation_types (id, name, price) VALUES (5, 'Первичный приём', 100000)").run();
  });
  try {
    const { sameService } = await import('../services/crm/booking-mirror.js');
    const { sameBookedService } = await import('../../public/js/shared/same-service.js');
    const { isBookedTwin } = await import('../../public/js/admin/views/booked-rows.js');
    const needs = (r) => r.service_id == null
      || !!Number((t.db.prepare('SELECT requires_doctor FROM services WHERE id = ?').get(r.service_id) || {}).requires_doctor);
    const key = (r) => ({ serviceId: r.service_id ?? null, consultationTypeId: r.consultation_type_id ?? null, doctorId: r.doctor_id, needsDoctor: needs(r) });
    const kinds = [{ service_id: 50 }, { service_id: 30 }, { service_id: 40 }, { service_id: null, consultation_type_id: 5 }];
    const docs = [null, 10, 11];
    let cells = 0;
    for (const kx of kinds) for (const ky of kinds) for (const dx of docs) for (const dy of docs) {
      const x = { consultation_type_id: null, ...kx, doctor_id: dx };
      const y = { consultation_type_id: null, ...ky, doctor_id: dy };
      const server = sameService(t.db, x, y);
      const label = JSON.stringify({ booked: x, line: y });
      assert.equal(sameBookedService(key(x), key(y), { needsDoctor: needs(y) }), server, 'правило расходится с сетью R7b: ' + label);
      if (server) assert.equal(isBookedTwin(key(y), key(x)), true, 'экран вставит вторую строку, а сеть уберёт строку записи: ' + label);
      cells++;
    }
    assert.equal(cells, 144);
    // M2-S1: ЭКГ записи у исполнителя 10, строка экрана у исполнителя 11 — одна услуга и для экрана
    assert.equal(isBookedTwin({ serviceId: 50, doctorId: 11, needsDoctor: false }, { serviceId: 50, doctorId: 10, needsDoctor: false }), true);
    // консультация у другого врача — другая запись (разбор ревью I1) — и для экрана
    assert.equal(isBookedTwin({ serviceId: 30, doctorId: 11, needsDoctor: true }, { serviceId: 30, doctorId: 10, needsDoctor: true }), false);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 (ревью денег S1): сеть R7b на правиле shared/same-service.js — ЭКГ записи (исполнитель 10) уходит под ЭКГ стойки (исполнитель 11), консультация другого врача — нет', async () => {
  const t = await startCrmApp((db) => {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'nurse', 'x', 'Петрова', 'doctor', 1)").run();
    db.prepare("INSERT INTO services (id, name, price, type, requires_doctor, duration_minutes) VALUES (50, 'ЭКГ', 50000, 'procedure', 0, 15)").run();
  });
  try {
    const ekg = await callcenterBook(t, TODAY, { hour: 22, svc: 50, doctor: 10 });
    const y = await addVisitLine(t, 'reg', ekg, { svc: 50, doctor: 11 });
    assert.deepEqual(vsOf(t, ekg).map((r) => r.id), [y], 'вторая ЭКГ в визите');
    const consult = await callcenterBook(t, localDay(1), { hour: 12, svc: 30, doctor: 10 });
    const x = vsOf(t, consult)[0].id;
    const y2 = await addVisitLine(t, 'reg', consult, { svc: 30, doctor: 11 });
    assert.deepEqual(vsOf(t, consult).map((r) => r.id), [x, y2], 'консультация другого врача заменила запись');
  } finally { t.close(); }
});
