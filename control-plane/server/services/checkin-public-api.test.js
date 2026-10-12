// PUBLIC_LICENCE_V1 — сверка с настоящей подписью (ключ — одноразовый, свой на
// прогон) и настоящим проверяющим клиники: отпечаток ключа обмена, переключатель
// онлайн-записи, «active» в лицензии (неоплаченной — лицензии нет, как до 8c),
// порядок issued_at, старая клиника без ключа.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from './enrollment.js';
import { checkIn } from './checkin.js';
import { signLicence } from './signing.js';
import { verifyLicence } from '../../../server/services/control/licence.js';

const vendor = crypto.generateKeyPairSync('ed25519');
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-8c-key-'));
const keyFile = path.join(keyDir, 'vendor-private.pem');
fs.writeFileSync(keyFile, vendor.privateKey.export({ type: 'pkcs8', format: 'pem' }));
test.before(() => { process.env.EASYMED_SIGNING_KEY = keyFile; });
test.after(() => { delete process.env.EASYMED_SIGNING_KEY; fs.rmSync(keyDir, { recursive: true, force: true }); });

/** Открытая половина ключа подписи клиники — так её шлёт сверка 8a (base64 DER SPKI) — и её отпечаток. */
function syncKey() {
  const pub = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  return { b64: pub.toString('base64'), fp: crypto.createHash('sha256').update(pub).digest('hex').slice(0, 32) };
}

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const code = createEnrollmentCode(db, { clinicId: 'c-000047', name: 'Шифо' });
  const token = redeemEnrollmentCode(db, { code }).install_token;
  const call = (body = {}) => checkIn(db, { installToken: token, ...body }, { signLicence });
  const row = () => db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get('c-000047');
  const verified = (licence) => verifyLicence(JSON.stringify(licence), { publicKey: vendor.publicKey, clinicId: 'c-000047' });
  return { db, call, row, verified };
}

test('старая клиника (ключа не шлёт): лицензия как прежде плюс подписанное «active», без api_sync_key — проверяющий клиники принимает', () => {
  const s = setup();
  const r = s.call({ version: '3.16.0' });
  assert.equal(r.subscription, 'active');
  const v = s.verified(r.licence);
  assert.equal(v.ok, true);
  assert.equal(v.licence.subscription, 'active');
  assert.equal('api_sync_key' in v.licence, false);
  assert.deepEqual([s.row().licence_subscription, s.row().licence_api_sync_key], ['active', null]);
  assert.equal(s.row().licence_valid_until, r.licence.payload.valid_until);
});

test('переключатель: ключ принят сразу, но в лицензию идёт только при включённой онлайн-записи', () => {
  const s = setup();
  const k = syncKey();
  const off = s.call({ apiSyncPublicKey: k.b64 });
  assert.equal('api_sync_key' in off.licence.payload, false, 'выключено — поля нет, обмен клиники молчит');
  assert.deepEqual([s.row().api_sync_key, s.row().api_sync_key_seen], [k.fp, k.fp]);
  s.db.prepare("UPDATE clinics SET api_enabled = 1 WHERE clinic_id = 'c-000047'").run();
  const on = s.call({ apiSyncPublicKey: k.b64 });
  assert.equal(s.verified(on.licence).licence.api_sync_key, k.fp);
  assert.equal(s.row().licence_api_sync_key, k.fp);
  s.db.prepare("UPDATE clinics SET api_enabled = 0 WHERE clinic_id = 'c-000047'").run();
  assert.equal('api_sync_key' in s.call({ apiSyncPublicKey: k.b64 }).licence.payload, false, 'выключили — со следующей сверки поля нет');
});

test('новый ПК — новый ключ ждёт подтверждения: лицензия несёт прежний, пока его не примут в панели', () => {
  const s = setup();
  s.db.prepare("UPDATE clinics SET api_enabled = 1 WHERE clinic_id = 'c-000047'").run();
  const a = syncKey();
  const b = syncKey();
  s.call({ apiSyncPublicKey: a.b64 });
  const r = s.call({ apiSyncPublicKey: b.b64 });
  assert.equal(r.licence.payload.api_sync_key, a.fp);
  assert.deepEqual([s.row().api_sync_key, s.row().api_sync_key_seen], [a.fp, b.fp]);
  s.db.prepare("UPDATE clinics SET api_sync_key = ? WHERE clinic_id = 'c-000047'").run(b.fp);   // «Принять новый ключ»
  assert.equal(s.call({ apiSyncPublicKey: b.b64 }).licence.payload.api_sync_key, b.fp);
});

