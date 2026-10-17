// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r2/zz-f2-r1b.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW (funnel lens) of CRM_LINK_ALL_V1 T1-T3 — batch B.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, cardLines, addVisitLine, calendarBook, callcenterBook, deskRegister } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const D3 = localDay(3);

// B1 — the F3b mechanism for a card step C already took before T1 (fresh lineless S1 card): pre-existing?
test('CRM_ONE_WAY_V1 (повтор r2) — B1 (pre-existing check): S1 card, registrar book+cancel+rebook same day — phantom consultation in the new visit?', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const vid = await calendarBook(t, 'reg', D3, { svc: 30, doctor: 10 });
    const c = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(D3, 12), status: 'cancelled' });
    assert.equal(c.status, 200, c.text);
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 40, start: at(D3, 15), duration_minutes: 30, status: 'scheduled' });
    const v2 = b.json.data.visit.id;
    await addVisitLine(t, 'reg', v2, { svc: 40, doctor: null });
    console.log('B1 second visit lines', JSON.stringify(vsOf(t, v2).map((x) => x.service_id)), 'card', t.lead(rid).status);
    assert.deepEqual(vsOf(t, v2).map((x) => x.service_id), [40]);
  } finally { t.close(); }
});

// B9 — R6 writes 'done' lines for every desk service; a service removed from the visit afterwards stays 'done' on the card.
test('CRM_ONE_WAY_V1 (повтор r2) — B9: desk service removed from the visit right after registration must not stay "done" on the card', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const { vid, ids } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }, { svc: 40 }] });
    console.log('B9 card after desk', JSON.stringify(cardLines(t, rid).map((l) => [l.service_id, l.status, l.visit_service_id])), 'lead', JSON.stringify(t.lead(rid)), 'link', JSON.stringify(link(t, vid)), 'all', JSON.stringify(t.db.prepare('SELECT id, request_id, status, visit_id, visit_service_id FROM crm_request_services').all()), 'vs', JSON.stringify(vsOf(t, vid)));
    const del = await t.dbq('reg', { table: 'visit_services', op: 'delete', filters: [{ col: 'id', op: 'eq', val: ids[1] }] });
    console.log('B9 delete', del.status, del.text.slice(0, 200));
    let removed = del.status === 200 && !t.db.prepare('SELECT 1 FROM visit_services WHERE id = ?').get(ids[1]);
    if (!removed) {
      const r = await t.rpc('remove_own_visit_line', 'reg', { visit_service_id: ids[1] });
      console.log('B9 remove_own_visit_line', r.status, r.text.slice(0, 200));
      removed = !t.db.prepare("SELECT 1 FROM visit_services WHERE id = ? AND status <> 'cancelled'").get(ids[1]);
    }
    console.log('B9 removed?', removed, 'visit lines', JSON.stringify(vsOf(t, vid).map((x) => x.service_id)));
    const lines = cardLines(t, rid).map((l) => [l.service_id, l.status]);
    console.log('B9 card after removal', JSON.stringify(lines));
    assert.ok(removed, 'could not remove the line in this harness');
    assert.ok(!lines.some(([s, st]) => s === 40 && st === 'done'), 'card shows the removed analysis as DONE (invariant: done = service in the visit)');
  } finally { t.close(); }
});

// B7 — strict phone rule with a guardian sharing the number (unchanged by T2?)
test('CRM_ONE_WAY_V1 (повтор r2) — B7: phone lead on a number a child\'s guardian record also carries — no match, no link', async () => {
  const t = await startCrmApp();
  try {
    t.db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78, 'Ребёнок Тест', '')").run();
    t.db.prepare("INSERT INTO patient_guardians (patient_id, guardian_patient_id, name, phone) VALUES (78, NULL, 'Мама', '+998 90 909 26 38')").run();
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '' });
    const vid = await calendarBook(t, 'reg', D3);
    console.log('B7 lead patient', t.lead(rid).patient_id, 'link', link(t, vid));
    assert.equal(t.lead(rid).patient_id, null);
    assert.equal(link(t, vid), null);
  } finally { t.close(); }
});

// B8 — branch-sync visit: no link, no R6 lines
test('CRM_ONE_WAY_V1 (повтор r2) — B8: sync_origin visit — C′ / R6 do nothing', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'came' });
    const live = addLead(t.db, {});
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by, sync_origin) VALUES (77, 10, ?, 'scheduled', 2, 'B')").run(at(TODAY, 10)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, rid);
    t.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, 40, 1, 40000, 40000, 'added')").run(vid);
    const { crmLinkVisit } = await import('../services/crm/visit-link.js');
    crmLinkVisit(t.db, vid, { id: 2, role: 'registrar', extra_roles: [] }, { desk: true });
    assert.deepEqual(cardLines(t, rid), []);
    assert.equal(t.lead(live).status, 'in_process');
  } finally { t.close(); }
});
