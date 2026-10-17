// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r2/zz-f2-funnel2.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL RE-REVIEW round 2 (funnel lens) — the same scenarios as zz-f2-funnel.test.js F-1/F-2b/F-9 but with a card
// that ONLY C′ takes (pending wish line on another day, so step C does not) — display links only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { link, calendarBook } from '../test-helpers/crm-link-all.js';
import { crmNoShowSweep } from '../services/crm/no-show.js';

const D3 = localDay(3);
const D7 = localDay(7);
const D10 = localDay(10);
const mark = (t, vid, day, hour, status, who = 'reg') => t.rpc('calendar_book', who, { visit_id: vid, start: at(day, hour), status });
const liveBookings = (t, rid) => t.db.prepare(`SELECT v.id FROM visits v WHERE v.status NOT IN ('cancelled','no_show') AND (
    v.id IN (SELECT visit_id FROM crm_booking_links WHERE request_id = ?) OR
    v.id IN (SELECT visit_id FROM crm_request_services WHERE request_id = ? AND status = 'pending'))`).all(rid, rid);
const card = (t, { stale = false } = {}) => {
  const rid = addLead(t.db, { status: 'recall', date: D10, updated: daysAgoIso(stale ? 5 : 1), assigned: 3 });
  addLine(t.db, rid, { svc: 40, day: localDay(12) });   // operator's wish for D+12, not booked
  return rid;
};

test('CRM_ONE_WAY_V1 (повтор r2) — G-1a: two registrar bookings, both C′ (display); cancel the FIRST → card date must follow to the remaining booking', async () => {
  const t = await startCrmApp();
  try {
    const rid = card(t);
    const v1 = await calendarBook(t, 'reg', D3);
    const v2 = await calendarBook(t, 'reg', D7, { svc: 30, doctor: 10, hour: 15 });
    console.log('G-1a links', JSON.stringify(link(t, v1)), JSON.stringify(link(t, v2)), 'card', t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    console.log('G-1a after cancel v1', t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.equal(t.lead(rid).scheduled_date, D7, 'card still shows the cancelled day');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — G-1b: two C′ bookings; cancel first, then second → card must not stay «Записан» with no live booking', async () => {
  const t = await startCrmApp();
  try {
    const rid = card(t);
    const v1 = await calendarBook(t, 'reg', D3);
    const v2 = await calendarBook(t, 'reg', D7, { svc: 30, doctor: 10, hour: 15 });
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    assert.equal((await mark(t, v2, D7, 15, 'cancelled')).status, 200);
    const L = t.lead(rid);
    console.log('G-1b after both cancelled', L.status, L.scheduled_date, 'live', liveBookings(t, rid).length,
      'undo', JSON.stringify(t.db.prepare('SELECT visit_id, prev_status, prev_scheduled_date, set_status FROM crm_booking_undo WHERE request_id = ?').all(rid)));
    crmNoShowSweep(t.db, { day: localDay(4) });
    console.log('G-1b after sweep D4', t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.equal(liveBookings(t, rid).length, 0);
    assert.notEqual(t.lead(rid).status, 'scheduled', 'card «Записан» although every booking is cancelled (P-3 trail only on v1)');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — G-1c: control — cancel in the other order (second, then first) → P-3 returns «Перезвонить» + D10', async () => {
  const t = await startCrmApp();
  try {
    const rid = card(t);
    const v1 = await calendarBook(t, 'reg', D3);
    const v2 = await calendarBook(t, 'reg', D7, { svc: 30, doctor: 10, hour: 15 });
    assert.equal((await mark(t, v2, D7, 15, 'cancelled')).status, 200);
    assert.equal((await mark(t, v1, D3, 12, 'cancelled')).status, 200);
    console.log('G-1c', t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.equal(t.lead(rid).status, 'recall');
    assert.equal(t.lead(rid).scheduled_date, D10);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — G-2: C′ booking, calendar «Подтверждён», then cancel → card must not stay «Подтверждён» (no booking left)', async () => {
  const t = await startCrmApp();
  try {
    const rid = card(t);
    const v = await calendarBook(t, 'reg', D3);
    console.log('G-2 booked', JSON.stringify(link(t, v)), t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.equal((await mark(t, v, D3, 12, 'confirmed')).status, 200);
    assert.equal(t.lead(rid).status, 'approved');
    assert.equal((await mark(t, v, D3, 12, 'cancelled')).status, 200);
    const L = t.lead(rid);
    crmNoShowSweep(t.db, { day: localDay(4) });
    console.log('G-2 cancelled', L.status, L.scheduled_date, 'after sweep', t.lead(rid).status, t.lead(rid).scheduled_date);
    assert.notEqual(t.lead(rid).status, 'approved', 'card «Подтверждён» for a cancelled booking — stuck');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — G-9: C′ (display) booking moved in the calendar → card date follows, updated_at untouched, stage unchanged', async () => {
  const t = await startCrmApp();
  try {
    const rid = card(t);
    const v = await calendarBook(t, 'reg', D3);
    t.db.prepare('UPDATE crm_requests SET updated_at = ? WHERE id = ?').run(daysAgoIso(2), rid);
    const before = t.lead(rid);
    const m = await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(D7, 15), status: 'scheduled' });
    assert.equal(m.status, 200, m.text);
    const after = t.lead(rid);
    console.log('G-9', JSON.stringify(link(t, v)), before.scheduled_date, '->', after.scheduled_date, before.updated_at, '->', after.updated_at, after.status);
    assert.equal(after.scheduled_date, D7);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.status, before.status);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — G-9b: C′ booking moved to a LATER day while the card also has an earlier booking → date stays on the earlier one', async () => {
  const t = await startCrmApp();
  try {
    const rid = card(t);
    const v1 = await calendarBook(t, 'reg', D3);
    const v2 = await calendarBook(t, 'reg', localDay(5), { hour: 15 });
    const m = await t.rpc('calendar_book', 'reg', { visit_id: v2, start: at(D7, 15), status: 'scheduled' });
    assert.equal(m.status, 200, m.text);
    console.log('G-9b', t.lead(rid).scheduled_date);
    assert.equal(t.lead(rid).scheduled_date, D3);
  } finally { t.close(); }
});
