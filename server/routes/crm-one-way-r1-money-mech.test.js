// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r1/zz-money-mech.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW — is the C1/C2 mechanism pre-existing for a card step C already linked (fresh lineless card)?
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead } from '../test-helpers/crm-unify-app.js';
import { link, calendarBook, deskRegister } from '../test-helpers/crm-link-all.js';
const TODAY = localDay(0);
const D2 = localDay(5);
const vsAll = (t, vid) => t.db.prepare("SELECT service_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid).map((x) => x.service_id);
test('CRM_ONE_WAY_V1 (повтор r1) — MECH C1: fresh card (step C) — book D2, cancel, rebook D2', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, {});
    const v1 = await calendarBook(t, 'reg', D2, { hour: 12 });
    console.log('link', JSON.stringify(link(t, v1)));
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v1, start: at(D2, 12), status: 'cancelled' })).status, 200);
    const v2 = await calendarBook(t, 'reg', D2, { hour: 15 });
    console.log('v2', JSON.stringify(vsAll(t, v2)));
    assert.deepEqual(vsAll(t, v2), [30]);
  } finally { t.close(); }
});
test('CRM_ONE_WAY_V1 (повтор r1) — MECH C2: fresh card (step C) — book today 17:00, cancel, walk-in analysis', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, {});
    const v1 = await calendarBook(t, 'reg', TODAY, { hour: 17 });
    assert.equal((await t.rpc('calendar_book', 'reg', { visit_id: v1, start: at(TODAY, 17), status: 'cancelled' })).status, 200);
    const { vid } = await deskRegister(t, 'reg', { items: [{ svc: 40, doctor: null }] });
    console.log('walk-in', JSON.stringify(vsAll(t, vid)));
    assert.deepEqual(vsAll(t, vid), [40]);
  } finally { t.close(); }
});
