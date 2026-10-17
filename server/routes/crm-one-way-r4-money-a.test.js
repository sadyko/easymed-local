// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r4/zz-r4-money-a.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// R4 adversarial review (CRM_ONE_WAY_V1) — repros asserting the SAFE behaviour. Scratch only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';

const vsAll = (t, vid) => t.db.prepare("SELECT id, service_id, doctor_id, quantity FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((x) => ({ ...x }));
const cancel = (t, vid, day, hour) => t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(day, hour), status: 'cancelled' });
const lineOf = (t, id) => t.db.prepare('SELECT * FROM crm_request_services WHERE id = ?').get(id);
const seed = (db) => {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петров', 'doctor', 1)").run();
};

// H1 — mistaken cancel, then the registrar marks the (cancelled) visit «Пришёл» directly.
test('CRM_ONE_WAY_V1 (повтор r4) — R4-H1: cancelled -> arrived (no «Записан» in between): the card line is not left as a released wish of a delivered service; card closed', async () => {
  const t = await startCrmApp(seed);
  try {
    const today = localDay(0);
    const rid = addLead(t.db, { assigned: 3 });
    const lid = addLine(t.db, rid, { svc: 30, day: today, doctor: 10 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(today, 23), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v = b.json.data.visit.id;
    const x = lineOf(t, lid).visit_service_id;
    assert.ok(x, 'O1 attached');
    assert.equal((await cancel(t, v, today, 23)).status, 200);
    assert.equal(lineOf(t, lid).released_from_visit_id, v);
    const arr = await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(today, 23), status: 'arrived' });
    assert.equal(arr.status, 200, arr.text);
    assert.deepEqual(vsAll(t, v).map((r) => r.id), [x], 'visit keeps its consultation');
    const l = lineOf(t, lid);
    console.log('R4-H1 line after cancelled->arrived:', JSON.stringify({ st: l.status, day: l.scheduled_date, visit: l.visit_id, vs: l.visit_service_id, rel: l.released_from_visit_id }), 'card:', t.lead(rid).status);
    assert.equal(l.released_from_visit_id, null, 'card still says «Запись отменена — назначьте услуге новую дату» for the consultation the patient is receiving');
    assert.equal(l.visit_service_id, x);
    assert.equal(t.lead(rid).status, 'came', 'arrival did not reach the card');
  } finally { t.close(); }
});
