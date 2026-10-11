// PUBLIC_API_V1 (мигр. 245) — ЗАЯВКИ ИЗ API, УДЕРЖАНИЕ ВРЕМЕНИ БЕЗ КАРТЫ, СОБЫТИЯ
// НАРУЖУ, СОСТОЯНИЕ ОБМЕНА: только CREATE TABLE. Прежние таблицы не тронуты;
// номер заявки партнёра у подключения один; живое удержание у заявки одно;
// у онлайн-записи всегда есть врач и время; тело события — объект JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { insertConnectionRow } from '../../test-helpers/api-connection-row.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dbBefore245() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig245-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 245)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
function seed(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (7, 'doc', 'x', 'Врач', 'doctor', 1)").run();
  const conn = insertConnectionRow(db);
  return { conn };
}
const req = (db, over = {}) => {
  const row = { public_id: 'rq_abc123def', connection_id: 1, kind: 'appointment', status: 'pending', doctor_id: 7,
    start_at: '2026-10-20T05:00:00Z', duration_minutes: 30, received_at: '2026-10-11T09:00:00Z', ...over };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO api_requests (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
};

test('245: четыре таблицы, строка состояния одна; прежние таблицы и визиты не тронуты', () => {
  const db = dbBefore245();
  const before = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  migrate(db);
  const after = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const added = after.filter((t) => !before.some((b) => b.name === t.name)).map((t) => t.name).sort();
  assert.deepEqual(added, ['api_outbox', 'api_requests', 'api_sync_state', 'slot_holds']);
  for (const b of before) assert.equal(after.find((t) => t.name === b.name).sql, b.sql, 'не тронута: ' + b.name);
  assert.deepEqual(db.prepare('SELECT id, inbox_cursor, last_error FROM api_sync_state').all().map((r) => ({ ...r })),
    [{ id: 1, inbox_cursor: '', last_error: '' }]);
  assert.throws(() => db.prepare('INSERT INTO api_sync_state (id) VALUES (2)').run(), /CHECK/);
});

test('245: номер заявки — rq_ и латиница/цифры; номер партнёра у подключения один; повтор public_id — отказ', () => {
  const db = fresh(); seed(db);
  for (const bad of ['rq_', 'rq_ab', 'xx_abcdefgh', 'rq_abc-defgh', 'rq_' + 'a'.repeat(40)]) {
    assert.throws(() => req(db, { public_id: bad }), /CHECK/, bad);
  }
  req(db, { public_id: 'rq_00000001', external_id: 'med-1' });
  assert.throws(() => req(db, { public_id: 'rq_00000002', external_id: 'med-1' }), /UNIQUE/);
  req(db, { public_id: 'rq_00000003', external_id: '' });
  req(db, { public_id: 'rq_00000004', external_id: '' });
  assert.throws(() => req(db, { public_id: 'rq_00000004' }), /UNIQUE/);
});

test('245: онлайн-запись — с врачом, временем и длительностью; заявка «перезвоните» — без удержания', () => {
  const db = fresh(); seed(db);
  assert.throws(() => req(db, { public_id: 'rq_noDoctor1', doctor_id: null }), /CHECK/);
  assert.throws(() => req(db, { public_id: 'rq_noStart01', start_at: null }), /CHECK/);
  assert.throws(() => req(db, { public_id: 'rq_noDur0001', duration_minutes: null }), /CHECK/);
  req(db, { public_id: 'rq_callback1', kind: 'request', status: 'new', doctor_id: null, start_at: null, duration_minutes: null });
  assert.throws(() => req(db, { public_id: 'rq_callback2', kind: 'request', status: 'pending', doctor_id: null, start_at: null, duration_minutes: null }), /CHECK/);
  assert.throws(() => req(db, { public_id: 'rq_callback3', kind: 'request', status: 'new', hold_until: '2026-10-11T09:30:00Z' }), /CHECK/);
  assert.throws(() => req(db, { public_id: 'rq_badstat1', status: 'booked' }), /CHECK/);
  assert.throws(() => req(db, { public_id: 'rq_badreas1', status: 'declined', decline_reason: 'busy' }), /CHECK/);
});

test('245: у заявки одно живое удержание; освобождённое — с причиной', () => {
  const db = fresh(); seed(db);
  const id = req(db);
  const hold = (over = {}) => db.prepare(`INSERT INTO slot_holds (doctor_id, start_at, duration_minutes, until_at, api_request_id, kind, released_at, release_reason)
    VALUES (7, '2026-10-20T05:00:00Z', 30, '2026-10-11T09:30:00Z', ?, ?, ?, ?)`).run(id, over.kind || 'booking', over.released_at ?? null, over.release_reason ?? '');
  hold();
  assert.throws(() => hold(), /UNIQUE/, 'второе живое удержание');
  hold({ released_at: '2026-10-11T09:10:00Z', release_reason: 'offered' });
  assert.throws(() => hold({ released_at: '2026-10-11T09:10:00Z' }), /CHECK/, 'освобождено без причины');
  assert.throws(() => hold({ release_reason: 'expired' }), /CHECK/, 'причина без освобождения');
  assert.throws(() => hold({ kind: 'visit', released_at: '2026-10-11T09:10:00Z', release_reason: 'expired' }), /CHECK/);
});

test('245: событие — объект JSON и известная пометка', () => {
  const db = fresh(); seed(db);
  const id = req(db);
  const ev = (body, note = '') => db.prepare('INSERT INTO api_outbox (api_request_id, connection_id, event, status, body, note) VALUES (?, 1, ?, ?, ?, ?)')
    .run(id, 'booking.confirmed', 'booked', body, note);
  ev('{"event":"booking.confirmed"}');
  assert.throws(() => ev('[1,2]'), /CHECK/);
  assert.throws(() => ev('не json'), /CHECK|malformed/);
  assert.throws(() => ev('{}', 'lost'), /CHECK/);
  ev('{}', 'no_secret');
});
