// DUP_STOP_V1 (2026-11-02) — «какую строку дверь уберёт под новой» БЕЗ изменений в базе:
// bookedTwinFor (сеть R7b, crm/booked-twin.js) и autoTwinFor (строка CRM уступает строке
// человека, crm/one-way.js). Запрет повтора (domain/dup-order.js) спрашивает их, чтобы не
// отказать строке, которая займёт место строки записи. Сама сеть R7b не изменилась —
// server/routes/crm-link-all-twin.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../../test-helpers/crm-unify-app.js';
import { callcenterBook, vsOf } from '../../test-helpers/crm-link-all.js';
import { bookedTwinFor } from './booked-twin.js';
import { autoTwinFor } from './one-way.js';

const TODAY = localDay(0);

test('DUP_STOP_V1: bookedTwinFor — строка записи колл-центра для ещё не вставленной строки той же услуги; база не меняется', async () => {
  const t = await startCrmApp();
  try {
    const vid = await callcenterBook(t, TODAY, { hour: 23 });
    const x = vsOf(t, vid)[0];
    const snap = JSON.stringify(vsOf(t, vid));
    assert.equal(bookedTwinFor(t.db, { visit_id: vid, service_id: 30, doctor_id: 10 }).id, x.id);
    assert.equal(bookedTwinFor(t.db, { visit_id: vid, service_id: 30, doctor_id: 11 }), null, 'консультация другого врача');
    assert.equal(bookedTwinFor(t.db, { visit_id: vid, service_id: 30, doctor_id: 10, quantity: 2 }), null, 'количество 2');
    assert.equal(bookedTwinFor(t.db, { visit_id: vid, service_id: 30, doctor_id: 10, status: 'in_progress' }), null, 'сразу в работе');
    assert.equal(bookedTwinFor(t.db, null), null);
    assert.equal(JSON.stringify(vsOf(t, vid)), snap, 'база изменилась');
  } finally { t.close(); }
});

test('DUP_STOP_V1: autoTwinFor — строка, которую CRM завела под желание, уступит строке той же услуги; база не меняется', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    addLine(t.db, rid, { svc: 40, day: TODAY });
    const ev = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(TODAY, 23) });
    assert.equal(ev.status, 200, ev.text);
    const vid = ev.json.data.visit.id;
    const auto = vsOf(t, vid).find((r) => r.service_id === 40);
    assert.ok(auto, 'желание карточки не село в визит');
    const snap = JSON.stringify(vsOf(t, vid));
    assert.equal(autoTwinFor(t.db, { visit_id: vid, service_id: 40 }).id, auto.id);
    assert.equal(autoTwinFor(t.db, { visit_id: vid, service_id: 30, doctor_id: 10 }), null, 'другая услуга');
    assert.equal(autoTwinFor(t.db, { visit_id: vid, service_id: 40, clinic_item_id: 5 }), null, 'товар');
    assert.equal(JSON.stringify(vsOf(t, vid)), snap, 'база изменилась');
  } finally { t.close(); }
});
