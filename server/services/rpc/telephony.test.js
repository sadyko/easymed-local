import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { telephonySettingsGet, telephonySettingsSave, telephonyTest, telephonyRecentCalls, RpcError } from './telephony.js';
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

test('all four RPCs are admin-only, counting extra roles', async () => {
  const db = fresh();
  for (const fn of [telephonySettingsGet, telephonyRecentCalls]) {
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

test('registered in the RPC registry under the planned names', () => {
  for (const name of ['telephony_settings_get', 'telephony_settings_save', 'telephony_test', 'telephony_recent_calls']) {
    assert.equal(typeof getRpc(name), 'function', name);
  }
});

test("'callcenter' is sellable — the locked-module screen's request must not 400", () => {
  // The telephony tile gates on the callcenter module; a locked clinic asks
  // for it through module_request, which validates against this exact set.
  assert.ok(SELLABLE_MODULES.has('callcenter'));
});
