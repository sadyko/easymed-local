// CRM_BOOKING_LOG_V1 (2026-11-23, владелец: «we need to add a log. for reviewing the which user sends,
// applied discount what service and what analyses should be performed») — СТРОКА «ЗАПИСЕЙ CRM»
// НАЗЫВАЕТ: кто записал (оператор колл-центра), кто оформил (регистратура), скидку (сколько, какая,
// кто дал) и анализы отдельно от услуг. Стенд — настоящее приложение (crm-unify-app.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { callcenterBook } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const seed = (db) => {
  db.prepare("INSERT INTO patient_categories (id, name, discount_percent, active) VALUES (903, 'Ветераны', 10, 1)").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (80, 'Анализова Вера', '+998 90 000 00 80')").run();
};
const waiting = async (t, args = {}) => {
  const r = await t.rpc('registrar_waiting', 'reg', args);
  assert.equal(r.status, 200, r.text);
  return new Map(r.json.data.rows.map((x) => [x.patient_id + '|' + x.status, x]));
};

test('ждёт: «Записал(а)» — оператор, анализы отдельно, оформившего и скидки ещё нет', async () => {
  const t = await startCrmApp(seed);
  try {
    await callcenterBook(t, TODAY, { hour: 12, svc: 30, doctor: 10, pid: 77 });
    const rid = addLead(t.db, { patient: 80, phone: '+998 90 000 00 80', name: 'Анализова Вера' });
    addLine(t.db, rid, { svc: 40, day: TODAY });
    const m = await waiting(t);
    const cc = m.get('77|waiting');
    assert.ok(cc, 'записи колл-центра нет в списке');
    assert.deepEqual(cc.booked_by, ['Оператор А'], 'кто записал — не оператор');
    assert.deepEqual(cc.analyses, [], 'консультация попала в анализы');
    assert.deepEqual(cc.registered_by, []);
    assert.equal(cc.discount, null);
    const lab = m.get('80|waiting');
    assert.ok(lab, 'анализа «на дату» нет в списке');
    assert.deepEqual(lab.analyses, ['Анализ крови'], 'анализ не назван анализом');
    assert.ok(lab.services.includes('Анализ крови'), 'services по-прежнему называют всё');
  } finally { t.close(); }
});

test('оформлен со скидкой группы: «Оформил(а)» — регистратура, скидка — сумма, причина и кто дал', async () => {
  const t = await startCrmApp(seed);
  try {
    const vid = await callcenterBook(t, TODAY, { hour: 12, svc: 30, doctor: 10, pid: 77 });
    t.db.prepare('UPDATE patients SET category_id = 903 WHERE id = 77').run();
    const booked = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status = 'added'").all(vid).map((r) => r.id);
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    assert.equal(ev.status, 200, ev.text);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: booked, discount_choice: 'group', payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.ok(Number(inv.json.data.invoice.discount_amount) > 0, 'стенд: скидка группы не дана');
    const m = await waiting(t, { status: 'all' });
    const row = m.get('77|registered');
    assert.ok(row, 'оформленной записи нет при «Все»: ' + JSON.stringify([...m.keys()]));
    assert.deepEqual(row.booked_by, ['Оператор А']);
    assert.deepEqual(row.registered_by, ['Регистратура'], 'кто оформил — не регистратура');
    assert.ok(row.discount, 'скидки в строке нет');
    assert.equal(row.discount.amount, 10000, 'скидка — не 10% от 100 000');
    assert.equal(row.discount.base, 100000);
    assert.deepEqual(row.discount.by, ['Регистратура']);
    assert.ok(row.discount.notes.length === 1 && row.discount.notes[0].includes('Ветераны'), 'причина скидки не названа: ' + JSON.stringify(row.discount.notes));
  } finally { t.close(); }
});
