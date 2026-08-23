import { test } from 'node:test';
import assert from 'node:assert';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { moduleRequest, licenceEnroll, licenceStatus } from './licence.js';
import { setDataDir } from '../control/config.js';
import { licensedDataDir } from '../control/licensed-fixture.js';
import { getRpc } from './index.js';
import { isAlwaysAllowedRpc } from '../control/gate.js';

// module_requests.requested_by is a real FK to users(id) (ON DELETE SET NULL —
// see 073_licensing.sql), so USER.id must reference an actual row or the
// INSERT throws SQLITE_CONSTRAINT_FOREIGNKEY before it ever reaches the
// unique-open-request logic under test. Every other rpc/*.test.js fresh()
// helper seeds a users row for the same reason (e.g. billing.free.test.js,
// accommodation.test.js) — bare migrate(db) alone never creates one.
const fresh = () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'admin','x','Admin','admin')").run();
  return db;
};
const USER = { id: 1, role: 'admin' };

test('requesting a module records a lead for the vendor', () => {
  const db = fresh();
  const r = moduleRequest(db, { module_key: 'marketing' }, USER);
  assert.equal(r.ok, true);
  const row = db.prepare('SELECT * FROM module_requests').get();
  assert.equal(row.module_key, 'marketing');
  assert.equal(row.requested_by, 1);
});

