// 081_service_editor.sql — the service editor's two columns, and the
// branch-sync asymmetry the design fixed in writing (docs/plans/
// 2026-08-31-service-editor-design.md):
//
//   default_doctor_percent SYNCS — the performer's default share is clinic-wide
//   pay policy and travels with the price list;
//   room_id DOES NOT — a room in building A means nothing in building B, so the
//   receiving branch keeps its own NULL/local value.
//
// The guarantee is by construction (catalogue.js lists columns in code, and the
// exporter physically cannot read anything else), but construction is exactly
// what a future edit changes — so both directions are pinned here, against the
// REAL exporter and the REAL importer, not a mirror of their column lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { exportCatalogue, applyCatalogue } from '../../services/branch-sync/catalogue.js';

// A fresh migrate REPLAYS 080 then 081 in order, so passing here proves 081
// applies cleanly on a database that took 080 — the state every 0.4.x clinic
// is in when this lands. 081 is two ADD COLUMNs and reads no branch state, so
// there is no upgraded-vs-fresh divergence to simulate separately.
function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('services gains default_doctor_percent, NOT NULL with default 0', () => {
  const db = freshDb();
  const id = db.prepare("INSERT INTO services (name, price) VALUES ('Приём терапевта', 100000)").run().lastInsertRowid;
  const row = db.prepare('SELECT default_doctor_percent FROM services WHERE id = ?').get(id);
  assert.equal(row.default_doctor_percent, 0, 'an old-style insert must land with 0, not NULL — reports COALESCE on it');
});

test('services gains room_id, nullable, and it is a real FK to rooms', () => {
  const db = freshDb();
  const noRoom = db.prepare("INSERT INTO services (name, price) VALUES ('Без кабинета', 1)").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT room_id FROM services WHERE id = ?').get(noRoom).room_id, null);

  // foreign_keys is ON (connection.js): a room that does not exist must be
  // refused, not stored as a dangling number the diagnostics queue trips over.
  assert.throws(
    () => db.prepare("INSERT INTO services (name, price, room_id) VALUES ('Битый кабинет', 1, 9999)").run(),
    /FOREIGN KEY/i,
  );

  const room = db.prepare("INSERT INTO rooms (name) VALUES ('Кабинет 5')").run().lastInsertRowid;
  const withRoom = db.prepare('INSERT INTO services (name, price, room_id) VALUES (?, ?, ?)')
    .run('УЗИ', 1, room).lastInsertRowid;
  assert.equal(db.prepare('SELECT room_id FROM services WHERE id = ?').get(withRoom).room_id, room);
});

test('catalogue export carries default_doctor_percent and NOT room_id', () => {
  const db = freshDb();
  const room = db.prepare("INSERT INTO rooms (name) VALUES ('Кабинет 2')").run().lastInsertRowid;
  db.prepare('INSERT INTO services (name, price, default_doctor_percent, room_id) VALUES (?, ?, ?, ?)')
    .run('Приём кардиолога', 250000, 35, room);

  const out = exportCatalogue(db);
  const svc = out.services.find((s) => s.name === 'Приём кардиолога');
  assert.ok(svc, 'the service must be exported at all');
  assert.equal(svc.default_doctor_percent, 35, 'pay policy travels with the price list');
  assert.equal('room_id' in svc, false, 'a room is a building-local fact and must not leave this install');
});

// A row shaped the way exportCatalogue actually ships it — every listed column
// present. applyCatalogue writes NULL for a listed-but-absent column, so a
// thinned-down fixture would test a payload the exporter never produces (and
// trip services' NOT NULL defaults for nothing).
const remoteService = (over = {}) => ({
  id: 501, name: 'Приём невролога', code: null, price: 200000, tax_rate: 12,
  duration_minutes: 30, requires_doctor: 1, active: 1, is_lab: 0, specimen: null,
  result_unit: null, ref_low: null, ref_high: null, ref_text: null,
  type: 'consultation', type_id: null, category_id: null, department_id: null,
  tube_color: null, default_doctor_percent: 40, ...over,
});

test('an incoming default_doctor_percent lands, on create and on a later change', () => {
  const db = freshDb();
  const payload = { services: [remoteService()] };
  applyCatalogue(db, payload);
  const created = db.prepare("SELECT * FROM services WHERE name = 'Приём невролога'").get();
  assert.equal(created.default_doctor_percent, 40);

  // The main branch changes its pay policy; the same remote id must UPDATE the
  // adopted local row, not spawn a twin. (Count by name, not the whole table —
  // a fresh database already carries seeded demo services.)
  payload.services[0].default_doctor_percent = 45;
  applyCatalogue(db, payload);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM services WHERE name = 'Приём невролога'").get().n, 1);
  assert.equal(db.prepare('SELECT default_doctor_percent FROM services WHERE id = ?').get(created.id).default_doctor_percent, 45);
});

test('a room_id smuggled into a payload is ignored — the local value stays local', () => {
  const db = freshDb();
  const room = db.prepare("INSERT INTO rooms (name) VALUES ('Местный кабинет')").run().lastInsertRowid;
  const local = db.prepare('INSERT INTO services (name, price, room_id) VALUES (?, ?, ?)')
    .run('Рентген кисти', 90000, room).lastInsertRowid;

  // Same name → the importer ADOPTS the local row; the payload names a room id
  // that means nothing here (and happens to exist — the dangerous case).
  applyCatalogue(db, {
    services: [remoteService({ id: 700, name: 'Рентген кисти', price: 95000, type: 'radiology', default_doctor_percent: 0, room_id: 12345 })],
  });
  const after = db.prepare('SELECT price, room_id FROM services WHERE id = ?').get(local);
  assert.equal(after.price, 95000, 'the price update itself must land — that is what sync is for');
  assert.equal(after.room_id, room, 'the local room assignment must survive the sync untouched');
});