test('отозванный ключ обмена не попадает в лицензию, даже если остался принятым', () => {
  const s = setup();
  s.db.prepare("UPDATE clinics SET api_enabled = 1 WHERE clinic_id = 'c-000047'").run();
  const a = syncKey();
  s.call({ apiSyncPublicKey: a.b64 });
  s.db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-000047', 'sync_key', ?)").run(a.fp);
  assert.equal('api_sync_key' in s.call({ apiSyncPublicKey: a.b64 }).licence.payload, false);
});

test('не оплачено: лицензии нет, как до 8c (Р14) — ни «unpaid», ни ключа, запись о выданной не трогается; оплатили — снова 14 дней, issued_at позже', () => {
  const s = setup();
  s.db.prepare("UPDATE clinics SET api_enabled = 1 WHERE clinic_id = 'c-000047'").run();
  const k = syncKey();
  const paid = s.call({ apiSyncPublicKey: k.b64 });
  const issued = () => [s.row().licence_issued_at, s.row().licence_valid_until, s.row().licence_subscription, s.row().licence_api_sync_key];
  const before = issued();
  assert.deepEqual(before, [paid.licence.payload.issued_at, paid.licence.payload.valid_until, 'active', k.fp]);
  s.db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = 'c-000047'").run();
  for (let i = 0; i < 2; i += 1) {
    const unpaid = s.call({ apiSyncPublicKey: k.b64 });
    assert.deepEqual([unpaid.subscription, unpaid.licence], ['unpaid', null], 'неоплаченной — ничего, партнёров отсекает список производителя');
  }
  assert.deepEqual(issued(), before, 'что сказано клинике — по-прежнему последняя оплаченная');
  s.db.prepare("UPDATE clinics SET subscription = 'active', subscription_until = '2020-01-01' WHERE clinic_id = 'c-000047'").run();
  assert.deepEqual([s.call({ apiSyncPublicKey: k.b64 }).licence, s.row().api_sync_key], [null, k.fp], '«оплачено до» прошло — тоже ничего; ключ обмена на месте');
  s.db.prepare("UPDATE clinics SET subscription_until = NULL WHERE clinic_id = 'c-000047'").run();
  const back = s.call({ apiSyncPublicKey: k.b64 });
  assert.deepEqual([back.licence.payload.subscription, back.licence.payload.api_sync_key], ['active', k.fp]);
  assert.ok(Date.parse(back.licence.payload.valid_until) > Date.now() + 13 * 86400000, 'оплатили — снова 14 дней');
  assert.ok(Date.parse(back.licence.payload.issued_at) > Date.parse(paid.licence.payload.issued_at));
});

test('issued_at строго растёт от сверки к сверке — и когда часы производителя отстали', () => {
  const s = setup();
  const seen = [];
  for (let i = 0; i < 5; i += 1) seen.push(Date.parse(s.call().licence.payload.issued_at));
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] > seen[i - 1], 'выдача ' + i);
  const ahead = new Date(Date.now() + 3600000).toISOString();
  s.db.prepare("UPDATE clinics SET licence_issued_at = ? WHERE clinic_id = 'c-000047'").run(ahead);
  assert.equal(Date.parse(s.call().licence.payload.issued_at), Date.parse(ahead) + 1);
});

test('мусор вместо ключа не роняет сверку; в базе — только отпечаток, открытой половины целиком нет', () => {
  const s = setup();
  for (const junk of ['не ключ', 42, { a: 1 }, 'A'.repeat(5000), syncKey().b64.replace(/A/g, 'B')]) {
    const r = s.call({ apiSyncPublicKey: junk });
    assert.ok(r && r.licence, String(junk).slice(0, 12));
  }
  const k = syncKey();
  s.call({ apiSyncPublicKey: k.b64 });
  const dump = JSON.stringify(s.db.prepare('SELECT * FROM clinics').all()) + JSON.stringify(s.db.prepare('SELECT * FROM checkins').all());
  assert.ok(!dump.includes(k.b64), 'открытая половина целиком не хранится');
  assert.ok(dump.includes(k.fp));
});
