// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r1/zz-money-wonlines-edges.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW (money / data-integrity) — crmWonCardLines edges + I7.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, calendarBook, deskRegister, addVisitLine } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const all = (t, rid) => t.db.prepare('SELECT service_id, status, visit_id, visit_service_id FROM crm_request_services WHERE request_id = ? ORDER BY id').all(rid);

test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-WON E1: desk closes today\'s fresh card B while an OLD «Пришёл» card A holds the visit by its R3 line — registered services go to B, not to A', async () => {
  const t = await startCrmApp();
  try {
    const a = addLead(t.db, { status: 'came', updated: daysAgoIso(9), name: 'A' });
    addLine(t.db, a, { svc: 40, day: TODAY });
    const b = addLead(t.db, { name: 'B' });
    const { vid, ids } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
    console.log('B status', t.lead(b).status, 'link', JSON.stringify(link(t, vid)));
    console.log('A lines', JSON.stringify(all(t, a)), 'B lines', JSON.stringify(all(t, b)), 'visit', JSON.stringify(vsOf(t, vid)));
    assert.equal(t.lead(b).status, 'came', 'precondition: the desk closed B');
    assert.ok(!all(t, a).some((l) => l.service_id === 30), 'today\'s consultation written onto last week\'s «Пришёл» card A');
    // CRM_ONE_WAY_V1 (O2, P-7) — строк-копий нет: карточка B показывает визит «Записями пациента».
    assert.deepEqual(all(t, b), []);
    const cb = await t.rpc('crm_card_bookings', 'cc', { request_id: b });
    assert.equal(cb.status, 200, cb.text);
    assert.ok(cb.json.data.bookings.some((x) => x.visit_id === vid), 'card B the desk closed today shows no services');
  } finally { t.close(); }
});

// CRM_ONE_WAY_V1 — УБРАН: ZZ-WON E2 проверял crmWonCardLines (удалён в ред. 2; строк «оказана» нет — O2).

test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-WON E3 (I7): card-line insert fails inside crmWonCardLines — fast registration and cashier_line_add still succeed', async () => {
  const t = await startCrmApp((db) => {
    db.exec("CREATE TRIGGER zz_no_done BEFORE INSERT ON crm_request_services WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'zz boom'); END;");
  });
  try {
    const rid = addLead(t.db, {});
    const { vid, ids } = await deskRegister(t, 'reg');
    assert.equal(t.lead(rid).status, 'came');
    const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const add = await t.rpc('cashier_line_add', 'boss', { invoice_id: inv.json.data.invoice.id, service_id: 40, doctor_id: null });
    assert.equal(add.status, 200, add.text);
    const tot = Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount);
    assert.equal(tot, 140000);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r1) — ZZ-WON E4 (I7): link insert fails inside C′ — the calendar booking still succeeds with its line', async () => {
  const t = await startCrmApp((db) => {
    db.exec("CREATE TRIGGER zz_no_link BEFORE INSERT ON crm_booking_links BEGIN SELECT RAISE(ABORT, 'zz boom'); END;");
  });
  try {
    const rid = addLead(t.db, { date: localDay(3) });
    addLine(t.db, rid, { svc: 40, day: localDay(3) });
    const vid = await calendarBook(t, 'reg', localDay(5));
    assert.deepEqual(vsOf(t, vid).map((x) => x.service_id), [30]);
    assert.equal(t.lead(rid).status, 'in_process', 'half-applied C′ (stage moved without link)');
  } finally { t.close(); }
});
