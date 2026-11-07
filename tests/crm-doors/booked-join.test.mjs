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
