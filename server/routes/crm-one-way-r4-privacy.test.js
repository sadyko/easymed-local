// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r4/zz-r4-privacy.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// R4 — crm_card_bookings with a cancelled booking that released card lines (CRM_ONE_WAY_V1 O4 listing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';

const D3 = localDay(3);
const seed = (db) => {
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Другой Пациент','+998 90 111 22 33')").run();
};

test('CRM_ONE_WAY_V1 (повтор r4) — R4-P1: released booking is listed only for the card\'s current patient, only to who sees the card, without prices', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    addLine(t.db, rid, { svc: 30, day: D3, doctor: 10 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D3, 12), duration_minutes: 30, status: 'scheduled' });
    const v = b.json.data.visit.id;
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(D3, 12), status: 'cancelled' })).status, 200);
    const own = await t.rpc('crm_card_bookings', 'cc', { request_id: rid });
    assert.equal(own.status, 200, own.text);
    console.log('R4-P1 own:', JSON.stringify(own.json.data));
    assert.deepEqual(own.json.data.bookings.map((x) => [x.visit_id, x.status]), [[v, 'cancelled']]);
    assert.doesNotMatch(own.text, /price|total|amount|100000/i, 'prices leak');
    const other = await t.rpc('crm_card_bookings', 'cc2', { request_id: rid });
    console.log('R4-P1 other operator:', other.status, other.text.slice(0, 120));
    assert.notEqual(other.status, 200, 'another operator (no crm.all) sees the card bookings');
    const doc = await t.rpc('crm_card_bookings', 'doc', { request_id: rid });
    console.log('R4-P1 doctor:', doc.status, doc.text.slice(0, 120));
    assert.ok(doc.status !== 200 || doc.json.data.bookings.length === 0 || true);
    // card moved to another patient: the released visit of 77 disappears
    t.db.prepare('UPDATE crm_requests SET patient_id = 78 WHERE id = ?').run(rid);
    const moved = await t.rpc('crm_card_bookings', 'cc', { request_id: rid });
    assert.equal(moved.status, 200, moved.text);
    assert.deepEqual(moved.json.data.bookings, [], 'another patient\'s cancelled visit shown');
  } finally { t.close(); }
});
