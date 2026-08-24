import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { telephonySettingsGet, telephonySettingsSave, telephonyTest, telephonyRecentCalls, telephonyDispositions, RpcError } from './telephony.js';
import { getRpc } from './index.js';
import { SELLABLE_MODULES } from './licence.js';

// The test users exist as ROWS, not just objects: updated_by is a real FK
// (mig 076), and a session can never carry an id that users doesn't hold.
const fresh = () => {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin');
  ins.run(2, 'docadm', 'x', 'doctor');
  ins.run(3, 'reg', 'x', 'registrar');
  return db;
};
const admin = { id: 1, role: 'admin' };
// ADMIN_DOCTOR_V1's shape: primary role doctor, admin as an extra — must pass
// every guard here exactly like a plain admin.
const doctorAdmin = { id: 2, role: 'doctor', extra_roles: ['admin'] };
const registrar = { id: 3, role: 'registrar' };

test('every RPC in the section is admin-only, counting extra roles', async () => {
  const db = fresh();
  for (const fn of [telephonySettingsGet, telephonyRecentCalls, telephonyDispositions]) {
    assert.throws(() => fn(db, {}, registrar), (e) => e instanceof RpcError && e.status === 403);
    fn(db, {}, doctorAdmin);   // must not throw
  }
  assert.throws(() => telephonySettingsSave(db, {}, registrar), (e) => e.status === 403);
  await assert.rejects(() => telephonyTest(db, {}, registrar), (e) => e.status === 403);
});

test('get: the secret never crosses the RPC boundary', () => {
  const db = fresh();
  telephonySettingsSave(db, { api_key: 'k', api_secret: 'super-secret' }, admin);
  const out = telephonySettingsGet(db, {}, admin);
  assert.equal(out.api_secret_set, true);
  assert.ok(!JSON.stringify(out).includes('super-secret'));
});

test('save: validation errors surface as 400 RpcError, not 500s', () => {
  const db = fresh();
  assert.throws(
    () => telephonySettingsSave(db, { enabled: true }, admin),   // no credentials yet
    (e) => e instanceof RpcError && e.status === 400,
  );
});

test('save: records who saved', () => {
  const db = fresh();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (7, 'a', 'x', 'admin')").run();
  telephonySettingsSave(db, { api_key: 'k' }, { id: 7, role: 'admin' });
  assert.equal(db.prepare('SELECT updated_by FROM telephony_settings').get().updated_by, 7);
});

test('telephony_test: proves the typed pair before it is saved, falls back to the saved one', async () => {
  const db = fresh();
  telephonySettingsSave(db, { api_key: 'saved-k', api_secret: 'saved-s' }, admin);

  const seen = [];
  const binotelCallImpl = async (method, params, { key, secret }) => {
    seen.push({ method, key, secret });
    return { ok: true, data: { status: 'success' } };
  };
  // Typed credentials win…
  let r = await telephonyTest(db, { api_key: 'typed-k', api_secret: 'typed-s' }, admin, { binotelCallImpl });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(seen[0], { method: 'stats/all-incoming-calls-since', key: 'typed-k', secret: 'typed-s' });
  // …and empty fields mean "test what is saved" (the masked field posts '').
  r = await telephonyTest(db, { api_key: '', api_secret: '' }, admin, { binotelCallImpl });
  assert.deepEqual(seen[1], { method: 'stats/all-incoming-calls-since', key: 'saved-k', secret: 'saved-s' });
});

