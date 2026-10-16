// CRM_LINK_ALL_V1 (2026-10-16) — R6 (дефект G4): УСЛУГИ ВИЗИТА, ЗАКРЫВШЕГО КАРТОЧКУ НА СТОЙКЕ,
// ВИДНЫ НА КАРТОЧКЕ. CRM_LINK_ALL_V1 (редакция 2, «показывать, а не копировать») — строками
// карточки 'done' их больше не пишут (crmWonCardLines удалён: 'done' до прихода — доказательство
// прихода, двойной счёт): карточка, которую закрыла стойка, держит визит привязкой, и её список
// «Записи пациента» (RPC crm_card_bookings) показывает его услуги. Деньги не меняются; другие
// карточки визит не получают.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, cardLines, addVisitLine, deskRegister } from '../test-helpers/crm-link-all.js';

test('CRM_LINK_ALL_V1 R6 (ред. 2): быстрая регистрация звонившего — «Пришёл», визит привязан к карточке; строк «оказана» не заводится, счёт прежний', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const { vid, ids } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }, { svc: 40 }] });
    assert.equal(t.lead(rid).status, 'came');
    assert.equal(link(t, vid).request_id, rid, 'визит не привязан к карточке, которую закрыла стойка');
    assert.deepEqual(cardLines(t, rid), [], 'строки визита записаны в карточку');
    assert.deepEqual(vsOf(t, vid).map((x) => x.id), ids, 'строки визита изменились');
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount), 140000);
    assert.deepEqual(cardLines(t, rid), [], 'счёт завёл на карточке строки');
    const bk = await t.rpc('crm_card_bookings', 'boss', { request_id: rid });
    assert.equal(bk.status, 200, bk.text);
    assert.deepEqual(bk.json.data.bookings.map((b) => [b.visit_id, b.services.map((s) => s.name)]), [[vid, ['Консультация терапевта', 'Анализ крови']]],
      'карточка, которую закрыла стойка, не показывает услуги своего визита');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R6 (ред. 2): касса добавляет услугу к счёту визита стойки — карточка «Пришёл» строк не получает, визит по-прежнему её', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const { vid, ids } = await deskRegister(t, 'reg');
    const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const add = await t.rpc('cashier_line_add', 'boss', { invoice_id: inv.json.data.invoice.id, service_id: 40, doctor_id: null });
    assert.equal(add.status, 200, add.text);
    assert.deepEqual(cardLines(t, rid), []);
    assert.equal(link(t, vid).request_id, rid);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R6 (ред. 2): только карточка, которую закрыла стойка, — «Пришёл» прошлого визита и «Отказ» не трогаются', async () => {
  const t = await startCrmApp();
  try {
    const past = addLead(t.db, { status: 'came', updated: daysAgoIso(9) });
    const refused = addLead(t.db, { status: 'stopped' });
    const fresh = addLead(t.db, {});
    const { vid } = await deskRegister(t, 'reg');
    assert.equal(link(t, vid).request_id, fresh);
    assert.deepEqual(cardLines(t, fresh), []);
    assert.deepEqual(cardLines(t, past), [], 'карточке прошлого прихода приписана сегодняшняя услуга');
    assert.deepEqual(cardLines(t, refused), [], '«Отказу» приписана услуга');
    assert.equal(t.lead(past).status, 'came');
    assert.equal(t.lead(refused).status, 'stopped');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R6 (ред. 2): услуга, добавленная к визиту ПРОШЛОГО дня, на карточку «Пришёл» не пишется', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'came' });
    const y = localDay(-1);
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 2)").run(at(y, 10)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, rid);
    await addVisitLine(t, 'reg', vid, { svc: 40, doctor: null });
    assert.deepEqual(cardLines(t, rid), []);
  } finally { t.close(); }
});
