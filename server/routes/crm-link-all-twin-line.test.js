// CRM_LINK_ALL_V1 (2026-10-16) — CRM_TWIN_LINE: ОТМЕНЁННАЯ ЗАПИСЬ НЕ ДАЁТ ВТОРОЙ УСЛУГИ В СЛЕДУЮЩЕЙ.
//
// Двойной счёт с CRM_UNIFY_V1 (на main; держит выпуск 3.17.0). Механизм: отмена записи
// отпускала строку карточки (visit_id → NULL), но оставляла её строку визита — строку
// отменённого визита 'added', свободную. Следующая запись того же дня брала строку карточки
// по дате (шаг A), и зеркало ПЕРЕНОСИЛО ту строку в новый визит, а экран добавлял свою —
// две консультации; запись другой услуги получала консультацию-фантом.
//
// Повторы ревью: zz-money-mech C1 / C2 (раунд 1), zz-f2-r1b B1 (раунд 2) — настоящими
// тестами, со счётом кассы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, addVisitLine, calendarBook, deskRegister } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const D2 = localDay(5);
const D3 = localDay(3);
const vsAll = (t, vid) => t.db.prepare("SELECT service_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((x) => x.service_id);
const cancel = (t, vid, day, hour) => t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(day, hour), status: 'cancelled' });
async function billOf(t, vid) {
  const ids = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((r) => r.id);
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  return Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount);
}

test('CRM_TWIN_LINE (C1): карточка ждёт без даты, регистратура записала консультацию на D2, отменила и записала снова на D2 — одна консультация, счёт 100 000', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const v1 = await calendarBook(t, 'reg', D2, { hour: 12 });
    assert.deepEqual(link(t, v1), { request_id: rid, source: 'match' });
    assert.equal((await cancel(t, v1, D2, 12)).status, 200);
    const v2 = await calendarBook(t, 'reg', D2, { hour: 15 });
    assert.deepEqual(vsAll(t, v2), [30], 'в визите две консультации');
    assert.equal(await billOf(t, v2), 100000);
    assert.deepEqual(vsAll(t, v1), [30], 'строку отменённого визита унесли');
  } finally { t.close(); }
});

test('CRM_TWIN_LINE (C2): запись на сегодня 17:00 отменили, пациент пришёл на анализ — в визите только анализ, счёт 40 000', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, {});
    const v1 = await calendarBook(t, 'reg', TODAY, { hour: 17 });
    assert.equal((await cancel(t, v1, TODAY, 17)).status, 200);
    const { vid } = await deskRegister(t, 'reg', { items: [{ svc: 40, doctor: null }] });
    assert.deepEqual(vsAll(t, vid), [40], 'консультация отменённой записи в визите стойки');
    assert.equal(await billOf(t, vid), 40000);
  } finally { t.close(); }
});

test('CRM_TWIN_LINE (B1): консультацию на D3 отменили, на D3 записали анализ — в визите только анализ, счёт 40 000', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, {});
    const v1 = await calendarBook(t, 'reg', D3, { svc: 30, doctor: 10 });
    assert.equal((await cancel(t, v1, D3, 12)).status, 200);
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 40, start: at(D3, 15), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v2 = b.json.data.visit.id;
    await addVisitLine(t, 'reg', v2, { svc: 40, doctor: null });
    assert.deepEqual(vsAll(t, v2), [40], 'консультация-фантом в записи анализа');
    assert.equal(await billOf(t, v2), 40000);
  } finally { t.close(); }
});

test('CRM_TWIN_LINE: колл-центр записал на D2 из карточки, консультацию поставила регистратура; запись отменили, регистратура записала снова с консультацией — одна консультация, счёт 100 000', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D2, 12), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v1 = b.json.data.visit.id;
    assert.deepEqual(link(t, v1), { request_id: rid, source: 'callcenter' });
    await addVisitLine(t, 'reg', v1, { svc: 30, doctor: 10 });
    assert.equal((await cancel(t, v1, D2, 12)).status, 200);
    const v2 = await calendarBook(t, 'reg', D2, { hour: 15 });
    assert.deepEqual(vsAll(t, v2), [30], 'в визите две консультации');
    assert.equal(await billOf(t, v2), 100000);
  } finally { t.close(); }
});