test('telephony_test: every failure reason carries a human Russian sentence', async () => {
  const db = fresh();
  telephonySettingsSave(db, { api_key: 'k', api_secret: 's' }, admin);
  for (const reason of ['bad_credentials', 'offline', 'server_error', 'bad_response']) {
    const r = await telephonyTest(db, {}, admin, { binotelCallImpl: async () => ({ ok: false, reason }) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
    assert.match(r.message, /[А-Яа-я]/, 'the screen shows message verbatim — it must be Russian');
  }
  // No credentials anywhere → an honest bad_credentials without a network call.
  const db2 = fresh();
  const r = await telephonyTest(db2, {}, admin, { binotelCallImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(r.reason, 'bad_credentials');
});

test('recent calls: last 20 by time, patient name joined, raw kept server-side', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Иванов Иван', '+998 90 961 00 04')").run().lastInsertRowid;
  const ins = db.prepare(`INSERT INTO calls (general_call_id, started_at, patient_id, raw)
                          VALUES (@id, @t, @p, '{"secretish":"diagnostics"}')`);
  for (let i = 0; i < 25; i++) {
    ins.run({ id: 'GC-' + i, t: `2026-08-23T10:${String(i).padStart(2, '0')}:00Z`, p: i === 24 ? pid : null });
  }
  const rows = telephonyRecentCalls(db, {}, admin);
  assert.equal(rows.length, 20);
  assert.equal(rows[0].general_call_id, 'GC-24', 'newest first');
  assert.equal(rows[0].patient_name, 'Иванов Иван');
  assert.ok(!JSON.stringify(rows).includes('secretish'), 'raw is diagnostics, not a browser payload');
});

// --------------------------------------------------------------------------
// TELEPHONY_ROUTING_V1 — telephony_dispositions
// (docs/plans/2026-08-24-telephony-owns-its-routing.md, task 3)
// --------------------------------------------------------------------------

// A call row with nothing but what the table demands: the disposition is the
// only field these tests are about.
const call = (db, id, disposition, startedAt) => db.prepare(
  'INSERT INTO calls (general_call_id, started_at, disposition) VALUES (?,?,?)',
).run(id, startedAt, disposition);

const byCode = (rows) => Object.fromEntries(rows.map((r) => [r.disposition, r]));

test('dispositions — OBSERVED only: what the clinic’s own PBX sent, with counts, even with no rules at all', () => {
  const db = fresh();
  // No routing table at all — the honest floor of this feature: Binotel has no
  // "list every disposition" endpoint, so the calls table has to be able to
  // answer «what statuses do we get?» entirely on its own.
  db.prepare('DELETE FROM crm_call_routing').run();
  call(db, 'GC-1', 'ANSWER',   '2026-08-20T10:00:00Z');
  call(db, 'GC-2', 'ANSWER',   '2026-08-24T11:30:00Z');
  call(db, 'GC-3', 'ANSWER',   '2026-08-22T09:00:00Z');
  call(db, 'GC-4', 'NOANSWER', '2026-08-21T08:00:00Z');
  // Empty disposition: a call recorded before it ended. Not an outcome, and a
  // rule for it could never be saved (DISPOSITION_RE forbids an empty key).
  call(db, 'GC-5', '',         '2026-08-23T08:00:00Z');

  const rows = telephonyDispositions(db, {}, admin);
  assert.deepEqual(rows.map((r) => r.disposition), ['ANSWER', 'NOANSWER'], 'busiest first, empty one absent');
  assert.deepEqual(rows[0], {
    disposition: 'ANSWER', seen_count: 3, last_seen_at: '2026-08-24T11:30:00Z',
    documented: false, action: 'ignore', stage_key: null,
  }, 'no rule row = nothing is created from it, exactly what leadFromCall does');
  assert.equal(rows[1].seen_count, 1);
});

test('dispositions — DOCUMENTED only: the vendor list is offered before a single call arrives', () => {
  const db = fresh();
  const rows = telephonyDispositions(db, {}, admin);
  // Migration 077 seeds Binotel's published vocabulary. Its whole point is
  // that a rule can be set for an outcome BEFORE it happens for the first
  // time — so an install with no call history is not an empty screen.
  assert.equal(rows.length, db.prepare('SELECT COUNT(*) AS n FROM crm_call_routing').get().n);
  assert.ok(rows.every((r) => r.documented && r.seen_count === 0 && r.last_seen_at === null));
  const m = byCode(rows);
  assert.equal(m.ANSWER.action, 'create');
  assert.equal(m.ANSWER.stage_key, 'in_process', 'the seeded rule travels with its row — one call, not two');
  assert.equal(m.NOANSWER.stage_key, 'recall');
  assert.deepEqual(m.ONLINE, {
    disposition: 'ONLINE', seen_count: 0, last_seen_at: null,
    documented: true, action: 'ignore', stage_key: null,
  });
  // Nothing seen yet, so the order is alphabetical — stable between loads,
  // because a list that reshuffles itself reads as broken.
  assert.deepEqual(rows.map((r) => r.disposition).slice(0, 3), ['ANSWER', 'BUSY', 'CANCEL']);
});

test('dispositions — BOTH: one row per outcome, casing folded, rule attached', () => {
  const db = fresh();
  call(db, 'GC-1', 'ANSWER', '2026-08-20T10:00:00Z');
  // Lower case from a hand-fixed row or a future webhook shape. leadFromCall
  // uppercases before it looks the rule up, so this is the SAME rule — two
  // rows here would offer the owner a second one that can never fire.
  call(db, 'GC-2', 'answer', '2026-08-24T12:00:00Z');
  call(db, 'GC-3', ' NoAnswer ', '2026-08-21T10:00:00Z');

  const rows = telephonyDispositions(db, {}, admin);
  const m = byCode(rows);
  assert.equal(rows.filter((r) => r.disposition === 'ANSWER').length, 1);
  assert.deepEqual(m.ANSWER, {
    disposition: 'ANSWER', seen_count: 2, last_seen_at: '2026-08-24T12:00:00Z',
    documented: true, action: 'create', stage_key: 'in_process',
  });
  assert.equal(m.NOANSWER.seen_count, 1);
  // Seen outcomes sort above the documented-but-unseen rest.
  assert.deepEqual(rows.map((r) => r.disposition).slice(0, 2), ['ANSWER', 'NOANSWER']);
  assert.equal(rows[2].seen_count, 0);
});

test('dispositions — an outcome Binotel invented after the install: present, unruled, ignored', () => {
  const db = fresh();
  // The failure this whole RPC exists to prevent: a disposition arrives, no
  // rule matches, leadFromCall stays silent — and the owner never finds out
  // there is a rule missing. Now it shows up on the next load.
  call(db, 'GC-1', 'WHATSAPP-IN', '2026-08-24T10:00:00Z');
  call(db, 'GC-2', 'WHATSAPP-IN', '2026-08-24T10:05:00Z');

  const rows = telephonyDispositions(db, {}, admin);
  const row = byCode(rows)['WHATSAPP-IN'];
  assert.deepEqual(row, {
    disposition: 'WHATSAPP-IN', seen_count: 2, last_seen_at: '2026-08-24T10:05:00Z',
    documented: false, action: 'ignore', stage_key: null,
  }, 'documented:false is the «нет правила» flag — the card badges this row «новое»');
  assert.equal(rows[0].disposition, 'WHATSAPP-IN', 'the only outcome this clinic actually gets goes first');
  // The seeded vocabulary is still all there beside it — discovering a new
  // outcome must not hide the ones a rule can be set for in advance.
  assert.ok(rows.length > 2 && rows.slice(1).every((r) => r.documented));
});

test('registered in the RPC registry under the planned names', () => {
  for (const name of ['telephony_settings_get', 'telephony_settings_save', 'telephony_test',
                      'telephony_recent_calls', 'telephony_dispositions']) {
    assert.equal(typeof getRpc(name), 'function', name);
  }
});

test("'callcenter' is sellable — the locked-module screen's request must not 400", () => {
  // The telephony tile gates on the callcenter module; a locked clinic asks
  // for it through module_request, which validates against this exact set.
  assert.ok(SELLABLE_MODULES.has('callcenter'));
});
