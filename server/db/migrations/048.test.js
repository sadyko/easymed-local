import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

// LAB_SERVICE_LINK_V1 — `services.type` and `services.is_lab` are two different
// answers to the same question ("is this a lab test?"), written by two different
// editors: Settings → Услуги sets `type`, the standalone services.js editor sets
// `is_lab`. Migration 022 backfilled them once and left no trigger, so they drifted
// apart — a service marked «Лаборатория» in the UI kept is_lab=0 and never reached
// the lab queue, which filters on is_lab. These tests pin the reconciliation and
// the trigger that stops it happening again.

test('048 reconciles services where type and is_lab had drifted apart', () => {
  const db = openDb(':memory:'); migrate(db);

  // Both directions of the drift seen in the real database.
  db.prepare("INSERT INTO services (name, price, type, is_lab) VALUES ('typed only', 1, 'lab', 0)").run();
  db.prepare("INSERT INTO services (name, price, type, is_lab) VALUES ('flagged only', 1, 'consultation', 1)").run();

  // Re-run the reconciliation the migration performs (the rows above were
  // inserted after it ran, so assert the TRIGGER caught them instead).
  const typed = db.prepare("SELECT type, is_lab FROM services WHERE name = 'typed only'").get();
  const flagged = db.prepare("SELECT type, is_lab FROM services WHERE name = 'flagged only'").get();
  assert.equal(typed.is_lab, 1, "type='lab' implies is_lab=1");
  assert.equal(flagged.type, 'lab', 'is_lab=1 implies type=lab');
});

test('048 keeps the two in sync when either side is edited', () => {
  const db = openDb(':memory:'); migrate(db);
  const id = db.prepare("INSERT INTO services (name, price, type, is_lab) VALUES ('X', 1, 'consultation', 0)").run().lastInsertRowid;

  // Settings → Услуги writes `type`.
  db.prepare("UPDATE services SET type='lab' WHERE id=?").run(id);
  assert.equal(db.prepare('SELECT is_lab FROM services WHERE id=?').get(id).is_lab, 1, 'setting type=lab raises is_lab');

  // …and back again.
  db.prepare("UPDATE services SET type='consultation' WHERE id=?").run(id);
  assert.equal(db.prepare('SELECT is_lab FROM services WHERE id=?').get(id).is_lab, 0, 'leaving type=lab clears is_lab');

  // The other editor writes `is_lab`.
  db.prepare('UPDATE services SET is_lab=1 WHERE id=?').run(id);
  assert.equal(db.prepare('SELECT type FROM services WHERE id=?').get(id).type, 'lab', 'raising is_lab sets type=lab');

  db.prepare('UPDATE services SET is_lab=0 WHERE id=?').run(id);
  assert.equal(db.prepare('SELECT type FROM services WHERE id=?').get(id).type, 'consultation',
    'clearing is_lab returns type to consultation');
});

test('048 does not disturb a non-lab service whose type changes', () => {
  const db = openDb(':memory:'); migrate(db);
  const id = db.prepare("INSERT INTO services (name, price, type, is_lab) VALUES ('Проц', 1, 'procedure', 0)").run().lastInsertRowid;
  db.prepare("UPDATE services SET type='imaging' WHERE id=?").run(id);
  const row = db.prepare('SELECT type, is_lab FROM services WHERE id=?').get(id);
  assert.equal(row.type, 'imaging', 'a non-lab type change is left alone');
  assert.equal(row.is_lab, 0);
});

test('048 leaves an already-consistent lab service untouched', () => {
  const db = openDb(':memory:'); migrate(db);
  const id = db.prepare("INSERT INTO services (name, price, type, is_lab, specimen) VALUES ('ОАК', 1, 'lab', 1, 'кровь')").run().lastInsertRowid;
  db.prepare("UPDATE services SET price = 2 WHERE id=?").run(id);
  const row = db.prepare('SELECT type, is_lab, specimen, price FROM services WHERE id=?').get(id);
  assert.deepEqual([row.type, row.is_lab, row.specimen, row.price], ['lab', 1, 'кровь', 2],
    'an unrelated edit changes nothing else');
});

test('048 gives lab_panels.service_id a unique index so two panels cannot claim one service', () => {
  const db = openDb(':memory:'); migrate(db);
  const svc = db.prepare("INSERT INTO services (name, price, type) VALUES ('ОАК', 1, 'lab')").run().lastInsertRowid;
  db.prepare("INSERT INTO lab_panels (name, service_id) VALUES ('A', ?)").run(svc);
  assert.throws(
    () => db.prepare("INSERT INTO lab_panels (name, service_id) VALUES ('B', ?)").run(svc),
    /UNIQUE/,
    'a second panel on the same service is rejected — result entry could not tell which to render',
  );
  // Unlinked panels are not constrained against each other.
  db.prepare("INSERT INTO lab_panels (name, service_id) VALUES ('C', NULL)").run();
  db.prepare("INSERT INTO lab_panels (name, service_id) VALUES ('D', NULL)").run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_panels WHERE service_id IS NULL').get().n, 2);
});