test('CRM_TWIN_LINE: желание карточки без даты взяло консультацию регистратуры; запись отменили — желание ждёт снова, без строки отменённого визита; новая запись с консультацией — одна, счёт 100 000', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { updated: daysAgoIso(1), date: D2 });   // карточка ждёт D2 (шаг C)
    const wish = addLine(t.db, rid, { svc: 30, doctor: 10 });   // без даты — желание оператора
    t.db.prepare('UPDATE crm_request_services SET created_at = ? WHERE id = ?').run(daysAgoIso(1), wish);
    const v1 = await calendarBook(t, 'reg', D2, { hour: 12 });
    const held = t.db.prepare('SELECT status, visit_id, visit_service_id FROM crm_request_services WHERE id = ?').get(wish);
    assert.deepEqual(link(t, v1), { request_id: rid, source: 'match' });
    assert.equal(held.visit_id, v1, 'желание не взяло запись');
    assert.equal((await cancel(t, v1, D2, 12)).status, 200);
    const after = t.db.prepare('SELECT status, visit_id, visit_service_id FROM crm_request_services WHERE id = ?').get(wish);
    assert.deepEqual([after.status, after.visit_id, after.visit_service_id], ['pending', null, null], 'желание держит строку отменённого визита');
    const v2 = await calendarBook(t, 'reg', D2, { hour: 15 });
    assert.deepEqual(vsAll(t, v2), [30], 'в визите две консультации');
    assert.equal(await billOf(t, v2), 100000);
  } finally { t.close(); }
});

// Строки, которые прежняя отмена оставила со строкой визита отменённой записи (базы клиник до
// правки): шаг A связи разбирает их тем же правилом, прежде чем они возьмут новую запись.
// CRM_ONE_WAY_V1 — копий строк визита в карточке больше нет (O2), поэтому строку «как до
// правки» (копию строки регистратуры: день отменённой записи, ссылка на её строку визита)
// заводим сами. Шаг A такую строку не берёт (она отпущена прежней отменой), разовое
// исправление (O8) снимает с неё ссылку.
const asBefore = (t, vid) => {
  const link = t.db.prepare('SELECT request_id FROM crm_booking_links WHERE visit_id = ?').get(vid);
  const rid = link ? link.request_id : t.db.prepare('SELECT id FROM crm_requests ORDER BY id LIMIT 1').get().id;
  const day = t.db.prepare("SELECT date(visit_date, 'localtime') AS d FROM visits WHERE id = ?").get(vid).d;
  let changes = 0;
  for (const x of t.db.prepare('SELECT * FROM visit_services WHERE visit_id = ?').all(vid)) {
    changes += t.db.prepare(`INSERT INTO crm_request_services (request_id, service_id, doctor_id, scheduled_date, status, visit_service_id, visit_service_auto)
                             VALUES (?, ?, ?, ?, 'pending', ?, 0)`).run(rid, x.service_id, x.doctor_id, day, x.id).changes;
  }
  return { changes };
};
test('CRM_TWIN_LINE (база до правки, C1): строка карточки со строкой отменённой записи — новая запись того же дня с консультацией: одна, счёт 100 000', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, {});
    const v1 = await calendarBook(t, 'reg', D2, { hour: 12 });
    assert.equal((await cancel(t, v1, D2, 12)).status, 200);
    assert.ok(asBefore(t, v1).changes >= 1, 'нет строки, чтобы вернуть её в прежний вид');
    const v2 = await calendarBook(t, 'reg', D2, { hour: 15 });
    assert.deepEqual(vsAll(t, v2), [30], 'в визите две консультации');
    assert.equal(await billOf(t, v2), 100000);
  } finally { t.close(); }
});

test('CRM_TWIN_LINE (база до правки, B1): строка карточки со строкой отменённой консультации — запись анализа того же дня: только анализ, счёт 40 000', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, {});
    const v1 = await calendarBook(t, 'reg', D3, { svc: 30, doctor: 10 });
    assert.equal((await cancel(t, v1, D3, 12)).status, 200);
    assert.ok(asBefore(t, v1).changes >= 1);
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 40, start: at(D3, 15), duration_minutes: 30, status: 'scheduled' });
    const v2 = b.json.data.visit.id;
    await addVisitLine(t, 'reg', v2, { svc: 40, doctor: null });
    assert.deepEqual(vsAll(t, v2), [40], 'консультация-фантом в записи анализа');
    assert.equal(await billOf(t, v2), 40000);
  } finally { t.close(); }
});

test('CRM_TWIN_LINE (база до правки): запись колл-центра со строкой регистратуры — повторная запись с консультацией: одна, счёт 100 000', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, { assigned: 3 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D2, 12), duration_minutes: 30, status: 'scheduled' });
    const v1 = b.json.data.visit.id;
    await addVisitLine(t, 'reg', v1, { svc: 30, doctor: 10 });
    assert.equal((await cancel(t, v1, D2, 12)).status, 200);
    assert.ok(asBefore(t, v1).changes >= 1);
    const v2 = await calendarBook(t, 'reg', D2, { hour: 15 });
    assert.deepEqual(vsAll(t, v2), [30], 'в визите две консультации');
    assert.equal(await billOf(t, v2), 100000);
  } finally { t.close(); }
});
