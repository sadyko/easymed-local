import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('049 gives the clinic a laboratory and a diagnostics department', () => {
  const db = openDb(':memory:'); migrate(db);
  const kinds = db.prepare('SELECT kind, name FROM departments ORDER BY kind').all();
  const byKind = Object.fromEntries(kinds.map(k => [k.kind, k.name]));
  assert.equal(byKind.laboratory, 'Лаборатория', 'a laboratory department exists to route lab services to');
  assert.equal(byKind.diagnostics, 'Диагностика');
  // 038's originals survive.
  for (const k of ['inpatient', 'clinical', 'procedure', 'administrative']) {
    assert.ok(byKind[k], '038 seeded ' + k + ' is still there');
  }
});

test('049 does not duplicate a laboratory department the clinic already made', () => {
  const db = openDb(':memory:');
  migrate(db);
  // Simulate a clinic that had already created its own, under its own name.
  db.prepare("DELETE FROM schema_migrations WHERE name = ?").run('049_seed_lab_department.sql');
  db.prepare("DELETE FROM departments WHERE kind IN ('laboratory','diagnostics')").run();
  db.prepare("INSERT INTO departments (name, kind) VALUES ('Клиническая лаборатория', 'laboratory')").run();

  migrate(db);   // re-runs 049 only

  const labs = db.prepare("SELECT name FROM departments WHERE kind = 'laboratory'").all();
  assert.equal(labs.length, 1, 'no duplicate laboratory department');
  assert.equal(labs[0].name, 'Клиническая лаборатория', "the clinic's own name is kept");
});

test('049 flags any service already sitting in a laboratory department', () => {
  const db = openDb(':memory:');
  migrate(db);
  const labDept = db.prepare("SELECT id FROM departments WHERE kind = 'laboratory'").get().id;

  // A service parked in the lab department but never marked as lab work — the
  // exact state that made a service invisible to the lab queue.
  db.prepare("INSERT INTO services (name, price, type, is_lab, department_id) VALUES ('Биохимия', 1, 'consultation', 0, ?)").run(labDept);
  // Re-run 049 so its UPDATE sees the row (it was inserted after migrate()).
  db.prepare("DELETE FROM schema_migrations WHERE name = ?").run('049_seed_lab_department.sql');
  migrate(db);

  const row = db.prepare("SELECT type, is_lab FROM services WHERE name = 'Биохимия'").get();
  assert.equal(row.type, 'lab', 'a service in the laboratory department is routed to the lab');
  assert.equal(row.is_lab, 1, "and migration 048's trigger keeps the older flag in step");
});

test('049 leaves services in other departments alone', () => {
  const db = openDb(':memory:');
  migrate(db);
  const clinical = db.prepare("SELECT id FROM departments WHERE kind = 'clinical'").get().id;
  db.prepare("INSERT INTO services (name, price, type, department_id) VALUES ('Приём', 1, 'consultation', ?)").run(clinical);
  db.prepare("DELETE FROM schema_migrations WHERE name = ?").run('049_seed_lab_department.sql');
  migrate(db);
  assert.equal(db.prepare("SELECT type FROM services WHERE name = 'Приём'").get().type, 'consultation');
});
