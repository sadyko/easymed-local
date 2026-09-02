// ROOMS_DELETE_V1 — удаление помещения не должно рвать клинические данные.
//
// Правило одно: пустое — удаляем физически, занятое — отключаем и говорим, чем
// занято. Тесты пиняют обе ветки, потому что именно здесь легко получить
// висячие ссылки: SQLite в этой сборке без ON DELETE, а на кабинете висят
// врачи, услуги и талоны очереди.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { roomsSetupDelete } from './rooms-delete.js';

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }
const admin = { id: 1, role: 'admin', extra_roles: [] };
const nurse = { id: 2, role: 'nurse', extra_roles: [] };

test('пустой кабинет удаляется физически', () => {
  const db = freshDb();
  const id = db.prepare("INSERT INTO rooms (name) VALUES ('Кабинет 201')").run().lastInsertRowid;
  const out = roomsSetupDelete(db, { kind: 'room', id }, admin);
  assert.equal(out.deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM rooms WHERE id = ?').get(id).c, 0);
});

test('кабинет с врачом НЕ удаляется — отключается, врач остаётся привязан', () => {
  const db = freshDb();
  const room = db.prepare("INSERT INTO rooms (name) VALUES ('Кабинет 202')").run().lastInsertRowid;
  const doc = db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor, room_id) VALUES ('d','x','Врач В.','doctor',1,?)").run(room).lastInsertRowid;
  const out = roomsSetupDelete(db, { kind: 'room', id: room }, admin);
  assert.equal(out.deleted, false);
  assert.equal(out.deactivated, true);
  assert.ok(out.held.some((x) => x.what === 'врачи'), JSON.stringify(out.held));
  assert.equal(db.prepare('SELECT active FROM rooms WHERE id = ?').get(room).active, 0);
  // ссылка цела: карточка врача не превращается в указатель в пустоту
  assert.equal(db.prepare('SELECT room_id FROM users WHERE id = ?').get(doc).room_id, room);
});

test('палата с пустыми койками удаляется вместе с ними', () => {
  const db = freshDb();
  const w = db.prepare("INSERT INTO wards (name) VALUES ('Палата 1')").run().lastInsertRowid;
  db.prepare("INSERT INTO beds (code, ward_id) VALUES ('1', ?)").run(w);
  db.prepare("INSERT INTO beds (code, ward_id) VALUES ('2', ?)").run(w);
  const out = roomsSetupDelete(db, { kind: 'ward', id: w }, admin);
  assert.equal(out.deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM beds WHERE ward_id = ?').get(w).c, 0);
});

test('палата с занятой койкой отключается, койки остаются', () => {
  const db = freshDb();
  const w = db.prepare("INSERT INTO wards (name) VALUES ('Палата 2')").run().lastInsertRowid;
  db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('1', ?, 'occupied')").run(w);
  const out = roomsSetupDelete(db, { kind: 'ward', id: w }, admin);
  assert.equal(out.deleted, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM beds WHERE ward_id = ?').get(w).c, 1);
});

test('этаж с кабинетом отключается, а не удаляется', () => {
  const db = freshDb();
  const f = db.prepare("INSERT INTO floors (name, level) VALUES ('2-й этаж', 2)").run().lastInsertRowid;
  db.prepare("INSERT INTO rooms (name, floor_id) VALUES ('Кабинет 203', ?)").run(f);
  const out = roomsSetupDelete(db, { kind: 'floor', id: f }, admin);
  assert.equal(out.deleted, false);
  assert.ok(out.held.some((x) => x.what === 'кабинеты'));
});

test('не админ получает 403', () => {
  const db = freshDb();
  const id = db.prepare("INSERT INTO rooms (name) VALUES ('Кабинет 204')").run().lastInsertRowid;
  assert.throws(() => roomsSetupDelete(db, { kind: 'room', id }, nurse), (e) => e.status === 403);
});

test('неизвестный kind отвергается', () => {
  const db = freshDb();
  assert.throws(() => roomsSetupDelete(db, { kind: 'building', id: 1 }, admin), (e) => e.status === 400);
});
