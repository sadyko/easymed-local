// CALL_RING_V1 (2026-10-17) — почтовый ящик событий станции: секрет хешем, десять
// минут жизни, повтор не удваивается, пустой курсор — только свежее, длинный
// опрос просыпается от вставки; saveKeys кладёт хеш секрета.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { testDb, NOW } from '../test-helpers/fixture.js';
import { ringHashOf, clinicByRingToken, insertPbxEvent, pbxEventsSince, waitForPbxEvent, PBX_TTL_MS, PBX_FRESH_MS, pbxLastId, pbxCursorAhead } from './pbx-events.js';
import { saveKeys } from './clinics.js';
import { isoOf } from '../lib/time.js';
import { runMaintenance } from '../jobs.js';   // FIX_318_V1 (C6)

const TOKEN = 'ab'.repeat(16);
function clinic(db, id = 'c-000777', token = TOKEN) {
  db.prepare("INSERT INTO clinics (clinic_id, key_fp, first_seen_at, last_seen_at, ring_hash) VALUES (?, 'fp', ?, ?, ?)")
    .run(id, isoOf(NOW), isoOf(NOW), ringHashOf(token));
}
const ev = (uuid, event = 'ring', over = {}) => ({ uuid, event, direction: 'in', caller: '998901112233', callee: '101', at: isoOf(NOW), ...over });

test('хеш секрета: 32 hex → sha256; иное — пусто; клиника находится только по своему секрету', () => {
  assert.equal(ringHashOf(TOKEN), crypto.createHash('sha256').update(TOKEN).digest('hex'));
  assert.equal(ringHashOf(''), '');
  assert.equal(ringHashOf('short'), '');
  const { db } = testDb();
  clinic(db);
  assert.deepEqual(clinicByRingToken(db, 'c-000777', TOKEN), { clinic_id: 'c-000777' });
  assert.equal(clinicByRingToken(db, 'c-000777', 'cd'.repeat(16)), null, 'чужой секрет подошёл');
  assert.equal(clinicByRingToken(db, 'c-000778', TOKEN), null, 'секрет одной клиники открыл другую');
  assert.equal(clinicByRingToken(db, 'c-000777', ''), null);
  db.prepare("UPDATE clinics SET ring_hash = '' WHERE clinic_id = 'c-000777'").run();
  assert.equal(clinicByRingToken(db, 'c-000777', TOKEN), null, 'пустой хеш — адреса нет');
});