test('clicking the button twice does not create two leads', () => {
  const db = fresh();
  moduleRequest(db, { module_key: 'marketing' }, USER);
  const second = moduleRequest(db, { module_key: 'marketing' }, USER);
  assert.equal(second.ok, true, 'the button must not show an error to the clinic');
  assert.equal(second.already, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM module_requests').get().n, 1);
});

test('the request date comes back so the button can show it', () => {
  const db = fresh();
  moduleRequest(db, { module_key: 'crm' }, USER);
  const again = moduleRequest(db, { module_key: 'crm' }, USER);
  assert.ok(again.requested_at, 'so the UI can say "Заявка отправлена <date>"');
});

test('an unknown module key is refused', () => {
  const db = fresh();
  assert.throws(() => moduleRequest(db, { module_key: 'not-a-module' }, USER), /module/i);
});

test('a missing module key is refused', () => {
  const db = fresh();
  assert.throws(() => moduleRequest(db, {}, USER), /module/i);
});

// --- attack-testing added beyond the spec's own list ------------------------

test('a requested_by that matches no user surfaces as a real error, not a false "already requested"', () => {
  // Regression test: an early version of the catch below matched ANY
  // SQLITE_CONSTRAINT at insert time (not just the unique index), which
  // silently relabelled a genuine foreign-key violation as a false-positive
  // {ok:true, already:true, requested_at:null} with no row ever written.
  // Found by running this very file's tests against a bare migrate()d db
  // with no users row for USER.id — see the comment on fresh() above.
  const db = fresh();
  assert.throws(() => moduleRequest(db, { module_key: 'crm' }, { id: 999 }), /FOREIGN KEY/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM module_requests').get().n, 0, 'no phantom row after a rejected insert');
});

test('the theoretical SELECT-then-INSERT race still answers cleanly, not a 500', () => {
  // moduleRequest is fully synchronous and better-sqlite3 is a single
  // synchronous connection per process, so two calls can never actually
  // interleave between the SELECT and the INSERT here — Node's event loop
  // will not preempt one synchronous handler to run another. This test does
  // not contradict that; it proves the defensive catch is safe IF that
  // reasoning is ever wrong (a future async rewrite, a second connection),
  // by simulating the interleave directly: the SELECT is stubbed to report
  // "nothing open" (as it would to two racing callers) while the INSERT is
  // stubbed to fail exactly as the real unique index would for the loser.
  const db = fresh();
  db.prepare('INSERT INTO module_requests (module_key, requested_by) VALUES (?, ?)').run('crm', 1); // the "winner"'s row

  let selectCount = 0;
  const racy = {
    prepare(sql) {
      if (sql.startsWith('SELECT')) {
        selectCount++;
        if (selectCount === 1) return { get: () => undefined }; // the racer's own pre-insert check
        return db.prepare(sql); // the post-catch re-read: sees the real winning row
      }
      if (sql.startsWith('INSERT')) {
        return { run: () => {
          const e = new Error('UNIQUE constraint failed: module_requests.module_key');
          e.code = 'SQLITE_CONSTRAINT_UNIQUE';
          throw e;
        } };
      }
      return db.prepare(sql);
    },
  };
  const r = moduleRequest(racy, { module_key: 'crm' }, USER);
  assert.equal(r.ok, true);
  assert.equal(r.already, true, 'the loser of the race must see "already requested", not a 500');
  assert.ok(r.requested_at);
});

// --- ENROLLMENT_SCREEN_V1 — licence_enroll ---------------------------------
//
// The RPC is a thin adapter: control/enroll.js owns the network, the
// verification and the file writes (and has its own suite); what belongs HERE
// is the admin gate and the mapping of enroll's fixed reason vocabulary onto
// the Russian sentences the activation screen shows verbatim. enrollImpl is
// injected the same way moduleRequest's race test injects its db — the
// transport is not what these tests are about.

const enrollOk = async () => ({ ok: true, clinic_id: 'c-000051', clinic_name: 'Нурафшон Мед' });
const enrollFail = (reason) => async () => ({ ok: false, reason });

test('licence_enroll: a non-admin is refused with the same 403 wording as licence_unlock', async () => {
  const db = fresh();
  await assert.rejects(
    () => licenceEnroll(db, { code: 'EM-7K4Q-9XZP' }, { id: 1, role: 'doctor' }, { enrollImpl: enrollOk }),
    (e) => e.status === 403 && /Только администратор может активировать/.test(e.message),
  );
});

test('licence_enroll: success hands back the clinic so the screen can greet it', async () => {
  const db = fresh();
  let got = null;
  const enrollImpl = async (dataDir, code) => { got = { dataDir, code }; return enrollOk(); };
  const r = await licenceEnroll(db, { code: 'EM-7K4Q-9XZP' }, USER, { enrollImpl });
  assert.deepEqual(r, { ok: true, clinic_id: 'c-000051', clinic_name: 'Нурафшон Мед' });
  assert.equal(got.code, 'EM-7K4Q-9XZP');
  assert.ok(got.dataDir, 'the transport must be pointed at the real data directory');
});

test('licence_enroll: a wrong or empty code reads as the unlock screen\'s own wording', async () => {
  const db = fresh();
  for (const reason of ['invalid_code', 'empty_code']) {
    await assert.rejects(
      () => licenceEnroll(db, { code: 'nope' }, USER, { enrollImpl: enrollFail(reason) }),
      (e) => e.status === 400 && /Код неверный\. Проверьте и введите ещё раз\./.test(e.message),
    );
  }
});

test('licence_enroll: rate-limited reads as "слишком много попыток"', async () => {
  const db = fresh();
  await assert.rejects(
    () => licenceEnroll(db, { code: 'EM-X' }, USER, { enrollImpl: enrollFail('too_many_attempts') }),
    /Слишком много попыток\. Попробуйте позже\./,
  );
});

test('licence_enroll: no internet reads as a connectivity problem, never as a bad code', async () => {
  const db = fresh();
  await assert.rejects(
    () => licenceEnroll(db, { code: 'EM-X' }, USER, { enrollImpl: enrollFail('offline') }),
    (e) => /Нет связи с Easy-Med/.test(e.message) && !/Код неверный/.test(e.message),
  );
});

test('licence_enroll: an already-enrolled install is told so', async () => {
  const db = fresh();
  await assert.rejects(
    () => licenceEnroll(db, { code: 'EM-X' }, USER, { enrollImpl: enrollFail('already_enrolled') }),
    /Эта установка уже привязана к клинике\./,
  );
});

test('licence_enroll: server_error/bad_response/write_failed all read as one retryable sentence', async () => {
  // The clinic can do nothing different across these three, so the screen must
  // not invent three scary variants — one honest "try again / call the vendor".
  const db = fresh();
  for (const reason of ['server_error', 'bad_response', 'write_failed']) {
    await assert.rejects(
      () => licenceEnroll(db, { code: 'EM-X' }, USER, { enrollImpl: enrollFail(reason) }),
      /Не удалось активировать\. Попробуйте ещё раз или обратитесь к менеджеру Easy-Med\./,
    );
  }
});

test('licence_enroll is registered and reachable through a not_enrolled lock', () => {
  // Both halves of "the screen can actually call it": the registry knows the
  // name, and the gate lets it through while locked — a not-enrolled install
  // is ALWAYS locked, so missing either line would make the screen 402 itself.
  assert.ok(getRpc('licence_enroll'), 'must be in the RPC registry');
  assert.equal(isAlwaysAllowedRpc('licence_enroll'), true, 'must be in ALWAYS_ALLOWED_RPCS');
});

// --- SYSTEM_SETTINGS_V1 — the subscription card's extra facts ---------------

test('licence_status carries the subscription card facts: clinic id, valid-until, last check-in', () => {
  const db = fresh();
  setDataDir(licensedDataDir());
  const before = licenceStatus(db, {}, USER);
  assert.equal(before.clinic_id, 'test-clinic');
  assert.equal(new Date(before.valid_until).getTime(), new Date('2099-01-01T00:00:00Z').getTime());
  assert.equal(before.last_checkin, null,
    'an install that has never checked in says so rather than inventing a date');

  // The key checkin.js itself writes after every successful call home —
  // this field is a read of that record, not new storage.
  db.prepare("INSERT INTO control_state (key, value) VALUES ('last_checkin_at', '2026-08-22T10:00:00.000Z')").run();
  assert.equal(licenceStatus(db, {}, USER).last_checkin, '2026-08-22T10:00:00.000Z');
});
