// CRM_LINK_ALL_V1 (2026-10-16) — R6 (дефект G4): УСЛУГИ ВИЗИТА, ЗАКРЫВШЕГО КАРТОЧКУ НА СТОЙКЕ,
// — НА КАРТОЧКЕ. Быстрая регистрация закрывает карточку в «Пришёл» раньше, чем в визите
// появляются строки; теперь каждая строка-услуга этого визита (вставленная стойкой,
// мастером «сейчас» или кассой) — строка карточки 'done' с visit_service_id. Только карточка,
// держащая этот визит; карточка остаётся «Пришёл»; деньги не меняются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, cardLines, addVisitLine, deskRegister } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);

test('CRM_LINK_ALL_V1 R6: быстрая регистрация звонившего — «Пришёл», и обе услуги визита на карточке строками done', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const { vid, ids } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }, { svc: 40 }] });
    assert.equal(t.lead(rid).status, 'came');
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.scheduled_date, l.status, l.visit_id, l.visit_service_id, l.visit_service_auto]),
      [[30, TODAY, 'done', vid, ids[0], 0], [40, TODAY, 'done', vid, ids[1], 0]]);
    assert.deepEqual(vsOf(t, vid).map((x) => x.id), ids, 'строки визита изменились (R6 — только визит → карточка)');
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount), 140000);
    assert.equal(cardLines(t, rid).length, 2, 'счёт завёл на карточке лишние строки');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R6: касса добавляет услугу к счёту визита стойки — и она на карточке «Пришёл»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const { vid, ids } = await deskRegister(t, 'reg');
    const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const add = await t.rpc('cashier_line_add', 'boss', { invoice_id: inv.json.data.invoice.id, service_id: 40, doctor_id: null });
    assert.equal(add.status, 200, add.text);
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.status]), [[30, 'done'], [40, 'done']]);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R6: только карточка, держащая визит, — «Пришёл» прошлого визита и «Отказ» не трогаются', async () => {
  const t = await startCrmApp();
  try {
    const past = addLead(t.db, { status: 'came', updated: daysAgoIso(9) });
    const refused = addLead(t.db, { status: 'stopped' });
    const fresh = addLead(t.db, {});
    const { vid } = await deskRegister(t, 'reg');
    assert.equal(link(t, vid).request_id, fresh);
    assert.deepEqual(cardLines(t, fresh).map((l) => l.service_id), [30]);
    assert.deepEqual(cardLines(t, past), [], 'карточке прошлого прихода приписана сегодняшняя услуга');
    assert.deepEqual(cardLines(t, refused), [], '«Отказу» приписана услуга');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R6: услуга, добавленная к визиту ПРОШЛОГО дня, на карточку «Пришёл» не пишется', async () => {
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