test('вставка, повтор за минуту, выдача по курсору и свежим, срок десять минут, unknown не выдаётся', () => {
  const { db } = testDb();
  clinic(db);
  const a = insertPbxEvent(db, 'c-000777', ev('u1'), NOW);
  assert.ok(a.id > 0);
  assert.deepEqual(insertPbxEvent(db, 'c-000777', ev('u1'), NOW + 30_000), { dup: true }, 'повтор начала за минуту удвоил событие');
  const b = insertPbxEvent(db, 'c-000777', ev('u1', 'answer'), NOW + 5000);
  insertPbxEvent(db, 'c-000777', { uuid: 'x', event: 'unknown', direction: '', caller: '', callee: '', at: isoOf(NOW) }, NOW + 6000, ['event', 'foo']);
  const fresh = pbxEventsSince(db, 'c-000777', '', NOW + 6000);
  assert.deepEqual(fresh.map((r) => [r.id, r.event]), [[a.id, 'ring'], [b.id, 'answer']], 'unknown уехал клинике или порядок сбит');
  assert.deepEqual(Object.keys(fresh[0]).sort(), ['at', 'callee', 'caller', 'direction', 'event', 'id', 'uuid']);
  assert.deepEqual(pbxEventsSince(db, 'c-000777', String(a.id), NOW + 6000).map((r) => r.id), [b.id]);
  assert.deepEqual(pbxEventsSince(db, 'c-000777', '', NOW + PBX_FRESH_MS + 7000), [], 'пустой курсор отдал старое — звонок проиграется заново');
  assert.deepEqual(pbxEventsSince(db, 'c-000777', '0', NOW + PBX_FRESH_MS + 7000).map((r) => r.id), [a.id, b.id], 'по курсору — всё, что живо');
  insertPbxEvent(db, 'c-000777', ev('u2'), NOW + PBX_TTL_MS + 7000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pbx_events WHERE uuid IN ('u1', 'x')").get().n, 0, 'старше десяти минут не стёрлось');
  assert.equal(db.prepare('SELECT keys FROM pbx_events WHERE uuid = ?').get('u2').keys, '[]');
  assert.throws(() => insertPbxEvent(db, 'c-000778', ev('u9'), NOW), /FOREIGN KEY/, 'событие легло клинике, которой нет');
});

test('чужой клинике события не выдаются; длинный опрос просыпается от вставки, тишина — false', async () => {
  const { db } = testDb();
  clinic(db);
  clinic(db, 'c-000778', 'cd'.repeat(16));
  insertPbxEvent(db, 'c-000777', ev('u1'), NOW);
  assert.deepEqual(pbxEventsSince(db, 'c-000778', '', NOW), []);
  const woke = waitForPbxEvent('c-000778', 2000);
  setTimeout(() => insertPbxEvent(db, 'c-000778', ev('u2'), NOW), 30);
  assert.equal(await woke, true);
  assert.equal(await waitForPbxEvent('c-000778', 20), false);
});

test('saveKeys кладёт хеш секрета; без секрета — пусто', () => {
  const { db } = testDb();
  db.prepare("INSERT INTO clinics (clinic_id, key_fp, first_seen_at, last_seen_at) VALUES ('c-000777', 'fp', ?, ?)").run(isoOf(NOW), isoOf(NOW));
  const box = crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const body = { generated_at: isoOf(NOW), box_key: box, connections: [] };
  assert.deepEqual(saveKeys(db, 'c-000777', { ...body, ring_token: TOKEN }, NOW), { ok: true, connections: 0 });
  assert.equal(db.prepare("SELECT ring_hash FROM clinics WHERE clinic_id = 'c-000777'").get().ring_hash, ringHashOf(TOKEN));
  assert.deepEqual(saveKeys(db, 'c-000777', { ...body, generated_at: isoOf(NOW + 1000) }, NOW + 1000), { ok: true, connections: 0 });
  assert.equal(db.prepare("SELECT ring_hash FROM clinics WHERE clinic_id = 'c-000777'").get().ring_hash, '', 'снятый секрет остался на сервере');
});

// FIX_318_V1 (C6) — базу сервера восстановили из копии: номера событий пошли с
// меньших, а курсор клиники — прежний, больший. Курсор больше последнего
// выданного номера — читается как пустой (свежие), и номер этот сервер отдаёт.
test('FIX_318_V1: курсор клиники больше последнего номера сервера (база восстановлена) — выдаются свежие и cursor_reset; свой курсор — как прежде', () => {
  const { db } = testDb();
  clinic(db);
  assert.equal(pbxLastId(db), 0, 'пустой ящик — ноль');
  assert.equal(pbxCursorAhead(db, '5'), true);
  assert.equal(pbxCursorAhead(db, ''), false, 'пустой курсор — не «впереди»');
  const a = insertPbxEvent(db, 'c-000777', ev('u1'), NOW);
  const b = insertPbxEvent(db, 'c-000777', ev('u2'), NOW + 1000);
  assert.equal(pbxLastId(db), b.id);
  assert.equal(pbxCursorAhead(db, String(b.id)), false);
  assert.equal(pbxCursorAhead(db, String(b.id + 500)), true);
  assert.deepEqual(pbxEventsSince(db, 'c-000777', String(b.id + 500), NOW + 2000).map((r) => r.id), [a.id, b.id],
    'курсор из будущего — событий нет никогда');
  assert.deepEqual(pbxEventsSince(db, 'c-000777', String(b.id), NOW + 2000), [], 'свой же курсор — как прежде, пусто');
  // Стёрто уборкой — номер не забывается (AUTOINCREMENT): курсор клиники остаётся годным.
  db.prepare('DELETE FROM pbx_events').run();
  assert.equal(pbxLastId(db), b.id);
  assert.equal(pbxCursorAhead(db, String(b.id)), false, 'после уборки свой курсор стал «из будущего»');
});

// FIX_318_V1 (C6) — десять минут хранения номеров были обещанием, которое
// исполнялось только при следующем приёме или выдаче: замолчала станция и
// клиника — номера лежали сколько угодно. Теперь их стирает и уборка (раз в минуту).
test('FIX_318_V1: номера живых звонков стирает уборка раз в минуту, даже когда никто не пишет и не забирает', () => {
  const { db, dir } = testDb();
  clinic(db);
  insertPbxEvent(db, 'c-000777', ev('u1'), NOW);
  insertPbxEvent(db, 'c-000777', ev('u2'), NOW + 5 * 60_000);
  const r = runMaintenance(db, dir, NOW + PBX_TTL_MS + 1000);
  assert.equal(r.pbx_events, 1);
  assert.deepEqual(db.prepare('SELECT uuid FROM pbx_events').all().map((x) => x.uuid), ['u2']);
  assert.equal(runMaintenance(db, dir, NOW + 5 * 60_000 + PBX_TTL_MS + 1000).pbx_events, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pbx_events').get().n, 0, 'номера пережили десять минут');
});
