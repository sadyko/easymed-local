// CRM_LINK_ALL_V1 (редакция 2, 2026-10-16) — «ЗАПИСИ ПАЦИЕНТА» В КАРТОЧКЕ CRM: RPC crm_card_bookings.
// Карточка показывает свои записи списком, а не строками-копиями: каждый живой или прошлый визит,
// который держит карточка — строкой, привязкой записи любого вида (и «только для воронки»: C′,
// телефон, стойка), — день и время, врач, состояние (Записан / Подтверждён / Пришёл / Не пришёл /
// Отменён) и услуги (название, количество, статус строки; БЕЗ ЦЕН). Видит только тот, кто видит
// карточку (то же правило строк, что у crm_requests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { calendarBook, callcenterBook, deskRegister } from '../test-helpers/crm-link-all.js';
import { crmCardBookings } from '../services/rpc/crm-card-bookings.js';

const D = localDay(3);
const D2 = localDay(5);
const list = async (t, who, rid) => {
  const r = await t.rpc('crm_card_bookings', who, { request_id: rid });
  assert.equal(r.status, 200, r.text);
  return r.json.data.bookings;
};
const brief = (b) => ({ day: b.day, status: b.status, doctor: b.doctor && b.doctor.name, services: b.services.map((s) => [s.name, s.quantity, s.status]) });

test('CRM_LINK_ALL_V1 ред. 2: запись регистратуры на другой день (C′) — в «Записях пациента» карточки: день, врач, «Записан», услуга; цен нет', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const vid = await calendarBook(t, 'reg', D2);
    const bookings = await list(t, 'boss', rid);
    assert.deepEqual(bookings.map((b) => b.visit_id), [vid]);
    assert.deepEqual(brief(bookings[0]), { day: D2, status: 'scheduled', doctor: 'Иванов', services: [['Консультация терапевта', 1, 'added']] });
    assert.ok(Date.parse(bookings[0].start) === Date.parse(at(D2, 12)), 'время записи');
    assert.ok(!/price|total|amount|sum/i.test(JSON.stringify(bookings)), 'в ответе деньги: ' + JSON.stringify(bookings));
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2: карточка по телефону и карточка, которую закрыла стойка, — визит в их списке со всеми услугами', async () => {
  const t = await startCrmApp();
  try {
    const phone = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    const v1 = await calendarBook(t, 'reg', D);
    assert.deepEqual((await list(t, 'boss', phone)).map((b) => b.visit_id), [v1]);
  } finally { t.close(); }
  const t2 = await startCrmApp();
  try {
    const rid = addLead(t2.db, {});
    const { vid } = await deskRegister(t2, 'reg', { items: [{ svc: 30, doctor: 10 }, { svc: 40 }] });
    const bookings = await list(t2, 'boss', rid);
    assert.deepEqual(bookings.map((b) => b.visit_id), [vid]);
    assert.deepEqual(bookings[0].services.map((s) => s.name), ['Консультация терапевта', 'Анализ крови']);
  } finally { t2.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2: состояния записи — «Подтверждён», «Пришёл» (отметка или оплата в день визита), «Не пришёл», «Отменён»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const v1 = await callcenterBook(t, D);
    const mark = async (vid, status) => {
      const v = t.db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(vid);
      const r = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: v.visit_date, status });
      assert.equal(r.status, 200, r.text);
    };
    await mark(v1, 'confirmed');
    assert.equal((await list(t, 'boss', rid)).find((b) => b.visit_id === v1).status, 'confirmed');
    await mark(v1, 'cancelled');
    assert.equal((await list(t, 'boss', rid)).find((b) => b.visit_id === v1).status, 'cancelled', 'отменённая запись пропала из списка карточки');
    const v3 = await callcenterBook(t, D2);
    await mark(v3, 'no_show');
    assert.equal((await list(t, 'boss', rid)).find((b) => b.visit_id === v3).status, 'no_show');
    const v2 = await callcenterBook(t, localDay(0), { hour: 23 });
    const ids = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ?').all(v2).map((r) => r.id);
    const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: v2, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    await t.rpc('record_payment', 'kassa', { invoice_id: inv.json.data.invoice.id, amount: 100000, method: 'cash' });
    assert.equal((await list(t, 'boss', rid)).find((b) => b.visit_id === v2).status, 'arrived');
    assert.deepEqual((await list(t, 'boss', rid)).map((b) => b.status), ['arrived', 'cancelled', 'no_show'], 'порядок — по дате записи (сегодня, D, D2)');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 ред. 2: чужую карточку не видно — оператор Б не получает записи карточки оператора А (I8)', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    await callcenterBook(t, D);
    const r = await t.rpc('crm_card_bookings', 'cc2', { request_id: rid });
    assert.equal(r.status, 404, r.text);
    assert.ok(!r.text.includes('Консультация'), 'ответ раскрыл записи чужой карточки');
    assert.equal((await list(t, 'cc', rid)).length, 1, 'свой оператор не видит записи своей карточки');
    const bad = await t.rpc('crm_card_bookings', 'boss', { request_id: 'x' });
    assert.equal(bad.status, 400, bad.text);
    assert.throws(() => crmCardBookings(t.db, { request_id: rid }, { id: 99, role: 'cashier', extra_roles: [] }), /не найдена/, 'правило строк crm_requests: чужая карточка не видна');
  } finally { t.close(); }
});
