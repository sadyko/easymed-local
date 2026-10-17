// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r2/zz-f2-privacy.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL RE-REVIEW round 2 (privacy lens) — crm_card_bookings. Each test asserts the SAFE behaviour;
// a FAIL = the suspected problem is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, USERS } from '../test-helpers/crm-unify-app.js';
import { link, calendarBook } from '../test-helpers/crm-link-all.js';
import { crmCardBookings } from '../services/rpc/crm-card-bookings.js';

const D3 = localDay(3);
const D5 = localDay(5);

function visitFor(db, pid, day, hour = 10) {
  return Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (?, 10, ?, 'scheduled', 2)")
    .run(pid, at(day, hour)).lastInsertRowid);
}

test('CRM_ONE_WAY_V1 (повтор r2) — PRIV-1: crm_card_bookings row scope == /api/db crm_requests row scope, for every role; invisible == nonexistent', async () => {
  const t = await startCrmApp();
  try {
    const A = addLead(t.db, { assigned: 3, name: 'A' });
    const B = addLead(t.db, { assigned: 4, name: 'B' });
    const C = addLead(t.db, { assigned: null, name: 'C' });
    for (const rid of [A, B, C]) {
      const v = visitFor(t.db, 77, D3);
      t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'patient')").run(v, rid);
    }
    const ghost = await t.rpc('crm_card_bookings', 'cc', { request_id: 99999 });
    for (const [, login] of USERS) {
      const sel = await t.dbq(login, { table: 'crm_requests', op: 'select', columns: ['id'], filters: [{ col: 'id', op: 'in', val: [A, B, C] }] });
      const seen = new Set(sel.status === 200 ? (sel.json.data || []).map((r) => r.id) : []);
      for (const rid of [A, B, C]) {
        const r = await t.rpc('crm_card_bookings', login, { request_id: rid });
        console.log('PRIV-1', login, rid, 'db', seen.has(rid), 'rpc', r.status);
        assert.equal(r.status === 200, seen.has(rid), `${login} card ${rid}: rpc ${r.status} vs /api/db visible=${seen.has(rid)}`);
        if (r.status !== 200) {
          assert.equal(r.status, ghost.status, 'invisible card answers differently from a nonexistent one');
          assert.equal(r.json && r.json.error && r.json.error.message, ghost.json && ghost.json.error && ghost.json.error.message);
          assert.ok(!/visit|bookings/i.test(r.text.replace(/"code":"[a-z_]+"/, '')), 'error leaks detail: ' + r.text);
        }
      }
    }
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — PRIV-2: view-only CRM role (custom, crm: viewer) — same scope (own + unassigned), never another operator\'s card', async () => {
  const t = await startCrmApp((db) => {
    db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('crm_view', 'CRM просмотр', 'callcenter')").run();
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
      .run('crm_view', JSON.stringify({ sections: ['crm'], levels: { crm: 'viewer' } }));
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, custom_role_code) VALUES (12, 'view', 'x', 'Наблюдатель', 'callcenter', 'crm_view')").run();
  });
  try {
    const mine = addLead(t.db, { assigned: 12 });
    const other = addLead(t.db, { assigned: 3 });
    const nobody = addLead(t.db, { assigned: null });
    for (const rid of [mine, other, nobody]) t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'patient')").run(visitFor(t.db, 77, D3), rid);
    const viewer = { id: 12, role: 'callcenter', custom_role_code: 'crm_view', extra_roles: [] };
    assert.equal(crmCardBookings(t.db, { request_id: mine }, viewer).bookings.length, 1);
    assert.equal(crmCardBookings(t.db, { request_id: nobody }, viewer).bookings.length, 1);
    assert.throws(() => crmCardBookings(t.db, { request_id: other }, viewer), (e) => e.status === 404);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — PRIV-3: card whose PATIENT CHANGED must not keep showing the previous patient\'s visits (doctor + services)', async () => {
  const t = await startCrmApp((db) => {
    db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78, 'Другой Пациент', '+998 90 111 22 33')").run();
  });
  try {
    const rid = addLead(t.db, { assigned: 3, updated: daysAgoIso(1) });
    const v = await calendarBook(t, 'reg', D3);            // C′ — registrar books patient 77, the card shows it
    console.log('PRIV-3 link', JSON.stringify(link(t, v)));
    assert.equal(link(t, v) && link(t, v).request_id, rid);
    // operator realises the card is about another person and re-links it to patient 78
    const up = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { patient_id: 78 }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(up.status, 200, up.text);
    const r = await t.rpc('crm_card_bookings', 'cc', { request_id: rid });
    console.log('PRIV-3 card of patient 78 shows', r.text);
    const shown = r.json.data.bookings;
    const foreign = shown.filter((b) => t.db.prepare('SELECT patient_id FROM visits WHERE id = ?').get(b.visit_id).patient_id !== 78);
    assert.equal(foreign.length, 0, 'card now about patient 78 lists patient 77\'s visit with doctor and services');
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — PRIV-4: no prices / money fields anywhere in the answer', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, updated: daysAgoIso(1) });
    const v = await calendarBook(t, 'reg', D3);
    const r = await t.rpc('crm_card_bookings', 'cc', { request_id: rid });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.data.bookings.some((b) => b.visit_id === v));
    assert.ok(!/price|total|amount|paid|invoice|sum/i.test(r.text), 'money field in answer: ' + r.text);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — PRIV-5: card with > 60 visits — all FUTURE (live) bookings are still listed (limit drops only the oldest)', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    for (let i = 70; i >= 1; i--) t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'patient')").run(visitFor(t.db, 77, localDay(-i)), rid);
    const fut = visitFor(t.db, 77, D5);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'patient')").run(fut, rid);
    const r = await t.rpc('crm_card_bookings', 'cc', { request_id: rid });
    const ids = r.json.data.bookings.map((b) => b.visit_id);
    console.log('PRIV-5 count', ids.length, 'first day', r.json.data.bookings[0].day, 'last', r.json.data.bookings.at(-1).day);
    assert.ok(ids.includes(fut));
    assert.ok(ids.length <= 60);
  } finally { t.close(); }
});

test('CRM_ONE_WAY_V1 (повтор r2) — PRIV-3b: after the card is re-linked to patient 78, patient 77 arriving must not close the card of 78 «Пришёл»', async () => {
  const t = await startCrmApp((db) => {
    db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78, 'Другой Пациент', '+998 90 111 22 33')").run();
  });
  try {
    const rid = addLead(t.db, { assigned: 3, updated: daysAgoIso(10), status: 'recall' });   // stale -> C′ reopen
    const v = await calendarBook(t, 'reg', localDay(0), { hour: 18 });
    console.log('PRIV-3b link', JSON.stringify(link(t, v)), t.lead(rid).status);
    const up = await t.dbq('cc', { table: 'crm_requests', op: 'update', values: { patient_id: 78, status: 'in_process' }, filters: [{ col: 'id', op: 'eq', val: rid }] });
    assert.equal(up.status, 200, up.text);
    const m = await t.rpc('calendar_book', 'reg', { visit_id: v, start: at(localDay(0), 18), status: 'arrived' });
    assert.equal(m.status, 200, m.text);
    console.log('PRIV-3b card of 78 after 77 arrived', t.lead(rid).status, t.lead(rid).patient_id);
    assert.equal(t.lead(rid).status, 'in_process', 'patient 77 arrival closed the card that is now patient 78');
  } finally { t.close(); }
});
