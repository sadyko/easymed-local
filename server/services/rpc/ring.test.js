// CALL_RING_V1 (2026-10-17) — три RPC блока «Звонит»: ворота по правам, спрос,
// рождение и смена секрета адреса, адреса для кабинета станции.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { telephonyLive, telephonyRingInfo, telephonyRingTokenRotate } from './ring.js';
import { RpcError } from './telephony.js';
import { getRpc } from './index.js';
import { noteEvent, resetLive, liveDemanded } from '../telephony/live.js';

const T0 = Date.parse('2026-10-17T07:00:00Z');
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const mk = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  mk.run(1, 'adm', 'x', 'Администратор', 'admin');
  mk.run(2, 'reg', 'x', 'Регистратор', 'registrar');
  mk.run(3, 'doc', 'x', 'Врач', 'doctor');
  return db;
}
const ADM = { id: 1, role: 'admin' };
const REG = { id: 2, role: 'registrar' };
const DOC = { id: 3, role: 'doctor' };
function dataDir(withClinic) {
  const dir = tmpDir('em-ring-');
  if (withClinic) fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ clinic_id: 'c-000777' }));
  return dir;
}
const env = { EASYMED_PUBLIC_URL: 'https://api.example.test' };

test('все три вызова зарегистрированы', () => {
  for (const n of ['telephony_live', 'telephony_ring_info', 'telephony_ring_token_rotate']) assert.equal(typeof getRpc(n), 'function', n);
});

test('telephony_live: врачу без прав — 403; регистратору — звонки и источник; сам вопрос — спрос', () => {
  resetLive();
  const db = seed();
  const dir = dataDir(false);
  assert.throws(() => telephonyLive(db, {}, DOC, { now: () => T0, dataDir: dir }), (e) => e instanceof RpcError && e.status === 403);
  assert.equal(liveDemanded(T0), false, 'отказанный вопрос не должен создавать спрос');
  const empty = telephonyLive(db, {}, REG, { now: () => T0, dataDir: dir });
  assert.deepEqual(empty, { calls: [], source: 'off', reason: 'not_enrolled' });
  assert.equal(liveDemanded(T0 + 1000), true);
  noteEvent(db, { uuid: 'u1', event: 'ring', direction: 'in', caller: '998901112233', callee: '101', at: '2026-10-17T07:00:00Z' }, T0);
  const live = telephonyLive(db, {}, REG, { now: () => T0 + 1000, dataDir: dir });
  assert.equal(live.calls.length, 1);
  assert.equal(live.calls[0].caller, '998901112233');
  assert.equal(live.calls[0].state, 'ringing');
});

test('telephony_ring_info: секрет рождается один раз; адреса через публичный сервер и прямой; регистратору — 403', () => {
  const db = seed();
  const dir = dataDir(true);
  assert.throws(() => telephonyRingInfo(db, {}, REG, { dataDir: dir, env }), (e) => e.status === 403);
  const a = telephonyRingInfo(db, {}, ADM, { dataDir: dir, env });
  assert.match(a.ring_token, /^[0-9a-f]{32}$/);
  assert.equal(a.relay_url, 'https://api.example.test/_pbx/v1/c-000777/' + a.ring_token);
  assert.equal(a.direct_url, '', 'без публичного адреса клиники прямого адреса нет');
  assert.equal(a.relay_ready, false);
  assert.equal(a.relay_reason, 'not_enrolled');
  assert.equal(a.clinic_id, 'c-000777');
  const b = telephonyRingInfo(db, {}, ADM, { dataDir: dir, env });
  assert.equal(b.ring_token, a.ring_token, 'повторный взгляд сменил секрет');
  db.prepare("UPDATE telephony_settings SET public_base_url = 'https://clinic.example.uz/' WHERE id = 1").run();
  assert.equal(telephonyRingInfo(db, {}, ADM, { dataDir: dir, env }).direct_url, 'https://clinic.example.uz/api/telephony/pbx/' + a.ring_token);
});

test('telephony_ring_token_rotate: новый секрет, прежний не подходит; регистратору — 403', () => {
  const db = seed();
  const dir = dataDir(true);
  const a = telephonyRingInfo(db, {}, ADM, { dataDir: dir, env });
  assert.throws(() => telephonyRingTokenRotate(db, {}, REG, { dataDir: dir, env }), (e) => e.status === 403);
  const b = telephonyRingTokenRotate(db, {}, ADM, { dataDir: dir, env });
  assert.match(b.ring_token, /^[0-9a-f]{32}$/);
  assert.notEqual(b.ring_token, a.ring_token);
  assert.equal(db.prepare('SELECT ring_token FROM telephony_settings WHERE id = 1').get().ring_token, b.ring_token);
});
