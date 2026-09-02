// 082_rooms_setup.sql — колонки, без которых объединённый раздел «Помещения»
// мог создать строку, но не мог её описать, и очередь кабинета.
//
// Проверяем не факт «ALTER выполнился», а СМЫСЛ:
//   * умолчания безопасны для уже работающих клиник — существующий кабинет
//     после обновления не начинает вдруг выдавать талоны (queue_mode='none');
//   * очередь кабинета реально маршрутизируется (issue_queue_numbers кладёт
//     номер в линию room:<id>:<день>), потому что именно этого не делал
//     services.room_id все предыдущие версии: колонка была, читателя не было.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { issueQueueNumbers } from '../../services/rpc/queue.js';

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }
const admin = { id: 1, role: 'admin', extra_roles: [] };

test('rooms gains code/room_type/capacity/queue_mode with safe defaults', () => {
  const db = freshDb();
  const id = db.prepare("INSERT INTO rooms (name) VALUES ('Кабинет 201')").run().lastInsertRowid;
  const r = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
  assert.equal(r.code, '');
  assert.equal(r.room_type, 'consultation');
  assert.equal(r.capacity, 0);
  // ГЛАВНОЕ умолчание: обновление не включает очередь задним числом.
  assert.equal(r.queue_mode, 'none');
});

test('wards gains code and floor_id', () => {
  const db = freshDb();
  const f = db.prepare("INSERT INTO floors (name, level) VALUES ('2-й этаж', 2)").run().lastInsertRowid;
  const w = db.prepare("INSERT INTO wards (name, code, floor_id) VALUES ('Палата 3', 'W3', ?)").run(f).lastInsertRowid;
  const row = db.prepare('SELECT * FROM wards WHERE id = ?').get(w);
  assert.equal(row.code, 'W3');
  assert.equal(row.floor_id, f);
});

// --- очередь кабинета ---------------------------------------------------

function seedVisitService(db, { roomId, queueMode }) {
  const room = db.prepare("INSERT INTO rooms (name, queue_mode) VALUES ('УЗИ-кабинет', ?)").run(queueMode).lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price, type, room_id) VALUES ('УЗИ брюшной полости', 100000, 'imaging', ?)")
    .run(roomId === undefined ? room : roomId).lastInsertRowid;
  const p = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент П.')").run().lastInsertRowid;
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, date('now','localtime'))").run(p).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, status, total) VALUES (?, ?, 'added', 100000)")
    .run(v, svc).lastInsertRowid;
  return { room, vs };
}

test("queue_mode='room' ставит номер в линию кабинета, а не услуги", () => {
  const db = freshDb();
  const { room, vs } = seedVisitService(db, { queueMode: 'room' });
  const out = issueQueueNumbers(db, { p_ids: [vs] }, admin);
  const day = db.prepare("SELECT date('now','localtime') d").get().d;
  assert.equal(out.length, 1);
  assert.equal(out[0].queue_key, `room:${room}:${day}`);
  assert.equal(out[0].number, 1);
});

test("queue_mode='none' оставляет прежний маршрут — обновление ничего не меняет", () => {
  const db = freshDb();
  const { room, vs } = seedVisitService(db, { queueMode: 'none' });
  const out = issueQueueNumbers(db, { p_ids: [vs] }, admin);
  assert.ok(!out[0].queue_key.startsWith(`room:${room}:`),
    'кабинет без включённой очереди не забирает талон себе: ' + out[0].queue_key);
});

test('талон кабинета подписан дверью, а не названием услуги', () => {
  const db = freshDb();
  const { room, vs } = seedVisitService(db, { queueMode: 'room' });
  db.prepare("UPDATE rooms SET name = 'Кабинет УЗИ', code = '204' WHERE id = ?").run(room);
  const out = issueQueueNumbers(db, { p_ids: [vs] }, admin);
  assert.equal(out[0].label, 'Кабинет УЗИ · 204');
});
