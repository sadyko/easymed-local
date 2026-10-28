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
import { loadSyncIdentity, SYNC_KEY_FILE } from '../api/sync-identity.js';   // FIX_318_V1
import { syncOnce, keyCodeOf } from '../api/public-sync.js';   // FIX_318_V1

function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

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

// FIX_318_V1 (C3) — «готово» смотрело только на лицензию: включённая клиника без
// API партнёров меняла адрес, экран говорил «готово», а секрет на публичный
// сервер не уходил (новый адрес — 404, прежний работал). Теперь «готово» — когда
// сервер ПРИНЯЛ ключи с нынешним секретом; иначе — что мешает и что делать.
test('FIX_318_V1 (C3): адрес через публичный сервер «готов», только когда секрет дошёл; без ключа обмена и без включения — своя причина и код ключа', async () => {
  const db = seed();
  const dir = dataDir(true);
  const keyPath = path.join(dir, SYNC_KEY_FILE);
  fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify({ payload: { clinic_id: 'c-000777' }, sig: 'AAAA' }));
  let a = telephonyRingInfo(db, {}, ADM, { dataDir: dir, env });
  assert.deepEqual([a.relay_ready, a.relay_reason], [false, 'no_sync_key'], 'нет ключа обмена — не «не зарегистрирована»');
  const id = loadSyncIdentity({ keyPath, create: true });
  a = telephonyRingInfo(db, {}, ADM, { dataDir: dir, env });
  assert.deepEqual([a.relay_ready, a.relay_reason, a.key_code], [false, 'not_enabled', keyCodeOf(id.fingerprint)]);
  fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify({ payload: { clinic_id: 'c-000777', api_sync_key: id.fingerprint }, sig: 'AAAA' }));
  const rotated = telephonyRingTokenRotate(db, {}, ADM, { dataDir: dir, env });
  assert.deepEqual([rotated.relay_ready, rotated.relay_reason], [false, 'pending'], 'секрет не ушёл на сервер, а экран говорит «готово»');
  assert.equal(rotated.relay_url, 'https://api.example.test/_pbx/v1/c-000777/' + rotated.ring_token, 'адрес можно вписать в кабинет заранее');
  const calls = [];
  const fetchImpl = async (u, o) => { calls.push(o.method + ' ' + new URL(u).pathname); return new Response('{"ok":true}', { status: 200 }); };
  const out = await syncOnce(db, dir, { fetchImpl, env, keyPath, now: () => T0 });
  assert.deepEqual(out, { ok: false, reason: 'no_slug' });
  assert.deepEqual(calls, ['PUT /_sync/v1/keys'], 'ключи с секретом не ушли без API партнёров');
  const after = telephonyRingInfo(db, {}, ADM, { dataDir: dir, env });
  assert.deepEqual([after.relay_ready, after.relay_reason, after.relay_error], [true, '', '']);
});

// FIX_318_V1 (C4) — секреты раздела «Телефония» — только администратору (правило
// rpc/telephony.js): адрес событий станции и есть секрет — кто знает адрес, тот
// пишет на панель «Телефон» любого «звонящего».
test('FIX_318_V1 (C4): адрес событий станции — только администратору; просмотр раздела видит «адрес есть», но не сам адрес; сменить — только администратор', () => {
  const db = seed();
  setGrants(db, 'registrar', { 'settings.telephony': 'edit' });
  const dir = dataDir(true);
  db.prepare("UPDATE telephony_settings SET public_base_url = 'https://clinic.example.uz' WHERE id = 1").run();
  const early = telephonyRingInfo(db, {}, REG, { dataDir: dir, env });
  assert.deepEqual([early.ring_token_set, early.secrets_hidden], [false, true]);
  assert.equal(db.prepare('SELECT ring_token FROM telephony_settings WHERE id = 1').get().ring_token, '', 'секрет родился от взгляда не-администратора');
  const adm = telephonyRingInfo(db, {}, ADM, { dataDir: dir, env });
  assert.equal(adm.secrets_hidden, false);
  assert.match(adm.relay_url, new RegExp(adm.ring_token + '$'));
  const reg = telephonyRingInfo(db, {}, REG, { dataDir: dir, env });
  assert.deepEqual([reg.ring_token_set, reg.secrets_hidden, reg.ring_token, reg.relay_url, reg.direct_url, reg.key_code], [true, true, '', '', '', '']);
  assert.ok(!JSON.stringify(reg).includes(adm.ring_token), 'секрет ушёл не-администратору');
  assert.equal(reg.relay_reason, adm.relay_reason, 'состояние адреса не-администратор видит то же');
  assert.throws(() => telephonyRingTokenRotate(db, {}, REG, { dataDir: dir, env }), (e) => e instanceof RpcError && e.status === 403);
  assert.equal(db.prepare('SELECT ring_token FROM telephony_settings WHERE id = 1').get().ring_token, adm.ring_token);
});

// FIX_318_V1 (C5) — живые звонки несут имя и номер карты пациента: с одним
// «Позвонить» (без «Журнала звонков») оператор, опрашивая раз в 2 секунды, видел
// бы все звонки клиники — журнал без права на журнал. Теперь — только свои.
test('FIX_318_V1 (C5): живые звонки всей клиники — с правом на журнал; у кого только «Позвонить» — свои, по своему внутреннему номеру', () => {
  resetLive();
  const db = seed();
  const mk = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, pbx_extension) VALUES (?,?,?,?,?,?)');
  mk.run(4, 'dialer', 'x', 'Только набор', 'nurse', '102');
  mk.run(5, 'dialer2', 'x', 'Набор без трубки', 'nurse', null);
  mk.run(6, 'watcher', 'x', 'Только журнал', 'lab', null);
  setGrants(db, 'nurse', { 'crm.dial': 'edit', 'crm.calls': 'none' });
  setGrants(db, 'lab', { 'crm.dial': 'none', 'crm.calls': 'view' });
  const dir = dataDir(false);
  const at = '2026-10-17T07:00:00Z';
  noteEvent(db, { uuid: 'u1', event: 'ring', direction: 'in', caller: '998901112233', callee: '101', at }, T0);
  noteEvent(db, { uuid: 'u2', event: 'ring', direction: 'in', caller: '998907778899', callee: '102', at }, T0);
  noteEvent(db, { uuid: 'u3', event: 'ring', direction: 'out', caller: '102', callee: '998935550112', at }, T0);
  const ids = (u) => telephonyLive(db, {}, u, { now: () => T0 + 1000, dataDir: dir }).calls.map((c) => c.uuid).sort();
  assert.deepEqual(ids({ id: 4, role: 'nurse' }), ['u2', 'u3'], 'с одним «Позвонить» видны чужие звонки');
  assert.deepEqual(ids({ id: 5, role: 'nurse' }), [], 'без своего внутреннего номера — своих звонков нет');
  assert.deepEqual(ids({ id: 6, role: 'lab' }), ['u1', 'u2', 'u3']);
  assert.deepEqual(ids(REG), ['u1', 'u2', 'u3'], 'регистратор по прежнему правилу ролей — и набор, и журнал');
  resetLive();
});
